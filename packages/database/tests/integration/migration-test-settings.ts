export const populatedUpgradeTestName = "upgrades populated Phase 4 data through the latest forward migrations";

// This test deliberately applies a populated pre-0020 schema and then the
// complete forward chain. Keep its allowance local: a prior uncached run took
// 4.836 seconds, leaving too little margin under Vitest's five-second default.
export const populatedUpgradeTimeoutMs = 15_000;
