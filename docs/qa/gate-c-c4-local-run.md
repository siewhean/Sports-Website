# Gate C C4 exact-SHA local evidence

Source SHA: `a2b764f63aaf6c3dc4779a8b2ab78c570981dc8f`

Local Gate C C4 validation: PENDING INDEPENDENT REVIEW

The complete local ledger exited zero on this source: frozen install,
clean-output, format, lint/i18n, typecheck, 1,057 unit tests, migrations
through 0041, backup/restore, real infrastructure integration, OpenAPI, audit,
secret scan, production build and asset checks, generic E2E, accessibility,
visual regression, `git diff --check`, and `pnpm check`.

Browser evidence: generic E2E 337 passed (10 project-applicability skips),
accessibility 94 passed with zero WCAG A/AA violations, and visual 80 passed.
The reported Tablet WebKit move flow passed under its unchanged strict timeout.

The direct uncached C4 journey command then ran twice. Both SHA-bound receipts
name this source, use distinct PostgreSQL schemas and Redis databases 14/15,
prove six browser projects per run, owned Redis keys `0 -> 0`, unrelated guard
preservation, C4 publication linkage, and export/public-truth oracles.

Raw logs and receipts are read-only outside Git. Their hashes and the retained
archive are in [`gate-c-c4-final-evidence.json`](./gate-c-c4-final-evidence.json).

Hosted GitHub Actions: Not executed because the account Actions allowance is
unavailable. Full Gate C remains incomplete.

## Command matrix

| Command                                                                           | Exit | Result                                                     |
| --------------------------------------------------------------------------------- | ---: | ---------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                                  |    0 | Frozen lockfile installed                                  |
| `git diff --exit-code -- pnpm-lock.yaml`                                          |    0 | Lockfile unchanged                                         |
| `pnpm ci:assert-clean-outputs`                                                    |    0 | 14 generated paths absent before build                     |
| `pnpm format:check` / `pnpm lint` / `pnpm typecheck`                              |    0 | Prettier, ESLint/i18n, TypeScript pass                     |
| `pnpm test:unit`                                                                  |    0 | 1,057 passed, 0 failed                                     |
| `pnpm db:migrate:check` / `pnpm backup:verify`                                    |    0 | 42 migrations; restore verified                            |
| `RUN_INFRA_TESTS=1 pnpm test:integration`                                         |    0 | API 113, database 63, scheduler 3 passed                   |
| `pnpm validate:fixtures`, `validate:phase2`, `validate:phase3`, `validate:phase4` |    0 | All validation commands passed                             |
| `pnpm openapi:check`, `dependencies:audit`, `secrets:scan`                        |    0 | Contract current; zero production advisories; zero secrets |
| `pnpm build`, `deploy:manifest`, `asset-delivery:verify:origin`                   |    0 | Production build and 64-origin-asset verification passed   |
| `pnpm test:e2e`                                                                   |    0 | 337 passed; 10 project-applicability skips; 0 failed       |
| `pnpm test:a11y`                                                                  |    0 | 94 passed; zero WCAG A/AA violations                       |
| `pnpm test:visual`                                                                |    0 | 80 passed; 0 failed                                        |
| `git diff --check` / `pnpm check`                                                 |    0 | Source diff check and umbrella gate passed                 |
| direct `pnpm test:e2e:phase4:real`                                                |    0 | Two fresh C4 runs; six browser projects each; 0 failed     |

### Intentional skips

The ten generic-E2E skips are scoped test exclusions: desktop-only and
smaller-screen-only assertions do not execute on incompatible projects, and
the real-C4 API test is intentionally selected only by the dedicated real
runner. They do not skip a required C4 assertion: all four generic projects,
the accessibility and visual matrices, and both six-project real C4 journeys
executed. `pnpm check` also invokes its integration tasks without
`RUN_INFRA_TESTS=1`; those conditional cases are non-acceptance reruns, since
the separately recorded real-infrastructure integration command above passed.
