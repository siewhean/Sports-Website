# ADR 0008 — V1 Online-First Scoring Policy & Printable Fallback Contingency

**Status:** Accepted  
**Date:** 13 October 2026  
**Applies to:** Gate C Operations, Live Scoring PWA, and Venue Operations

## Context

The original platform specification envisioned fully autonomous offline peer-to-peer scorekeeper synchronization with opportunistic reconnect for venues lacking cellular/Wi-Fi coverage.

However, the V1 production audit (`docs/V1_RECOVERY_AUDIT.md`) revealed that distributed offline vector reconciliations, cryptographic key expiry during partitions, and edge conflict resolutions introduced severe failure modes on event days. Attempting to support untrusted client-side offline replay across disparate devices created operational unpredictability.

## Architectural Decision

### 1. Online-First Scoring for V1

- Matchday live digital scoring operates as an **online-first** system.
- Scorekeepers record events via the mobile PWA with active network connectivity to the Fastify API (over cellular or local Wi-Fi).
- Short temporary disconnections (sub-minute jitter) are buffered in browser session memory with idempotency-key deduplication and lease generation checks.
- Prolonged multi-hour offline multi-device replay is explicitly removed from the certified V1 operational scope.

### 2. Printable Fallback Contingency

- For venues with complete network loss, the officially supported and certified contingency is the **printable paper fallback workflow**:
  1. Organisers print authoritative blank score-sheets and master schedule sheets directly from Matchday prior to tournament start (`/export/scoresheet`, `/export/schedule`).
  2. Table officials record points, fouls, and match completion on physical paper sheets.
  3. Organisers record verified final match results and scores via the organiser workspace once connectivity is restored.
  4. The platform atomically finalises matches, advances brackets, recalculates standings, and pushes public projections.

## Consequences

- Eliminates edge vector-clock conflict storms and corrupted split-brain streams during live competition.
- Protects organisers with a simple, universally understood paper fallback practiced across all amateur sport federations.
- Keeps client scoring bundle light, reliable, and accessible on any smartphone browser.
