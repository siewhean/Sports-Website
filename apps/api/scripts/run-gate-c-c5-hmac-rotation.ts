import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { lookup as dnsLookup } from "node:dns/promises";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { secureGateCC5JsonRequest } from "./gate-c-c5-controlled-staging-runtime.js";

const executeFile = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const sha256Pattern = /^[a-f0-9]{64}$/u;
const sourceShaPattern = /^[a-f0-9]{40}$/u;
const safeOracle = /^[a-z][a-z0-9_]{2,199}$/u;
const secretLikeContent =
  /(?:\b(?:secret|token|password|cookie|authorization|bearer)\b|(?:postgres(?:ql)?|redis|rediss):\/\/)/iu;

type RotationObservation = Readonly<{
  new_primary_issuance_verified: true;
  old_material_overlap_verified: true;
  premature_retirement_refused: true;
  audited_retirement_verified: true;
  retirement_verified: true;
  retired_key_rejected: true;
  ambiguity_failed_closed: true;
  key_fingerprints: readonly string[];
  recovery_oracle: string;
}>;

type ExternalDrillOutput = Readonly<{
  source_sha: string;
  run_id: string;
  deployment_id: string;
  build_id: string;
  attestation_nonce: string;
  attestation: string;
  rate_limit: RotationObservation;
  fallback_code: RotationObservation;
}>;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
function attestation(secret: string, fields: Record<string, string>): string {
  return createHmac("sha256", secret)
    .update(
      Object.entries(fields)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${value}`)
        .join("\n"),
      "utf8",
    )
    .digest("hex");
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`Gate C C5 HMAC rotation drill requires ${name}`);
  return value;
}

function privateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [first, second] = address.split(".").map(Number);
    if (first === undefined) return true;
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      first === 169 ||
      (first === 100 && second !== undefined && second >= 64 && second <= 127) ||
      (first === 192 && second === 168) ||
      (first === 192 && second === 0) ||
      (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
      (first === 198 && second !== undefined && (second === 18 || second === 19 || second === 51)) ||
      (first === 203 && second === 0) ||
      first >= 224
    );
  }
  let normalizedAddress = address.toLowerCase();
  const dottedTail = normalizedAddress.slice(normalizedAddress.lastIndexOf(":") + 1);
  if (dottedTail.includes(".")) {
    const octets = dottedTail.split(".").map(Number);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255))
      return true;
    normalizedAddress = `${normalizedAddress.slice(0, normalizedAddress.lastIndexOf(":") + 1)}${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const [left = "", right = ""] = normalizedAddress.split("::");
  const leftGroups = left ? left.split(":") : [];
  const rightGroups = right ? right.split(":") : [];
  if (leftGroups.length + rightGroups.length > 8) return true;
  const groups = [
    ...leftGroups,
    ...Array(Math.max(0, 8 - leftGroups.length - rightGroups.length)).fill("0"),
    ...rightGroups,
  ].map((group) => Number.parseInt(group || "0", 16));
  if (groups.length !== 8 || groups.some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff))
    return true;
  const first = groups[0]!;
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true;
  if (
    groups.every((group) => group === 0) ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xff00) === 0xff00
  )
    return true;
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff)
    return privateAddress(`${groups[6]! >> 8}.${groups[6]! & 255}.${groups[7]! >> 8}.${groups[7]! & 255}`);
  return false;
}

async function assertExternalControlPlane(environment: NodeJS.ProcessEnv): Promise<URL> {
  const raw = required(environment, "GATE_C_C5_HMAC_CONTROL_PLANE_URL");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Gate C C5 HMAC control plane must be an external HTTPS URL");
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    /(?:^|\.)(?:localhost|local|nip\.io|sslip\.io)$/u.test(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new Error("Gate C C5 HMAC control plane must be an external credential-free HTTPS URL");
  }
  const addresses = await dnsLookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => privateAddress(address))) {
    throw new Error("Gate C C5 HMAC control plane must resolve only to public infrastructure");
  }
  return url;
}

