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
