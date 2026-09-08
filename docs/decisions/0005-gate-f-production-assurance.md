# ADR 0005 — Phase 8 Gate F production assurance profile

**Status:** Accepted  
**Date:** 8 September 2026  
**Applies to:** Gate F production certification

## Context

Phase 7 successfully completed Gates D and E under ADR 0004 (`automated-only-owner-waived-v1`), which established that non-executable human and physical-device activities must be recorded truthfully as `WAIVED_NOT_EXECUTED` rather than fabricated.

Phase 8 and Gate F require operational readiness (`OPS-001` through `OPS-018`), production simulation, zero-downtime deployment, migration safety, backup/restore, rollback drills, monitoring, and production recertification.

ADR 0003 deferred formal authorised legal/privacy approval to Gate F. In this pre-commercial phase, full external counsel sign-off is scheduled prior to commercial monetization with paying customers. Physical-device testing and external human reviews cannot be executed by the single operator for this release cycle.

## Decision

Introduce assurance profile `automated-only-owner-waived-v2` for Gate F.

1. Every machine-verifiable requirement in `OPS-001` through `OPS-018` is mandatory.
2. Formal authorised legal/privacy approval is recorded as `DEFERRED_TO_FIRST_COMMERCIAL_RELEASE`. All substantive technical privacy controls, terms, policies, export, and deletion capabilities remain mandatory and must pass automated audit.
3. Human-only or physical-only items are explicitly recorded as `WAIVED_NOT_EXECUTED` and never marked as `PASS`.
4. The production candidate must be bound to an exact 40-character Git SHA across hosted CI, OCI production deployment, and all retained operational receipts.

## Waived Gate F Evidence

The following items are recorded as `WAIVED_NOT_EXECUTED`:

- `independent_manual_pentest`
- `independent_gate_f_reviewer`
- `physical_device_matrix_session`
- `human_screen_reader_audit`
- `live_organiser_pilot_observation`

## Legal Disposition

- `formal_authorised_legal_approval`: `DEFERRED_TO_FIRST_COMMERCIAL_RELEASE`
