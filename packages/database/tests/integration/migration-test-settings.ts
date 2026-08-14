export const populatedUpgradeTestName = "upgrades populated Phase 4 data through the latest forward migrations";

// This test deliberately applies a populated pre-0020 schema and then the
// complete forward chain. Keep its allowance local: a prior uncached run took
// 4.836 seconds, leaving too little margin under Vitest's five-second default.
export const populatedUpgradeTimeoutMs = 15_000;

// Migration and test-schema teardown share one database-global advisory lock.
// Tests that apply a migration chain inside the test body can therefore spend
// part of their wall-clock allowance waiting for another suite's DDL to finish.
// Keep the larger allowance scoped to those tests; their isolated work remains
// well below Vitest's default timeout.
export const contendedMigrationTestTimeoutMs = 15_000;
