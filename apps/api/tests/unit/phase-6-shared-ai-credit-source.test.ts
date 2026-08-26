import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");

describe("Phase 6 shared AI credit invariants", () => {
  const migration = read("packages/database/migrations/0059_phase6_shared_ai_credits.sql");

  it("retains organisation-wide credit consumption and locks before cache recheck", () => {
    expect(migration).toContain("CREATE TABLE ai_credit_consumptions");
    expect(migration).toContain("ledger_id uuid NOT NULL UNIQUE");
    const lock = migration.indexOf("phase6-ai-credit:");
    const cache = migration.indexOf("SELECT * INTO cached FROM ai_response_cache", lock);
    const consume = migration.indexOf("INSERT INTO ai_credit_consumptions", lock);
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(cache).toBeGreaterThan(lock);
    expect(consume).toBeGreaterThan(cache);
  });

  it("turns a final-credit race into manual fallback rather than an exception", () => {
    expect(migration).toContain("final_outcome:='manual_fallback'");
    expect(migration).toContain("failure_code_value:='quota_exhausted'");
    expect(migration).not.toContain("RAISE EXCEPTION 'AI action quota exhausted'");
  });

  it("includes durable shared-credit consumption in the billing summary", () => {
    const runtime = read("apps/api/src/entitlement-runtime.ts");
    expect(runtime).toContain("FROM ai_credit_consumptions c");
    expect(runtime).toContain("topUpRemaining");
    expect(runtime).toContain("baseRemaining + topUpRemaining");
  });
});
