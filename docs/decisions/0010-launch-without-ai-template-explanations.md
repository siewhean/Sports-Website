# ADR 0010 — Track R4: Launch Without AI Models & Deterministic Template Explanations

**Status:** Accepted  
**Date:** 14 October 2026  
**Applies to:** Track R4 (AI: Real Provider or Honest Removal), Phase 4 / Phase 6 AI Surfaces

---

## Context

During the production readiness audit of Phase 4 and Phase 6 AI capabilities, three critical architectural and commercial issues were identified:

1. **Charged Stub Outputs:** In `apps/api/src/phase-4-ai-provider.ts`, `DeterministicPhase4AiStub` implemented three mock methods (`modifyFormat`, `suggestSchedulePreferences`, and `recommendRepairActions`). When invoked, these methods returned canned mock data, but finalized through `phase4_finalize_ai_action` which charged 1 credit unit against the organiser's usage allowance (`charged_units: 1`).
2. **Schema Inconsistencies:** The mock format modify stub returned a document with camelCase properties (`schemaVersion: 1`), which failed validation against the strict `FormatDocument` schema (`schema_version: 1`).
3. **Misleading Nomenclature:** Organiser setup journeys labeled format options simply as "Recommendations" without clarifying that the underlying engine is a deterministic domain calculation rather than an AI model.

Concurrently, the core Matchday domain packages already implement comprehensive, deterministic, template-based explanations:

- **Format Options:** `packages/domain/src/format.ts` computes feasible competition formats based on exact slot capacity and pairs them with clear advantage statements (e.g., _"Ranks every entry"_, _"Keeps complete group play with shorter finals"_, _"Uses the fewest match slots"_).
- **Solver Infeasibility Diagnostics:** `packages/domain/src/schedule-constraints.ts` produces precise, actionable explanations for any `no_solution` state (e.g. court-minute deficits, entry daily caps, required rest spacing).
- **Result & Standings Traces:** `packages/domain/src/results.ts` traces standings tie-break resolutions and withdrawal policies deterministically.

---

## Decision

### 1. Launch with Zero External AI Models

Matchday will launch with **no external AI model**. All format recommendations, schedule feasibility diagnostics, standings traces, and repair policies will rely exclusively on deterministic algorithms and string templates.

### 2. Disable Charged Canned Mock Features at Zero Cost

The three canned mock methods (`modifyFormat`, `suggestSchedulePreferences`, and `recommendRepairActions`) are removed from `DeterministicPhase4AiStub`.

- If an API client calls `/ai/format-modify`, `/ai/schedule-preferences`, or `/repairs/:caseId/ai-recommendations`, the runtime marks `failureCode = "provider_unavailable"`.
- The ledger finalizes with `outcome = "manual_fallback"`, and `charged_units = 0`.
- The API returns `status: "manual_fallback"`, `reason: "provider_unavailable"`, `charged_units: 0`, and preserves the organiser's input text in `preserved_text`.

**What is true about charging after this ADR:**

- **In production the AI provider is disabled** (`PHASE4_AI_PROVIDER=disabled`). With no provider, every AI action ends in `manual_fallback` and charges nothing.
- **Disabled and unimplemented features never charge.** Only a validated `success` with a cache miss can charge a unit.
- **The competition brief (`/ai/competition-brief`) remains a local/test stub.** In stub mode (`PHASE4_AI_PROVIDER=stub`, local development, tests and the simulation harness only) a valid brief may charge one unit, exactly once per idempotency key; replays and cache hits charge zero.

### 2a. No AI Top-Ups

AI top-ups are no longer sold. `POST …/billing/checkout` with `purchaseType: "ai_top_up"` (or a plan checkout with `topUpUnits > 0`) is rejected with **`409 AI_TOP_UP_UNAVAILABLE`** before Stripe is contacted. This is unconditional rather than tied to the AI mode, because even in stub mode there is nothing real to buy. Webhook fulfilment and revocation of historical `ai_top_up` sessions are kept so old Stripe events still replay idempotently.

### 2b. Usage Endpoint Removed, One Org-Wide Quota

The unused `GET /api/v1/organisations/:organisationId/ai/usage` endpoint is removed. AI quota is organisation-wide and computed in one place, `phase6_org_ai_quota()` (migration 0074). The same function drives the pre-check before an AI action, the finalize charge, the billing summary `ai_quota`, and the `usage` field in AI responses. Per-actor `ai_usage_allowances` rows are kept as an audit ledger only.

### 3. Transparently Label Format Suggestions as Rules-Based

The organiser setup UI (`AssistedSetupJourneyView`, `AssistedSetupWorkspace`, and `V1FormatPicker`) explicitly labels format recommendations as **"Rules-based suggestions"**, with explanatory copy stating that options are computed deterministically from capacity and format preferences without AI models.

### 4. Post-Launch Paid Model Governance (Future Option)

If organisers explicitly request natural-language assistant capabilities post-launch, any model provider integration must strictly comply with the following governance rules:

1. **Cheap Paid Model:** Utilize cost-efficient, high-speed models (e.g., Claude 3.5 Haiku or GPT-4o-mini) rather than expensive frontier models.
2. **Strict Spending Caps & Quota Budgets:** Enforce hard per-organisation monthly spend caps and quota limits.
3. **Zero Cost on Invalid or Rejected Outputs:** Never bill organisers for no-op, invalid, rejected, or cached actions.
4. **Enterprise Privacy & No-Training Terms:** Model providers must be contracted under zero-data-retention and no-training terms to ensure competition and participant data is never used for model training.
5. **Proposal-Only Architecture:** AI outputs remain unpinned proposals. Every proposal must pass domain validation rules and constraint solver feasibility checks before being presented to organisers; models will never directly mutate competition state.
6. **Focus on Explaining Diagnostics:** The primary use case for post-launch models will be translating technical solver diagnostics and schedule trade-offs into plain English.

---

## Consequences

### Positive

- **Commercial Honesty:** Eliminates all instances where organisers could be charged credits for canned mock text.
- **Reliability:** Avoids non-deterministic LLM behavior, hallucinations, latency, and third-party API availability risks on the critical path of tournament creation.
- **Transparency:** Organisers know exactly how formats and schedules are generated.
- **Zero Cost:** No model API billing costs incurred during launch.

### Negative

- Natural-language modification of format graphs is not available at launch (organisers use the visual format designer or rules-based suggestions).
