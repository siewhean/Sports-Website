# Gate D status — automated-only assurance profile

**Candidate:** `fd9dabad92484e08534485230dc7d423d6eb1d08`

**Assurance profile:** `automated-only-owner-waived-v1`

**Status:** `AUTOMATED-ONLY PASS / HUMAN EVIDENCE WAIVED`

## Technical evidence

- Hosted CI run `34190555628`: PASS.
  - `secrets`: PASS
  - `quality-fast`: PASS
  - `integration`: PASS
  - `browser-e2e`: PASS
  - `gate-d-real-e2e`: PASS
- Controlled OCI qualification run `34190842572`: PASS.
- Retained artifact `10042701736`: `gate-d-oci-final-fd9dabad92484e08534485230dc7d423d6eb1d08`.
- QA-010 peak 2x p95: `180.92139 ms` against `<2500 ms`, error rate `0%`: PASS.
- QA-011 scoring peak 2x p95: `438.058018 ms` against `<500 ms`, error rate `0%`: PASS.
- QA-011 result propagation p95: `217.34597 ms` against `<2000 ms`, error rate `0%`: PASS.
- CI integration job includes migration compatibility and automated backup restore verification: PASS.
- Browser job includes Chromium/WebKit/Firefox E2E plus automated accessibility and visual regression: PASS.

## Human / physical evidence

The following were **not executed** and are explicitly owner-waived under ADR 0004:

- human accessibility session;
- physical device/browser matrix beyond automation;
- budget Android physical session;
- incident tabletop;
- event-day tabletop;
- real local organiser/official pilot;
- pilot-specific standings observation;
- organiser intervention log;
- pilot-specific Critical/High defect observation;
- independent Gate D review.

These are not PASS claims.

## Gate interpretation

Engineering may progress to Gate E under the automated-only profile. The original full-assurance Gate D remains unclaimed because the human/physical sessions did not occur.

See `artifacts/gate-d-automated-only-certification.json` and `docs/decisions/0004-phase7-automated-only-assurance.md`.
