export type PublicProjectionVersionInput = Readonly<{
  competitionId: string;
  scheduleVersion: number;
  resultVersion: number;
  projectionVersion: number;
  generatedAt: string;
  sourceUpdatedAt: string;
}>;

export type PublicProjectionPrivacyViolation = Readonly<{
  path: string;
  reason: "forbidden_field" | "secret_like_value" | "unsupported_value";
}>;

const forbiddenPublicFieldPattern =
  /(?:^|_)(?:account_id|access_pass_id|access_session_id|scoring_session_id|writer_generation|offline_authorization_id|resume_secret|device_id|device_label|client_ip|ip_address|email|phone|token|secret|password|cookie|authorization)(?:_|$)/iu;

const forbiddenPublicTextPatterns: ReadonlyArray<readonly [string, RegExp]> = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/iu],
  ["bearer credential", /bearer\s+[a-z0-9._~+/=-]+/iu],
  [
    "credential header",
    /(?:authorization|proxy-authorization|set-cookie|x-api-key|api[_-]?key)\s*[:=]\s*[^\s,;]+/iu,
  ],
  ["JWT", /eyJ[a-z0-9_-]{8,}\.eyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}/iu],
  ["credential-bearing PostgreSQL URL", /postgres(?:ql)?:\/\/[^/\s]+:[^@\s]+@/iu],
  ["credential-bearing Redis URL", /redis:\/\/[^/\s]+:[^@\s]+@/iu],
  ["scoring access fragment", /#access=/iu],
  ["offline grant cookie", /__Secure-matchday-offline-grant/iu],
];

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Public projection version input contains an unsupported value");
  return serialized;
}

function positiveVersion(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
}

function validTimestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a valid timestamp`);
  return parsed;
}

export function canonicalPublicProjectionVersionInput(input: PublicProjectionVersionInput): string {
  if (!input.competitionId.trim()) throw new Error("Public projection requires a competition ID");
  positiveVersion(input.scheduleVersion, "Schedule version");
  positiveVersion(input.resultVersion, "Result version");
  positiveVersion(input.projectionVersion, "Projection version");
  const generatedAt = validTimestamp(input.generatedAt, "Projection generation time");
  const sourceUpdatedAt = validTimestamp(input.sourceUpdatedAt, "Projection source update time");
  if (generatedAt < sourceUpdatedAt) {
    throw new Error("Public projection cannot be generated before its source update");
  }
  return stableJson({
    competition_id: input.competitionId,
    generated_at: new Date(generatedAt).toISOString(),
    projection_version: input.projectionVersion,
    result_version: input.resultVersion,
    schedule_version: input.scheduleVersion,
    source_updated_at: new Date(sourceUpdatedAt).toISOString(),
  });
}

export function publicProjectionPrivacyViolations(value: unknown): PublicProjectionPrivacyViolation[] {
  const violations: PublicProjectionPrivacyViolation[] = [];
  const visited = new Set<object>();

  const visit = (candidate: unknown, path: readonly string[]): void => {
    if (
      candidate === null ||
      typeof candidate === "boolean" ||
      typeof candidate === "number" ||
      typeof candidate === "string"
    ) {
      if (typeof candidate === "number" && !Number.isFinite(candidate)) {
        violations.push({ path: path.join(".") || "<root>", reason: "unsupported_value" });
      }
      if (typeof candidate === "string") {
        const match = forbiddenPublicTextPatterns.find(([, pattern]) => pattern.test(candidate));
        if (match) violations.push({ path: path.join(".") || "<root>", reason: "secret_like_value" });
      }
      return;
    }
    if (typeof candidate !== "object") {
      violations.push({ path: path.join(".") || "<root>", reason: "unsupported_value" });
      return;
    }
    if (visited.has(candidate)) {
      violations.push({ path: path.join(".") || "<root>", reason: "unsupported_value" });
      return;
    }
    visited.add(candidate);
    if (Array.isArray(candidate)) {
      candidate.forEach((item, index) => visit(item, [...path, String(index)]));
      return;
    }
    for (const [key, child] of Object.entries(candidate as Record<string, unknown>)) {
      const childPath = [...path, key];
      if (forbiddenPublicFieldPattern.test(key)) {
        violations.push({ path: childPath.join("."), reason: "forbidden_field" });
      }
      visit(child, childPath);
    }
  };

  visit(value, []);
  return violations.sort((left, right) => left.path.localeCompare(right.path) || left.reason.localeCompare(right.reason));
}

export function assertPublicProjectionPrivacy(value: unknown): void {
  const violations = publicProjectionPrivacyViolations(value);
  if (violations.length === 0) return;
  throw new Error(
    `Public projection contains forbidden data: ${violations
      .map((violation) => `${violation.path} (${violation.reason})`)
      .join(", ")}`,
  );
}
