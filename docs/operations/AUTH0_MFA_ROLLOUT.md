# Auth0 MFA and WebAuthn rollout

> **Superseded for the high-assurance rollout.** Use `docs/operations/AUTH0_MFA_ASSURANCE_ROLLOUT_V2.md`. The V2 runbook corrects the Auth0 first-login challenge sequencing and keeps enforcement disabled until the organiser assurance gate and OIDC assurance-context request are integrated and tested.

MATCHDAY captures authentication assurance now, but enforcement must stay disabled until the real Auth0 tenant proves the expected signed claims. This runbook is deliberately fail-safe: an existing organiser must not be locked out by deploying the code alone.

## Application contract

MATCHDAY accepts standard OIDC `amr`, `acr`, and `auth_time` only from the verified ID token returned by the existing Authorization Code + PKCE flow.

`amr` containing `mfa` proves generic MFA only. It is **not** sufficient to classify a session as phishing resistant. MATCHDAY requires a second, namespaced boolean ID-token claim for that classification and additionally requires `amr` to contain `mfa`.

Recommended claim name:

`https://v1-preview.poladex.shop/claims/phishing-resistant`

Configure the API with the exact same value in `IDENTITY_OIDC_ASSURANCE_CLAIM`.

## 1. Prepare Auth0 without enabling MATCHDAY enforcement

1. Keep `IDENTITY_ASSURANCE_POLICY=off`.
2. If a production custom Auth0 domain will be used, establish it **before** enrolling production WebAuthn credentials; changing the relying-party domain later can invalidate existing enrolments.
3. In Auth0 Dashboard > Security > Multi-factor Auth, enable an independent factor suitable for recovery and enable WebAuthn security keys and/or device biometrics as supported by the tenant plan.
4. Enrol at least two appropriate authenticators for administrator recovery where operationally possible.
5. Do not make SMS the preferred high-assurance factor.

## 2. Add the Post-Login Action

Create a Login / Post Login Action and attach it to the Login flow. The Action should derive the claim only from authentication methods Auth0 says were completed in this transaction.

```js
const CLAIM = "https://v1-preview.poladex.shop/claims/phishing-resistant";
const STRONG_FACTORS = new Set(["webauthn-platform", "webauthn-roaming"]);

exports.onExecutePostLogin = async (event, api) => {
  const methods = event.authentication?.methods ?? [];
  const phishingResistant = methods.some(
    (method) => method.name === "mfa" && typeof method.type === "string" && STRONG_FACTORS.has(method.type),
  );

  api.idToken.setCustomClaim(CLAIM, phishingResistant);
};
```

The application intentionally rejects an inconsistent token where this custom claim is `true` but standard `amr` does not contain `mfa`.

## 3. Prove the real claims

Use a controlled staging account and inspect the decoded ID-token payload locally without logging or committing the token.

Verify all of the following:

- ordinary non-MFA authentication does not receive elevated assurance;
- generic OTP/push/SMS MFA may produce `amr` containing `mfa`, but the namespaced claim remains false;
- a completed WebAuthn MFA transaction produces `amr` containing `mfa` and the namespaced claim is true;
- malformed or missing assurance claims do not upgrade the MATCHDAY session;
- `auth_time` is present when MATCHDAY sends `max_age` for freshness enforcement.

Never paste real ID tokens, authorization codes, session cookies, or authenticator secrets into tickets, logs, screenshots, or this repository.

## 4. Staged enforcement

1. Deploy with `IDENTITY_ASSURANCE_POLICY=off` and the claim name configured. Confirm normal organiser login still works.
2. Set `IDENTITY_ASSURANCE_POLICY=mfa` in staging. Prove non-MFA sessions receive `STEP_UP_REQUIRED` and MFA sessions work.
3. Test recovery with a lost primary authenticator before proceeding.
4. Set `IDENTITY_ASSURANCE_POLICY=phishing_resistant` in staging. Prove generic MFA is denied while WebAuthn MFA succeeds.
5. Optionally set `IDENTITY_ASSURANCE_MAX_AGE_SECONDS` for a freshness requirement. The application passes this as OIDC `max_age` and rejects sessions whose verified `auth_time` is absent or too old.
6. Only after staging passes should the equivalent production policy be enabled.

## 5. Rollback

If assurance enforcement causes an unexpected lockout, set `IDENTITY_ASSURANCE_POLICY=off` and redeploy. Do not weaken token validation, CSRF, tenant authorization, cookie security, or the Auth0 callback flow as a workaround.

## Acceptance evidence

Before enabling production enforcement, retain non-secret evidence for:

- Auth0 factors/policy configured;
- Post-Login Action deployed to the correct flow;
- WebAuthn login accepted;
- generic MFA rejected by `phishing_resistant` policy;
- non-MFA login rejected by `mfa` policy;
- recovery path tested;
- authentication freshness tested if configured;
- no token or credential material present in application logs.

## References

Use the current official Auth0 documentation for WebAuthn MFA, MFA factors, Post-Login Action `event.authentication.methods`, `api.idToken.setCustomClaim`, and OIDC `max_age` / `auth_time` behavior when performing the rollout.
