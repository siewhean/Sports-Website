# CI and releases

## Workflows (`.github/workflows/`)

| Workflow                 | Trigger                               | Purpose                                                                                |
| ------------------------ | ------------------------------------- | -------------------------------------------------------------------------------------- |
| `ci.yml`                 | PR, push to `main`, `v*` tags, manual | secrets scan, quality, integration, sharded browser e2e, Gate D real e2e, image build  |
| `docker-build-check.yml` | PR touching the Dockerfile / lockfile | builds api + web images without pushing; asserts non-root, no toolchain, correct label |
| `dependency-audit.yml`   | weekly + manual                       | `pnpm audit --prod` (removed from the per-push release guard)                          |
| `security-assurance.yml` | PR to `main` (path filtered), manual  | identity/assurance slice                                                               |

Closed-gate workflows live in `.github/workflows-archive/` (see its README). No workflow may use self-hosted runners or
`workflow_run` triggers; `scripts/check-source-contract.test.mjs` enforces this and full-SHA action pinning.

## Images

The `images` job (only on `main` or `v*` tags, after `quality-fast` and `integration`) builds `api`, `web`, `worker`,
`migrate` and `backup` with `docker/build-push-action` and pushes `ghcr.io/<owner>/matchday-<name>:<git sha>`
(plus `:latest` for `main`, `:<tag>` for release tags) with provenance (`mode=max`) and an SBOM. Digests are printed in
the job summary. It is the only job with `packages: write`.

Repository variables (Settings > Secrets and variables > Actions > Variables) are baked into the web image:
`MATCHDAY_PUBLIC_ORIGIN` (required), `NEXT_PUBLIC_MATCHDAY_API_BASE_URL`, `NEXT_PUBLIC_SENTRY_DSN`.
Deploy with `infra/oci/deploy-prod.sh` (pulls by SHA; `--build-locally` is the fallback).

## Browser tests

e2e and a11y run in two shards on Chromium and WebKit only. Visual regression is **non-required**: baselines are
platform specific (`-darwin` / `-linux` suffix) and CI never rewrites them. Until `*-linux.png` baselines are committed
the CI step is a no-op notice. To create them, run `CI` manually (Actions > CI > Run workflow) with
`generate_linux_visual_baselines` ticked, download the `visual-baselines-linux` artifact, review the images and commit
them next to the darwin files. Thresholds are `threshold: 0.2`, `maxDiffPixelRatio: 0.05`.
