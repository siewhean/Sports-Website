# Phase 6 commercial and operational completeness evidence

Phase 6 pre-merge status: **READY FOR FINAL WRAPPER CI AND INDEPENDENT QA/QC**.

This document supersedes the stale Phase 6 evidence wrapper that was bound to `d225e5a4...`. The active product candidate is the Event Pass remediation candidate below. This file intentionally does not attempt to contain its own eventual docs-only wrapper commit SHA; that SHA and its terminal CI receipt are recorded in PR #39 certification metadata after the commit exists.

## Active product candidate

- **Product candidate SHA:** `1f5697071e973f05e18068bfe70284f4ff365374`
- **Branch:** `phase-6/commercial-operations`
- **Pull request:** [#39](https://github.com/siewhean/Sports-Website/pull/39)
- **Product change:** Phase 6 commercial/operational completion including competition-scoped Event Pass entitlements, customer checkout flow, structured public competition data, and prior Phase 6 notification/email/admin/export remediation.
- **Previous SMTP-certified product baseline:** `d225e5a4d3a7de1bdbdb208bff233abc2520a03f`

The Event Pass remediation is product code. It is therefore certified directly at `1f569707...`; the earlier `d225e5a4...` product receipt is retained only as supporting history.

## Exact product CI — PASS

GitHub Actions run [33393688186](https://github.com/siewhean/Sports-Website/actions/runs/33393688186) on exact product SHA `1f5697071e973f05e18068bfe70284f4ff365374` completed **SUCCESS**.

- `secrets` job `99493051586` — SUCCESS
- `quality-fast` job `99493117531` — SUCCESS
  - frozen install — SUCCESS
  - dependency audit — SUCCESS
  - format check — SUCCESS
  - lint — SUCCESS
  - typecheck — SUCCESS
  - unit tests — SUCCESS
  - Gate C seal/evidence checks — SUCCESS
  - Vercel verification — SUCCESS
- `integration` job `99493117511` — SUCCESS
  - migration check — SUCCESS
  - backup verification — SUCCESS
  - integration tests — SUCCESS
  - fixture validation — SUCCESS
  - OpenAPI generation/check — SUCCESS
- `browser-e2e` job `99493679887` — SUCCESS
  - production build — SUCCESS
  - deploy manifest — SUCCESS
  - origin asset verification — SUCCESS
  - Playwright browser installation — SUCCESS
  - `pnpm test:e2e` — SUCCESS
  - `pnpm test:a11y` — SUCCESS
  - `pnpm test:visual` — SUCCESS

No required browser lane was skipped.

## Event Pass P1 remediation — PASS

The two final commercial P1 findings are resolved on `1f569707...`.

### Competition-scoped Event Pass

- checkout metadata carries the selected competition;
- ownership is validated before checkout;
- Event Pass grant persistence is competition-scoped;
- migrations `0060_phase6_event_pass_competition_scope.sql` and `0061_phase6_reject_organisation_event_pass.sql` enforce the scoped model and reject organisation-wide Event Pass state;
- effective competition tier checks prevent a pass for Competition A from unlocking sibling Competition B;
- regression coverage includes multi-competition isolation and migration-order safety.

### Customer checkout flow

- pricing routes Event Pass customers to the authenticated organiser checkout surface;
- an owned competition must be selected;
- the web BFF uses the existing session/CSRF boundary;
- Stripe secrets remain API-side;
- redirect is constrained to the Stripe Checkout URL returned by the protected billing endpoint;
- checkout destination and competition validation have unit coverage.

Both associated Codex P1 review threads are resolved.

## Exact current-product Vercel staging — PASS

Vercel deployment `dpl_5g1r2azWDCVrWZuHxnVTPkeK7oep` is **READY** and is explicitly bound by provider metadata to exact Git SHA `1f5697071e973f05e18068bfe70284f4ff365374` on `phase-6/commercial-operations`.

- Project: `sports-website-web`
- Deployment URL: `sports-website-bsh2w4541-siewheans-projects.vercel.app`
- Branch alias: `sports-website-web-git-phase-6-commer-050c77-siewheans-projects.vercel.app`
- Provider state: READY
- Exact Git SHA: `1f5697071e973f05e18068bfe70284f4ff365374`

The subsequent SMTP-workflow-only commit is correctly classified by Vercel as web-unaffected and does not replace this exact-product READY deployment.

## Controlled SMTP delivery — PASS on current product

The SMTP certification workflow was re-baselined to product candidate `1f569707...` in QA-only certification harness commit `8d744ca893ec28b1a8143af2067cbb44da1e62f3`.

The workflow first proved zero product-tree drift from `1f569707...` across the API, worker, database/config, jobs, notifications, edge-cache and observability paths under SMTP certification.

Controlled certification run [33397679768](https://github.com/siewhean/Sports-Website/actions/runs/33397679768) completed **SUCCESS**.

Retained artifact:

- **Name:** `phase-6-smtp-certification-33397679768`
- **Artifact id:** `9760009718`
- **Digest:** `sha256:bb4075a6ff511882788b9e484e1bbbf2d4817198c279c3d50dfd70daaa9d3f96`
- **Product candidate:** `1f5697071e973f05e18068bfe70284f4ff365374`
- **Certification harness:** `8d744ca893ec28b1a8143af2067cbb44da1e62f3`

Exact retained verdict:

> PASS — deployed Matchday worker delivered transactional email through controlled SMTP, persisted provider delivery state, recovered from a genuine transient SMTP failure through the production retry path without duplicate delivery, preserved idempotency, and emitted no controlled credential material in retained worker logs.

Receipt assertions include:

- same outbox row `2cdd4e01-a37f-4ec1-a863-e73946009675` throughout;
- initial `pending`, attempts `0`;
- genuine `ECONNREFUSED 127.0.0.1:1025`, classified transient, attempts `1`;
- production retry delivered the same row at attempts `2`;
- persisted provider id `<c6cb91e4-cd22-b95b-2ed7-884b802994eb@matchday.test>`;
- exactly one SMTP message;
- duplicate publish returned the same outbox id;
- persisted counts remained one notification and one outbox row;
- additional worker polls did not resend;
- controlled credential log scan passed with zero matches.

## Independent QA/QC

Independent QA for the Event Pass remediation passed after the migration-order and i18n corrections. The final merge decision remains guarded on the terminal CI result of this docs-only evidence wrapper and the absence of any new P0/P1 finding against the frozen product candidate.

## Physical-device gate

No physical-device result is retained in this PR evidence document by release-owner instruction. This document therefore makes no retained-device-receipt claim.

## Governance

Formal authorised legal/privacy approval remains **SUPERSEDED FOR PHASE 6 BY APPROVED DECISION RECORD; formal authorised legal/privacy approval remains mandatory at Gate F.**

See [ADR 0003](../decisions/0003-phase6-legal-privacy-approval-gate.md). This is a governance deferral, not a legal/privacy approval receipt.

## Pre-merge gate summary

| Gate | Status | Evidence |
| --- | --- | --- |
| Event Pass competition scope | PASS | Product SHA `1f569707...`; migrations `0060`/`0061`; exact-SHA CI |
| Event Pass checkout UI/BFF | PASS | Product SHA `1f569707...`; exact-SHA CI |
| Product CI | PASS | Run `33393688186`, all four jobs green; E2E/a11y/visual executed |
| Controlled staging | PASS | Vercel `dpl_5g1r2azWDCVrWZuHxnVTPkeK7oep`, READY, exact `1f569707...` |
| Controlled SMTP | PASS | Run `33397679768`; artifact `9760009718`; digest above |
| Independent Event Pass QA | PASS | Passed after migration-order and i18n remediation |
| Physical-device retained receipt | NOT RECORDED | Omitted from retained PR evidence by release-owner instruction |
| Legal/privacy | DEFERRED TO GATE F | ADR 0003; not an approval receipt |
| Final docs-only wrapper CI | PENDING | Record in PR metadata after this commit exists |
| Post-merge target CI/integration deployment | PENDING | Requires the eventual merge SHA |

## Release decision

There are no known unresolved Phase 6 product P0/P1 findings in the current candidate. **Do not merge solely from this file:** first require the docs-only wrapper commit containing this evidence to complete its full CI matrix successfully and confirm PR #39 has not moved unexpectedly. Then perform the merge guarded by the exact wrapper head SHA.

After merge, target-branch CI and a non-production integration deployment for the merge SHA remain mandatory before Phase 6 post-merge certification is closed. No production promotion is authorised by Phase 6.
