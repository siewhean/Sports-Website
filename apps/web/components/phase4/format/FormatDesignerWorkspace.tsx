"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowRight, CloudSlash, GridFour, Warning } from "@phosphor-icons/react";
import type { FormatBuilderPageDocument, FormatEditorState, FormatSurfaceState } from "@/lib/phase4-format";
import type { FormatDivisionOption } from "@/lib/phase4-format-division";
import { resolveFormatWorkspaceRenderState } from "@/lib/phase4-format-workspace";
import { opaqueId, translate as t } from "@matchday/ui";
import { FormatEditor } from "./FormatDesignerParts";
import { DesignerSkeleton, DesignerState } from "./FormatDesignerPanels";

const stateCopy: Record<Exclude<FormatSurfaceState, "ready" | "loading" | "empty">, { title: string; body: string }> = {
  error: { title: t("prototype.825eb58e5ef2"), body: t("prototype.f7664bec2b06") },
  offline: { title: t("prototype.fb50f4d0f2aa"), body: t("prototype.58cc20f9863f") },
  permission: { title: t("prototype.754d312aa0d3"), body: t("prototype.72b2c902df68") },
  "read-only": { title: t("prototype.d7d6b6505b25"), body: t("prototype.f65cde1ae5a1") },
  conflict: { title: t("prototype.1c30d12dca7e"), body: t("prototype.0d51a3bd0ed6") },
  quota: { title: t("prototype.32da9c17ed32"), body: t("prototype.414488b9f927") },
  plan: { title: t("prototype.b21c9117015f"), body: t("prototype.366a21bb03b5") },
};

const hiddenHeadingStyle = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
} as const;

export function FormatDesignerWorkspace({
  page,
  divisions,
}: {
  page: FormatBuilderPageDocument;
  divisions: readonly FormatDivisionOption[];
}) {
  const [draft, setDraft] = useState(page.draft);
  const [viewState, setViewState] = useState(page.state);
  const [busy, setBusy] = useState<"validate" | "save" | "materialise" | "publish" | "template" | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [showTemplates, setShowTemplates] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [templateId, setTemplateId] = useState<string | null>(null);
  const initial = useMemo<FormatEditorState | null>(
    () =>
      draft
        ? {
            document: structuredClone(draft.document),
            selectedStageId: draft.document.graph.stages[0]?.id ?? null,
            mode: opaqueId("visual"),
            dirty: false,
            validation:
              draft.validation.pending || draft.validation.validated_definition_hash === null
                ? null
                : draft.validation.issues.length
                  ? { valid: false, issues: draft.validation.issues, graph_hash: null, materialisation: null }
                  : null,
          }
        : null,
    [draft],
  );
  const renderState = resolveFormatWorkspaceRenderState(viewState, Boolean(initial && draft));
  if (renderState === "loading") return <DesignerSkeleton />;
  if (renderState === "problem") {
    const problemState = viewState as keyof typeof stateCopy;
    const copy = stateCopy[problemState];
    return (
      <DesignerState
        icon={viewState === "offline" ? <CloudSlash /> : <Warning />}
        title={copy.title}
        body={copy.body}
        action={
          viewState === "conflict" ? (
            <button onClick={() => window.location.reload()}>{t("prototype.4b46950ea4dd")}</button>
          ) : undefined
        }
      />
    );
  }
  if (renderState === "empty" || !initial || !draft)
    return (
      <DesignerState
        icon={<GridFour />}
        title={t("prototype.caa4511dd910")}
        body={t("prototype.d30c489ec255")}
        action={
          <Link href={`/organiser/competitions/${page.competitionId}/setup`}>
            {t("prototype.e2a78250c5f5")}
            <ArrowRight />
          </Link>
        }
      />
    );
  return (
    <>
      <h1 style={hiddenHeadingStyle}>{t("prototype.675eeee2578b")}</h1>
      <FormatEditor
        key={draft.draft_id}
        page={page}
        divisions={divisions}
        initial={initial}
        draft={draft}
        onDraft={setDraft}
        viewState={viewState}
        onViewState={setViewState}
        busy={busy}
        onBusy={setBusy}
        announcement={announcement}
        onAnnouncement={setAnnouncement}
        showTemplates={showTemplates}
        onShowTemplates={setShowTemplates}
        templateName={templateName}
        onTemplateName={setTemplateName}
        templateId={templateId}
        onTemplateId={setTemplateId}
      />
    </>
  );
}
