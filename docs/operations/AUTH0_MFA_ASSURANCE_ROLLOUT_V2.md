# Auth0 MFA assurance rollout — V2

This document supersedes the earlier single-Action rollout example for the high-assurance path. Keep `IDENTITY_ASSURANCE_POLICY=off` until the application route gate, OIDC assurance-context request, and real Auth0 claims have all passed staging tests.

## Current application state

MATCHDAY can capture, normalize, and persist verified ID-token assurance evidence. The current security branch deliberately refuses startup when `IDENTITY_ASSURANCE_POLICY` is not `off`, because the central organiser assurance gate is not yet integrated and verified.

Do not remove that startup refusal until the missing gate has tests proving all of these properties:

- low-assurance sessions cannot access the private organiser APIs when stronger assurance is required;
- low-assurance sessions can still sign out and can still be identified for defensive rate limiting;
- successful step-up issues a fresh MATCHDAY application session;
- the displaced lower-assurance session cannot later regain privileged access through replay or policy relaxation.

## Assurance semantics

Standard OIDC `amr` containing `mfa` means generic MFA only. It does not prove that the factor was phishing resistant.

MATCHDAY's phishing-resistant classification requires both:

1. standard verified ID-token `amr` containing `mfa`; and
2. a namespaced boolean ID-token claim set only after Auth0 observed a completed WebAuthn MFA factor.

Recommended claim:

`https://v1-preview.poladex.shop/claims/phishing-resistant`

Recommended application-specific assurance context:

`https://v1-preview.poladex.shop/assurance/phishing-resistant`

For generic MFA, use Auth0's documented multi-factor assurance context where applicable.

## Use two ordered Post-Login Actions

Do not use one Action that starts MFA and immediately assumes the newly completed method is visible in the same execution.

Use two Actions in the Login flow.

### Action 1 — challenge

Inspect the requested assurance context from the transaction and invoke Auth0's current authentication challenge API. For phishing-resistant MATCHDAY access, challenge only supported WebAuthn factors such as platform or roaming WebAuthn. Do not silently downgrade a phishing-resistant request to OTP, SMS, email, or push.

### Action 2 — stamp evidence

Place this Action after the challenge Action. It inspects the authentication methods that Auth0 reports as completed and stamps a namespaced boolean ID-token claim.

```js
const CLAIM = "https://v1-preview.poladex.shop/claims/phishing-resistant";
const STRONG_FACTORS = new Set(["webauthn-platform", "webauthn-roaming"]);

exports.onExecutePostLogin = async (event, api) => {
  const methods = event.authentication?.methods ?? [];
  const phishingResistant = methods.some(
    (method) =>
      method.name === "mfa" &&
      typeof method.type === "string" &&
      STRONG_FACTORS.has(method.type),
  );

  api.idToken.setCustomClaim(CLAIM, phishingResistant);
};
```

MATCHDAY intentionally rejects a token where this claim is true but standard `amr` does not also prove MFA.

## Step-up session transition

The browser receiving a stronger Auth0 result is not sufficient by itself. The application must treat step-up as a session transition.

After successful step-up:

1. create a new opaque MATCHDAY session bound to the new assurance evidence;
2. replace the browser's old session cookie with the new session cookie;
3. revoke or otherwise make the displaced lower-assurance application session incapable of later privileged reuse;
4. preserve a non-secret audit trail of the transition without logging either session token;
5. prove that replaying the displaced session does not recover organiser access, including after a policy change.

Do not mutate an existing low-assurance session row in place to make it privileged. Session rotation keeps the security boundary explicit and gives revocation a clear target.

## Staging proof before enforcement

Capture no secrets in the evidence. Prove all of the following using a controlled staging account:

1. ordinary non-MFA login receives no elevated assurance;
2. generic OTP/push/SMS MFA can satisfy generic MFA but does not set the phishing-resistant claim;
3. completed WebAuthn MFA sets both standard MFA evidence and the namespaced phishing-resistant claim;
4. malformed assurance claims fail closed;
5. an insufficient organiser session gets `STEP_UP_REQUIRED` once the route gate is integrated;
6. that same insufficient session can still sign out;
7. successful step-up rotates the MATCHDAY session;
8. replay of the displaced lower-assurance session does not regain organiser access;
9. WebAuthn satisfies the phishing-resistant organiser policy;
10. non-WebAuthn MFA does not satisfy the phishing-resistant organiser policy;
11. recovery from a lost primary authenticator works without weakening normal policy;
12. application logs contain no ID token, authorization code, session token, fallback code, or authenticator secret.

## Authentication freshness

Do not enable an authentication-age requirement merely because `auth_time` exists. First prove the complete loop:

requested maximum age → provider reauthentication → new verified `auth_time` → new server session binding → displaced-session handling → stale session rejected.

Only after that proof should `IDENTITY_ASSURANCE_MAX_AGE_SECONDS` be used in a deployed environment.

## Rollout order

1. Keep MATCHDAY policy `off`.
2. Configure Auth0 WebAuthn and recovery factors.
3. Deploy the two ordered Auth0 Actions.
4. Prove the real token claims without logging tokens.
5. Integrate and test the central organiser assurance gate.
6. Integrate and test the OIDC assurance-context request (`acr_values`).
7. Integrate and test step-up session rotation/revocation.
8. Remove the temporary startup refusal for non-`off` policies only after steps 1–7 pass.
9. Enable generic MFA in staging and test allowed/denied cases.
10. Enable phishing-resistant policy in staging and test WebAuthn versus non-WebAuthn factors.
11. Test rollback by returning the policy to `off` without changing any other security control, including proof that displaced lower-assurance sessions do not unexpectedly regain privilege.
12. Only then repeat the reviewed configuration in production.

## Rollback rule

If assurance enforcement causes an unexpected lockout, set `IDENTITY_ASSURANCE_POLICY=off` and redeploy. Do not weaken CSRF, tenant authorization, OIDC state/nonce/PKCE checks, cookie security, provider issuer validation, or session revocation as a workaround.

Use current official Auth0 documentation during the real tenant rollout because factor availability and Action APIs are provider configuration that may change over time.
