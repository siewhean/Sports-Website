# Phase 4 final evidence manifest

Status: **PRE-FINAL — BLOCKED**

Local validation: BLOCKED

Hosted GitHub Actions: Not executed because Actions allowance is unavailable

The machine-readable manifest is
[`phase-4-final-evidence.json`](./phase-4-final-evidence.json). It is an honest
pre-final scaffold: required commands, both isolated organiser journeys,
environment versions, test counts, artifact locations, hashes, collection time
and the privacy-safe reviewer label remain pending. It does not inherit PASS
claims or hashes from an older source commit.

Run the fail-closed validator from the repository root:

```sh
pnpm evidence:phase4:validate
```

The command is expected to fail while this scaffold remains `BLOCKED`. The
recorded source commit may be the checked-out commit or an ancestor followed
only by evidence-document commits. This avoids the impossible requirement for a
commit to contain its own SHA without weakening source identity: the validator
rejects every committed or uncommitted path after the recorded source except
the two final-evidence documents, `phase-4-local-run.md` and
`phase-4-verdict.md`.

A final manifest validates only when it:

- identifies a full commit SHA that exists and is an ancestor of the checkout;
- records every required command as executed successfully with zero failed and
  zero skipped checks;
- records distinct PostgreSQL and Redis isolation for two complete real Gate B
  journeys across phone Chromium, tablet WebKit and desktop Chromium;
- includes exact browser and toolchain versions;
- binds every raw command log plus the Playwright report archive, screenshots
  and traces with lowercase SHA-256 digests;
- reports passing accessibility, visual, browser-console and failed-request
  summaries; and
- contains no secret-like field names or credential-shaped values.

Raw artifacts may remain at the ignored local retention location recorded in the
manifest. Only sanitised metadata and hashes belong in Git. Do not record
session material, raw access values, `.env` content, database dumps containing
personal data, or generated credentials.

The visual evidence boundary must remain explicit in the final summary:
demo-backed fixtures provide stable visual regression, while real full-stack E2E
proves persistence and integration. They are complementary evidence, not the
same proof.
