# Auth0 MFA assurance rollout — V2

This document supersedes the earlier single-Action rollout example for the high-assurance path. Keep `IDENTITY_ASSURANCE_POLICY=off` until the application route gate, session replacement, OIDC assurance request, and real Auth0 claims have all passed staging tests.

## Application contract

MATCHDAY accepts authentication assurance only from claims in the ID token already verified by the existing Authorization Code + PKCE flow.

Standard OIDC `amr` containing `mfa` means generic MFA only. It does not prove that the factor was phishing resistant. MATCHDAY's phishing-resistant classification requires both:

1. verified `amr` containing `mfa`; and
2. a namespaced boolean ID-token claim set only after Auth0 reports a completed WebAuthn MFA factor.

Recommended claim:

`https://v1-preview.poladex.shop/claims/phishing-resistant`

Configure the API with the exact same value in `IDENTITY_OIDC_ASSURANCE_CLAIM`.

For any enabled MATCHDAY assurance policy, the application sends Auth0's documented multi-factor authentication context:

`http://schemas.openid.net/pape/policies/2007/06/multi-factor`

as `acr_values` on the authorization request. If authentication freshness is configured, MATCHDAY also sends `max_age` and later verifies the signed `auth_time` claim before granting organiser access.

## Prepare Auth0 while MATCHDAY enforcement is off

1. Keep `IDENTITY_ASSURANCE_POLICY=off` in MATCHDAY.
2. Establish the production Auth0 custom domain first if one will be used. WebAuthn credentials are relying-party-domain sensitive; do not casually move an enrolled production population to a different login domain later.
3. In Auth0 Dashboard > Security > Multi-factor Auth, enable the WebAuthn factors intended for MATCHDAY (`webauthn-platform` and/or `webauthn-roaming`).
4. Enable **Customize MFA Factors using Actions**.
5. Use a tenant MFA policy such as **Always** as a defence-in-depth backup so failure to execute the custom challenge Action does not silently remove MFA.
6. Before using `challengeWith` or `challengeWithAny`, enrol the controlled staging organiser in at least one requested WebAuthn factor. Auth0 fails the authentication transaction if none of the requested factors is both enabled and enrolled.
7. Establish and test a recovery procedure before enforcing WebAuthn. A recovery factor is for account recovery, not an automatic downgrade of the normal phishing-resistant organiser policy.
8. Enrol at least two appropriate authenticators for high-value administrator accounts where operationally practical.

Do not switch MATCHDAY enforcement on merely because Auth0's dashboard shows MFA enabled. The application must prove the resulting signed token evidence.

## Use two ordered Login / Post-Login Actions

Auth0 updates `event.authentication.methods` when an Action begins. After an Action requests an MFA challenge, the flow pauses while the user completes it. The result of that challenge is therefore inspected in the **next** Action.

Place these Actions in this order in the Login flow.

### Action 1 — require MATCHDAY WebAuthn

Scope this Action to the MATCHDAY application client and to authorization requests that asked for the MFA ACR. Replace the placeholder client ID with the reviewed MATCHDAY Auth0 client ID during tenant configuration.

```js
const MATCHDAY_CLIENT_ID = "REPLACE_WITH_REVIEWED_MATCHDAY_CLIENT_ID";
const MFA_ACR = "http://schemas.openid.net/pape/policies/2007/06/multi-factor";

exports.onExecutePostLogin = async (event, api) => {
  const requestedAcrs = event.transaction?.acr_values ?? [];
  const matchdayRequestedMfa =
    event.client?.client_id === MATCHDAY_CLIENT_ID && requestedAcrs.includes(MFA_ACR);

  if (!matchdayRequestedMfa) return;

  api.authentication.challengeWithAny([
    { type: "webauthn-platform" },
    { type: "webauthn-roaming" },
  ]);
};
```

Do not silently fall back from this high-assurance challenge to SMS, email, OTP, or push. If the organiser is not enrolled in an allowed WebAuthn factor, fix enrolment or follow the reviewed recovery procedure.

### Action 2 — stamp signed phishing-resistant evidence

Place this Action immediately after Action 1. It reads the completed factor type now visible in `event.authentication.methods` and stamps the namespaced ID-token claim.

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

MATCHDAY intentionally rejects a token where this claim is `true` but standard verified `amr` does not also contain `mfa`.

## Step-up is a MATCHDAY session replacement

A stronger Auth0 result is not sufficient by itself. The application session must transition as well.

