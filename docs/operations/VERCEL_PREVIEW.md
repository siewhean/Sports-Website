# Vercel web preview

The Next.js app (`apps/web`) is previewed on Vercel (`apps/web/vercel.json`). Production traffic is served from the
OCI VM (see `infra/oci/README.md`); Vercel is the preview and verification surface only. The API, scheduler and worker
no longer run on Render (`render.yaml` was removed).

## API origin

The web deployment owns the only browser-facing HTTPS hostname. Set its server-only `API_ORIGIN` to the HTTPS origin of
the API the preview should use (no path, query, credentials or fragment). The checked-in Next rewrite then proxies only
`/api/v1/*` to it, and the interactive identity routes redirect to it. Set `MATCHDAY_API_BASE_URL` to the same browser
hostname, never to the direct API hostname, so the host-only session cookie survives the OIDC callback and the
organiser BFF.

`RENDER_API_ORIGIN` is the deprecated former name of `API_ORIGIN`. It is still read when `API_ORIGIN` is unset so
existing Vercel projects keep working; rename the variable in the Vercel project settings and then remove the old one.

## Setup checklist

- Set `MATCHDAY_BUILD_ID` for the web deployment so release verification can bind the running origin to the signed-off
  manifest (`scripts/verify-vercel-deployment.mjs`).
- Inject the validated variables from [ENVIRONMENTS.md](ENVIRONMENTS.md) through the provider secret store.
- Keep the API `/health/deep` endpoint private; supply `DEEP_HEALTH_TOKEN` only to the verification path.
- Run `pnpm db:migrate` once as a controlled release action before the API starts; never from the scheduler or worker.
