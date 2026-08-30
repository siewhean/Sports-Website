# ADR 0003 — Defer formal legal and privacy approval to Gate F

**Status:** Accepted

**Date:** 31 August 2026

**Affected frozen product candidate:** `393fdc88348721fc506803b9b452121226aabfe4`

## Context

Phase 6 requires substantive public policies, privacy controls, consent behaviour,
and technical privacy verification. Its earlier certification language also required
a separate authorised legal/privacy approval receipt. The product is not being
represented as ready for unrestricted public paid production release at Phase 6;
that release decision belongs to Gate F.

## Decision

Formal authorised legal/privacy approval is deferred from Phase 6 to Gate F. It is
mandatory before Gate F can pass or Matchday is represented as ready for unrestricted
public paid production release.

## Phase 6 effect

Phase 6 still requires substantive Terms, Privacy, and Cookie policies; implemented
privacy and consent controls; privacy/consent automated tests; independent technical
QA/QC; and zero unresolved P0/P1 privacy implementation defects. The deferred
external approval receipt is superseded for Phase 6 only by this decision.

## Gate F obligation

Gate F requires a dated authorised legal/privacy approval tied to the candidate,
policy revisions, launch jurisdictions, legal entity, provider disclosures, retention
and deletion policy, and public/minor visibility controls.

## Safeguards and consequences

This decision does not assert legal compliance, permit inaccurate policies,
non-consensual optional tracking, or unreviewed material data-category changes. It
does not weaken SEO, accessibility, email-deliverability, SMTP, device/staging, or
independent QA/QC requirements. Formal review must be pulled forward before any pilot
or release that materially changes personal-data processing, involves minors, adds
jurisdictions, or otherwise increases legal/privacy risk.

## Superseded requirement

The Phase 6 requirement for a standalone authorised legal/privacy approval receipt is
superseded only as a Phase 6 closure condition. The requirement remains mandatory at
Gate F under this ADR.
