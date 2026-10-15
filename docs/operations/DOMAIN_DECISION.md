# Operations Decision — Launch Domain Specification

**Status:** Accepted  
**Date:** 15 October 2026  
**Track:** R7.2 (Commercial, legal and identity readiness)  
**Applies to:** Production deployment, DNS, OIDC, SMTP, and ingress

---

## 1. Context

Deliverable R7.2 requires a formal decision on whether to launch on `poladex.shop` (`matchday.poladex.shop`) or transition to a dedicated custom domain prior to commercial release.

As documented in `docs/EXECUTION_ROADMAP.md` (§6, §7, and §9), the platform infrastructure, host environment, and OAuth application clients are provisioned under `poladex.shop`.

---

## 2. Decision

**The platform will launch on `matchday.poladex.shop`.**

### Rationale:

1. **Config-Driven Architecture:** All application origins, API routes, OIDC redirect URIs, and cookie domain scopes are strictly configuration-driven across `packages/config/src/index.ts`, `apps/web`, and `apps/api`. No domain names are hardcoded in application logic.
2. **Immediate Infrastructure Readiness:** `matchday.poladex.shop` is wired to the OCI Caddy reverse proxy and web BFF configurations.
3. **Seamless Future Migration:** When a dedicated brand domain is acquired (e.g. `matchday.sport`), the transition can be executed purely via environment variable configuration, DNS cutover, and OIDC client updates without code modifications or database schema migrations.

---

## 3. Production Configuration Bindings Matrix

| Component / Variable                    | Production Setting                                        | Purpose                                                       |
| --------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------- |
| **`OCI_PUBLIC_HOSTNAME`**               | `matchday.poladex.shop`                                   | Hostname routed by Caddy reverse proxy on OCI                 |
| **`MATCHDAY_PUBLIC_ORIGIN`**            | `https://matchday.poladex.shop`                           | Canonical web frontend origin, metadata baseUrl, CSP          |
| **`NEXT_PUBLIC_MATCHDAY_API_BASE_URL`** | `https://matchday.poladex.shop/api`                       | Web client API base URL                                       |
| **`IDENTITY_COOKIE_SITE`**              | `https://matchday.poladex.shop`                           | Scheme + site boundary for `SameSite=Strict` cookies          |
| **`IDENTITY_OIDC_CALLBACK_URI`**        | `https://matchday.poladex.shop/api/v1/identity/callback`  | OIDC authorization code exchange callback                     |
| **`IDENTITY_OIDC_ASSURANCE_CLAIM`**     | `https://matchday.poladex.shop/claims/phishing-resistant` | WebAuthn phishing-resistant MFA assertion claim               |
| **`SMTP_FROM`**                         | `Matchday <no-reply@matchday.poladex.shop>`               | Transactional email sender (via the configured SMTP provider) |

Note: `IDENTITY_OIDC_ASSURANCE_CLAIM` is not part of the typed `@matchday/config` schema; it is read directly from `process.env` in `apps/api/src/main.ts`, which rejects any value that is not a namespaced HTTPS URI at boot. `SMTP_FROM` defaults to `Matchday <no-reply@${OCI_PUBLIC_HOSTNAME}>` in `infra/oci/.env.prod.example`.

---

## 4. Ingress & TLS Architecture

### 4.1 Ingress Routing (`infra/oci/Caddyfile`)

Caddy operates as the edge reverse proxy on the OCI host, terminating TLS and routing requests to internal containers on the `matchday-prod_backend` bridge network:

```caddy
{$OCI_PROD_HOSTNAME} {
  encode gzip zstd
  @privateHealth path /health/deep /health/deep/*
  handle @privateHealth {
    respond 404
  }
  @api path /api/v1/* /health/live /health/ready /health/version /openapi.json /docs /docs/*
  handle @api {
    reverse_proxy 172.31.0.11:4000 {
      trusted_proxies 172.31.0.12
    }
  }
  handle {
    reverse_proxy 172.31.0.12:3000
  }
}
```

### 4.2 DNS & Certificate Requirements

Prior to launching production traffic:

- An **A record** for `matchday.poladex.shop` must point to the OCI VM public IP address so Caddy can obtain an automated Let's Encrypt / ZeroSSL TLS certificate via HTTP-01 challenge.
- Email records (SPF / DKIM TXT records) will be configured in DNS based on the production email delivery provider setup.

---

## 5. Future Custom Domain Rebinding Runbook

When rebinding to an alternative domain (e.g., `app.matchday.sport`):

1. **DNS Provisioning:** Create A/AAAA records for new domain pointing to OCI ingress IP.
2. **Email Verification:** Complete SPF/DKIM verification for new sender domain in the email provider.
3. **Auth0 Client Update:** Add `https://<new-domain>/api/v1/identity/callback` and `https://<new-domain>` to Allowed Callback URLs, Allowed Logout URLs, and Allowed Web Origins.
4. **Environment Deployment:** Update `OCI_PROD_HOSTNAME`, `MATCHDAY_PUBLIC_ORIGIN`, and `IDENTITY_COOKIE_SITE` in `infra/oci/.env.prod`.
5. **Caddy Reload:** Restart or reload the Caddy container to acquire new TLS certificates.
6. **Graceful Redirection:** Retain 301 permanent redirects from `matchday.poladex.shop` to `<new-domain>` for 180 days.
