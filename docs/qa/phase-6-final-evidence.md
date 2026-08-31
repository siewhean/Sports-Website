# Phase 6 commercial and operational completeness evidence

Phase 6 release-gate status: **HOLD — physical-device evidence and independent pre-merge acceptance remain outstanding.**

This document is the fresh evidence wrapper for the immutable Phase 6 product candidate below. Its own commit SHA is intentionally recorded in the PR certification metadata after this file is committed, because a commit cannot truthfully contain its own final SHA.

## Product candidate

- **Product candidate SHA:** `d225e5a4d3a7de1bdbdb208bff233abc2520a03f`
- **Branch:** `phase-6/commercial-operations`
- **Pull request:** [#39](https://github.com/siewhean/Sports-Website/pull/39)
- **Product change:** transactional schedule-publication notification/outbox path
- **Previous product baseline:** `0875c146c6c57760cede1bc8bdad1a0a295faac9`

The product commit changes the API/notification domain path and tests. Repository inspection found no `apps/web` change in `d225e5a4...`.

## Exact product CI receipt

GitHub Actions run [33370509134](https://github.com/siewhean/Sports-Website/actions/runs/33370509134) on exact product SHA `d225e5a4d3a7de1bdbdb208bff233abc2520a03f` — **SUCCESS**.

- `secrets` job `99420296711` — SUCCESS
- `quality-fast` job `99420355990` — SUCCESS
- `integration` job `99420356007` — SUCCESS
- `browser-e2e` job `99420909157` — SUCCESS
  - production build — SUCCESS
  - deploy manifest — SUCCESS
  - origin asset verification — SUCCESS
  - `pnpm test:e2e` — SUCCESS
  - `pnpm test:a11y` — SUCCESS
  - `pnpm test:visual` — SUCCESS

## Certification-tooling receipt

The certification tooling head before this docs-only wrapper is `4546c713db4bb17ee59dbddd4ef655dce24b8ac6`. Commits after the product candidate are QA/certification tooling only; the SMTP workflow enforces product-tree equivalence against `d225e5a4...` for the product/runtime paths under certification.

GitHub Actions run [33377931510](https://github.com/siewhean/Sports-Website/actions/runs/33377931510) on `4546c713db4bb17ee59dbddd4ef655dce24b8ac6` — **SUCCESS**.

- `secrets` job `99443561228` — SUCCESS
- `quality-fast` job `99443628853` — SUCCESS
- `integration` job `99443628791` — SUCCESS
- `browser-e2e` job `99444110859` — SUCCESS
  - production build, manifest and origin verification — SUCCESS
  - E2E, accessibility and visual tests — SUCCESS

## Controlled SMTP delivery — PASS

Controlled SMTP certification run [33377926903](https://github.com/siewhean/Sports-Website/actions/runs/33377926903) on certification wrapper `4546c713...` — **SUCCESS**.

Retained artifact:

- **Name:** `phase-6-smtp-certification-33377926903`
- **Artifact id:** `9752626855`
- **Digest:** `sha256:969e3ea3bc5af280947c1728279750d5db563a120990672057cc3d102ad55a2b`
- **Product bound by workflow equivalence check:** `d225e5a4d3a7de1bdbdb208bff233abc2520a03f`

The retained receipt proves:

- the same outbox row persisted through the entire lifecycle;
- initial state `pending`, attempts `0`;
- a genuine SMTP `ECONNREFUSED 127.0.0.1:1025` classified as `transient`, attempts `1`, with the production retry scheduled;
- controlled Mailpit started only after that first failure;
- the production worker automatically retried and delivered the same row at attempts `2`;
- `delivered_at` and provider message id were persisted;
- Mailpit retained exactly one message and its MessageID matched the persisted provider message id;
- duplicate `NotificationService.publish()` with the same idempotency key returned the same outbox id and DB counts remained one notification plus one outbox row;
- subsequent worker polls did not resend the delivered message;
- the retained worker log showed retry then delivery and the controlled credential scan found zero matches.

The SMTP review thread is resolved. SMTP is no longer a Phase 6 blocker.

## Controlled staging provider evidence

To re-establish current-product staging provenance without modifying PR #39, temporary certification branch `cert/phase6-d225e5-staging` was created at the parent and fast-forwarded to exact product SHA `d225e5a4d3a7de1bdbdb208bff233abc2520a03f`.

Vercel created exact-product record `dpl_7FVdgmrqq1tSq2K7y2kVCDbbaiyL` for project `sports-website-web`, branch `cert/phase6-d225e5-staging`, and exact Git SHA `d225e5a4...`. Vercel reported the record **CANCELED because the web project is unaffected**, linking its monorepo "skipping unaffected projects" reason. This is retained as provider evidence and is not represented as a READY exact-SHA deployment.

Because `d225e5a4...` contains no `apps/web` change, the web artifact remains the one produced from immediate parent `0875c146c6c57760cede1bc8bdad1a0a295faac9`. Authenticated Vercel inspection on 2026-08-31 confirms deployment `dpl_FQJ3B2ArmLfWzJYu9VA4SZhp9jra` remains **READY** for `sports-website-web`. Authenticated fetch confirms Vercel Authentication and security/no-index headers including `x-robots-tag: noindex`, HSTS and `x-frame-options: DENY`.

This establishes controlled **web staging infrastructure equivalence** for the current product candidate using Vercel's own unaffected-project classification. It does not substitute for signed-in physical-device receipts.

## Governance and review receipts

| Gate | Status | Retained evidence / closure requirement |
| --- | --- | --- |
| Legal and privacy | SUPERSEDED FOR PHASE 6 | Formal authorised approval is deferred to Gate F by [ADR 0003](../decisions/0003-phase6-legal-privacy-approval-gate.md). This is a governance deferral, not a legal approval receipt. |
| Exact product CI | PASS | Run `33370509134` on `d225e5a4...`, all four jobs green including executed E2E/a11y/visual. |
| Certification-tooling CI | PASS | Run `33377931510` on `4546c713...`, all four jobs green. |
| Controlled SMTP delivery | PASS | Run `33377926903`, retained artifact id `9752626855`, digest above. |
| Controlled web staging provenance | PASS WITH PROVIDER EQUIVALENCE | Exact-product Vercel record `dpl_7FV...` classified the web project as unaffected; unchanged parent web deployment `dpl_FQJ...` remains READY. |
| Physical-device signed-in evidence | **BLOCKED / OPEN** | Physical iPhone/Safari and physical Android/Chrome organiser, official and spectator critical-flow receipts are still required. |
| Independent pre-merge QA/QC | BLOCKED | Can issue the required merge PASS only after all mandatory pre-merge evidence, including physical-device receipts, is present. |
| Post-merge CI and integration preview | BLOCKED | Requires the eventual merge SHA on the target branch; cannot exist pre-merge. |

## Release decision

**HOLD.**

The product, automated CI, SMTP delivery certification and controlled web-staging provenance are green. The remaining pre-merge blocker is the required physical-device signed-in evidence. Until that evidence exists, this wrapper does not assert the required independent merge verdict `PASS — zero unresolved P0/P1 pre-merge release blockers`, and PR #39 must not be merged.

After physical-device evidence is retained, update the PR certification metadata with this wrapper's exact SHA and CI receipt, obtain the independent pre-merge verdict, and only then perform the guarded merge. Post-merge target-branch CI and non-production integration deployment remain mandatory before Phase 6 post-merge certification can close.
