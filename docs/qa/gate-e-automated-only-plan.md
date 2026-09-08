# Gate E — Automated-Only Execution and Certification Plan

**Assurance profile:** `automated-only-owner-waived-v1`  
**Decision:** ADR 0004  
**Release checkpoint:** Phase 7 Gate E

This plan implements every Gate E task that can be executed without a human or physical-device session. Human-only work is never relabelled as passing evidence; it is retained as `WAIVED_NOT_EXECUTED` under ADR 0004.

## Gate E task matrix

| Requirement | Automated implementation | Gate E disposition |
| --- | --- | --- |
| QA-020 national parallel pilot | Exact-SHA OCI full-stack qualification remains mandatory; real national competition event | `WAIVED_NOT_EXECUTED` for the human event |
| QA-021 standings comparison | Existing deterministic manual-oracle unit coverage remains mandatory in hosted CI | automated coverage retained; live observation waived |
| QA-022 intervention log | No synthetic organiser interventions may be invented | `WAIVED_NOT_EXECUTED` |
| QA-023 Critical/High pilot defects | Hosted CI, automated security/e2e/load failures remain fail-closed | pilot-specific human observation waived |
| QA-024 SLO validation | `scripts/run-gate-e-slo-audit.mjs` composes exact-SHA QA-010, QA-011 and QA-011-RP receipts | mandatory `PASS` |
| QA-027 legal review package | `scripts/run-gate-e-legal-audit.mjs` validates policy source and ADR 0003 | technical package mandatory; authorised approval deferred to Gate F |
| QA-028 SEO audit | `scripts/run-gate-e-seo-audit.mjs` crawls deployed exact-SHA web origin, robots and sitemap | mandatory `PASS` |
| QA-029 penetration test | `scripts/run-gate-e-security-audit.mjs`, hosted OWASP/integration/rate-limit/token tests and dependency audit | automated scope mandatory; independent manual pentest waived |
| QA-030 email deliverability | `scripts/run-gate-e-email-audit.mjs` verifies SPF/DKIM/DMARC; hosted notification tests verify templates/SMTP composition | mandatory `PASS` |
| Independent Gate E review | No reviewer identity or verdict may be fabricated | `WAIVED_NOT_EXECUTED` |

## Required final evidence

The exact Gate E candidate must retain:

- `artifacts/qa-010-load-public-summary.json`
- `artifacts/qa-011-load-scoring-summary.json`
- `artifacts/qa-011-result-propagation-summary.json`
- `artifacts/gate-e-slo-validation.json`
- `artifacts/gate-e-seo-audit.json`
- `artifacts/gate-e-email-deliverability.json`
- `artifacts/gate-e-security-automation.json`
- `artifacts/gate-e-legal-package.json`
- `artifacts/gate-e-certification.json`

Final validation command:

```bash
node scripts/validate-gate-e-automated.mjs <EXACT_GATE_E_SHA>
```

Required success string:

```text
✓ GATE E AUTOMATED-ONLY CERTIFICATION VERIFIED
```

## Non-negotiable technical requirements

- exact candidate SHA must match hosted CI, web build ID, API build metadata and all retained load receipts;
- QA-010 2x p95 `<2500ms` and error rate `<=0.1%`;
- QA-011 2x p95 `<500ms` and error rate `<=0.1%`;
- result propagation p95 `<2000ms` and error rate `<=0.1%`;
- dependency audit must pass at `moderate` severity threshold;
- hosted secrets, unit, integration, browser, accessibility, visual and Gate-D-real-E2E suites remain green;
- deployed security headers must meet the Gate E automated audit;
- SEO routes, robots and sitemap must pass against the exact web build;
- SPF, DKIM and DMARC must resolve for the configured sending domain;
- legal/privacy policy source must remain substantive, with formal authorised approval explicitly deferred to Gate F.

## Release semantics

A successful run may be called **`AUTOMATED-ONLY GATE E PASS / HUMAN EVIDENCE WAIVED`**. It must not be described as a real national pilot, physical-device certification, independent penetration test, or independent human QA review.
