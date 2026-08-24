# Gate C external closure commands

This document is an execution runbook, not certification evidence. Do not copy its output into `docs/qa` and do not run the sealer until every artifact below validates for the same immutable candidate SHA.

## C2 controlled staging migration-lock observation

Required resources: an isolated disposable PostgreSQL database with a non-production `DATABASE_URL`, permission to create/drop schemas, and the complete migration history. The database must not share a schema or traffic with production.

```sh
export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"
export GATE_C_C2_CONTROLLED_STAGING=1
export DATABASE_URL='postgresql://.../matchday_gate_c_staging?sslmode=require'
# Default representative profile: 3 competitions, 6 divisions, 72 scheduled
# matches, 1,152 canonical score events, 72 scoring sessions, 6 conflicts.
# Override only when the approved controlled-staging profile requires it.
export GATE_C_C2_FIXTURE_COMPETITIONS=3
export GATE_C_C2_FIXTURE_DIVISIONS_PER_COMPETITION=2
export GATE_C_C2_FIXTURE_MATCHES_PER_DIVISION=12
export GATE_C_C2_FIXTURE_SCORE_EVENTS_PER_MATCH=16
export GATE_C_C2_FIXTURE_SCORING_SESSIONS_PER_MATCH=1
export GATE_C_C2_FIXTURE_RESULT_CONFLICTS_PER_COMPETITION=2
pnpm --filter @matchday/database exec tsx scripts/benchmark-migration-locks.ts
```

Expected artifacts: `artifacts/qa/gate-c-c2/<candidate-sha>/migration-lock-benchmark.json` and the four retained sanitized profile logs under `raw/`, each hash-bound from the benchmark receipt.

PASS oracle: the observation receipt is exact-SHA bound; its explicitly selected profile and observed row counts are representative and recorded; writer traffic performs canonical score appends (not lease-only mutations); every reader/writer outcome, timeout/deadlock, lock and transaction duration, DB metadata/size and sanitized identifier hash is retained; and the preflight-abort plus every disposable schema/migration-directory cleanup outcome is retained. This collector is not a PASS receipt and cannot author Gate C PASS evidence. Until independently reviewed controlled-staging execution demonstrates otherwise, the operational conclusion is **maintenance window plus write drain required**.

## C3 physical-device evidence import

Required resources: one real iOS Safari device and one real Android Chrome device, a single Vercel `READY` deployment of the candidate SHA, its provider build ID, a route manifest approved for that deployment/build/origin, and sanitized traces captured on each device. Browser-emulation descriptors are not physical-device evidence.

```sh
export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"
export CANDIDATE_SHA="$(git rev-parse HEAD)"
pnpm --filter @matchday/api exec tsx scripts/import-gate-c-c3-physical-evidence.ts \
  --sha="$CANDIDATE_SHA" \
  --deployment-receipt=/secure-evidence/vercel-ready.json \
  --route-manifest=/secure-evidence/approved-routes.json \
  /secure-evidence/ios-device.json /secure-evidence/android-device.json
```

Required environment/resources: Node `v24.18.0`, pnpm `10.33.0`; `vercel-ready.json` must identify the exact SHA, `dpl_*` deployment, provider build ID, `READY` state and HTTPS origin; `approved-routes.json` must contain `artifact_kind: gate-c-c3-approved-route-manifest`, that same SHA/deployment/build/origin, and non-empty approved routes. Each device payload must include the source SHA, those same deployment/build/route-manifest identifiers, the eight required scenarios, and raw trace hashes/events.

Expected artifacts: `artifacts/qa/gate-c-c3/<candidate-sha>/physical/{ios,android}/receipt.json`, canonical scenario receipts, and sanitized raw trace files.

PASS oracle: both importer receipts pass `pnpm evidence:gate-c-c3:run`; hashes reopen against retained bytes; each iOS/Android receipt matches the same exact `READY` deployment/build/origin and approved route manifest; all eight scenarios pass exactly once. Failure to meet any condition is `BLOCKED`, never PASS.

## C5 controlled-staging workload and HMAC lifecycle drills

Required resources: a non-production API, web, worker-control and identity deployment; a disposable PostgreSQL schema and Redis namespace behind that deployment; authenticated C5 control-plane endpoints; and an operator-owned executable outside this checkout that runs the real rate-limit and fallback-code A-to-B lifecycle drills. Do not use local Fastify, loopback URLs, production origins, or an in-repository shell wrapper.

```sh
export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"
export CANDIDATE_SHA="$(git rev-parse HEAD)"
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
export GATE_C_C5_WORKLOAD_PROFILE_JSON='<approved 900-second profile JSON>'
export GATE_C_C5_MINIMUM_SAMPLES=500
export GATE_C_C5_MAXIMUM_SAMPLES=1000000
export GATE_C_C5_OPERATION_TIMEOUT_MS=30000
# Set all 72 variables: GATE_C_C5_<FAULT>_{PRECONDITION,INJECT,DEGRADATION,RECOVER,INVARIANT,CLEANUP}_COMMAND
# Each executable must return exactly one signed control-plane JSON attestation
# bound to the supplied SHA/run/deployment/build/component/fault/phase/nonce.
# Arbitrary stdout is rejected and only hashes are retained.
export GATE_C_C5_HMAC_DRILL_OPT_IN=1
export GATE_C_C5_HMAC_CONTROL_PLANE_URL='https://<staging-control>/hmac/health'
export GATE_C_C5_HMAC_OPERATOR_TOKEN='<32-plus-byte-staging-hmac-control-token>'
export GATE_C_C5_HMAC_DRILL_RUNNER='/opt/matchday-gate-c-operators/run-hmac-rotation-drill'
pnpm evidence:gate-c-c5:run
```

Expected artifacts: `artifacts/qa/gate-c-c5/<candidate-sha>/certification.json`, the 36 retained fault logs, and `artifacts/qa/gate-c-c5/<candidate-sha>/hmac-rotation.json` plus its hash-bound `hmac-rotation/drill.log`.

PASS oracle: each of five operations has 500 successful samples, zero timeout/unexpected failures, and its budget; every response has the signed exact SHA/run/deployment/build provenance from its distinct component origin; every fault hook proves precondition, injection, degradation, recovery, invariant and cleanup; and the external HMAC attestation proves new-primary issuance, overlap verification, premature-retirement refusal, audited retirement, retired-key rejection and ambiguity failure for both keyrings. The sealer rehashes all retained bytes.

## Provider deployment evidence

Required credentials: `VERCEL_TOKEN`, `VERCEL_PROJECT_ID`, and `VERCEL_TEAM_ID` for the dedicated staging project.

```sh
export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"
export CANDIDATE_SHA="$(git rev-parse HEAD)"
export VERCEL_TOKEN='...'
export VERCEL_PROJECT_ID='...'
export VERCEL_TEAM_ID='...'
node scripts/verify-vercel-deployment.mjs --sha="$CANDIDATE_SHA"
```

Expected artifact: `artifacts/qa/deployment/vercel-response.json` produced from the live provider API. PASS oracle: provider `READY`, configured project/team and branch, candidate SHA and provider URL all match exactly. Artifact-only or stale provider output is rejected by the sealer.
