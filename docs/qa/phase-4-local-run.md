# Phase 4 reproducible local Gate B run

Local validation: PASS

Validated source SHA: `4f9202e4e1c546bfef2a23bcfc7e26825c90b314`

Branch: `fix/gate-b-local-remediation-20260724-132224`

Operating system: Darwin `25.6.0`, arm64

Toolchain: Node `v24.18.0`, pnpm `10.33.0`, PostgreSQL `18.4`, Redis
`8.2.7`, Playwright `1.61.1`, Chromium `149.0.7827.55`, WebKit `26.5`

Evidence location:
`artifacts/qa/gate-b/4f9202e4e1c546bfef2a23bcfc7e26825c90b314/`

## Exact-SHA command ledger

Every required command exited `0`. The schema-v2 manifest records the exact
command, positive millisecond duration, test counts, intentional skips and
SHA-256 of its retained log.

| Check                               | Result | Important count                                |
| ----------------------------------- | ------ | ---------------------------------------------- |
| Frozen install and lockfile         | PASS   | lockfile unchanged                             |
| Format, lint, typecheck             | PASS   | all workspace tasks                            |
| Unit                                | PASS   | 697 tests                                      |
| Migration and backup                | PASS   | 27 migrations; restore verified                |
| Infrastructure integration          | PASS   | API 90/90; database 54/54; all workspace tasks |
| Fixture validators                  | PASS   | Phase 2, Phase 3 and Phase 4                   |
| OpenAPI and dependency audit        | PASS   | no known production vulnerabilities            |
| Secret scan                         | PASS   | no leaks                                       |
| Production build and asset delivery | PASS   | manifest and origin verified                   |
| General E2E                         | PASS   | 278 passed; 9 explained applicability skips    |
| Real Gate B journey                 | PASS   | 2 runs × 3 browser projects                    |
| Accessibility                       | PASS   | 68/68                                          |
| Visual                              | PASS   | 57/57                                          |
| State preservation repeat           | PASS   | 20/20                                          |
| `git diff --check`                  | PASS   | no whitespace error                            |
| `pnpm check`                        | PASS   | complete umbrella command                      |

The umbrella command intentionally runs without `RUN_INFRA_TESTS`, so 99
infrastructure-only cases are reported as applicability skips there. The
canonical `RUN_INFRA_TESTS=1 pnpm test:integration` command separately executed
all 171 infrastructure integration tests at the same source SHA.

## Isolation evidence

Run 1 used a disposable PostgreSQL database and Redis logical DB 14. Run 2 used
a different disposable PostgreSQL database and Redis logical DB 15. Each run
started fresh API, scheduler/worker and production web processes and created
separate competition aggregates for phone Chromium, tablet WebKit and desktop
Chromium.

Both runs:

- refused dirty owned namespaces at startup;
- recorded zero owned keys at startup and shutdown;
- stopped producers before bounded `SCAN` plus `UNLINK`;
- preserved the unrelated near-prefix TTL sentinel;
- passed setup, format, schedule, move, publication, audit and outbox database
  oracles; and
- left no reusable browser storage or generated fixture for the other run.

## Correction trail

The final green result was not obtained by suppressing failures:

- An early evidence runner used a reserved zsh variable and produced no
  acceptance record.
- Commit-hook build output correctly failed the clean-output precondition and
  was removed before a full restart.
- Mailpit absence caused an infrastructure failure; the repository service was
  restored and the full ledger restarted.
- Concurrent full migration chains exposed several 10-second setup-hook
  margins. API integration files and root integration tasks are now serialized;
  four uncached full integration runs passed before the exact-SHA run.
- A duration-provenance defect was fixed so every command must record a
  positive integer `duration_ms`.
- A previous browser attempt exhausted local disk while writing Playwright
  traces. Regenerable caches were removed, Docker was restarted without
  deleting volumes, and the complete exact-SHA ledger was rerun from the
  beginning.

No test, assertion, authorization check, skip gate or dependency audit was
weakened to obtain the result.

## Residual risk boundary

Accepted P2/P3 findings and their owners, rationale and deadlines are recorded
in [`phase-4-verdict.md`](./phase-4-verdict.md).
