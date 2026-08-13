# MATCHDAY Security Policy

MATCHDAY treats organiser access, scoring authority, competition integrity, tenant isolation, and private operational data as security-sensitive boundaries.

This policy is a development and release requirement. It is not a claim that the application is invulnerable or that it is certified to a banking or regulatory standard.

## Supported security target

The active V1 security target is `v1/simple-working-product`.

For the web application and API, the verification baseline is OWASP ASVS 5.0.0 Level 2, with Level 3-style controls applied to privileged authentication, secrets, scoring authority, and high-impact organiser actions where practical.

## Non-negotiable invariants

- Deployed environments use OIDC only. No demo, test, direct-exchange, or authentication-bypass path may be enabled outside local/test.
- Privileged organiser access must use multi-factor authentication. The target for production is phishing-resistant WebAuthn/passkey or security-key authentication through the identity provider, with application-side assurance verification for privileged actions.
- Successful authentication step-up must issue a fresh application session. A displaced lower-assurance session must not become privileged through replay, policy relaxation, or browser-cookie reuse; its revocation/expiry behavior must be explicitly tested before assurance enforcement is enabled.
- Every private competition read or mutation re-authorizes the authenticated account against an active organisation membership on the server. Client-supplied organisation, competition, division, match, or role identifiers are never authorization evidence.
- Browser mutations require same-origin protection and CSRF protection where cookie authentication is used.
- Session, OIDC-flow, and scoring credentials are never stored in browser localStorage, rendered into pages, written to application logs, or persisted in plaintext server-side.
- Session and scoring cookies are host-only, HttpOnly, Secure in deployed environments, and use an appropriate SameSite policy.
- Pre-authentication rate limits use only trusted server-derived identity such as the authenticated account or peer address. Unauthenticated client headers must not select a rate-limit bucket.
- Scoring access codes and tokens are rate-limited, short-lived, scoped to the intended competition/match, and verified server-side before any scoring authority is granted.
- Non-public identity, organiser, scheduling, access-pass, and scoring responses use private/no-store caching.
- Interactive API documentation and detailed dependency diagnostics are not exposed in deployed environments without an explicit protected operational need.
- Secrets are supplied by deployment secret stores and never committed. Production/staging secrets must be distinct where the code supports independent keys.
- Unexpected server failures return generic client errors. Authentication codes, tokens, cookies, database credentials, Redis credentials, and raw OIDC callback URLs must not enter logs or telemetry.
- Public user-controlled text is rendered through framework escaping. Raw HTML execution, dynamic code evaluation, user-controlled command execution, and user-controlled outbound network destinations require an explicit security review before introduction.
- Security headers must include CSP, anti-framing protection, nosniff, restrictive permissions policy, referrer policy, and HSTS for deployed HTTPS surfaces.
- CI workflow actions that execute third-party code are pinned to reviewed immutable commit SHAs; mutable major-version tags alone are not sufficient for security-sensitive release workflows.

## Release security checks

Before an internet-facing production release:

1. Run formatting, lint, typecheck, unit and integration tests for all changed security boundaries.
2. Run the production dependency audit and secret scan defined by the repository scripts.
3. Verify the production-equivalent deployment, not only a frontend preview.
4. Confirm identity-provider MFA/passkey policy and privileged authentication assurance.
5. Confirm database, Redis, telemetry, queue, and identity-provider connections use approved protected transport and least-privilege credentials.
6. Confirm debug/documentation/deep-health surfaces are inaccessible from public ingress unless explicitly protected.
7. Review open security findings. No known Critical or High finding may ship; Medium findings require an explicit risk decision and compensating controls.
8. Complete an independent penetration test before describing the service as high-assurance or bank-grade.
9. Re-run the threat model after material changes to authentication, scoring authority, multi-tenancy, public sharing, uploads, payments, third-party integrations, or infrastructure.

## Vulnerability reporting

Do not publish credentials, session material, scoring codes, exploit payloads, or sensitive vulnerability details in public channels.

For this private repository, report suspected vulnerabilities privately to the repository owner/maintainers with:

- affected revision and environment;
- affected route/component;
- security impact and required attacker capabilities;
- minimal reproduction steps;
- evidence with secrets redacted;
- suggested mitigation if known.

Rotate or revoke any credential that may have been disclosed before continuing investigation.

## Security changes

Security fixes should be isolated on a short-lived branch, include a regression test for the broken security property when feasible, and remain unmerged until the relevant tests/builds have actually run. A frontend deployment check is not sufficient evidence for an API or database security change.
