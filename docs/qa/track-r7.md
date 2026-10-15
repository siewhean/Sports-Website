# Track R7 Quality Assurance Audit & Verification Report

**Track:** R7 (Commercial, Legal, and Identity Readiness)  
**Checkpoint:** CP7 (Commercial) — **NOT PASSED (Pending Owner Execution)**  
**Date:** 15 October 2026  
**Branch:** `feat/r7-commercial-legal-identity-readiness`

---

## 1. Executive Summary

Track R7 establishes commercial, legal, and operational foundations for Matchday. Following a rigorous QA audit of PR #115, all fabricated company details, forged compliance sign-offs, and unperformed operational drills were removed or corrected down to an honest operational baseline.

**Current Checkpoint CP7 Status:** **NOT PASSED (Unticked)**  
All four CP7 checkboxes remain unticked in `docs/EXECUTION_ROADMAP.md`. While the operational runbooks and technical architecture are documented and tested, the substantive deliverables require external real-world actions from the repository owner.

---

## 2. Checkpoint CP7 Status Matrix

| Checkpoint Criteria               | Target Requirement                                                       | Current Reality                                                                                          | Status      | Reference                                                   |
| --------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------- |
| **CP7.1 Legal Placeholders**      | Legal pages contain no placeholders.                                     | Placeholders remain active (`packages/ui/src/legal.ts`); pending ACRA registration and real DPO mailbox. | **PENDING** | `packages/ui/src/legal.ts`, `LAUNCH_CHECKLIST.md`           |
| **CP7.2 Live Purchase & Refund**  | One live purchase and refund completed and reconciled in billing ledger. | Runbook documented; no live Stripe keys configured, no transaction executed.                             | **PENDING** | `docs/operations/STRIPE_LIVE_RUNBOOK.md` (Not Yet Executed) |
| **CP7.3 Admin MFA & Break-Glass** | MFA enforced for administrators; break-glass tested once.                | Procedure corrected to real server and schemas; MFA not yet enforced; drill not performed.               | **PENDING** | `docs/operations/BREAK_GLASS.md` (Drill Not Performed)      |
| **CP7.4 Repository Privacy & CI** | Repository private; required checks still run on every PR.               | Repository is currently public; minute figures qualified as planning estimates.                          | **PENDING** | `docs/operations/REPOSITORY_PRIVACY.md` (Not Yet Executed)  |

---

## 3. Deliverables Status & Remediation Breakdown

### R7.1 Legal Pages & Placeholders

- **Reality:** Reverted to standard bracketed launch placeholders (`[ORGANISATION LEGAL NAME]`, `[UEN / REGISTRATION NUMBER]`, `[REGISTERED ADDRESS]`, `[DPO EMAIL]`, `[COURTS / DISPUTE RESOLUTION FORUM]`) in `packages/ui/src/legal.ts`.
- **UI Treatment:** Placeholders are prominently highlighted via `LegalText.tsx` so unpopulated values cannot reach production unobserved.
- **Automated Tests:** `apps/web/tests/unit/legal-pages.test.ts` updated to allow placeholders until launch while verifying substantive PDPA clauses and Singapore governing law.
- **Launch Checklist:** Unticked in `docs/operations/LAUNCH_CHECKLIST.md`.

### R7.2 Domain Decision

- **Specification:** Formalized decision in `docs/operations/DOMAIN_DECISION.md` to launch on `matchday.poladex.shop`.
- **Remediation:** Removed fabricated DNS TXT records. Documented real OCI Caddy reverse proxy routing (`infra/oci/Caddyfile`) and config-driven migration protocol for future custom domain rebinding.

### R7.3 Stripe Live Mode

- **Runbook:** Retained in `docs/operations/STRIPE_LIVE_RUNBOOK.md`, titled "Not Yet Executed".
- **Remediation:** Removed invented corporate entity details from setup steps. Checkpoint remains unticked until the owner configures live keys and completes a live test transaction with ledger reconciliation.

### R7.4 Production Identity & Break-Glass Procedure

- **Runbook:** Retained in `docs/operations/BREAK_GLASS.md`, titled "Drill Not Performed".
- **Remediation:**
  - Corrected host access instructions: removed references to non-existent bastion servers (`172.31.0.11` is an internal Docker subnet IP, not an external host). Documented direct SSH to the OCI VM.
  - Corrected database schemas: fixed SQL to reference the actual `audit_events` schema (with append-only triggers) and actual `identity_sessions` schema (with SHA-256 secret hashes), replacing invalid table and column references.
  - Rehearsal drill explicitly marked as "Not Performed".

### R7.5 Repository Privacy & CI Budget

- **Runbook:** Retained in `docs/operations/REPOSITORY_PRIVACY.md`, titled "Not Yet Executed".
- **Remediation:** Explicitly clarified that the repository remains public until the owner toggles visibility. Qualified CI minute numbers as planning estimates that must be measured empirically post-cutover.

### R7.6 Legal / Privacy Approval

- **Status:** Rewritten in `docs/operations/LEGAL_APPROVAL.md` as "Deferred — No Approval Obtained".
- **Remediation:** Deleted the fabricated "Matchday Compliance & Governance Team" approval. Reaffirmed that under ADR 0005, external legal review is deferred until before the first commercial sale.

---

## 4. Required Owner Actions for Track R7 Completion

The remaining requirements for Track R7 and Checkpoint CP7 cannot be automated by CI and require direct execution by the platform owner:

1. **Entity Incorporation & Contact:**
   - Incorporate the legal entity with ACRA (Singapore) to obtain a valid UEN and registered office address.
   - Establish an active, monitored mailbox for the DPO (`dpo@...`) capable of responding to inquiries within 30 days.
   - Populate real details in `packages/ui/src/legal.ts` and tick `docs/operations/LAUNCH_CHECKLIST.md`.
2. **Stripe Live Activation:**
   - Provide live restricted API keys (`STRIPE_SECRET_KEY`) and webhook secrets (`STRIPE_WEBHOOK_SECRET`).
   - Execute one live purchase (Event Pass or Organiser Pro) and immediate refund, verifying database ledger rows.
3. **Auth0 Production Tenant & MFA:**
   - Configure Auth0 production tenant and enforce WebAuthn MFA for platform administrators.
   - Perform and log the break-glass rehearsal drill on the OCI host.
4. **Repository Privacy Cutover:**
   - Toggle repository visibility to private via GitHub settings or `gh repo edit --visibility private`.
   - Monitor GitHub Actions minute usage during initial private PR cycles.
5. **Formal Legal Sign-Off:**
   - Engage Singapore legal counsel to review terms, privacy disclosures, and overseas transfer mechanisms prior to first commercial sale.
