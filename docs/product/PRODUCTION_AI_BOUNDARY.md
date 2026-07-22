# Production AI boundary

**Decision date:** 22 July 2026  
**Gate:** Gate B remediation  
**Production mode:** `PHASE4_AI_PROVIDER=disabled`

## Decision

The controlled-staging Gate B release uses the complete deterministic and manual organiser workflow. It does not enable an AI provider in staging or production.

The deterministic `stub` exists only for local tests and the canonical Gate B AI evaluation set. It is not a production model, must not be described as one, and fails startup configuration outside local/test.

## User behavior

When AI is disabled:

- Assisted Setup remains fully usable through structured fields.
- Capacity, format recommendations, validation, scheduling, scoring, and publication remain deterministic.
- No AI action is charged.
- No organiser brief is sent to an external provider.
- A failed or unavailable conversion never blocks manual competition setup.

## Product and marketing constraints

Until a production provider adapter passes its gate:

- Do not promise active production AI conversion.
- Do not describe the deterministic local stub as AI availability.
- Label AI conversion as unavailable where the control is shown in a deployed environment.
- Keep the guided setup path visually primary and complete.

## Activation requirements for a future live provider

A production provider may be added only after all of the following pass:

1. Provider-neutral adapter and explicit configuration.
2. Strict structured-output schema validation.
3. Deterministic business-rule validation of every accepted field.
4. Bounded timeout and retry behavior.
5. No raw organiser brief in audit logs, application logs, analytics, traces, or unapproved provider metadata.
6. Request fingerprinting and safe cache behavior.
7. Exact quota and concurrent-race accounting.
8. Failed and cached requests do not consume allowance.
9. Provider and model version evidence.
10. Cost, latency, outage, and malformed-output monitoring.
11. Prompt-injection and data-exfiltration tests.
12. Complete manual fallback during provider outage.
13. Privacy and product-owner approval.
14. Independent `Verdict: PASS` for the production AI phase.

## Release interpretation

This decision closes the requirement to choose a truthful production AI posture. It does not claim that production AI is implemented.