After successful reauthentication in the same browser:

1. create a new opaque MATCHDAY session bound to the newly verified assurance evidence;
2. revoke the valid MATCHDAY session cookie that initiated the reauthentication;
3. replace the browser cookie with the new session cookie only after the server-side transition succeeds;
4. record non-secret audit evidence identifying session IDs, never session tokens;
5. never mutate a low-assurance session row in place to make it privileged.

Other legitimate devices are not automatically revoked by this browser-session replacement. Provider password/session revocation and the existing account/session controls remain separate mechanisms.

## Staging proof before enforcement

Capture no secrets in the evidence. Prove all of the following using a controlled staging account:

1. ordinary login while MATCHDAY policy is `off` receives no accidental elevated assurance;
2. a MATCHDAY authorization request with assurance enabled contains the expected `acr_values` and, if configured, `max_age`;
3. the Auth0 challenge Action runs only for the reviewed MATCHDAY client and requested MFA context;
4. a user without an enrolled requested WebAuthn factor fails closed rather than falling back to a weaker factor;
5. completed WebAuthn MFA produces standard `amr` containing `mfa` and the namespaced phishing-resistant claim set to `true`;
6. generic/non-WebAuthn MFA never sets the phishing-resistant claim to `true`;
7. malformed assurance claims fail authentication;
8. an insufficient organiser session gets `STEP_UP_REQUIRED` once application enforcement is enabled;
9. that same insufficient session can still sign out;
10. defensive rate-limit attribution can still identify a valid low-assurance account without granting organiser access;
11. successful step-up creates a new MATCHDAY session and revokes the displaced browser session;
12. replay of the displaced session cannot regain organiser access, including after returning policy to `off`;
13. WebAuthn satisfies the phishing-resistant organiser policy;
14. non-WebAuthn MFA does not satisfy the phishing-resistant organiser policy;
15. recovery from a lost primary authenticator works without weakening the normal policy;
16. application logs contain no ID token, authorization code, session token, scoring credential, fallback code, or authenticator secret.

## Authentication freshness

Do not enable `IDENTITY_ASSURANCE_MAX_AGE_SECONDS` merely because `auth_time` exists. Prove the complete loop first:

requested `max_age` → provider reauthentication → new verified `auth_time` → new server session binding → displaced-session revocation → stale session rejected.

Only after that proof should authentication-age enforcement be used in a deployed environment.

## Rollout order

1. Keep MATCHDAY policy `off`.
2. Configure Auth0 WebAuthn, recovery, the Actions customization toggle, and the reviewed tenant MFA policy.
3. Enrol the controlled staging organiser in the requested WebAuthn factor(s).
4. Deploy Action 1 followed by Action 2.
5. Prove the real token claims without logging tokens.
6. Run MATCHDAY's organiser assurance boundary tests under the pinned Node/pnpm toolchain.
7. Run the OIDC `acr_values` / `max_age` integration tests.
8. Run the browser-session replacement/replay tests.
9. Remove the temporary startup refusal for non-`off` policies only after steps 1–8 pass.
10. Enable `IDENTITY_ASSURANCE_POLICY=phishing_resistant` in staging and run the full authenticated organiser journey.
11. Test rollback by returning policy to `off` and prove that displaced low-assurance sessions remain revoked.
12. Only then repeat the reviewed configuration in production.

The runtime retains a generic `mfa` policy for controlled compatibility/testing, but the production high-assurance target is WebAuthn-backed `phishing_resistant`. Do not spend V1 effort inventing a provider-specific weaker-factor policy unless a real product requirement justifies that complexity.

## Rollback rule

If assurance enforcement causes an unexpected lockout, set `IDENTITY_ASSURANCE_POLICY=off` and redeploy. Do not weaken CSRF, tenant authorization, OIDC state/nonce/PKCE checks, cookie security, provider issuer validation, session revocation, or scoring controls as a workaround.

## Provider references

During real tenant configuration, verify the current official Auth0 documentation for:

- step-up authentication for web applications and the MFA `acr_values` context;
- `challengeWith` / `challengeWithAny` behavior;
- the rule that challenge results are visible through `event.authentication.methods` in the next Action;
- WebAuthn factor names and enrolment requirements;
- MFA tenant policy and Actions customization settings.

Provider behavior and tenant features can change; the repository runbook is not a substitute for checking the current Auth0 documentation at rollout time.
