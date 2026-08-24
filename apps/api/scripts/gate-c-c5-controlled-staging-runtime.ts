import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import {
  C5_WORKLOAD_OPERATIONS,
  type C5ControlledFailure,
  type C5ControlledFailureHook,
  type C5WorkloadExecutor,
  type C5WorkloadOperation,
} from "@matchday/observability";

import { createGateCC5ControlledStagingFaultHooks } from "./gate-c-c5-controlled-staging-faults.js";

const endpointVariables = {
  score_event_acknowledgement: "GATE_C_C5_SCORE_EVENT_ACK_ENDPOINT",
  public_current_conditional_read: "GATE_C_C5_PUBLIC_CURRENT_ENDPOINT",
  public_result_convergence: "GATE_C_C5_PUBLIC_CONVERGENCE_ENDPOINT",
  lease_takeover: "GATE_C_C5_LEASE_TAKEOVER_ENDPOINT",
  repair_publication: "GATE_C_C5_REPAIR_PUBLICATION_ENDPOINT",
} as const satisfies Record<C5WorkloadOperation, string>;

export type GateCC5ControlledStagingRuntime = Readonly<{
  executors: Readonly<Record<C5WorkloadOperation, C5WorkloadExecutor>>;
  controlledFailureHooks: Readonly<Record<C5ControlledFailure, C5ControlledFailureHook>>;
  postgresqlIdentifier: string;
  redisNamespace: string;
}>;

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`Gate C C5 controlled staging requires ${name}`);
  return value;
}

type Lookup = (hostname: string) => Promise<readonly { address: string }[]>;
type JsonResponse = Readonly<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
type JsonRequester = typeof secureGateCC5JsonRequest;

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

async function externalHttpsUrl(environment: NodeJS.ProcessEnv, name: string, lookup: Lookup): Promise<URL> {
  const value = required(environment, name);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Gate C C5 ${name} must be an HTTPS URL`);
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    /(?:^|\.)(?:localhost|local|nip\.io|sslip\.io)$/u.test(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new Error(`Gate C C5 ${name} must be an external credential-free HTTPS URL`);
  }
  const addresses = await lookup(url.hostname);
  if (!addresses.length || addresses.some(({ address }) => privateAddress(address))) {
    throw new Error(`Gate C C5 ${name} must resolve only to public infrastructure`);
  }
  return url;
}

/** Resolve once, connect to that exact public address, retain the TLS SNI/Host
 * name, and never follow redirects. This prevents DNS rebinding and redirect
 * based credential forwarding from turning a staging endpoint into loopback. */
export async function secureGateCC5JsonRequest(
  url: URL,
  input: Readonly<{ method?: "GET" | "POST"; headers: Record<string, string>; body?: string; signal: AbortSignal }>,
  lookup: Lookup,
): Promise<JsonResponse> {
  const addresses = await lookup(url.hostname);
  const address = addresses.find(({ address }) => !privateAddress(address))?.address;
  if (!address || addresses.some(({ address }) => privateAddress(address))) {
    throw new Error("Gate C C5 request target must resolve only to public infrastructure");
  }
  return new Promise<JsonResponse>((resolve, reject) => {
    const request = httpsRequest(
      {
        hostname: address,
        family: isIP(address),
        servername: url.hostname,
        port: url.port ? Number(url.port) : 443,
        path: `${url.pathname}${url.search}`,
        method: input.method ?? "GET",
        headers: { ...input.headers, host: url.host },
        signal: input.signal,
      },
      (response) => {
        const parts: Buffer[] = [];
        response.on("data", (part: Buffer) => parts.push(part));
        response.on("error", reject);
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            json: async () => JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown,
          });
        });
      },
    );
    request.on("error", reject);
    request.end(input.body);
  });
}

function identifier(environment: NodeJS.ProcessEnv, name: string): string {
  const value = required(environment, name);
  if (value.length > 512 || /(?:postgres(?:ql)?:\/\/|redis(?:s)?:\/\/|password|secret|token)/iu.test(value)) {
    throw new Error(`Gate C C5 ${name} must be a non-secret infrastructure identifier`);
  }
  return value;
}

function attestation(secret: string, fields: Record<string, string>): string {
  return createHmac("sha256", secret)
    .update(
      Object.entries(fields)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}=${value}`)
        .join("\n"),
      "utf8",
    )
    .digest("hex");
}

