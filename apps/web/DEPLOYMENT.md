# V1 web deployment marker

This file intentionally lives inside the Vercel web project so a production rebuild can be triggered after a provider-side skipped/rate-limited deployment without changing application runtime behavior.

The V1 production branch is `v1/simple-working-product`.

Latest verified acceptance: direct Format readiness, all-field draft persistence, signed-in home state, schedule generation/move/publish, scoring/correction, knockout advancement and public results passed on 2026-08-14.

Production deployment retry: accepted V1 Format readiness merge after provider cooldown.

V2 production deployment trigger: deploy the certified `main` application tree (`f62c689d647a6d0bd68e4d87da45109308b4c49e`) on 2026-08-19; documentation-only marker, no runtime behavior change.
