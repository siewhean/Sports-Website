import type {
  Phase4FormatBuilderDocument,
  Phase4FormatDraftView,
  Phase4OrganiserTemplateView,
} from "@matchday/contracts";

/**
 * A save always creates the next immutable revision beneath the exact draft
 * currently visible to the organiser. Using the draft's own parent would
 * create sibling revisions and make comparison/rollback ambiguous.
 */
export function formatSaveBody(draft: Phase4FormatDraftView, document: Phase4FormatBuilderDocument) {
  return {
    draft_id: draft.draft_id,
    expected_revision: draft.revision,
    parent_revision_id: draft.draft_id,
    document,
    idempotency_key: crypto.randomUUID(),
  };
}

/**
 * The template picker shows one current immutable version per logical
 * template. A newly returned version replaces the previous visible version;
 * competitions already pinned to an older version remain unchanged.
 */
export function upsertOrganiserTemplate(
  current: readonly Phase4OrganiserTemplateView[],
  saved: Phase4OrganiserTemplateView,
): readonly Phase4OrganiserTemplateView[] {
  return [...current.filter((template) => template.template_id !== saved.template_id), saved].sort(
    (left, right) => left.name.localeCompare(right.name) || right.revision - left.revision,
  );
}

export function formatTemplateSaveBody(
  draft: Phase4FormatDraftView,
  name: string,
  sportCode: string,
  current: Phase4OrganiserTemplateView | null,
) {
  return {
    template_id: current?.template_id ?? null,
    parent_version_id: current?.template_version_id ?? null,
    expected_version: current?.revision ?? null,
    name: name.trim(),
    description: current?.description ?? null,
    sport_code: sportCode,
    source_format_revision_id: draft.draft_id,
    idempotency_key: crypto.randomUUID(),
  };
}
