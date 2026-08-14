# Auth0 MFA and WebAuthn rollout

> **Superseded. Do not use this document for deployment.**

The authoritative MATCHDAY authentication-assurance rollout procedure is:

`docs/operations/AUTH0_MFA_ASSURANCE_ROLLOUT_V2.md`

The V2 runbook contains the corrected Auth0 challenge sequencing, phishing-resistant-factor classification, staging proof requirements, recovery checks, session-replacement verification, and rollback procedure.

Keep deployed `IDENTITY_ASSURANCE_POLICY=off` until the V2 staging acceptance has been completed against the real Auth0 tenant. Do not copy the historical single-Action examples from earlier revisions of this file.
