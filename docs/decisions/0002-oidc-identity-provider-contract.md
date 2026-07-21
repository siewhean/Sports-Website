# ADR 0002 — OIDC Identity Provider Contract

**Status:** Accepted implementation contract; provider selection and live tenant evidence remain pending.

**Date:** 17 July 2026

## Context

FND-005 requires deployable sign-in, sign-out, recovery, session expiry, and account profile behavior. ADR 0001 requires provider issuer/subject identities to map to immutable application accounts without leaking provider SDK types into the domain. The repository previously implemented secure application sessions but deliberately booted an unavailable provider.

## Decision

- The production identity adapter is generic OpenID Connect authorization-code flow with PKCE `S256`.
- The API, not browser JavaScript, creates the PKCE verifier, state, nonce, callback URI, and post-authentication destination.
- A five-minute AES-256-GCM sealed, HttpOnly, SameSite=Lax flow cookie binds state, nonce, verifier, issue/expiry time, and an exact allowlisted return URI to the browser transaction.
- The callback validates state before exchange. The OIDC library validates PKCE, nonce, token signature, issuer, audience, authorised party when applicable, and token times.
- Required application claims are a bounded subject, email, boolean email-verification status, and a safe display-name source. A verified email is required before creating an account.
- Provider claims establish identity only. Organisation, competition, match, and object authorisation remains application-owned.
- The application stores no password, access token, refresh token, or ID token. It issues the existing hashed opaque session after a valid provider exchange.
- Recovery is provider-hosted. OIDC does not define password-reset initiation, so the app redirects to one configured provider URL and never performs an account-existence lookup.
- `disabled` provider mode is permitted only for local/test fixtures. Staging and production configuration is rejected before listen unless a complete OIDC configuration is present.
- Discovery and token calls have bounded timeouts. Invalid discovery or configuration prevents startup; later exchange outages fail closed without invalidating existing application sessions.
- The public direct code-exchange and email-recovery fixtures are registered only in local/test disabled-provider mode, never for an OIDC deployment.

## Security properties

- Callback and post-authentication redirects are exact configured URIs; arbitrary same-origin paths are not trusted.
- Flow and application cookies have no Domain attribute and require Secure. The application session uses `__Host-` with `Path=/`; the callback-scoped flow cookie uses `__Secure-` because `__Host-` would forbid its narrow path.
- Default Fastify request logging is disabled because callback URLs contain one-time codes. Query-free structured route completion logs remain enabled.
- Client secret, flow-seal key, verifier, state, nonce, provider tokens, code, and full email are excluded from configuration summaries, audit payloads, and logs.
- Unexpected provider/protocol state never falls back to a local identity.

## Provider decision still required

Before live acceptance, the owner must select an OIDC provider and create separate staging/production tenants. The decision evidence must confirm issuer, claim availability, hosted recovery, email verification, failed-sign-in lockout, password/passwordless policy, administrator and organiser MFA, back-channel logout or password-change invalidation, data residency, client-secret rotation, and incident revocation.

## Consequences

- A provider can be changed without rewriting internal account, session, membership, or RBAC code.
- Rotating the flow-seal key invalidates only authorization transactions started in the preceding five minutes; application sessions are unaffected.
- Local deterministic exchange fixtures remain useful for domain/API tests but are not evidence of a live provider.
- Phase 1 cannot claim live FND-005 acceptance until staging exchange, recovery delivery, provider security policy, and password-change/session-revocation evidence are recorded.