function assertObservation(value: unknown, label: string): asserts value is RotationObservation {
  const candidate =
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  const expected = [
    "new_primary_issuance_verified",
    "old_material_overlap_verified",
    "premature_retirement_refused",
    "audited_retirement_verified",
    "retirement_verified",
    "retired_key_rejected",
    "ambiguity_failed_closed",
    "key_fingerprints",
    "recovery_oracle",
  ];
  if (
    !candidate ||
    Object.keys(candidate).sort().join(",") !== expected.sort().join(",") ||
    expected.slice(0, 7).some((key) => candidate[key] !== true) ||
    !Array.isArray(candidate.key_fingerprints) ||
    candidate.key_fingerprints.length < 2 ||
    new Set(candidate.key_fingerprints).size !== candidate.key_fingerprints.length ||
    candidate.key_fingerprints.some(
      (fingerprint) => typeof fingerprint !== "string" || !sha256Pattern.test(fingerprint),
    ) ||
    typeof candidate.recovery_oracle !== "string" ||
    !safeOracle.test(candidate.recovery_oracle)
  ) {
    throw new Error(`Gate C C5 HMAC ${label} drill output is incomplete or malformed`);
  }
}

function parseOutput(
  value: string,
  input: { sourceSha: string; runId: string; nonce: string; deploymentId: string; buildId: string; secret: string },
): ExternalDrillOutput {
  if (value.length > 16_384 || secretLikeContent.test(value)) {
    throw new Error("Gate C C5 HMAC drill output is unsafe or oversized");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Gate C C5 HMAC drill must emit one JSON attestation");
  }
  const candidate =
    parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  if (
    !candidate ||
    Object.keys(candidate).sort().join(",") !==
      [
        "attestation",
        "attestation_nonce",
        "build_id",
        "deployment_id",
        "fallback_code",
        "rate_limit",
        "run_id",
        "source_sha",
      ].join(",") ||
    candidate.source_sha !== input.sourceSha ||
    candidate.run_id !== input.runId ||
    candidate.attestation_nonce !== input.nonce ||
    candidate.deployment_id !== input.deploymentId ||
    candidate.build_id !== input.buildId ||
    typeof candidate.attestation !== "string" ||
    !sha256Pattern.test(candidate.attestation) ||
    !timingSafeEqual(
      Buffer.from(candidate.attestation, "hex"),
      Buffer.from(
        attestation(input.secret, {
          source_sha: input.sourceSha,
          run_id: input.runId,
          attestation_nonce: input.nonce,
          deployment_id: input.deploymentId,
          build_id: input.buildId,
        }),
        "hex",
      ),
    )
  ) {
    throw new Error("Gate C C5 HMAC drill output is not bound to this exact invocation");
  }
  assertObservation(candidate.rate_limit, "rate-limit");
  assertObservation(candidate.fallback_code, "fallback-code");
  return candidate as unknown as ExternalDrillOutput;
}

/**
 * Runs an operator-owned executable outside this checkout. The executable is
 * responsible for making authenticated staging lifecycle calls and may not be
 * replaced by an ordinary C5 workload command or an in-repository echo stub.
 */
