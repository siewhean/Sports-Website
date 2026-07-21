"use client";

import Link from "next/link";
import { useEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import {
  ArrowCounterClockwise,
  ArrowRight,
  Check,
  CheckCircle,
  CloudSlash,
  CornersOut,
  DotsThreeVertical,
  GitBranch,
  GridFour,
  Info,
  ListChecks,
  Medal,
  Plus,
  SquaresFour,
  Trash,
  Trophy,
  UsersThree,
  Warning,
  X,
} from "@phosphor-icons/react";
import type { Phase4FormatDraftView, Phase4FormatGraphStage } from "@matchday/contracts";
import {
  formatEditorReducer,
  formatSaveBody,
  formatStageLibrary,
  nextStageId,
  parseFormatDraft,
  parseFormatMaterialisation,
  parseOrganiserTemplate,
  parseFormatValidation,
  type FormatBuilderPageDocument,
  type FormatEditorState,
  type FormatSurfaceState,
} from "@/lib/phase4-format";
import styles from "./FormatDesignerWorkspace.module.css";
import { opaqueId, translate as t } from "@matchday/ui";

const NODE_WIDTH = 210;
const NODE_HEIGHT = 132;
const MOVE_STEP = 12;

const stateCopy: Record<Exclude<FormatSurfaceState, "ready" | "loading" | "empty">, { title: string; body: string }> = {
  error: { title: t("prototype.825eb58e5ef2"), body: t("prototype.f7664bec2b06") },
  offline: { title: t("prototype.fb50f4d0f2aa"), body: t("prototype.58cc20f9863f") },
  permission: { title: t("prototype.754d312aa0d3"), body: t("prototype.72b2c902df68") },
  "read-only": { title: t("prototype.d7d6b6505b25"), body: t("prototype.f65cde1ae5a1") },
  conflict: { title: t("prototype.1c30d12dca7e"), body: t("prototype.0d51a3bd0ed6") },
  quota: { title: t("prototype.32da9c17ed32"), body: t("prototype.414488b9f927") },
  plan: { title: t("prototype.b21c9117015f"), body: t("prototype.366a21bb03b5") },
};

export function FormatDesignerWorkspace({ page }: { page: FormatBuilderPageDocument }) {
  const [draft, setDraft] = useState(page.draft);
  const [viewState, setViewState] = useState(page.state);
  const [busy, setBusy] = useState<"validate" | "save" | "materialise" | "template" | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [showTemplates, setShowTemplates] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const initial = useMemo<FormatEditorState | null>(
    () =>
      page.draft
        ? {
            document: structuredClone(page.draft.document),
            selectedStageId: page.draft.document.graph.stages[0]?.id ?? null,
            mode: opaqueId("visual"),
            dirty: false,
            validation:
              page.draft.validation.pending || page.draft.validation.validated_definition_hash === null
                ? null
                : page.draft.validation.issues.length
                  ? { valid: false, issues: page.draft.validation.issues, graph_hash: null, materialisation: null }
                  : null,
          }
        : null,
    [page.draft],
  );
  if (viewState === "loading") return <DesignerSkeleton />;
  if (viewState === "empty" || !initial || !draft)
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
  if (viewState !== "ready" && viewState !== "read-only") {
    const copy = stateCopy[viewState];
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
  return (
    <FormatEditor
      key={draft.draft_id}
      page={page}
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
    />
  );
}

function FormatEditor({
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
  const canvasRef = useRef<HTMLDivElement>(null);
  const templateTriggerRef = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ stageId: string; pointerId: number; dx: number; dy: number } | null>(null);
  const selected = state.document.graph.stages.find((stage) => stage.id === state.selectedStageId) ?? null;
  const positions = useMemo(
    () => new Map(state.document.layout.stage_positions.map((position) => [position.stage_id, position])),
    [state.document.layout.stage_positions],
  );
  const editable = !draft.read_only && draft.permission === "edit" && viewState !== "read-only";
  const connections = useMemo(
    () => buildConnections(state.document.graph.matches, positions),
    [state.document, positions],
  );
  const validationIssues = state.validation?.issues ?? draft.validation.issues;
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
    if (!templateName.trim() || busy || state.dirty || !valid || !page.organisationId) return;
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
            sport_code: opaqueId("canoe_polo"),
            source_format_revision_id: draft.draft_id,
            idempotency_key: crypto.randomUUID(),
          }),
        },
      );
      if (!response.ok) {
        onAnnouncement(
          response.status === 409
            ? opaqueId("That template changed. Reload before saving a new version.")
            : opaqueId("Template could not be saved."),
        );
        return;
      }
      onAnnouncement(`Template “${templateName.trim()}” saved.`);
      onShowTemplates(false);
      onTemplateName("");
    } catch {
      onViewState(opaqueId("offline"));
    } finally {
      onBusy(null);
    }
  }

  function addStage(kind: Phase4FormatGraphStage["kind"], x = 80, y = 80) {
    if (!editable) return;
    const definition = formatStageLibrary.find((item) => item.kind === kind);
    const label = definition?.label ?? "Stage";
    const stage: Phase4FormatGraphStage = {
      id: nextStageId(state.document.graph, label),
      label,
      kind,
      order: state.document.graph.stages.length + 1,
      groupIds: kind === "group" ? [`G${state.document.graph.stages.length + 1}`] : [],
      groupSize: kind === "group" ? 4 : null,
      outputRanks: kind === "bronze" ? 1 : 2,
      matchIds: [],
      qualificationPositions: [1],
      destinationStageIds: [],
      seeding: opaqueId("seeded"),
    };
    dispatch({ type: "add_stage", stage, x, y });
  }

  function startDrag(event: PointerEvent<HTMLButtonElement>, stageId: string) {
    if (!editable || event.button !== 0) return;
    const canvas = canvasRef.current;
    const position = positions.get(stageId);
    if (!canvas || !position) return;
    const bounds = canvas.getBoundingClientRect();
    drag.current = {
      stageId,
      pointerId: event.pointerId,
      dx: event.clientX - bounds.left - position.x,
      dy: event.clientY - bounds.top - position.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    dispatch({ type: "select_stage", stageId });
  }

  function moveDrag(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    const canvas = canvasRef.current;
    if (!current || current.pointerId !== event.pointerId || !canvas) return;
    const bounds = canvas.getBoundingClientRect();
    dispatch({
      type: "move_stage",
      stageId: current.stageId,
      x: Math.min(bounds.width - NODE_WIDTH, event.clientX - bounds.left - current.dx),
      y: Math.min(bounds.height - NODE_HEIGHT, event.clientY - bounds.top - current.dy),
    });
  }

  function stopDrag(event: PointerEvent<HTMLButtonElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    drag.current = null;
  }

  function keyboardMove(event: KeyboardEvent<HTMLButtonElement>, stageId: string) {
    const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    const position = positions.get(stageId);
    if (!delta || !position || !editable) return;
    event.preventDefault();
    const step = event.shiftKey ? MOVE_STEP * 2 : MOVE_STEP;
    dispatch({ type: "move_stage", stageId, x: position.x + delta[0]! * step, y: position.y + delta[1]! * step });
  }

  return (
    <div className={styles.designer} data-testid="phase4-format-designer">
      <header className={styles.commandBar}>
        <div className={styles.context}>
          <Link href={`/organiser/competitions/${page.competitionId}`} aria-label={t("prototype.52bf5663e489")}>
            {t("prototype.08f271887ce9")}
          </Link>
          <span>
            <strong>{page.competitionName}</strong>
            <small>{page.divisionName}</small>
          </span>
        </div>
        <div className={styles.modeSwitch} role="group" aria-label={t("prototype.d4d9f813ef5b")}>
          <button
            aria-pressed={state.mode === "visual"}
            type="button"
            onClick={() => dispatch({ type: "set_mode", mode: opaqueId("visual") })}
          >
            <SquaresFour /> {t("prototype.ba3033214fe4")}
          </button>
          <button
            aria-pressed={state.mode === "manual"}
            type="button"
            onClick={() => dispatch({ type: "set_mode", mode: opaqueId("manual") })}
          >
            <ListChecks /> {t("prototype.b0b9fe24ffa9")}
          </button>
        </div>
        <div className={styles.commandActions}>
          <span data-saved={!state.dirty}>
            <CheckCircle />
            {state.dirty ? t("prototype.a710c2b90913") : `Draft r${draft.revision} saved`}
          </span>
          <button
            ref={templateTriggerRef}
            type="button"
            className={styles.secondaryCommand}
            onClick={() => onShowTemplates(true)}
            disabled={!editable || state.dirty}
          >
            {t("prototype.56b564b75c7f")}
          </button>
          <button
            type="button"
            className={styles.primaryCommand}
            onClick={() => void save()}
            disabled={!editable || busy !== null || !state.dirty}
          >
            {busy === "save" ? t("prototype.23e39291d613") : t("prototype.1509f561f241")}
          </button>
          <button className={styles.iconCommand} type="button" aria-label={t("prototype.6c0d50de0f82")}>
            <DotsThreeVertical />
          </button>
        </div>
      </header>

      {viewState === "read-only" ? (
        <div className={styles.banner} role="status">
          <Info />
          {t("prototype.aa040aab458f")}
        </div>
      ) : null}
      {showTemplates ? (
        <TemplateDialog
          templates={templates}
          name={templateName}
          onName={onTemplateName}
          busy={busy === "template"}
          canSave={!state.dirty && valid && Boolean(page.organisationId)}
          onClose={() => {
            onShowTemplates(false);
            window.requestAnimationFrame(() => templateTriggerRef.current?.focus());
          }}
          onSave={() => void saveTemplate()}
          onReuse={(id) => void reuseTemplate(id)}
          onArchive={(id) => void archiveTemplate(id)}
        />
      ) : null}

      <div className={styles.body}>
        <aside className={styles.library} aria-label={t("prototype.f514fa20697a")}>
          <p>{t("prototype.f514fa20697a")}</p>
          {formatStageLibrary.map((definition) => (
            <button key={definition.kind} type="button" disabled={!editable} onClick={() => addStage(definition.kind)}>
              <span>{stageIcon(definition.kind)}</span>
              <span>
                <strong>{definition.label}</strong>
                <small>{definition.detail}</small>
              </span>
              <Plus />
            </button>
          ))}
          <div>
            <CornersOut />
            <span>{t("prototype.6f0a0a2ad6b8")}</span>
          </div>
        </aside>

        <main className={styles.surface}>
          {state.mode === "visual" ? (
            <div ref={canvasRef} className={styles.canvas} data-testid="format-canvas">
              <svg className={styles.connections} aria-label={t("prototype.775875fcc186")}>
                <defs>
                  <marker
                    id="phase4-arrow"
                    viewBox="0 0 8 8"
                    refX={t("prototype.7902699be42c")}
                    refY={t("prototype.4b227777d4dd")}
                    markerWidth={t("prototype.e7f6c011776e")}
                    markerHeight={t("prototype.e7f6c011776e")}
                    orient={t("prototype.929260ad9b9e")}
                  >
                    <path d="M0 0 8 4 0 8Z" />
                  </marker>
                </defs>
                {connections.map((connection) => (
                  <path key={connection.id} d={connection.path} />
                ))}
              </svg>
              {state.document.graph.stages.map((stage) => {
                const position = positions.get(stage.id);
                if (!position) return null;
                return (
                  <button
                    key={stage.id}
                    className={styles.stageNode}
                    data-stage-index={state.document.graph.stages.indexOf(stage)}
                    data-selected={stage.id === state.selectedStageId}
                    style={{ transform: `translate3d(${position.x}px, ${position.y}px, 0)` }}
                    type="button"
                    onClick={() => dispatch({ type: "select_stage", stageId: stage.id })}
                    onPointerDown={(event) => startDrag(event, stage.id)}
                    onPointerMove={moveDrag}
                    onPointerUp={stopDrag}
                    onPointerCancel={stopDrag}
                    onKeyDown={(event) => keyboardMove(event, stage.id)}
                    aria-label={`${stage.label}. Use arrow keys to move.`}
                  >
                    <header>
                      <span>{stageIcon(stage.kind)}</span>
                      <strong>{stage.label}</strong>
                      <DotsThreeVertical />
                    </header>
                    <p>{stage.kind.replaceAll("_", " ")}</p>
                    <small>
                      {stage.matchIds.length}{" "}
                      {stage.matchIds.length === 1 ? t("prototype.4945a70fa7f9") : t("prototype.a54084383e3c")}
                    </small>
                    <span className={styles.nodePort} aria-hidden="true" />
                  </button>
                );
              })}
              <div className={styles.zoomControls} aria-label={t("prototype.832e45f70532")}>
                <button type="button" aria-label={t("prototype.438c41a7af19")}>
                  <CornersOut />
                </button>
                <button type="button" aria-label={t("prototype.29682be8aa7d")}>
                  <ArrowCounterClockwise />
                </button>
              </div>
            </div>
          ) : (
            <ManualBuilder state={state} editable={editable} dispatch={dispatch} />
          )}
        </main>

        <aside className={styles.inspector} aria-label={t("prototype.b24b93d158db")}>
          <header>
            <p>{t("prototype.b24b93d158db")}</p>
            <button
              type="button"
              aria-label={t("prototype.cea4d2e010b8")}
              onClick={() => dispatch({ type: "select_stage", stageId: null })}
            >
              <X />
            </button>
          </header>
          {selected ? (
            <Inspector
              stage={selected}
              editable={editable}
              dispatch={dispatch}
              issue={
                validationIssues.find(
                  (item) =>
                    item.path.includes(selected.id) ||
                    item.path.includes(`stages[${state.document.graph.stages.indexOf(selected)}]`),
                )?.message
              }
            />
          ) : (
            <div className={styles.noSelection}>
              <Info />
              <p>{t("prototype.91702227a9c9")}</p>
            </div>
          )}
        </aside>
      </div>

      <footer className={styles.validationBar} data-valid={valid && !state.dirty} data-testid="format-validation-bar">
        <div>
          {valid && !state.dirty ? <Check /> : validationIssues.length ? <Warning /> : <Info />}
          <span>
            <strong>
              {valid && !state.dirty
                ? t("prototype.b1de949fcc97")
                : validationIssues.length
                  ? `${validationIssues.length} validation ${validationIssues.length === 1 ? t("prototype.4a502846d070") : t("prototype.02e3fe5aad80")}`
                  : state.dirty
                    ? t("prototype.afb73acd1100")
                    : t("prototype.e6bbe9a6d9b9")}
            </strong>
            <small>
              {valid
                ? `${state.validation?.valid ? state.validation.materialisation.match_count : draft.metrics.match_count} matches · hash ${(state.validation?.valid ? state.validation.graph_hash : draft.definition_hash).slice(0, 10)}`
                : t("prototype.ac77bbab0d40")}
            </small>
          </span>
        </div>
        <div className={styles.validationActions}>
          <button type="button" onClick={() => void validate()} disabled={busy !== null}>
            {busy === "validate" ? t("prototype.cd51f8c88998") : t("prototype.a8d8bdf0bca9")}
          </button>
          <button type="button" onClick={() => void materialise()} disabled={busy !== null || state.dirty || !valid}>
            {busy === "materialise" ? t("prototype.27248e20d2d7") : t("prototype.bafe874a510c")}
          </button>
        </div>
        <p aria-live="polite">{announcement}</p>
      </footer>
    </div>
  );
}

