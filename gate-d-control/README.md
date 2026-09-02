# Gate D evidence control plane

This branch is evidence-only for the frozen candidate:

`06f1acd6a90775f92d5b5c260c5545fc81c2470d`

Do not merge evidence commits into the candidate branch. The application candidate remains `phase-7/release-hardening` at the SHA above; `gate-d/candidate-06f1acd6` is the frozen reference.

## Already satisfied

- Hosted CI run `33653457048`: PASS
- `secrets`: PASS
- `quality-fast`: PASS
- `integration`: PASS
- `browser-e2e` including a11y and visual: PASS
- `gate-d-real-e2e`: PASS
- Exact Vercel candidate deployment: READY (`artifacts/gate-d-web-deployment.json`)

## Controlled staging

Provision an isolated Gate D Render API/scheduler/worker deployment from the frozen candidate, with a dedicated PostgreSQL database and Redis namespace. The deployment API must return the exact candidate SHA from `/api/v1/meta/build`.

The operator machine needs only the controlled resource URLs/credentials; no scoring token is supplied manually. The seeder creates a one-time scoring handoff and the QA-011 runner deletes it.

```bash
export CANDIDATE_SHA=06f1acd6a90775f92d5b5c260c5545fc81c2470d
export TARGET_URL=https://<controlled-gate-d-api>
export DATABASE_URL='postgres://<isolated-gate-d-db>'
export REDIS_URL='rediss://<isolated-gate-d-redis>'

bash gate-d-control/run-controlled-staging.sh
```

The runner:

1. checks out the exact candidate in a detached temporary worktree;
2. verifies `/api/v1/meta/build` equals the candidate SHA;
3. runs `seed:staging:pilot` against the isolated database/Redis and deployed API;
4. captures the single-use QA-011 scoring handoff without retaining it in repository artifacts;
5. runs real staging QA-010, QA-011 scoring writes, and QA-011 result propagation;
6. requires the scoring handoff file and parent directory to be deleted;
7. runs `evidence:gate-d:verify`;
8. copies only sanitized validated receipts back into this evidence branch working tree.

After a successful run, review and commit only:

- `artifacts/staging-pilot-seed.json`
- `artifacts/qa-010-load-public-summary.json`
- `artifacts/qa-011-load-scoring-summary.json`
- `artifacts/qa-011-result-propagation-summary.json`
- `artifacts/gate-d-staging-run.json`

Never commit the temporary `scorekeeper-access.json` handoff.

## Human / pilot evidence still required

Update `artifacts/gate-d-certification.json` only from actual retained evidence. Every item must remain `PENDING` until the session is completed and has a controlled evidence reference:

- accessibility human audit;
- physical browser/device matrix;
- budget Android scoring session;
- incident-response tabletop;
- event-day-support tabletop;
- realistic restore drill;
- deployed SEO crawl;
- closed local pilot;
- manual standings-oracle comparison;
- organiser intervention log;
- zero open Critical/High pilot defects;
- independent reviewer verdict exactly `PASS`.

When all staging receipts and human evidence exist, run from a checkout that contains the evidence artifacts:

```bash
CANDIDATE_SHA=06f1acd6a90775f92d5b5c260c5545fc81c2470d \
GATE_D_CERTIFICATION_FILE=artifacts/gate-d-certification.json \
node scripts/validate-gate-d-freeze.mjs
```

Only `GATE D FREEZE CERTIFICATION VERIFIED` permits Gate D freeze/merge. Any candidate code change resets the cycle to a new exact SHA.
