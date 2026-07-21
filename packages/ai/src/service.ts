import type {
  Phase4AiAccountingDecision,
  Phase4AiAuditMetadata,
  Phase4AiBriefWorkflowState,
  Phase4AiFailureCode,
  Phase4CompetitionBrief,
} from "@matchday/contracts";
import { decideAiActionAccounting } from "./accounting.js";
import { createAiAuditMetadata, createAiRequestFingerprint } from "./audit.js";
import {
  createCompetitionBriefProviderRequest,
  executeCompetitionBriefProvider,
  type AiProviderPort,
  type ProviderAttemptEvent,
} from "./provider.js";
import { validateCompetitionBrief } from "./schema.js";

export type CompetitionBriefCacheKey = {
  organisationId: string;
  action: "text_to_brief";
  requestFingerprint: string;
  schemaVersion: "1.0";
};

export interface CompetitionBriefCachePort {
  get(key: CompetitionBriefCacheKey): Promise<unknown | null>;
  finalize(
    key: CompetitionBriefCacheKey,
    brief: Phase4CompetitionBrief,
  ): Promise<{ cacheStatus: "hit" | "miss"; brief: unknown }>;
}

type SuccessResult = {
  status: "success";
  source: "provider" | "cache";
  brief: Phase4CompetitionBrief;
  accounting: Phase4AiAccountingDecision;
  audit: Phase4AiAuditMetadata;
};

type ManualFallbackResult = {
  status: "manual_fallback";
  reason: "provider_disabled" | Phase4AiFailureCode;
  preservedText: string;
  accounting: Phase4AiAccountingDecision;
  audit: Phase4AiAuditMetadata;
};

type QuotaResult = {
  status: "quota_exhausted";
  preservedText: string;
  accounting: Phase4AiAccountingDecision;
  audit: Phase4AiAuditMetadata;
};

export type CompetitionBriefConversionResult = SuccessResult | ManualFallbackResult | QuotaResult;

function fallbackAccounting(): Phase4AiAccountingDecision {
  return decideAiActionAccounting({ outcome: "manual_fallback", cacheStatus: "not_checked", valid: false });
}

function cacheKey(organisationId: string, fingerprint: string): CompetitionBriefCacheKey {
  return {
    organisationId,
    action: "text_to_brief",
    requestFingerprint: fingerprint,
    schemaVersion: "1.0",
  };
}

function workflowEvent(event: ProviderAttemptEvent): Phase4AiBriefWorkflowState {
  return event.status === "requesting"
    ? { status: "requesting", attempt: event.attempt, maximum_attempts: event.maximumAttempts }
    : {
        status: "retrying",
        attempt: event.attempt,
        maximum_attempts: event.maximumAttempts,
        reason: event.reason,
      };
}

