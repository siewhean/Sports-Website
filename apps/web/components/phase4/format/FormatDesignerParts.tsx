"use client";

import { useEffect, useReducer, useState } from "react";
import type { Phase4FormatDraftView } from "@matchday/contracts";
import {
  formatEditorReducer,
  parseFormatDraft,
  parseFormatMaterialisation,
  parseOrganiserTemplate,
  parseFormatValidation,
  type FormatBuilderPageDocument,
  type FormatEditorState,
  type FormatSurfaceState,
} from "@/lib/phase4-format";
import { formatSaveBody, upsertOrganiserTemplate } from "@/lib/phase4-format-persistence";
import { opaqueId, translate as t } from "@matchday/ui";
import { FormatDesignerSurface } from "./FormatDesignerSurface";
import { focusIssue } from "./format-designer-helpers";

export function FormatEditor({
  page,
  initial,
  draft,
  onDraft,
  viewState,
  onViewState,
  busy,
  onBusy,
  announcement,
  onAnnouncement,
  showTemplates,
  onShowTemplates,
  templateName,
  onTemplateName,
}: {
  page: FormatBuilderPageDocument;
  initial: FormatEditorState;
  draft: Phase4FormatDraftView;
  onDraft(value: Phase4FormatDraftView): void;
  viewState: FormatSurfaceState;
  onViewState(value: FormatSurfaceState): void;
  busy: "validate" | "save" | "materialise" | "template" | null;
  onBusy(value: "validate" | "save" | "materialise" | "template" | null): void;
  announcement: string;
  onAnnouncement(value: string): void;
  showTemplates: boolean;
  onShowTemplates(value: boolean): void;
  templateName: string;
  onTemplateName(value: string): void;
}) {
  const [state, dispatch] = useReducer(formatEditorReducer, initial);
  const [templates, setTemplates] = useState(page.templates);
  const editable = !draft.read_only && draft.permission === "edit" && viewState !== "read-only";
  const valid = state.validation
    ? state.validation.valid
    : !state.dirty &&
      !draft.validation.pending &&
      draft.validation.validated_definition_hash === draft.definition_hash &&
      draft.validation.issues.length === 0;

  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const setPhoneDefault = () => {
      if (media.matches) dispatch({ type: "set_mode", mode: opaqueId("manual") });
    };
    setPhoneDefault();
    media.addEventListener("change", setPhoneDefault);
    return () => media.removeEventListener("change", setPhoneDefault);
  }, []);

  async function validate() {
    if (busy) return null;
    onBusy(opaqueId("validate"));
    onAnnouncement(opaqueId("Validating the exact working graph…"));
    try {
      const response = await fetch(
        `/api/phase4/competitions/${encodeURIComponent(page.competitionId)}/divisions/${encodeURIComponent(page.divisionId)}/format-builder/validate`,
        {
          method: opaqueId("POST"),
          headers: { "content-type": opaqueId("application/json") },
          body: JSON.stringify({ document: state.document }),
        },
      );
      const result = parseFormatValidation(await response.json().catch(() => null));
      if (!response.ok || !result) {
        if (response.status === 401 || response.status === 403) onViewState(opaqueId("permission"));
        else onAnnouncement(opaqueId("Validation could not complete."));
        return null;
      }
      dispatch({ type: "validation", validation: result });
      onAnnouncement(
        result.valid
          ? `Format valid. ${result.materialisation.match_count} matches can be materialised.`
          : `Format has ${result.issues.length} validation ${result.issues.length === 1 ? opaqueId("issue") : opaqueId("issues")}.`,
      );
      if (!result.valid && result.issues[0]) focusIssue(result.issues[0].path);
      return result;
    } catch {
      onViewState(opaqueId("offline"));
      return null;
    } finally {
      onBusy(null);
    }
  }

  async function save() {
    if (!editable || busy) return;
    const checked = state.validation ?? (await validate());
    if (!checked?.valid) return;
    onBusy(opaqueId("save"));
    onAnnouncement(opaqueId("Saving format draft…"));
    try {
      const response = await fetch(
        `/api/phase4/competitions/${encodeURIComponent(page.competitionId)}/divisions/${encodeURIComponent(page.divisionId)}/format-builder`,
        {
          method: opaqueId("PUT"),
          headers: { "content-type": opaqueId("application/json") },
          body: JSON.stringify(formatSaveBody(draft, state.document)),
        },
      );
      const next = parseFormatDraft(await response.json().catch(() => null), page.competitionId, page.divisionId);
      if (!response.ok || !next) {
        if (response.status === 409) onViewState(opaqueId("conflict"));
        else if (response.status === 401 || response.status === 403) onViewState(opaqueId("permission"));
        else onAnnouncement(opaqueId("The format draft could not be saved."));
        return;
      }
      onDraft(next);
      dispatch({ type: "replace_document", document: next.document });
      onAnnouncement(`Draft revision ${next.revision} saved.`);
    } catch {
      onViewState(opaqueId("offline"));
    } finally {
      onBusy(null);
    }
  }

  async function materialise() {
    if (busy || state.dirty || !valid) return;
    onBusy(opaqueId("materialise"));
    try {
      const response = await fetch(`/api/phase4/format-revisions/${encodeURIComponent(draft.draft_id)}/materialise`, {
        method: opaqueId("POST"),
        headers: { "content-type": opaqueId("application/json") },
        body: JSON.stringify({ idempotency_key: crypto.randomUUID() }),
      });
      const result = response.ok
        ? parseFormatMaterialisation(await response.json().catch(() => null), draft.draft_id)
        : null;
      if (!response.ok || !result) {
        if (response.status === 409) onViewState(opaqueId("conflict"));
        else onAnnouncement(opaqueId("Materialisation was blocked. Validate and save the current graph."));
        return;
      }
      onAnnouncement(
        result.idempotent_replay
          ? t("prototype.ddaf7c4e576a", { value1: result.match_count })
          : t("prototype.312322978db0", { value1: result.match_count }),
      );
    } catch {
      onViewState(opaqueId("offline"));
    } finally {
      onBusy(null);
    }
  }

  async function reuseTemplate(templateVersionId: string) {
    if (busy || state.dirty || !page.organisationId) return;
    onBusy(opaqueId("template"));
    try {
      const response = await fetch(
        `/api/phase4/organisations/${encodeURIComponent(page.organisationId)}/format-templates/apply`,
        {
          method: opaqueId("POST"),
          headers: { "content-type": opaqueId("application/json") },
          body: JSON.stringify({
            competition_id: page.competitionId,
            division_id: page.divisionId,
            template_version_id: templateVersionId,
            expected_format_revision: draft.revision,
            idempotency_key: crypto.randomUUID(),
          }),
        },
      );
      const next = parseFormatDraft(await response.json().catch(() => null), page.competitionId, page.divisionId);
      if (!response.ok || !next) {
        if (response.status === 409) onViewState(opaqueId("conflict"));
        else onAnnouncement(opaqueId("Template could not be reused."));
        return;
      }
      onDraft(next);
      dispatch({ type: "replace_document", document: next.document });
      onShowTemplates(false);
      onAnnouncement(opaqueId("Template version applied to a new format draft."));
    } catch {
      onViewState(opaqueId("offline"));
    } finally {
      onBusy(null);
    }
  }

  async function archiveTemplate(templateId: string) {
    if (busy || !page.organisationId) return;
    onBusy(opaqueId("template"));
    try {
      const response = await fetch(
        `/api/phase4/organisations/${encodeURIComponent(page.organisationId)}/format-templates/${encodeURIComponent(templateId)}/archive`,
        {
          method: opaqueId("POST"),
          headers: { "content-type": opaqueId("application/json") },
          body: JSON.stringify({
            template_id: templateId,
            expected_status: opaqueId("active"),
            idempotency_key: crypto.randomUUID(),
          }),
        },
      );
      const archived = response.ok
        ? parseOrganiserTemplate(await response.json().catch(() => null), page.organisationId)
        : null;
      if (!response.ok || !archived) {
        if (response.status === 409) onViewState(opaqueId("conflict"));
        else onAnnouncement(opaqueId("Template could not be archived."));
        return;
      }
      setTemplates((current) => current.map((item) => (item.template_id === archived.template_id ? archived : item)));
      onAnnouncement(`Template “${archived.name}” archived. Pinned competitions are unchanged.`);
    } catch {
      onViewState(opaqueId("offline"));
    } finally {
      onBusy(null);
    }
  }

  async function saveTemplate() {
    const sportCode = page.sportCode;
    if (!templateName.trim() || busy || state.dirty || !valid || !page.organisationId || !sportCode) return;
    onBusy(opaqueId("template"));
    try {
      const response = await fetch(
        `/api/phase4/organisations/${encodeURIComponent(page.organisationId)}/format-templates`,
        {
          method: opaqueId("POST"),
          headers: { "content-type": opaqueId("application/json") },
          body: JSON.stringify({
            template_id: null,
            parent_version_id: null,
            expected_version: null,
            name: templateName.trim(),
            description: null,
            sport_code: sportCode,
            source_format_revision_id: draft.draft_id,
            idempotency_key: crypto.randomUUID(),
          }),
        },
      );
      const saved = response.ok
        ? parseOrganiserTemplate(await response.json().catch(() => null), page.organisationId)
        : null;
      if (!response.ok || !saved) {
        onAnnouncement(
          response.status === 409
            ? opaqueId("That template changed. Reload before saving a new version.")
            : opaqueId("Template could not be saved."),
        );
        return;
      }
      setTemplates((current) => upsertOrganiserTemplate(current, saved));
      onAnnouncement(`Template “${saved.name}” saved.`);
      onShowTemplates(false);
      onTemplateName("");
    } catch {
      onViewState(opaqueId("offline"));
    } finally {
      onBusy(null);
    }
  }

  return (
    <FormatDesignerSurface
      page={page}
      state={state}
      dispatch={dispatch}
      draft={draft}
      editable={editable}
      busy={busy}
      announcement={announcement}
      viewState={viewState}
      showTemplates={showTemplates}
      templates={templates}
      templateName={templateName}
      valid={valid}
      onShowTemplates={onShowTemplates}
      onTemplateName={onTemplateName}
      onSave={() => void save()}
      onValidate={() => void validate()}
      onMaterialise={() => void materialise()}
      onSaveTemplate={() => void saveTemplate()}
      onReuseTemplate={(id) => void reuseTemplate(id)}
      onArchiveTemplate={(id) => void archiveTemplate(id)}
    />
  );
}
