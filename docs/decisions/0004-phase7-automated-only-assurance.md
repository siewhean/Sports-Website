# ADR 0004 — Phase 7 automated-only assurance profile

**Status:** Accepted

**Date:** 8 September 2026

**Applies to:** Gates D and E for the current release cycle

## Context

The project owner cannot execute physical-device or human evidence sessions for this release cycle. Matchday must not fabricate organiser, official, accessibility, tabletop, penetration-test, reviewer, or physical-device receipts.

Gate D technical assurance for candidate `fd9dabad92484e08534485230dc7d423d6eb1d08` is already backed by exact-SHA hosted CI run `34190555628` and exact-candidate OCI qualification run `34190842572`.

The execution roadmap permits scope changes only when they are explicit. This ADR records the assurance reduction instead of silently relabelling unperformed human checks as passing evidence.

## Decision

Introduce assurance profile `automated-only-owner-waived-v1` for Phase 7 Gates D and E.

1. Every machine-verifiable technical requirement remains mandatory.
2. Human-only or physical-only requirements that cannot be executed are recorded as `WAIVED_NOT_EXECUTED`, never `PASS`.
3. Automated analogues may reduce risk but may not be represented as the missing human test.
4. Gate status may be described as `AUTOMATED-ONLY PASS / HUMAN EVIDENCE WAIVED` only after every non-waived technical requirement for that gate passes.
5. Full-assurance Gate D/E is not claimed under this profile.
6. Gate F and unrestricted public production remain separate. This ADR does not waive production operations, legal approval, or machine-verifiable launch controls.

## Waived Phase 7 evidence

The following may be marked `WAIVED_NOT_EXECUTED` when no human execution is available:

- human accessibility session;
- physical browser/device matrix beyond automated browser coverage;
- budget Android physical-device test;
- incident-response tabletop;
- event-day support tabletop;
- real local organiser/official pilot;
- real national parallel pilot;
- pilot-specific manual standings observation;
- organiser intervention log;
- pilot-specific Critical/High defect observation;
- independent Gate D/E human review;
- independent manual penetration test.

## Gate E replacements that remain mandatory

The automated-only Gate E profile still requires:

- exact-SHA hosted CI success;
- exact-SHA controlled OCI qualification and Gate D performance budgets still passing;
- QA-024 SLO receipt built from exact-SHA QA-010, QA-011, and result-propagation evidence;
- QA-028 deployed SEO crawl;
- QA-030 SPF, DKIM, DMARC validation plus passing notification template tests in hosted CI;
- automated security evidence including dependency audit, OWASP integration coverage, security-header checks, rate-limit/token tests, and secret scanning;
- Phase 6 legal/privacy implementation and policy package, with formal authorised legal approval still deferred to Gate F by ADR 0003;
- fail-closed Gate E evidence validation bound to one exact candidate SHA.

## Evidence semantics

`WAIVED_NOT_EXECUTED` means the session did not happen. It is not evidence of successful physical-device operation, organiser independence, independent security review, or real-event reliability.

## Consequence

Engineering may progress through Gate E under the reduced assurance profile without inventing receipts. The reduced assurance must remain visible in release evidence until the waived work is actually performed or a later decision supersedes this ADR.
