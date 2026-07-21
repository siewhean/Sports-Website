# Identity provider operations

The API supports a confidential OIDC authorization-code client. This runbook configures and verifies it without making a vendor-specific assumption.

## Tenant and client setup

Create separate staging and production provider tenants or projects. For each environment:

1. Register a confidential web client using authorization code and PKCE `S256`; disable implicit and password grants.
2. Register exactly the value of `IDENTITY_OIDC_CALLBACK_URI`. Its path must be `/api/v1/identity/callback`.
3. Enable `openid email profile` and ensure the ID token supplies `sub`, `email`, `email_verified`, and either `name` or `preferred_username`. Supply `sid` when provider-session-specific revocation is required.
4. Configure the provider-hosted reset/passwordless page and record its exact URL as `IDENTITY_HOSTED_RECOVERY_URL`.
5. Configure verified-email enforcement, credential-stuffing protection, failed-sign-in lockout, password/passwordless policy, administrator MFA, and the approved organiser MFA policy.
6. Configure the provider automation or a narrow bridge to send the signed event contract below on every password change and provider session revocation.
7. Set `IDENTITY_COOKIE_SITE` to the scheme plus registrable-domain boundary shared by the credentialed frontend and API, such as `https://matchday.example`. Typed startup validation rejects a callback, allowed frontend origin, or post-auth destination outside that boundary, because `SameSite=Strict` application cookies would not work cross-site.
8. Put the client secret, CSRF HMAC secret, independently generated flow-seal key, and dedicated provider-event HMAC secret in the deployment secret store. Never put them in the web environment, source, image, logs, or support tickets.

The issuer string must be copied exactly from the provider discovery document. A trailing slash is significant; do not add or remove it manually.

## Deployment checks

Before promotion:

- Run typed configuration validation. Staging/production must refuse `IDENTITY_PROVIDER=disabled` or incomplete OIDC values.
- Confirm discovery issuer equality and HTTPS authorization, token, and JWKS endpoints.
- Confirm `/api/v1/identity/authorize` redirects only to the provider and writes a five-minute HttpOnly SameSite=Lax flow cookie.
- Confirm a valid callback writes `__Host-matchday_session`, clears callback-scoped `__Secure-matchday_oidc`, and redirects only to an exact configured destination.
- Reject missing, expired, or tampered flow cookies; state/nonce mismatch; reused authorization codes; invalid signature/issuer/audience/time; and unverified email for a new account. The encrypted flow cookie is stateless and is not itself a replay ledger; replay resistance relies on its short expiry, state/nonce binding, callback-scoped deletion, and the provider's single-use authorization code. Do not claim independent one-time-cookie enforcement.
- Confirm direct `POST /api/v1/identity/sign-in` and email `POST /api/v1/identity/recovery` return 404 in the OIDC environment.
- Confirm hosted recovery renders the same response for existing and unknown accounts and that a real recovery message is delivered.
- Confirm callback codes, cookies, tokens, verifier, nonce, state, client secret, and full email do not appear in application, ingress, CDN, trace, error-tracker, or audit records.
- Change a test user's password or revoke its provider session and prove all mapped application sessions are invalidated before production acceptance.

## Signed provider event contract

The exact endpoint is `POST /api/v1/identity/provider-events`. It is a server-to-server endpoint; never call it from the browser. Send JSON with:

- `event_id`: a new UUID retained as the durable replay receipt.
- `type`: `password_changed` or `session_revoked`.
- `issuer`: the exact configured OIDC issuer.
- `subject`: required for `password_changed`; for `session_revoked`, send exactly one of `subject` or `provider_session_id`.
- `provider_session_id`: the OIDC `sid` for session-scoped revocation.
- `occurred_at`: RFC 3339 timestamp no more than five minutes from API time.

Compute `x-matchday-provider-signature` as `sha256=<base64url HMAC-SHA256>` using `IDENTITY_PROVIDER_EVENT_HMAC_SECRET`. The signed bytes are the length-prefixed canonical fields produced by `providerEventSigningInput` in `apps/api/src/identity-provider-events.ts`; the provider bridge must implement that fixture exactly. A valid event receives invariant `202 {"accepted":true}`. Invalid, stale, wrong-issuer, or wrongly shaped events receive `401`; duplicate UUIDs receive `202` without another revocation or audit. Revocation, the replay receipt, every affected application-session audit, and the provider-event audit commit in one database transaction.

## Rotation and incident response

- Rotate an OIDC client secret using provider overlap: add the new secret, deploy it, verify sign-in, then revoke the old secret.
- Rotate `IDENTITY_FLOW_SEAL_KEY` by deploying a new 32-byte value. In-flight sign-ins may retry; existing app sessions remain valid.
- Rotate `IDENTITY_CSRF_HMAC_SECRET` only with an explicit plan because current CSRF tokens will change while sessions remain present.
- Rotate `IDENTITY_PROVIDER_EVENT_HMAC_SECRET` with a coordinated bridge/API deployment. There is currently one active key, so an uncoordinated rotation makes valid revocation events fail closed.
- On provider compromise, disable new authorization at ingress, revoke the provider client, revoke affected application sessions, rotate all identity secrets, preserve PII-safe audit evidence, and re-enable only after issuer/JWKS/client verification.

## Rollback

Rollback restores the previous application image and its compatible secret set. Never set staging or production to `disabled` as a rollback; that configuration is intentionally rejected. If the provider is unavailable, existing sessions continue under their application expiry while new sign-in fails closed.

## Evidence boundary

Repository tests prove protocol, issuer/subject and issuer/`sid` mapping, signed revocation, replay receipt, atomic audit, and application behavior against deterministic/local OIDC fixtures. A real provider tenant, credentials, hosted recovery email, MFA/lockout configuration, deployed event bridge, and observed password-change delivery are external release evidence and must be recorded separately.
