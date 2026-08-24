# Gate C C5 controlled-staging execution

This is an execution runbook, not certification evidence. The repository never
creates a C5 `PASS` record from this document or from the observation benchmark.

## Required resources

- A disposable PostgreSQL database/schema with a principal that may create and
  drop the C5 schema.
- A dedicated Redis namespace and an isolated worker queue.
- A controlled staging API, web process and worker process that the adapter can
  interrupt and recover. Do not point the adapter at production.
- A disposable mounted volume for the disk-pressure drill, a controllable
  network/latency proxy, and approved backup/restore storage.
- The checked-in `gate-c-c5-controlled-staging-runtime.ts` adapter, which has
  no in-process/local fallback. It probes separately deployed API, web, worker
  and identity endpoints, then sends workload invocations only to authenticated
  external control-plane endpoints.
- For every one of the twelve fault names, six executable command variables:
  `GATE_C_C5_<FAULT>_{PRECONDITION,INJECT,DEGRADATION,RECOVER,INVARIANT,CLEANUP}_COMMAND`.
  Each must be an operator-owned program that sends the supplied challenge to
  the staging control plane and prints exactly one signed JSON attestation.
  Plain stdout (including `printf`) is rejected. The runner supplies the exact
  SHA, run/deployment/build IDs, expected component, fault, phase and a fresh
  nonce in `GATE_C_C5_FAULT_*`; the response must bind all of them plus a
  bounded observation. Retained artifacts contain identifiers and SHA-256s of
  nonce/observation/attestation only, never raw command stdout.
- An operator-owned HMAC drill executable outside this checkout. It must run
  both real rate-limit and fallback-code A-to-B lifecycle drills through the
  staging control plane; the normal workload runner cannot supply its receipt.

## Exact command

Run from a clean checkout of the immutable candidate SHA using Node `v24.18.0`
and pnpm `10.33.0`:

```sh
export GATE_C_C5_STAGING_OPT_IN=1
export GATE_C_C5_IDENTITY_BEARER_TOKEN='<32-plus-byte-staging-control-token>'
export GATE_C_C5_COMPONENT_ATTESTATION_HMAC_SECRET='<32-plus-byte-shared-staging-attestation-secret>'
export GATE_C_C5_FAULT_ATTESTATION_HMAC_SECRET='<separate-32-plus-byte-staging-fault-attestation-secret>'
export GATE_C_C5_DEPLOYMENT_ID='dpl_<exact-candidate-staging-deployment>'
export GATE_C_C5_BUILD_ID='<exact-candidate-provider-build-id>'
export GATE_C_C5_API_PROBE_URL='https://<staging-api>/health'
export GATE_C_C5_WEB_PROBE_URL='https://<staging-web>/health'
export GATE_C_C5_WORKER_PROBE_URL='https://<staging-worker-control>/health'
export GATE_C_C5_IDENTITY_PROBE_URL='https://<staging-identity>/me'
export GATE_C_C5_POSTGRES_IDENTIFIER='controlled-staging-postgres-schema-id'
export GATE_C_C5_REDIS_NAMESPACE='matchday:staging:gate-c-c5:<run-id>:'
export GATE_C_C5_SCORE_EVENT_ACK_ENDPOINT='https://<staging-control>/c5/score-event-acknowledgement'
export GATE_C_C5_PUBLIC_CURRENT_ENDPOINT='https://<staging-control>/c5/public-current'
export GATE_C_C5_PUBLIC_CONVERGENCE_ENDPOINT='https://<staging-control>/c5/public-convergence'
export GATE_C_C5_LEASE_TAKEOVER_ENDPOINT='https://<staging-control>/c5/lease-takeover'
export GATE_C_C5_REPAIR_PUBLICATION_ENDPOINT='https://<staging-control>/c5/repair-publication'
export GATE_C_C5_WORKLOAD_PROFILE_JSON='{"profileId":"<approved-id>","durationSeconds":900,"scorekeeperCount":5,"publicReaderCount":10,"organiserWorkerCount":5,"approval":{"owner":"<owner>","approvedAtUtc":"<UTC>","reference":"<approval>"}}'
export GATE_C_C5_MINIMUM_SAMPLES=500
export GATE_C_C5_MAXIMUM_SAMPLES=1000000
export GATE_C_C5_OPERATION_TIMEOUT_MS=30000
export GATE_C_C5_HMAC_DRILL_OPT_IN=1
export GATE_C_C5_HMAC_CONTROL_PLANE_URL='https://<staging-control>/hmac/health'
export GATE_C_C5_HMAC_OPERATOR_TOKEN='<32-plus-byte-staging-hmac-control-token>'
export GATE_C_C5_HMAC_DRILL_RUNNER='/opt/matchday-gate-c-operators/run-hmac-rotation-drill'
pnpm evidence:gate-c-c5:run
```

## Evidence and PASS oracle

Expected ignored artifact root:

`artifacts/qa/gate-c-c5/<exact-source-sha>/certification.json`

and retained logs below:

`artifacts/qa/gate-c-c5/<exact-source-sha>/retained/<fault>/{injection,recovery,cleanup}.log`

and the independently executed HMAC drill output:

`artifacts/qa/gate-c-c5/<exact-source-sha>/hmac-rotation.json`

with its hash-bound retained attestation at
`artifacts/qa/gate-c-c5/<exact-source-sha>/hmac-rotation/drill.log`.

Each deployed component probe must return a signed JSON attestation with the
exact `source_sha`, generated `run_id`, deployment/build IDs and its distinct
component identity. Each operation endpoint must return the same signed
candidate/run/deployment/build provenance alongside its success oracle. The
runner rejects an unsigned response, same-origin component substitution, a
private/DNS-alias target, or an identifier that includes credentials.

The run is eligible for later sealing only when `certification.json` contains a
valid integrated receipt for the exact SHA; each of the five operations has at
least 500 successful samples, zero timeout/unexpected failures, and passes its
budget; all twelve fault receipts prove injection, recovery, cleanup and log
hashes; the HMAC receipt proves A-to-B promotion, overlap verification,
premature-retirement refusal, audited retirement, retired-key rejection and
ambiguity failure for both rate-limit and fallback-code keyrings; and the
adapter has removed all disposable resources. Provider-ready
and physical-device evidence remain separate sealer requirements.
