# ADR 0004 — Phase 7 automated-only assurance profile

**Status:** Accepted

**Date:** 8 September 2026

**Applies to:** Gates D and E for the current release cycle

## Context

The project owner cannot execute physical-device or human evidence sessions for this release cycle. Matchday must not fabricate organiser, official, accessibility, tabletop, penetration-test, reviewer, or physical-device receipts.

The current Gate D product candidate is `fd9dabad92484e08534485230dc7d423d6eb1d08`. It has exact-SHA hosted CI success (run `34190555628`) and exact-candidate controlled OCI qualification success (run `34190842572`, retained artifact `10042701736`).

The execution roadmap requires explicit decision records for later scope reductions. This ADR records that decision rather than silently weakening or falsifying evidence.

## Decision

Introduce the assurance profile `automated-only-owner-waived-v1` for Phase 7 Gates D and E.

Under this profile:

1. All machine-verifiable technical requirements remain mandatory. Exact-SHA CI, controlled qualification, migration compatibility, backup/restore automation, security/integration tests, browser E2E, automated accessibility, visual tests, performance budgets, source immutability, evidence integrity, SEO/email automation, authentication, fencing, idempotency, and correctness requirements are not weakened.
2. Human-only or physical-only evidence that cannot be executed is recorded as `WAIVED_NOT_EXECUTED`, never as `PASS`.
3. Automated analogues may support risk reduction but may not be relabeled as the missing human or physical test.
4. A gate may be described as `AUTOMATED-ONLY PASS / HUMAN EVIDENCE WAIVED` once every non-waived technical requirement for that gate is satisfied.
5. This status is not equivalent to the original full-assurance Gate D/E definition and must not be described as real-device, organiser-pilot, national-pilot, independent-pentest, or independent-review validation.
6. Public or release-facing material must disclose the absence of those validations when a reader could otherwise reasonably infer they were performed.
7. Gate F and public production release remain a separate decision point. This ADR does not silently waive legal approval, production operations, or non-human technical launch requirements.

## Waived human/physical evidence

For Gates D/E in this release cycle, the following may be recorded as `WAIVED_NOT_EXECUTED` when they are the only missing evidence:

- human accessibility session;
- physical browser/device matrix beyond automated browser coverage;
- budget Android physical-device session;
- incident-response tabletop;
- event-day support tabletop;
- real local organiser/official pilot;
- real national parallel pilot;
- pilot-specific standings observation;
- organiser intervention log;
- pilot-specific Critical/High defect observation;
- independent human/third-party Gate D/E review;
- independent manual penetration test;
- any equivalent human/physical Phase 7 evidence item that cannot be performed and has no machine-verifiable execution path.

## Evidence semantics

`WAIVED_NOT_EXECUTED` means exactly that the session did not occur. It is not evidence of successful physical-device operation, human usability, organiser independence, independent security review, or real-event reliability.

Automated evidence remains separately auditable and must retain its original name and scope.

## Consequences

This decision allows engineering progression through Gates D and E without inventing receipts, while preserving the risk signal that physical/human validation is absent. It reduces assurance relative to the original roadmap and transfers that risk to the project owner for this release cycle.

## References

- PR #43 owner decision comment: `5584011390`
- Gate D candidate: `fd9dabad92484e08534485230dc7d423d6eb1d08`
- Hosted CI: `34190555628`
- OCI qualification: `34190842572`
- OCI evidence artifact: `10042701736`
