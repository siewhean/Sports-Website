# Local preparation QC

## Performed in the preparation environment

- Audited the synced five sport packs.
- Audited the Canoe-Polo-specific web transport and scorekeeper boundary.
- Strict TypeScript checks used TypeScript 5.8.3 with `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- Compiled runtime smoke tests covered all five sports.
- Reducer scenarios covered period skipping, premature deciding set, post-retirement scoring, exceptional-outcome reversal, completion audit history and non-current-segment events.
- Sequential `git apply --check` passed for all four patches.
- `git diff --check` passed after every simulated application.
- All shell scripts passed `bash -n`.

## Not performed in that environment

- The repository's Node 24.18.0/pnpm 10.33.0 commands.
- Actual monorepo TypeScript 5.9.3 checks.
- Repository Vitest suites.
- PostgreSQL/Redis integration.
- Next production build.
- Playwright, accessibility or visual review.
- Git commits on the user's implementation branch.

Each pack's validation script must pass locally before its corresponding commit is accepted.