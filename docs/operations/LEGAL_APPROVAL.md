# Legal and Privacy Review Status (Deferred per ADR 0005)

**Status:** Deferred — No Approval Obtained  
**Date:** 15 October 2026  
**Track:** R7.6 (Commercial, legal and identity readiness)  
**Governing ADR:** ADR 0005 — Phase 8 Gate F production assurance profile (`docs/decisions/0005-gate-f-production-assurance.md`)  
**Jurisdiction:** Republic of Singapore (Personal Data Protection Act 2012 / PDPA)

---

## 1. Overview & Deferral Rationale

Deliverable R7.6 addresses the requirement for formal legal/privacy approval prior to the first commercial sale.

**ADR 0005** (Accepted, 8 September 2026) is the Gate F production assurance decision. It introduced the assurance profile `automated-only-owner-waived-v2`, under which every machine-verifiable operational requirement (`OPS-001`–`OPS-018`) is mandatory, human-only or physical-only items are recorded as `WAIVED_NOT_EXECUTED` (never `PASS`), and formal authorised legal/privacy approval is recorded as **`DEFERRED_TO_FIRST_COMMERCIAL_RELEASE`**. The substantive technical privacy controls, terms, policies, export and deletion capabilities remained mandatory under that profile. ADR 0005 does not itself grant or waive legal approval; it defers it, so external counsel sign-off is still required before the first commercial sale / customer monetisation.

**Current Status:**

- **No legal or privacy approval has been obtained.**
- No formal legal review has been conducted by qualified Singapore legal counsel.
- The platform does not have an internal "Matchday Compliance & Governance Team".
- Placeholders remain in place on legal pages (`/terms` and `/privacy`).

---

## 2. Platform Compliance Architecture (Technical Baseline Only)

While legal approval has not yet been obtained, technical privacy foundations have been developed in code:

| PDPA Area                         | Technical Implementation                                                                                | Automated Test / Code Reference                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| **Consent & Notification**        | Explicit consent banners and highlighted placeholders for unpopulated entity details.                   | `apps/web/app/privacy/page.tsx`, `LegalText.tsx`         |
| **Access & Portability**          | Machine-readable JSON export of account data.                                                           | `apps/api/tests/integration/account-data-rights.test.ts` |
| **Erasure & Anonymization**       | Irreversible account deletion confirmed via exact phrase `DELETE MY ACCOUNT`.                           | Tested in `apps/api` and `apps/web`                      |
| **Retention Limitation**          | Advisory-locked purge job for expired sessions, notifications, and transient records.                   | Migration `0069_pdpa_retention.sql`, `retentionSchedule` |
| **Overseas Transfer Disclosures** | Explicit disclosure of US hosting and SaaS vendors (Auth0, OCI Phoenix, Vercel, Sentry, Stripe, Resend) | `packages/ui/src/legal.ts`                               |

These technical mechanisms do **not** constitute legal approval or legal compliance certification.

---

## 3. Requirements Prior to First Commercial Sale

Before accepting payments from any real customer or organiser, the repository owner must:

1. **Incorporate / Register Legal Entity:** Register the business entity in Singapore with ACRA and obtain a valid Unique Entity Number (UEN).
2. **Establish Real Contact Channels:** Set up a functioning mailbox for DPO and customer support that can reliably receive and respond to inquiries within statutory PDPA timeframes (30 days).
3. **Engage Qualified Legal Counsel:** Retain qualified Singapore legal counsel to review the Terms of Service, Privacy Policy, and Sub-Processor Data Processing Agreements (DPAs).
4. **Obtain Written Legal Sign-Off:** Record formal written sign-off from legal counsel.
5. **Update Production Legal Pages:** Replace all `[PLACEHOLDER]` tokens in `packages/ui/src/legal.ts` with real legal particulars and verify them in production.

---

## 4. Certification Status

- [ ] Legal entity registered with ACRA (UEN issued)
- [ ] Working DPO mailbox active and monitored
- [ ] Formal legal review conducted by qualified counsel
- [ ] Formal legal approval signed off prior to first sale
- [ ] Legal placeholders in `packages/ui/src/legal.ts` replaced with real details