function exactAttestation(
  value: unknown,
  expected: Record<string, string>,
  secret: string,
  label: string,
  additionalResponseKeys: readonly string[] = [],
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Gate C C5 ${label} did not return a provenance attestation`);
  }
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== Object.keys(expected).length + 1 + additionalResponseKeys.length ||
    Object.entries(expected).some(([key, value]) => candidate[key] !== value) ||
    Object.keys(candidate).some(
      (key) => key !== "attestation" && !Object.hasOwn(expected, key) && !additionalResponseKeys.includes(key),
    ) ||
    typeof candidate.attestation !== "string" ||
    !/^[a-f0-9]{64}$/u.test(candidate.attestation) ||
    !timingSafeEqual(Buffer.from(candidate.attestation, "hex"), Buffer.from(attestation(secret, expected), "hex"))
  ) {
    throw new Error(`Gate C C5 ${label} provenance does not match the immutable candidate`);
  }
}

async function expectHealthy(
  url: URL,
  token: string,
  label: string,
  expected: Record<string, string>,
  secret: string,
  lookup: Lookup,
  requestJson: JsonRequester,
): Promise<void> {
  const runId = expected.run_id;
  if (!runId) throw new Error(`Gate C C5 ${label} probe has no run identifier`);
  const response = await requestJson(
    url,
    {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "x-gate-c-c5-run-id": runId,
      },
      signal: AbortSignal.timeout(10_000),
    },
    lookup,
  );
  if (!response.ok) throw new Error(`Gate C C5 ${label} probe failed with HTTP ${String(response.status)}`);
  exactAttestation(await response.json(), expected, secret, `${label} probe`);
}

function operationExecutor(
  url: URL,
  token: string,
  runId: string,
  sourceSha: string,
  deploymentId: string,
  buildId: string,
  componentAttestationSecret: string,
  lookup: Lookup,
  requestJson: JsonRequester,
): C5WorkloadExecutor {
  return async (invocation) => {
    const response = await requestJson(
      url,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json",
          "x-gate-c-c5-run-id": runId,
        },
        body: JSON.stringify({
          operation: invocation.operation,
          worker_index: invocation.workerIndex,
          sample_index: invocation.sampleIndex,
        }),
        signal: invocation.signal,
      },
      lookup,
    );
    if (!response.ok)
      throw new Error(`Gate C C5 external ${invocation.operation} returned HTTP ${String(response.status)}`);
    const value: unknown = await response.json();
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== 7 ||
      (value as { outcome?: unknown }).outcome !== "success" ||
      (value as { correctness?: { passed?: unknown } }).correctness?.passed !== true ||
      (value as { source_sha?: unknown }).source_sha !== sourceSha ||
      (value as { run_id?: unknown }).run_id !== runId ||
      (value as { deployment_id?: unknown }).deployment_id !== deploymentId ||
      (value as { build_id?: unknown }).build_id !== buildId
    ) {
      throw new Error(`Gate C C5 external ${invocation.operation} returned an invalid success oracle`);
    }
    exactAttestation(
      value,
      {
        outcome: "success",
        source_sha: sourceSha,
        run_id: runId,
        deployment_id: deploymentId,
        build_id: buildId,
      },
      componentAttestationSecret,
      `external ${invocation.operation}`,
      ["correctness"],
    );
    return { outcome: "success", correctness: { passed: true } };
  };
}

/**
 * The certification runtime intentionally owns no Postgres, Redis, Fastify, or
 * in-process worker. It can only exercise a separately deployed, authenticated
 * controlled-staging control plane. This keeps a local test app from being
 * misrepresented as staging certification.
 */
export async function createGateCC5ControlledStagingRuntime(
  input: Readonly<{
    retainedRoot: string;
    environment?: NodeJS.ProcessEnv;
    sourceSha: string;
    lookup?: Lookup;
    requestJson?: JsonRequester;
  }>,
): Promise<GateCC5ControlledStagingRuntime> {
  const environment = input.environment ?? process.env;
  const lookup: Lookup = input.lookup ?? (async (hostname) => dnsLookup(hostname, { all: true, verbatim: true }));
  const requestJson = input.requestJson ?? secureGateCC5JsonRequest;
  const token = required(environment, "GATE_C_C5_IDENTITY_BEARER_TOKEN");
  if (Buffer.byteLength(token, "utf8") < 32) {
    throw new Error("Gate C C5 GATE_C_C5_IDENTITY_BEARER_TOKEN must contain at least 32 bytes");
  }
  if (!/^[a-f0-9]{40}$/u.test(input.sourceSha))
    throw new Error("Gate C C5 controlled staging requires an exact source SHA");
  const componentAttestationSecret = required(environment, "GATE_C_C5_COMPONENT_ATTESTATION_HMAC_SECRET");
  if (Buffer.byteLength(componentAttestationSecret, "utf8") < 32) {
    throw new Error("Gate C C5 component attestation secret must contain at least 32 bytes");
  }
  const faultAttestationSecret = required(environment, "GATE_C_C5_FAULT_ATTESTATION_HMAC_SECRET");
  if (Buffer.byteLength(faultAttestationSecret, "utf8") < 32) {
    throw new Error("Gate C C5 fault attestation secret must contain at least 32 bytes");
  }
  const runId = randomUUID();
  const deploymentId = required(environment, "GATE_C_C5_DEPLOYMENT_ID");
  const buildId = required(environment, "GATE_C_C5_BUILD_ID");
  const probes: Array<[string, URL]> = [
    ["api", await externalHttpsUrl(environment, "GATE_C_C5_API_PROBE_URL", lookup)],
    ["web", await externalHttpsUrl(environment, "GATE_C_C5_WEB_PROBE_URL", lookup)],
    ["worker", await externalHttpsUrl(environment, "GATE_C_C5_WORKER_PROBE_URL", lookup)],
    ["identity", await externalHttpsUrl(environment, "GATE_C_C5_IDENTITY_PROBE_URL", lookup)],
  ];
  if (new Set(probes.map(([, url]) => url.origin)).size !== probes.length) {
    throw new Error("Gate C C5 API, web, worker and identity probes must target distinct deployed origins");
  }
  await Promise.all(
    probes.map(async ([label, url]) =>
      expectHealthy(
        url,
        token,
        label,
        {
          source_sha: input.sourceSha,
          run_id: runId,
          deployment_id: deploymentId,
          build_id: buildId,
          component: label,
        },
        componentAttestationSecret,
        lookup,
        requestJson,
      ),
    ),
  );
  const executors = Object.fromEntries(
    await Promise.all(
      C5_WORKLOAD_OPERATIONS.map(async (operation) => [
        operation,
        operationExecutor(
          await externalHttpsUrl(environment, endpointVariables[operation], lookup),
          token,
          runId,
          input.sourceSha,
          deploymentId,
          buildId,
          componentAttestationSecret,
          lookup,
          requestJson,
        ),
      ]),
    ),
  ) as Record<C5WorkloadOperation, C5WorkloadExecutor>;
  return {
    executors,
    controlledFailureHooks: createGateCC5ControlledStagingFaultHooks({
      retainedRoot: input.retainedRoot,
      sourceSha: input.sourceSha,
      runId,
      deploymentId,
      buildId,
      faultAttestationSecret,
      environment,
    }),
    postgresqlIdentifier: identifier(environment, "GATE_C_C5_POSTGRES_IDENTIFIER"),
    redisNamespace: identifier(environment, "GATE_C_C5_REDIS_NAMESPACE"),
  };
}