function ManualBuilder({
  state,
  editable,
  dispatch,
}: {
  state: FormatEditorState;
  editable: boolean;
  dispatch: React.Dispatch<Parameters<typeof formatEditorReducer>[1]>;
}) {
  return (
    <div className={styles.manual}>
      <header>
        <div>
          <p>{t("prototype.a0b084069534")}</p>
          <h1>{t("prototype.09bf6eb9e9ec")}</h1>
        </div>
        <button
          type="button"
          disabled={!editable}
          onClick={() => {
            const label = opaqueId("New stage");
            dispatch({
              type: "add_stage",
              stage: {
                id: nextStageId(state.document.graph, label),
                label,
                kind: "group",
                order: state.document.graph.stages.length + 1,
                groupIds: [`G${state.document.graph.stages.length + 1}`],
                groupSize: 4,
                outputRanks: 2,
                matchIds: [],
                qualificationPositions: [1, 2],
                destinationStageIds: [],
                seeding: opaqueId("seeded"),
              },
              x: 70,
              y: 70,
            });
          }}
        >
          <Plus /> {t("prototype.76fa771d57f8")}
        </button>
      </header>
      <ol>
        {state.document.graph.stages.map((stage, index) => (
          <li
            key={stage.id}
            data-stage-index={index}
            data-selected={stage.id === state.selectedStageId}
            tabIndex={-1}
          >
            <button
              type="button"
              className={styles.manualSelect}
              onClick={() => dispatch({ type: "select_stage", stageId: stage.id })}
            >
              <span>{String(index + 1).padStart(2, "0")}</span>
              <strong>{stage.label}</strong>
              <small>{stage.kind.replaceAll("_", " ")}</small>
            </button>
            <label>
              <span>{t("prototype.1f31e5b6c525")}</span>
              <input
                value={stage.label}
                disabled={!editable}
                onChange={(event) =>
                  dispatch({ type: "update_stage", stageId: stage.id, patch: { label: event.target.value } })
                }
              />
            </label>
            <label>
              <span>{t("prototype.bc1e201eb038")}</span>
              <select
                value={stage.kind}
                disabled={!editable}
                onChange={(event) =>
                  dispatch({
                    type: "update_stage",
                    stageId: stage.id,
                    patch: { kind: event.target.value as Phase4FormatGraphStage["kind"] },
                  })
                }
              >
                {formatStageLibrary.map((item) => (
                  <option value={item.kind} key={item.kind}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{t("prototype.cb04725bcb62")}</span>
              <input
                type="number"
                min={0}
                max={64}
                value={stage.outputRanks}
                disabled={!editable}
                onChange={(event) =>
                  dispatch({
                    type: "update_stage",
                    stageId: stage.id,
                    patch: { outputRanks: Number(event.target.value) },
                  })
                }
              />
            </label>
            <label>
              <span>{t("prototype.ee12c1cc2939")}</span>
              <input
                value={(stage.destinationStageIds ?? []).join(", ")}
                disabled={!editable}
                onChange={(event) =>
                  dispatch({
                    type: "update_stage",
                    stageId: stage.id,
                    patch: {
                      destinationStageIds: event.target.value
                        .split(",")
                        .map((value) => value.trim())
                        .filter(Boolean),
                    },
                  })
                }
              />
            </label>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Inspector({
  stage,
  editable,
  dispatch,
  issue,
}: {
  stage: Phase4FormatGraphStage;
  editable: boolean;
  dispatch: React.Dispatch<Parameters<typeof formatEditorReducer>[1]>;
  issue?: string;
}) {
  return (
    <div className={styles.inspectorForm}>
      <label data-issue={Boolean(issue)}>
        <span>{t("prototype.1f31e5b6c525")}</span>
        <input
          value={stage.label}
          disabled={!editable}
          onChange={(event) =>
            dispatch({ type: "update_stage", stageId: stage.id, patch: { label: event.target.value } })
          }
        />
        {issue ? <small role="alert">{issue}</small> : null}
      </label>
      <label>
        <span>{t("prototype.bc1e201eb038")}</span>
        <select
          value={stage.kind}
          disabled={!editable}
          onChange={(event) =>
            dispatch({
              type: "update_stage",
              stageId: stage.id,
              patch: { kind: event.target.value as Phase4FormatGraphStage["kind"] },
            })
          }
        >
          {formatStageLibrary.map((item) => (
            <option value={item.kind} key={item.kind}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>{t("prototype.a7594de07874")}</span>
        <input
          value={(stage.qualificationPositions ?? []).join(", ")}
          disabled={!editable}
          onChange={(event) =>
            dispatch({
              type: "update_stage",
              stageId: stage.id,
              patch: {
                qualificationPositions: event.target.value
                  .split(",")
                  .map(Number)
                  .filter((value) => Number.isInteger(value) && value > 0),
              },
            })
          }
        />
      </label>
      <label>
        <span>{t("prototype.156b83993b58")}</span>
        <input
          value={(stage.destinationStageIds ?? []).join(", ")}
          disabled={!editable}
          onChange={(event) =>
            dispatch({
              type: "update_stage",
              stageId: stage.id,
              patch: {
                destinationStageIds: event.target.value
                  .split(",")
                  .map((value) => value.trim())
                  .filter(Boolean),
              },
            })
          }
        />
      </label>
      <label>
        <span>{t("prototype.34c15fc4a4ac")}</span>
        <select
          value={stage.seeding ?? "seeded"}
          disabled={!editable}
          onChange={(event) =>
            dispatch({
              type: "update_stage",
              stageId: stage.id,
              patch: { seeding: event.target.value as NonNullable<Phase4FormatGraphStage["seeding"]> },
            })
          }
        >
          <option value="seeded">{t("prototype.0bdff5f34767")}</option>
          <option value="snake">{t("prototype.aaa73ac77213")}</option>
          <option value="random">{t("prototype.67bc484430fe")}</option>
          <option value="manual">{t("prototype.b0b9fe24ffa9")}</option>
        </select>
      </label>
      <button
        type="button"
        className={styles.removeStage}
        disabled={!editable}
        onClick={() => dispatch({ type: "remove_stage", stageId: stage.id })}
      >
        <Trash /> {t("prototype.1c2a084f678e")}
      </button>
      <p>
        <Info /> {t("prototype.425ac6236004")}
      </p>
    </div>
  );
}

function TemplateDialog({
  templates,
  name,
  onName,
  busy,
  canSave,
  onClose,
  onSave,
  onReuse,
  onArchive,
}: {
  templates: FormatBuilderPageDocument["templates"];
  name: string;
  onName(value: string): void;
  busy: boolean;
  canSave: boolean;
  onClose(): void;
  onSave(): void;
  onReuse(id: string): void;
  onArchive(id: string): void;
}) {
  const dialogRef = useRef<HTMLElement>(null);

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]',
      ) ?? [],
    );
    const first = controls[0];
    const last = controls.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className={styles.dialogBackdrop}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="template-title"
        onKeyDown={handleKeyDown}
      >
        <header>
          <div>
            <p>{t("prototype.0708dc3add19")}</p>
            <h2 id="template-title">{t("prototype.3319af2a6a28")}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label={t("prototype.7d9eb7acb13e")}>
            <X />
          </button>
        </header>
        {templates.length ? (
          <ul className={styles.templateList}>
            {templates.map((template) => (
              <li key={template.template_version_id} data-archived={template.status === "archived"}>
                <div>
                  <strong>{template.name}</strong>
                  <small>
                    {t("prototype.dd167905de0d")}
                    {template.revision} · {template.status}
                  </small>
                </div>
                <button
                  type="button"
                  disabled={busy || template.status === "archived"}
                  onClick={() => onReuse(template.template_version_id)}
                >
                  {t("prototype.7c975f737516")}
                </button>
                <button
                  type="button"
                  disabled={busy || template.status === "archived"}
                  onClick={() => onArchive(template.template_id)}
                >
                  {t("prototype.66f4804ee23d")}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.templateEmpty}>{t("prototype.173c1e65f846")}</p>
        )}
        <label>
          <span>{t("prototype.0a05447da7d3")}</span>
          <input autoFocus value={name} maxLength={120} onChange={(event) => onName(event.target.value)} />
          <small>{t("prototype.a26ecb810eb9")}</small>
        </label>
        <footer>
          <button type="button" onClick={onClose}>
            {t("prototype.19766ed6ccb2")}
          </button>
          <button type="button" disabled={!canSave || !name.trim() || busy} onClick={onSave}>
            {busy ? t("prototype.23e39291d613") : t("prototype.47f72a2f3e91")}
          </button>
        </footer>
      </section>
    </div>
  );
}
function DesignerState({
  icon,
  title,
  body,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <section className={styles.state}>
      <span>{icon}</span>
      <h1>{title}</h1>
      <p>{body}</p>
      {action}
    </section>
  );
}
function DesignerSkeleton() {
  return (
    <div className={styles.skeleton} aria-label={t("prototype.7d9c2feb8c9a")}>
      <span />
      <span />
      <span />
    </div>
  );
}
function focusIssue(path: string) {
  const stageIndex = /stages\[(\d+)\]/.exec(path)?.[1];
  window.requestAnimationFrame(() => {
    (stageIndex
      ? document.querySelector<HTMLElement>(`[data-stage-index="${stageIndex}"]`)
      : document.querySelector<HTMLElement>("[data-issue='true']")
    )?.focus();
  });
}
function stageIcon(kind: Phase4FormatGraphStage["kind"]) {
  if (kind === "group") return <UsersThree />;
  if (kind === "placement" || kind === "bronze") return <Medal />;
  if (kind === "single_elimination") return <Trophy />;
  if (kind === "round_robin") return <SquaresFour />;
  return <GitBranch />;
}
function buildConnections(
  matches: readonly { id: string; stageId: string; home: unknown; away: unknown }[],
  positions: Map<string, { x: number; y: number }>,
) {
  const stageByMatch = new Map(matches.map((match) => [match.id, match.stageId]));
  const keys = new Set<string>();
  const result: Array<{ id: string; path: string }> = [];
  for (const match of matches)
    for (const source of [match.home, match.away]) {
      const item = source as { type?: string; stageId?: string; matchId?: string };
      const fromId =
        item.type === "stage_rank"
          ? item.stageId
          : item.type === "winner" || item.type === "loser"
            ? stageByMatch.get(item.matchId ?? "")
            : null;
      if (!fromId || fromId === match.stageId) continue;
      const key = `${fromId}:${match.stageId}`;
      if (keys.has(key)) continue;
      const from = positions.get(fromId);
      const to = positions.get(match.stageId);
      if (!from || !to) continue;
      keys.add(key);
      const x1 = from.x + NODE_WIDTH;
      const y1 = from.y + NODE_HEIGHT / 2;
      const x2 = to.x;
      const y2 = to.y + NODE_HEIGHT / 2;
      const mx = x1 + Math.max(45, (x2 - x1) / 2);
      result.push({ id: key, path: `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}` });
    }
  return result;
}
