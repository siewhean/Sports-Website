import { createHash } from "node:crypto";
import type { Phase4AiActionKind, Phase4AiAuditMetadata, Phase4AiFailureCode } from "@matchday/contracts";

function canonicalText(text: string): string {
  return text.normalize("NFC").trim().replace(/\s+/g, " ");
}

export function createAiRequestFingerprint(input: {
  action: Phase4AiActionKind;
  schemaVersion: string;
  locale: string;
  text: string;
}): string {
  const identity = JSON.stringify({
    action: input.action,
    schema_version: input.schemaVersion,
    locale: input.locale.toLowerCase(),
    text: canonicalText(input.text),
  });
  return createHash("sha256").update(identity).digest("hex");
}

export function createAiAuditMetadata(input: {
  action: Phase4AiActionKind;
  text: string;
  schemaVersion: string;
  locale: string;
  outcome: "success" | "failure" | "manual_fallback";
  cacheStatus: "hit" | "miss" | "not_checked";
  chargedUnits: 0 | 1;
  attempts: number;
  durationMs: number;
  failureCode?: Phase4AiFailureCode;
  providerRequestId?: string;
}): Phase4AiAuditMetadata {
  const providerRequestId =
    input.providerRequestId !== undefined && /^[A-Za-z0-9._:-]{1,128}$/.test(input.providerRequestId)
      ? input.providerRequestId
      : undefined;
  return {
    action: input.action,
    request_fingerprint: createAiRequestFingerprint({
      action: input.action,
      schemaVersion: input.schemaVersion,
      locale: input.locale,
      text: input.text,
    }),
    input_character_count: [...input.text].length,
    outcome: input.outcome,
    cache_status: input.cacheStatus,
    charged_units: input.chargedUnits,
    attempts: input.attempts,
    duration_ms: Math.max(0, Math.round(input.durationMs)),
    ...(input.failureCode === undefined ? {} : { failure_code: input.failureCode }),
    ...(providerRequestId === undefined ? {} : { provider_request_id: providerRequestId }),
  };
}
