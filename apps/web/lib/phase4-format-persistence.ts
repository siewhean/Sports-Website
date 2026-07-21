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
