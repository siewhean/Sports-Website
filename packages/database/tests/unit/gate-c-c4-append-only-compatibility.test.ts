import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

describe("Gate C C4 append-only compatibility bridge", () => {
  it("sorts before the historical trigger reference without rewriting the applied migration", async () => {
    const bridge = "0036_z_gate_c_repair_append_only_compatibility.sql";
    const adjustment = "0037_gate_c_repair_schedule_adjustments.sql";
    const [bridgeSource, adjustmentSource] = await Promise.all([
      readFile(path.join(migrationsDirectory, bridge), "utf8"),
      readFile(path.join(migrationsDirectory, adjustment), "utf8"),
    ]);

    expect(bridge.localeCompare(adjustment)).toBeLessThan(0);
    expect(bridge.localeCompare("0040_gate_c_atomic_result_repair_cases.sql")).toBeLessThan(0);
    expect(bridgeSource).toContain("TG_TABLE_NAME = 'schedule_repair_cases'");
    expect(bridgeSource).toContain("to_jsonb(OLD) - 'result_repair_case_id'");
    expect(bridgeSource).toContain("CREATE OR REPLACE FUNCTION phase3_reject_append_only_change() RETURNS trigger");
    expect(bridgeSource).toContain("RAISE EXCEPTION '% is append-only', TG_TABLE_NAME");
    expect(adjustmentSource).toContain("EXECUTE FUNCTION phase3_reject_append_only_change()");
  });
});