export async function convertCompetitionTextToBrief(input: {
  organisationId: string;
  text: string;
  locale?: string;
  provider: AiProviderPort | null;
  cache?: CompetitionBriefCachePort;
  quotaAvailable: boolean;
  timeoutMs?: number;
  maximumAttempts?: number;
  retryDelayMs?: number;
  signal?: AbortSignal;
  onState?: (state: Phase4AiBriefWorkflowState) => void;
}): Promise<CompetitionBriefConversionResult> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.organisationId)) {
    throw new Error("organisationId must be a bounded opaque identifier");
  }
  const request = createCompetitionBriefProviderRequest({
    text: input.text,
    ...(input.locale === undefined ? {} : { locale: input.locale }),
  });
  const fingerprint = createAiRequestFingerprint({
    action: "text_to_brief",
    schemaVersion: request.schemaVersion,
    locale: request.locale,
    text: request.organiserText,
  });
  const key = cacheKey(input.organisationId, fingerprint);
  let cacheHealthy = input.cache !== undefined;

  if (input.cache !== undefined) {
    try {
      const candidate = await input.cache.get(key);
      if (candidate !== null) {
        const validated = validateCompetitionBrief(candidate);
        if (validated.ok) {
          const accounting = decideAiActionAccounting({ outcome: "success", cacheStatus: "hit", valid: true });
          const audit = createAiAuditMetadata({
            action: "text_to_brief",
            text: request.organiserText,
            schemaVersion: request.schemaVersion,
            locale: request.locale,
            outcome: "success",
            cacheStatus: "hit",
            chargedUnits: accounting.units,
            attempts: 0,
            durationMs: 0,
          });
          input.onState?.({
            status: "complete",
            source: "cache",
            brief: validated.brief,
            missing_fields: validated.brief.missing_fields,
            charged_units: 0,
          });
          return { status: "success", source: "cache", brief: validated.brief, accounting, audit };
        }
      }
    } catch {
      // Cache availability must not block the provider or the complete manual path.
      cacheHealthy = false;
    }
  }
  const cacheMissStatus = cacheHealthy ? "miss" : "not_checked";

  if (!input.quotaAvailable) {
    const accounting = fallbackAccounting();
    const audit = createAiAuditMetadata({
      action: "text_to_brief",
      text: request.organiserText,
      schemaVersion: request.schemaVersion,
      locale: request.locale,
      outcome: "manual_fallback",
      cacheStatus: cacheMissStatus,
      chargedUnits: 0,
      attempts: 0,
      durationMs: 0,
    });
    input.onState?.({ status: "quota_exhausted", manual_fallback_available: true });
    return { status: "quota_exhausted", preservedText: request.organiserText, accounting, audit };
  }

  if (input.provider === null) {
    const accounting = fallbackAccounting();
    const audit = createAiAuditMetadata({
      action: "text_to_brief",
      text: request.organiserText,
      schemaVersion: request.schemaVersion,
      locale: request.locale,
      outcome: "manual_fallback",
      cacheStatus: cacheMissStatus,
      chargedUnits: 0,
      attempts: 0,
      durationMs: 0,
    });
    input.onState?.({
      status: "manual_fallback",
      reason: "provider_disabled",
      preserved_text: request.organiserText,
      charged_units: 0,
    });
    return {
      status: "manual_fallback",
      reason: "provider_disabled",
      preservedText: request.organiserText,
      accounting,
      audit,
    };
  }

  const executed = await executeCompetitionBriefProvider(input.provider, request, {
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.maximumAttempts === undefined ? {} : { maximumAttempts: input.maximumAttempts }),
    ...(input.retryDelayMs === undefined ? {} : { retryDelayMs: input.retryDelayMs }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    onAttempt: (event) => input.onState?.(workflowEvent(event)),
  });
  if (!executed.ok) {
    const accounting = fallbackAccounting();
    const audit = createAiAuditMetadata({
      action: "text_to_brief",
      text: request.organiserText,
      schemaVersion: request.schemaVersion,
      locale: request.locale,
      outcome: "manual_fallback",
      cacheStatus: cacheMissStatus,
      chargedUnits: 0,
      attempts: executed.attempts,
      durationMs: executed.durationMs,
      failureCode: executed.failure.code,
    });
    input.onState?.({
      status: "manual_fallback",
      reason: executed.failure.code,
      preserved_text: request.organiserText,
      charged_units: 0,
    });
    return {
      status: "manual_fallback",
      reason: executed.failure.code,
      preservedText: request.organiserText,
      accounting,
      audit,
    };
  }

  let providerCacheStatus: "hit" | "miss" | "not_checked" = "not_checked";
  let finalBrief = executed.brief;
  let finalSource: "provider" | "cache" = "provider";
  if (input.cache !== undefined && cacheHealthy) {
    try {
      const finalization = await input.cache.finalize(key, executed.brief);
      const validated = validateCompetitionBrief(finalization.brief);
      if (!validated.ok) throw new Error("Atomic cache finalization returned an invalid brief");
      providerCacheStatus = finalization.cacheStatus;
      finalBrief = validated.brief;
      finalSource = finalization.cacheStatus === "hit" ? "cache" : "provider";
    } catch {
      // Without atomic cache finalization, this result is successful but deliberately non-chargeable.
    }
  }
  const accounting = decideAiActionAccounting({ outcome: "success", cacheStatus: providerCacheStatus, valid: true });
  const audit = createAiAuditMetadata({
    action: "text_to_brief",
    text: request.organiserText,
    schemaVersion: request.schemaVersion,
    locale: request.locale,
    outcome: "success",
    cacheStatus: providerCacheStatus,
    chargedUnits: accounting.units,
    attempts: executed.attempts,
    durationMs: executed.durationMs,
    ...(executed.providerRequestId === undefined ? {} : { providerRequestId: executed.providerRequestId }),
  });
  input.onState?.({
    status: "complete",
    source: finalSource,
    brief: finalBrief,
    missing_fields: finalBrief.missing_fields,
    charged_units: accounting.units,
  });
  return { status: "success", source: finalSource, brief: finalBrief, accounting, audit };
}