export async function runGateCC5HmacRotationDrill(
  input: Readonly<{
    sourceSha: string;
    environment?: NodeJS.ProcessEnv;
  }>,
): Promise<string> {
  if (!sourceShaPattern.test(input.sourceSha)) throw new Error("Gate C C5 HMAC drill requires an exact source SHA");
  const environment = input.environment ?? process.env;
  if (environment.GATE_C_C5_HMAC_DRILL_OPT_IN !== "1") {
    throw new Error("Refusing HMAC rotation drill without GATE_C_C5_HMAC_DRILL_OPT_IN=1");
  }
  const token = required(environment, "GATE_C_C5_HMAC_OPERATOR_TOKEN");
  const secret = required(environment, "GATE_C_C5_COMPONENT_ATTESTATION_HMAC_SECRET");
  const deploymentId = required(environment, "GATE_C_C5_DEPLOYMENT_ID");
  const buildId = required(environment, "GATE_C_C5_BUILD_ID");
  if (Buffer.byteLength(token, "utf8") < 32)
    throw new Error("Gate C C5 HMAC operator token must contain at least 32 bytes");
  const controlPlane = await assertExternalControlPlane(environment);
  const runner = required(environment, "GATE_C_C5_HMAC_DRILL_RUNNER");
  if (!path.isAbsolute(runner)) throw new Error("Gate C C5 HMAC drill runner must be an absolute operator-owned path");
  const realRunner = await realpath(runner);
  if (realRunner.startsWith(`${root}${path.sep}`)) {
    throw new Error("Gate C C5 HMAC drill runner must be outside this repository");
  }
  if (!(await lstat(realRunner)).isFile()) throw new Error("Gate C C5 HMAC drill runner must be a regular file");
  const runId = randomBytes(16).toString("hex");
  const probe = await secureGateCC5JsonRequest(
    controlPlane,
    {
      headers: { authorization: `Bearer ${token}`, accept: "application/json", "x-gate-c-c5-run-id": runId },
      signal: AbortSignal.timeout(10_000),
    },
    async (hostname) => dnsLookup(hostname, { all: true, verbatim: true }),
  );
  if (!probe.ok) throw new Error(`Gate C C5 HMAC control-plane probe failed with HTTP ${String(probe.status)}`);
  const probeValue = await probe.json();
  const expectedProbe = {
    source_sha: input.sourceSha,
    run_id: runId,
    deployment_id: deploymentId,
    build_id: buildId,
    component: "hmac_control_plane",
  };
  const probeAttestation =
    probeValue && typeof probeValue === "object" ? (probeValue as Record<string, unknown>).attestation : undefined;
  if (
    !probeValue ||
    typeof probeValue !== "object" ||
    Object.keys(probeValue).length !== 6 ||
    Object.entries(expectedProbe).some(([key, value]) => (probeValue as Record<string, unknown>)[key] !== value) ||
    typeof probeAttestation !== "string" ||
    !sha256Pattern.test(probeAttestation) ||
    !timingSafeEqual(Buffer.from(probeAttestation, "hex"), Buffer.from(attestation(secret, expectedProbe), "hex"))
  )
    throw new Error("Gate C C5 HMAC control-plane provenance does not match the immutable candidate");
  const nonce = randomBytes(32).toString("base64url");
  const result = await executeFile(realRunner, [], {
    encoding: "utf8",
    timeout: 10 * 60_000,
    windowsHide: true,
    env: {
      PATH: environment.PATH,
      HOME: environment.HOME,
      LANG: environment.LANG,
      LC_ALL: environment.LC_ALL,
      GATE_C_C5_HMAC_OPERATOR_TOKEN: token,
      GATE_C_C5_HMAC_DRILL_SOURCE_SHA: input.sourceSha,
      GATE_C_C5_HMAC_DRILL_RUN_ID: runId,
      GATE_C_C5_HMAC_DRILL_DEPLOYMENT_ID: deploymentId,
      GATE_C_C5_HMAC_DRILL_BUILD_ID: buildId,
      GATE_C_C5_HMAC_DRILL_ATTESTATION_NONCE: nonce,
      GATE_C_C5_HMAC_CONTROL_PLANE_URL: controlPlane.toString(),
    },
  });
  const output = parseOutput(`${result.stdout}\n${result.stderr}`.trim(), {
    sourceSha: input.sourceSha,
    runId,
    nonce,
    deploymentId,
    buildId,
    secret,
  });
  const directory = path.join(root, "artifacts", "qa", "gate-c-c5", input.sourceSha, "hmac-rotation");
  await mkdir(directory, { recursive: true });
  if ((await realpath(directory)) !== directory)
    throw new Error("Gate C C5 HMAC retained directory must not traverse symlinks");
  const logPath = path.join(directory, "drill.log");
  const receiptPath = path.join(root, "artifacts", "qa", "gate-c-c5", input.sourceSha, "hmac-rotation.json");
  const log = `${JSON.stringify(output)}\n`;
  await writeFile(logPath, log, { encoding: "utf8", flag: "wx", mode: 0o600 });
  const receipt = {
    artifact_kind: "gate-c-c5-hmac-rotation",
    source_sha: input.sourceSha,
    evidence_type: "operational_drill",
    status: "PASS",
    control_plane_sha256: sha256(controlPlane.origin),
    attestation_nonce_sha256: sha256(nonce),
    run_id_sha256: sha256(runId),
    deployment_id_sha256: sha256(deploymentId),
    build_id_sha256: sha256(buildId),
    operator_attestation_sha256: sha256(output.attestation),
    drill_log: "hmac-rotation/drill.log",
    drill_log_sha256: sha256(log),
    rate_limit: { status: "PASS", ...output.rate_limit },
    fallback_code: { status: "PASS", ...output.fallback_code },
  };
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return receiptPath;
}
