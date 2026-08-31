import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { once } from "node:events";

import {
  EmailTemplateRegistry,
  NoopNotificationRateLimiter,
  NotificationService,
  PostgresNotificationRepository,
} from "@matchday/notifications";
import postgres, { type Sql } from "postgres";

const outputDirectory = "artifacts/phase-6-smtp-certification";
const workerLogPath = `${outputDirectory}/worker.log`;
const mailpitLogPath = `${outputDirectory}/mailpit.log`;
const mailpitMessagesPath = `${outputDirectory}/mailpit-messages.json`;
const receiptPath = `${outputDirectory}/receipt.json`;
const mailpitContainer = "matchday-phase6-smtp-certification";

const databaseUrl = requiredEnvironment("DATABASE_URL");
const redisUrl = requiredEnvironment("REDIS_URL");
const productCandidateSha = requiredEnvironment("SMTP_CERT_PRODUCT_SHA");
const secretSentinel = requiredEnvironment("SMTP_CERT_SECRET_SENTINEL");
const harnessSha = process.env.GITHUB_SHA ?? "local";
const runId = process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`;
const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY
  ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${runId}`
  : null;

await mkdir(outputDirectory, { recursive: true });

const accountId = randomUUID();
const notificationIdempotencyKey = `phase6-smtp-cert:${productCandidateSha}:${runId}`;
const emailIdempotencyKey = `notification-email:${accountId}:${notificationIdempotencyKey}`;
const recipient = "phase6-smtp-certification@matchday.test";
const sql = postgres(databaseUrl, { max: 2, idle_timeout: 10 });
let worker: ChildProcessWithoutNullStreams | null = null;
let workerLog = "";
let mailpitStarted = false;

const snapshots: Record<string, unknown> = {};

