"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, type KeyboardEvent, type PointerEvent } from "react";
import {
  ArrowCounterClockwise,
  Check,
  CheckCircle,
  CornersOut,
  DotsThreeVertical,
  Info,
  ListChecks,
  Plus,
  SquaresFour,
  Warning,
  X,
} from "@phosphor-icons/react";
import type { Phase4FormatDraftView, Phase4FormatGraphStage, Phase4OrganiserTemplateView } from "@matchday/contracts";
import {
  formatEditorReducer,
  formatStageLibrary,
  nextStageId,
  type FormatBuilderPageDocument,
  type FormatEditorState,
  type FormatSurfaceState,
} from "@/lib/phase4-format";
import { formatDivisionHref, type FormatDivisionOption } from "@/lib/phase4-format-division";
import { opaqueId, translate as t } from "@matchday/ui";
import styles from "./FormatDesignerWorkspace.module.css";
import { Inspector, ManualBuilder, TemplateDialog } from "./FormatDesignerPanels";
import { buildConnections, NODE_HEIGHT, NODE_WIDTH, MOVE_STEP, stageIcon } from "./format-designer-helpers";

type BusyState = "validate" | "save" | "materialise" | "publish" | "template" | null;

type FormatDesignerSurfaceProps = {
  page: FormatBuilderPageDocument;
  divisions: readonly FormatDivisionOption[];
  state: FormatEditorState;
  dispatch: React.Dispatch<Parameters<typeof formatEditorReducer>[1]>;
  draft: Phase4FormatDraftView;
  editable: boolean;
  busy: BusyState;
  announcement: string;
  viewState: FormatSurfaceState;
  showTemplates: boolean;
  templates: readonly Phase4OrganiserTemplateView[];
  templateName: string;
  templateId: string | null;
  valid: boolean;
  onShowTemplates(value: boolean): void;
  onTemplateName(value: string): void;
  onTemplateId(value: string | null): void;
  onSave(): void;
  onValidate(): void;
  onMaterialise(): void;
  onPublish(): void;
  onSaveTemplate(): void;
  onReuseTemplate(id: string): void;
  onArchiveTemplate(id: string): void;
};

export function FormatDesignerSurface({
  page,
  divisions,
  state,
  dispatch,
  draft,
  editable,
  busy,
  announcement,
  viewState,
  showTemplates,
  templates,
  templateName,
  templateId,
  valid,
  onShowTemplates,
  onTemplateName,
  onTemplateId,
  onSave,
  onValidate,
  onMaterialise,
  onPublish,
  onSaveTemplate,
  onReuseTemplate,
  onArchiveTemplate,
}: FormatDesignerSurfaceProps) {
  const router = useRouter();
  const canvasRef = useRef<HTMLDivElement>(null);
  const templateTriggerRef = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ stageId: string; pointerId: number; dx: number; dy: number } | null>(null);
  const selected = state.document.graph.stages.find((stage) => stage.id === state.selectedStageId) ?? null;
  const positions = useMemo(
    () => new Map(state.document.layout.stage_positions.map((position) => [position.stage_id, position])),
    [state.document.layout.stage_positions],
  );
  const connections = useMemo(
    () => buildConnections(state.document.graph.matches, positions),
    [state.document, positions],
  );
  const validationIssues = state.validation?.issues ?? draft.validation.issues;

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
    <div
      className={styles.designer}
      data-testid="phase4-format-designer"
      data-division-id={page.divisionId}
      data-draft-id={draft.draft_id}
    >
      <header className={styles.commandBar}>
        <div className={styles.context}>
          <Link href={`/organiser/competitions/${page.competitionId}`} aria-label={t("prototype.52bf5663e489")}>
            {t("prototype.08f271887ce9")}
          </Link>
          <span>
            <strong>{page.competitionName}</strong>
            {divisions.length > 1 ? (
              <select
                className={styles.divisionSelect}
                aria-label={t("prototype.85a0c348e2a1")}
                value={page.divisionId}
                disabled={state.dirty || busy !== null}
                onChange={(event) => router.push(formatDivisionHref(page.competitionId, event.currentTarget.value))}
              >
                {divisions.map((division) => (
                  <option key={division.id} value={division.id}>
                    {division.name}
                  </option>
                ))}
              </select>
            ) : (
              <small>{page.divisionName}</small>
            )}
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
            onClick={onSave}
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
          selectedTemplateId={templateId}
          onName={onTemplateName}
          onSelect={(template) => {
            onTemplateId(template.template_id);
            onTemplateName(template.name);
          }}
          busy={busy === "template"}
          canSave={!state.dirty && valid && Boolean(page.organisationId && page.sportCode)}
          onClose={() => {
            onShowTemplates(false);
            onTemplateId(null);
            onTemplateName("");
            window.requestAnimationFrame(() => templateTriggerRef.current?.focus());
          }}
          onSave={onSaveTemplate}
          onReuse={onReuseTemplate}
          onArchive={onArchiveTemplate}
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
                    data-stage-id={stage.id}
                    data-stage-x={position.x}
                    data-stage-y={position.y}
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
          <button type="button" onClick={onValidate} disabled={busy !== null}>
            {busy === "validate" ? t("prototype.cd51f8c88998") : t("prototype.a8d8bdf0bca9")}
          </button>
          <button type="button" onClick={onMaterialise} disabled={!editable || busy !== null || state.dirty || !valid}>
            {busy === "materialise" ? t("prototype.27248e20d2d7") : t("prototype.bafe874a510c")}
          </button>
          <button type="button" onClick={onPublish} disabled={!editable || busy !== null || state.dirty || !valid}>
            {busy === "publish" ? opaqueId("Publishing…") : opaqueId("Publish format")}
          </button>
        </div>
        <p aria-live="polite">{announcement}</p>
      </footer>
    </div>
  );
}
