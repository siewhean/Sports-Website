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
- An in-repository runtime adapter implementing
  `createGateCC5CertificationRuntime`, including all 12 real hooks and their
  retained sanitised logs. The runner rejects an adapter that merely returns
  narrative receipts.
- For every one of the twelve fault names, three executable command variables:
  `GATE_C_C5_<FAULT>_INJECT_COMMAND`, `_RECOVER_COMMAND`, and
  `_CLEANUP_COMMAND`. Commands must be controlled-staging probes that emit one
  bounded, sanitised assertion line; the adapter refuses missing commands.

## Exact command

Run from a clean checkout of the immutable candidate SHA using Node `v24.18.0`
and pnpm `10.33.0`:

```sh
export GATE_C_C5_STAGING_OPT_IN=1
export DATABASE_URL='postgres://<controlled-staging-db>'
export TEST_REDIS_URL='rediss://<controlled-staging-redis>'
export GATE_C_C5_RUNTIME_MODULE='apps/api/scripts/<approved-staging-adapter>.ts'
export GATE_C_C5_WORKLOAD_PROFILE_JSON='{"profileId":"<approved-id>","durationSeconds":900,"scorekeeperCount":5,"publicReaderCount":10,"organiserWorkerCount":5,"approval":{"owner":"<owner>","approvedAtUtc":"<UTC>","reference":"<approval>"}}'
export GATE_C_C5_MINIMUM_SAMPLES=500
export GATE_C_C5_MAXIMUM_SAMPLES=1000000
export GATE_C_C5_OPERATION_TIMEOUT_MS=30000
pnpm evidence:gate-c-c5:run
```

## Evidence and PASS oracle

Expected ignored artifact root:

`artifacts/qa/gate-c-c5/<exact-source-sha>/certification.json`

and retained logs below:

`artifacts/qa/gate-c-c5/<exact-source-sha>/retained/<fault>/{injection,recovery,cleanup}.log`

The run is eligible for later sealing only when `certification.json` contains a
valid integrated receipt for the exact SHA; each of the five operations has at
least 500 successful samples, zero timeout/unexpected failures, and passes its
budget; all twelve fault receipts prove injection, recovery, cleanup and log
hashes; and the adapter has removed all disposable resources. Provider-ready
and physical-device evidence remain separate sealer requirements.
