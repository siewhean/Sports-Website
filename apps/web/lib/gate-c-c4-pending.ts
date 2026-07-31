export type GateCC4PendingRepairCase = Readonly<{
  result_repair_case_id: string;
  correction_transaction_id: string;
  corrected_match_id: string;
  corrected_match_code: string;
  division_id: string;
  division_name: string;
  source_result_version: number;
  created_at: string;
}>;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

export function parseGateCC4PendingRepairCases(value: unknown): GateCC4PendingRepairCase[] | null {
  if (!Array.isArray(value)) return null;
  const output: GateCC4PendingRepairCase[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    if (
      !record(item) ||
      !uuid(item.result_repair_case_id) ||
      ids.has(item.result_repair_case_id) ||
      !uuid(item.correction_transaction_id) ||
      !uuid(item.corrected_match_id) ||
      typeof item.corrected_match_code !== "string" ||
      !uuid(item.division_id) ||
      typeof item.division_name !== "string" ||
      !Number.isSafeInteger(item.source_result_version) ||
      (item.source_result_version as number) < 1 ||
      typeof item.created_at !== "string" ||
      !Number.isFinite(Date.parse(item.created_at))
    ) {
      return null;
    }
    ids.add(item.result_repair_case_id);
    output.push(item as GateCC4PendingRepairCase);
  }
  return output;
}