try {
  await sql`
    INSERT INTO accounts (id, primary_email, display_name, status, email_verified_at)
    VALUES (${accountId}, ${recipient}, 'Phase 6 SMTP Certification', 'active', now())
  `;

  const repository = new PostgresNotificationRepository(sql);
  const notificationService = new NotificationService(repository, repository, new EmailTemplateRegistry(), {
    createId: randomUUID,
    now: () => new Date(),
    rateLimiter: new NoopNotificationRateLimiter(),
  });
  const input = {
    accountId,
    type: "competition-published",
    payload: {
      certification: true,
      product_candidate_sha: productCandidateSha,
    },
    idempotencyKey: notificationIdempotencyKey,
    channels: ["in_app", "email"] as const,
    essential: false,
    email: {
      to: recipient,
      template: { id: "competition-published", version: 1 },
      variables: {
        competitionName: "Phase 6 SMTP Certification",
        actionUrl: "https://staging.matchday.test/organiser/competitions/smtp-certification/schedule",
      },
    },
  };

  const firstPublish = await notificationService.publish(input);
  const duplicatePublish = await notificationService.publish(input);
  assert(firstPublish.emailOutboxId !== null, "first publish did not create an email outbox item");
  assert(
    duplicatePublish.emailOutboxId === firstPublish.emailOutboxId,
    "duplicate publish did not resolve to the existing email outbox item",
  );

  const persistedCounts = await sql<{ notifications: number; outbox: number }[]>`
    SELECT
      (SELECT count(*)::int FROM notifications
       WHERE account_id = ${accountId} AND idempotency_key = ${notificationIdempotencyKey}) AS notifications,
      (SELECT count(*)::int FROM notification_email_outbox
       WHERE idempotency_key = ${emailIdempotencyKey}) AS outbox
  `;
  assert(persistedCounts[0]?.notifications === 1, "notification idempotency created more than one row");
  assert(persistedCounts[0]?.outbox === 1, "email idempotency created more than one outbox row");

  const pending = await readOutbox(sql, emailIdempotencyKey);
  assert(pending.status === "pending" && pending.attempts === 0, "outbox did not begin pending with zero attempts");
  snapshots.pending = pending;

  assertPortIsClosed();
  worker = startWorker();
  worker.stdout.on("data", captureWorkerLog);
  worker.stderr.on("data", captureWorkerLog);

  const firstFailure = await waitForOutbox(
    sql,
    emailIdempotencyKey,
    (row) => row.status === "pending" && row.attempts === 1 && row.last_failure_classification === "transient",
    25_000,
    "transient SMTP failure",
  );
  snapshots.transientFailure = firstFailure;
  assert(firstFailure.last_error?.includes("ECONNREFUSED") ?? false, "first failure was not a refused SMTP connection");

  startMailpit();
  mailpitStarted = true;
  await waitForMailpit(15_000);

  const delivered = await waitForOutbox(
    sql,
    emailIdempotencyKey,
    (row) => row.status === "delivered" && row.attempts === 2 && row.provider_message_id !== null,
    55_000,
    "successful retry delivery",
  );
  snapshots.delivered = delivered;

  const messageList = await fetchMailpitMessages();
  await writeFile(mailpitMessagesPath, `${JSON.stringify(messageList.raw, null, 2)}\n`);
  assert(messageList.messages.length === 1, `expected exactly one SMTP message, got ${messageList.messages.length}`);
  assert(
    JSON.stringify(messageList.messages[0]).includes("Phase 6 SMTP Certification"),
    "SMTP catcher did not retain the expected certification message",
  );

  await sleep(10_000);
  const stable = await readOutbox(sql, emailIdempotencyKey);
  const stableMessages = await fetchMailpitMessages();
  assert(stable.status === "delivered" && stable.attempts === 2, "worker reprocessed an already delivered outbox item");
  assert(stableMessages.messages.length === 1, "SMTP catcher received a duplicate message after subsequent worker polls");
  snapshots.stableAfterAdditionalPolls = stable;

  const secretMatches = [secretSentinel, databaseUrl]
    .filter((value) => value.length > 0)
    .filter((value) => workerLog.includes(value));
  assert(secretMatches.length === 0, "worker logs contain controlled credential material");

  const mailpitLog = execFileSync("docker", ["logs", mailpitContainer], { encoding: "utf8" });
  await writeFile(workerLogPath, workerLog);
  await writeFile(mailpitLogPath, mailpitLog);

  const receipt = {
    verdict:
      "PASS — deployed Matchday worker delivered transactional email through controlled SMTP, persisted provider delivery state, recovered from a genuine transient SMTP failure through the production retry path without duplicate delivery, preserved idempotency, and emitted no controlled credential material in retained worker logs.",
    productCandidateSha,
    certificationHarnessSha: harnessSha,
    githubRunId: runId,
    githubRunUrl: runUrl,
    environment: "GitHub Actions controlled non-production runner",
    workerEntrypoint: "apps/worker/dist/main.js via pnpm --filter @matchday/worker start",
    database: "PostgreSQL 18.4 service container",
    redis: "Redis 8.2 service container",
    smtp: "Mailpit v1.27.4 container started only after the first worker delivery attempt",
    notificationType: "competition-published",
    notificationIdempotencyKey,
    emailIdempotencyKey,
    accountId,
    recipient,
    firstPublishEmailOutboxId: firstPublish.emailOutboxId,
    duplicatePublishEmailOutboxId: duplicatePublish.emailOutboxId,
    persistedCounts: persistedCounts[0],
    snapshots,
    smtpMessageCount: stableMessages.messages.length,
    providerMessageId: delivered.provider_message_id,
    secretLogScan: {
      passed: true,
      scannedControlledDatabaseCredential: true,
      matches: 0,
    },
    completedAt: new Date().toISOString(),
  };
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  if (worker !== null && worker.exitCode === null) {
    worker.kill("SIGTERM");
    await Promise.race([once(worker, "exit"), sleep(10_000)]).catch(() => undefined);
  }
  if (workerLog !== "") await writeFile(workerLogPath, workerLog).catch(() => undefined);
  if (mailpitStarted) {
    const mailpitLog = safeDockerLogs();
    if (mailpitLog !== "") await writeFile(mailpitLogPath, mailpitLog).catch(() => undefined);
    execFileSync("docker", ["rm", "--force", mailpitContainer], { stdio: "ignore" });
  }
  await sql.end({ timeout: 5 });
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function captureWorkerLog(chunk: Buffer | string): void {
  workerLog += chunk.toString();
}

function startWorker(): ChildProcessWithoutNullStreams {
  return spawn("pnpm", ["--filter", "@matchday/worker", "start"], {
    env: {
      ...process.env,
      APP_ENV: "test",
      DATABASE_URL: databaseUrl,
      REDIS_URL: redisUrl,
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: "1025",
      SMTP_SECURE: "false",
      SMTP_FROM: "Matchday <no-reply@matchday.test>",
      LOG_LEVEL: "info",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function startMailpit(): void {
  execFileSync(
    "docker",
    [
      "run",
      "--detach",
      "--rm",
      "--name",
      mailpitContainer,
      "--publish",
      "1025:1025",
      "--publish",
      "8025:8025",
      "axllent/mailpit:v1.27.4",
    ],
    { stdio: "ignore" },
  );
}

function assertPortIsClosed(): void {
  try {
    execFileSync("bash", ["-lc", "echo >/dev/tcp/127.0.0.1/1025"], { stdio: "ignore", timeout: 1_000 });
    throw new Error("SMTP port 1025 is already open; transient-failure proof would be invalid");
  } catch (error) {
    if (error instanceof Error && error.message.includes("transient-failure proof")) throw error;
  }
}

async function waitForMailpit(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:8025/api/v1/messages");
      if (response.ok) return;
    } catch {
      // The container is still starting.
    }
    await sleep(500);
  }
  throw new Error("Mailpit did not become ready");
}

type OutboxRow = {
  id: string;
  status: "pending" | "processing" | "delivered" | "dead_letter";
  attempts: number;
  available_at: string;
  delivered_at: string | null;
  provider_message_id: string | null;
  last_error: string | null;
  last_failure_classification: "transient" | "permanent" | null;
};

async function readOutbox(sqlClient: Sql, idempotencyKey: string): Promise<OutboxRow> {
  const rows = await sqlClient<OutboxRow[]>`
    SELECT id, status, attempts, available_at::text, delivered_at::text, provider_message_id,
           last_error, last_failure_classification
    FROM notification_email_outbox
    WHERE idempotency_key = ${idempotencyKey}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw new Error("certification outbox row is missing");
  return row;
}

async function waitForOutbox(
  sqlClient: Sql,
  idempotencyKey: string,
  predicate: (row: OutboxRow) => boolean,
  timeoutMs: number,
  label: string,
): Promise<OutboxRow> {
  const deadline = Date.now() + timeoutMs;
  let last: OutboxRow | null = null;
  while (Date.now() < deadline) {
    last = await readOutbox(sqlClient, idempotencyKey);
    if (predicate(last)) return last;
    if (worker !== null && worker.exitCode !== null) {
      throw new Error(`worker exited before ${label}; exit code ${worker.exitCode}\n${workerLog}`);
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${label}; last state ${JSON.stringify(last)}`);
}

async function fetchMailpitMessages(): Promise<{ raw: unknown; messages: unknown[] }> {
  const response = await fetch("http://127.0.0.1:8025/api/v1/messages");
  if (!response.ok) throw new Error(`Mailpit API returned ${response.status}`);
  const raw = (await response.json()) as Record<string, unknown>;
  const messages = Array.isArray(raw.messages)
    ? raw.messages
    : Array.isArray(raw.items)
      ? raw.items
      : Array.isArray(raw.Messages)
        ? raw.Messages
        : [];
  return { raw, messages };
}

function safeDockerLogs(): string {
  try {
    return execFileSync("docker", ["logs", mailpitContainer], { encoding: "utf8" });
  } catch {
    return "";
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
