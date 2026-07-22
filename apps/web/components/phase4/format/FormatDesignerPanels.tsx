"use client";

import { useRef, type KeyboardEvent } from "react";
import { Info, Plus, Trash, X } from "@phosphor-icons/react";
import type { Phase4FormatGraphStage } from "@matchday/contracts";
import {
  formatEditorReducer,
  formatStageLibrary,
  nextStageId,
  type FormatBuilderPageDocument,
  type FormatEditorState,
} from "@/lib/phase4-format";
import { opaqueId, translate as t } from "@matchday/ui";
import styles from "./FormatDesignerWorkspace.module.css";

export function ManualBuilder({
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
        {state.document.graph.stages.map((stage, index) => {
          const position = state.document.layout.stage_positions.find((item) => item.stage_id === stage.id)!;
          return (
            <li
              key={stage.id}
              data-stage-index={index}
              data-stage-id={stage.id}
              data-stage-x={position.x}
              data-stage-y={position.y}
              data-selected={stage.id === state.selectedStageId}
              tabIndex={-1}
            >
              <output className="visually-hidden" aria-label={`${stage.label} canvas position`}>
                {opaqueId(`Canvas position ${position.x}, ${position.y}`)}
              </output>
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
          );
        })}
      </ol>
    </div>
  );
}

export function Inspector({
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

export function TemplateDialog({
  templates,
  name,
  selectedTemplateId,
  onName,
  onSelect,
  busy,
  canSave,
  onClose,
  onSave,
  onReuse,
  onArchive,
}: {
  templates: FormatBuilderPageDocument["templates"];
  name: string;
  selectedTemplateId: string | null;
  onName(value: string): void;
  onSelect(template: FormatBuilderPageDocument["templates"][number]): void;
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
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]",
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
              <li
                key={template.template_id}
                data-archived={template.status === "archived"}
                data-selected={template.template_id === selectedTemplateId}
              >
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
                  onClick={() => onSelect(template)}
                >
                  {opaqueId("Update")}
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
          <span>{selectedTemplateId ? opaqueId("Updated template name") : t("prototype.0a05447da7d3")}</span>
          <input autoFocus value={name} maxLength={120} onChange={(event) => onName(event.target.value)} />
          <small>{t("prototype.a26ecb810eb9")}</small>
        </label>
        <footer>
          <button type="button" onClick={onClose}>
            {t("prototype.19766ed6ccb2")}
          </button>
          <button type="button" disabled={!canSave || !name.trim() || busy} onClick={onSave}>
            {busy
              ? t("prototype.23e39291d613")
              : selectedTemplateId
                ? opaqueId("Save new version")
                : t("prototype.47f72a2f3e91")}
          </button>
        </footer>
      </section>
    </div>
  );
}

export function DesignerState({
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

export function DesignerSkeleton() {
  return (
    <div className={styles.skeleton} aria-label={t("prototype.7d9c2feb8c9a")}>
      <span />
      <span />
      <span />
    </div>
  );
}
