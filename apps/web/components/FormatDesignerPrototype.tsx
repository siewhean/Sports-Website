"use client";

import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type PointerEvent } from "react";
import {
  ArrowsClockwise,
  CheckCircle,
  CloudSlash,
  CornersOut,
  CursorClick,
  ListChecks,
  Medal,
  Minus,
  Plus,
  Trash,
  Trophy,
  UsersThree,
  Warning,
} from "@phosphor-icons/react";
import { opaqueId, translate as t } from "@matchday/ui";
import styles from "./FormatDesignerPrototype.module.css";
import { cssModuleClasses as cx } from "./prototype/cssModuleClasses";
import primitiveStyles from "./prototype/PrototypePrimitives.module.css";
import {
  KEYBOARD_MOVE_STEP,
  STAGE_NODE_SIZE,
  clampStagePosition,
  findAvailableStagePosition,
  getAdvancementPath,
  resolveDroppedStagePosition,
  type AdvancementConnection,
  type CanvasSize,
  type StagePosition,
} from "./formatDesignerGeometry";

const componentStyles = {
  ...primitiveStyles,
  ...styles,
  eyebrow: `${primitiveStyles.eyebrow} ${primitiveStyles.eyebrowInverse}`,
};

type Stage = {
  id: string;
  type: "groups" | "round-robin" | "knockout" | "placement" | "final";
  name: string;
  participants: number;
  advance: number;
  bestOf: number;
  constraint: string;
  x: number;
  y: number;
};

const stageDefinitions = [
  [opaqueId("groups"), t("prototype.d216068038f3"), UsersThree],
  [opaqueId("round-robin"), t("prototype.8ad7364fcbf4"), ArrowsClockwise],
  [opaqueId("knockout"), t("prototype.e2ec5fc1c15b"), Trophy],
  [opaqueId("placement"), t("prototype.4df9939944a7"), Medal],
  [opaqueId("final"), t("prototype.d8c48fd5e5d6"), Trophy],
] as const;

const stageTypeLabels: Record<Stage["type"], string> = {
  groups: t("prototype.4ed379d418bb"),
  "round-robin": t("prototype.ab2e7e09a155"),
  knockout: t("prototype.5f91878bc4db"),
  placement: t("prototype.1480fb125459"),
  final: t("prototype.2443630b4620"),
};

const initialStages: Stage[] = [
  {
    id: "pool-a",
    type: "groups",
    name: t("prototype.f0fddc1d53e2"),
    participants: 4,
    advance: 2,
    bestOf: 1,
    constraint: t("prototype.8519b5922755"),
    x: 80,
    y: 88,
  },
  {
    id: "pool-b",
    type: "groups",
    name: t("prototype.172706503fcb"),
    participants: 4,
    advance: 2,
    bestOf: 1,
    constraint: t("prototype.8519b5922755"),
    x: 80,
    y: 298,
  },
  {
    id: "semi",
    type: "knockout",
    name: t("prototype.312f3a8893d9"),
    participants: 4,
    advance: 2,
    bestOf: 1,
    constraint: t("prototype.bdbc0152c6d3"),
    x: 330,
    y: 192,
  },
  {
    id: "final",
    type: "final",
    name: t("prototype.8effb868b3db"),
    participants: 4,
    advance: 0,
    bestOf: 1,
    constraint: t("prototype.fff889c4bb67"),
    x: 540,
    y: 192,
  },
];

const advancementConnections: AdvancementConnection[] = [
  { id: "pool-a-to-semi", sourceStageId: initialStages[0].id, targetStageId: initialStages[2].id },
  { id: "pool-b-to-semi", sourceStageId: initialStages[1].id, targetStageId: initialStages[2].id },
  { id: "semi-to-final", sourceStageId: initialStages[2].id, targetStageId: initialStages[3].id },
];

const stageTypes = new Set<Stage["type"]>(stageDefinitions.map(([type]) => type));
const paletteDragType = opaqueId("application/x-matchday-stage");
const plainTextDragType = opaqueId("text/plain");
const connectorMarkerReference = opaqueId("url(#advancement-arrow)");

type PreviewState = "ready" | "loading" | "empty" | "offline" | "conflict";

export function FormatDesignerPrototype() {
  const [mode, setMode] = useState<"visual" | "manual">(opaqueId("visual"));
  const [stages, setStages] = useState(initialStages);
  const [selectedId, setSelectedId] = useState<string>(opaqueId("semi"));
  const [previewState, setPreviewState] = useState<PreviewState>(opaqueId("ready"));
  const [validation, setValidation] = useState<"valid" | "invalid">(opaqueId("valid"));
  const [validConnectionAdded, setValidConnectionAdded] = useState(false);
  const [canvasSize, setCanvasSize] = useState<CanvasSize>({ width: 950, height: 570 });
  const [draggedStageId, setDraggedStageId] = useState<string | null>(null);
  const [isPaletteDragOver, setIsPaletteDragOver] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const pointerDrag = useRef<{
    id: string;
    pointerId: number;
    grabOffset: StagePosition;
  } | null>(null);
  const nextStageSequence = useRef(1);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 767px)");
    const updateMode = () => {
      if (query.matches) setMode("manual");
    };
    updateMode();
    query.addEventListener("change", updateMode);
    return () => query.removeEventListener("change", updateMode);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const updateCanvasSize = () => {
      const bounds = canvas.getBoundingClientRect();
      setCanvasSize((current) => {
        if (current.width === bounds.width && current.height === bounds.height) return current;
        return { width: bounds.width, height: bounds.height };
      });
    };
    updateCanvasSize();

    const observer = new ResizeObserver(updateCanvasSize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [mode, previewState]);

  const selected = stages.find((stage) => stage.id === selectedId) ?? stages[0];
  const visibleStages = useMemo(() => (previewState === "empty" ? [] : stages), [previewState, stages]);
  const matchCount = useMemo(
    () => stages.reduce((total, stage) => total + (stage.type === "groups" ? 6 : stage.type === "final" ? 2 : 2), 0),
    [stages],
  );

  const renderedConnections = useMemo(() => {
    const stagesById = new Map(visibleStages.map((stage) => [stage.id, stage]));
    return advancementConnections.flatMap((connection) => {
      const from = stagesById.get(connection.sourceStageId);
      const to = stagesById.get(connection.targetStageId);
      return from && to ? [{ ...connection, path: getAdvancementPath(from, to) }] : [];
    });
  }, [visibleStages]);

  const addStage = (type: Stage["type"], requestedPosition?: StagePosition) => {
    const stageId = `stage-${type}-${nextStageSequence.current++}`;
    setStages((current) => {
      const position = requestedPosition
        ? resolveDroppedStagePosition(requestedPosition, current, canvasSize)
        : findAvailableStagePosition(current, canvasSize);
      return [
        ...current,
        {
          id: stageId,
          type,
          name: stageDefinitions.find((item) => item[0] === type)?.[1] ?? t("prototype.de838855e4a6"),
          participants: 4,
          advance: type === "final" ? 0 : 2,
          bestOf: 1,
          constraint: "",
          ...position,
        },
      ];
    });
    setSelectedId(stageId);
    setPreviewState("ready");
  };

  const moveStage = (id: string, requestedPosition: StagePosition) => {
    const position = clampStagePosition(requestedPosition, canvasSize);
    setStages((current) => current.map((stage) => (stage.id === id ? { ...stage, ...position } : stage)));
  };

  const handlePaletteDragStart = (event: DragEvent<HTMLButtonElement>, type: Stage["type"]) => {
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(paletteDragType, type);
    event.dataTransfer.setData(plainTextDragType, type);
  };

  const handleCanvasDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsPaletteDragOver(true);
  };

  const handleCanvasDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsPaletteDragOver(false);
    const type = event.dataTransfer.getData(paletteDragType) || event.dataTransfer.getData(plainTextDragType);
    if (!isStageType(type)) return;

    const bounds = event.currentTarget.getBoundingClientRect();
    addStage(type, {
      x: event.clientX - bounds.left - STAGE_NODE_SIZE.width / 2,
      y: event.clientY - bounds.top - STAGE_NODE_SIZE.height / 2,
    });
  };

  const handleStagePointerDown = (event: PointerEvent<HTMLButtonElement>, stage: Stage) => {
    if (event.button !== 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const bounds = canvas.getBoundingClientRect();
    pointerDrag.current = {
      id: stage.id,
      pointerId: event.pointerId,
      grabOffset: {
        x: event.clientX - bounds.left - stage.x,
        y: event.clientY - bounds.top - stage.y,
      },
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelectedId(stage.id);
    setDraggedStageId(stage.id);
  };

  const handleStagePointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = pointerDrag.current;
    const canvas = canvasRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !canvas) return;

    const bounds = canvas.getBoundingClientRect();
    moveStage(drag.id, {
      x: event.clientX - bounds.left - drag.grabOffset.x,
      y: event.clientY - bounds.top - drag.grabOffset.y,
    });
  };

  const finishStagePointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    if (pointerDrag.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    pointerDrag.current = null;
    setDraggedStageId(null);
  };

  const handleStageKeyDown = (event: KeyboardEvent<HTMLButtonElement>, stage: Stage) => {
    const direction = {
      ArrowLeft: { x: -1, y: 0 },
      ArrowRight: { x: 1, y: 0 },
      ArrowUp: { x: 0, y: -1 },
      ArrowDown: { x: 0, y: 1 },
    }[event.key];
    if (!direction) return;

    event.preventDefault();
    const step = event.shiftKey ? KEYBOARD_MOVE_STEP * 2 : KEYBOARD_MOVE_STEP;
    moveStage(stage.id, {
      x: stage.x + direction.x * step,
      y: stage.y + direction.y * step,
    });
  };

  const updateSelected = (patch: Partial<Stage>) => {
    setStages((current) => current.map((stage) => (stage.id === selectedId ? { ...stage, ...patch } : stage)));
  };

  const removeSelected = () => {
    setStages((current) => current.filter((stage) => stage.id !== selectedId));
    setSelectedId(stages.find((stage) => stage.id !== selectedId)?.id ?? "");
  };

  return (
    <div className={cx(componentStyles, "designer-workspace")}>
      <header className={cx(componentStyles, "designer-commandbar")}>
        <div>
          <p className={cx(componentStyles, "eyebrow")}>{t("prototype.675eeee2578b")}</p>
          <h1>{t("prototype.f4e712b5779d")}</h1>
        </div>
        <div className={cx(componentStyles, "designer-mode")} role="group" aria-label={t("prototype.156943e295ef")}>
          <button type="button" aria-pressed={mode === "visual"} onClick={() => setMode("visual")}>
            <CursorClick />
            {t("prototype.ba3033214fe4")}
          </button>
          <button type="button" aria-pressed={mode === "manual"} onClick={() => setMode("manual")}>
            <ListChecks />
            {t("prototype.b0b9fe24ffa9")}
          </button>
        </div>
        <div className={cx(componentStyles, "designer-command-actions")}>
          <label>
            {t("prototype.a19e21c7cc69")}
            <select value={previewState} onChange={(event) => setPreviewState(event.target.value as PreviewState)}>
              <option value="ready">{t("prototype.5fa7aac5375c")}</option>
              <option value="loading">{t("prototype.dc380888c4e2")}</option>
              <option value="empty">{t("prototype.c6c094bc0054")}</option>
              <option value="offline">{t("prototype.a1794783aab7")}</option>
              <option value="conflict">{t("prototype.014659ab9d98")}</option>
            </select>
          </label>
          <button className={cx(componentStyles, "button signal")} type="button">
            {t("prototype.6388dcbd501a")}
          </button>
        </div>
      </header>

      {previewState === "offline" && (
        <div className={cx(componentStyles, "designer-banner")} role="status">
          <CloudSlash />
          <strong>{t("prototype.f439fed8b703")}</strong>
          <span>{t("prototype.d94f15d8bc83")}</span>
        </div>
      )}
      {previewState === "conflict" && (
        <div className={cx(componentStyles, "designer-banner is-danger")} role="alert">
          <Warning />
          <strong>{t("prototype.476745222559")}</strong>
          <span>{t("prototype.24f37f13d5e3")}</span>
          <button type="button">{t("prototype.9e053092b7f3")}</button>
        </div>
      )}

      <div className={cx(componentStyles, "designer-body")}>
        <aside className={cx(componentStyles, "stage-library")} aria-label={t("prototype.f514fa20697a")}>
          <p className={cx(componentStyles, "eyebrow")}>{t("prototype.f514fa20697a")}</p>
          <h2>{t("prototype.a441d02e4443")}</h2>
          <p>{t("prototype.84e0b4f1ece8")}</p>
          <div>
            {stageDefinitions.map(([type, label, Icon]) => (
              <button
                key={type}
                type="button"
                draggable
                className={styles.stageLibraryItem}
                data-stage-type={type}
                onClick={() => addStage(type)}
                onDragStart={(event) => handlePaletteDragStart(event, type)}
              >
                <span>
                  <Icon />
                </span>
                <strong>{label}</strong>
                <Plus aria-hidden="true" />
              </button>
            ))}
          </div>
          <small>{t("prototype.d53e1c54d3b3")}</small>
        </aside>

        <section className={cx(componentStyles, "format-surface")} aria-label={t("prototype.62d29fd055c5")}>
          {previewState === "loading" ? (
            <DesignerLoading />
          ) : mode === "visual" ? (
            <div
              ref={canvasRef}
              className={cx(componentStyles, `format-canvas ${styles.canvas}`)}
              data-testid="format-canvas"
              data-empty={visibleStages.length === 0}
              data-drag-over={isPaletteDragOver}
              onDragOver={handleCanvasDragOver}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsPaletteDragOver(false);
              }}
              onDrop={handleCanvasDrop}
            >
              <div className={cx(componentStyles, "canvas-grid")} aria-hidden="true" />
              {renderedConnections.length > 0 && (
                <svg
                  className={cx(componentStyles, `connections ${styles.connections}`)}
                  role="img"
                  aria-label={t("prototype.74ab7c9dbf27")}
                  viewBox={`0 0 ${canvasSize.width} ${canvasSize.height}`}
                  preserveAspectRatio="none"
                >
                  <title>{t("prototype.74ab7c9dbf27")}</title>
                  <defs>
                    <marker
                      id="advancement-arrow"
                      viewBox="0 0 8 8"
                      refX={7}
                      refY={4}
                      markerWidth={5}
                      markerHeight={5}
                      orient={opaqueId("auto")}
                    >
                      <polygon points={opaqueId("0,0 8,4 0,8")} />
                    </marker>
                  </defs>
                  {renderedConnections.map((connection) => (
                    <path
                      key={connection.id}
                      data-connection-id={connection.id}
                      data-from-stage={connection.sourceStageId}
                      data-to-stage={connection.targetStageId}
                      d={connection.path}
                      markerEnd={connectorMarkerReference}
                    />
                  ))}
                </svg>
              )}
              {visibleStages.length === 0 ? (
                <div className={cx(componentStyles, "canvas-empty")}>
                  <UsersThree />
                  <h3>{t("prototype.0d5aebd5c785")}</h3>
                  <p>{t("prototype.7ee6838f888e")}</p>
                  <button
                    className={cx(componentStyles, "button signal")}
                    type="button"
                    onClick={() => addStage("groups")}
                  >
                    {t("prototype.dcce387499ce")}
                  </button>
                </div>
              ) : (
                visibleStages.map((stage) => (
                  <button
                    key={stage.id}
                    type="button"
                    className={cx(
                      componentStyles,
                      "stage-node",
                      styles.stageNode,
                      (stage.type === "final" || stage.type === "placement") && `stage-${stage.type}`,
                      stage.id === selectedId && "is-selected",
                    )}
                    style={{ left: stage.x, top: stage.y }}
                    data-stage-id={stage.id}
                    data-stage-x={stage.x}
                    data-stage-y={stage.y}
                    data-dragging={draggedStageId === stage.id}
                    onClick={() => setSelectedId(stage.id)}
                    onPointerDown={(event) => handleStagePointerDown(event, stage)}
                    onPointerMove={handleStagePointerMove}
                    onPointerUp={finishStagePointerMove}
                    onPointerCancel={finishStagePointerMove}
                    onKeyDown={(event) => handleStageKeyDown(event, stage)}
                    aria-pressed={stage.id === selectedId}
                    aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight"
                  >
                    <span className={cx(componentStyles, "stage-node-type")}>{stageTypeLabels[stage.type]}</span>
                    <strong>{stage.name}</strong>
                    <small>
                      {stage.participants} {t("prototype.81e7bab3576c")} {stage.advance} {t("prototype.e40dfff1a71e")}
                    </small>
                    <span className={cx(componentStyles, "stage-ports")} aria-hidden="true">
                      <i />
                      <i />
                    </span>
                  </button>
                ))
              )}
              <div className={cx(componentStyles, "canvas-controls")} aria-label={t("prototype.4057b33b628b")}>
                <button type="button" aria-label={t("prototype.bc7b631a689b")}>
                  <Minus />
                </button>
                <span>{t("prototype.32e48995f98c")}</span>
                <button type="button" aria-label={t("prototype.0e47f09a748f")}>
                  <Plus />
                </button>
                <button type="button" aria-label={t("prototype.438c41a7af19")}>
                  <CornersOut />
                </button>
              </div>
            </div>
          ) : (
            <div className={cx(componentStyles, "manual-editor")}>
              <div className={cx(componentStyles, "manual-stage-list")}>
                <div>
                  <p className={cx(componentStyles, "eyebrow")}>{t("prototype.4bafa9f08f72")}</p>
                  <span>
                    {stages.length} {t("prototype.7a77c515879a")}
                  </span>
                </div>
                {stages.map((stage, index) => (
                  <button
                    key={stage.id}
                    type="button"
                    aria-pressed={stage.id === selectedId}
                    onClick={() => setSelectedId(stage.id)}
                  >
                    <span>{index + 1}</span>
                    <span>
                      <strong>{stage.name}</strong>
                      <small>
                        {stageTypeLabels[stage.type]} · {stage.participants} {t("prototype.34ef94a0ea33")}
                      </small>
                    </span>
                  </button>
                ))}
                {stages.length === 0 && (
                  <div className={cx(componentStyles, "manual-empty")}>
                    <p>{t("prototype.d015fa4eed82")}</p>
                    <button
                      className={cx(componentStyles, "button signal")}
                      type="button"
                      onClick={() => addStage("groups")}
                    >
                      {t("prototype.dcce387499ce")}
                    </button>
                  </div>
                )}
              </div>
              <div className={cx(componentStyles, "manual-connection-list")}>
                <p className={cx(componentStyles, "eyebrow")}>{t("prototype.74ab7c9dbf27")}</p>
                <div>
                  <strong>{t("prototype.3991442f938b")}</strong>
                  <span>{t("prototype.d188b29ab730")}</span>
                </div>
                <div>
                  <strong>{t("prototype.312f3a8893d9")}</strong>
                  <span>{t("prototype.0f83cdf46d53")}</span>
                </div>
                {validConnectionAdded && (
                  <div>
                    <strong>{t("prototype.4df9939944a7")}</strong>
                    <span>{t("prototype.498e3f3021ab")}</span>
                  </div>
                )}
                <button
                  type="button"
                  className={primitiveStyles.textButton}
                  disabled={validConnectionAdded}
                  onClick={() => setValidConnectionAdded(true)}
                >
                  <Plus />
                  {validConnectionAdded ? t("prototype.6a3767f87d80") : t("prototype.233c7625477d")}
                </button>
              </div>
            </div>
          )}
        </section>

        <aside className={cx(componentStyles, "stage-inspector")} aria-label={t("prototype.eb425c6edd2c")}>
          {selected ? (
            <>
              <div className={cx(componentStyles, "inspector-heading")}>
                <div>
                  <p className={cx(componentStyles, "eyebrow")}>{t("prototype.35a85ebd7b51")}</p>
                  <h2>{selected.name}</h2>
                </div>
                <button
                  className={primitiveStyles.iconButton}
                  type="button"
                  aria-label={t("prototype.3cf8146e529f", { name: selected.name })}
                  onClick={removeSelected}
                >
                  <Trash />
                </button>
              </div>
              <label>
                {t("prototype.1f31e5b6c525")}
                <input value={selected.name} onChange={(e) => updateSelected({ name: e.target.value })} />
              </label>
              <div className={cx(componentStyles, "inspector-grid")}>
                <label>
                  {t("prototype.0e27279b3302")}
                  <input
                    type="number"
                    min="2"
                    value={selected.participants}
                    onChange={(e) => updateSelected({ participants: Number(e.target.value) })}
                  />
                </label>
                <label>
                  {t("prototype.775988890d65")}
                  <input
                    type="number"
                    min="0"
                    value={selected.advance}
                    onChange={(e) => updateSelected({ advance: Number(e.target.value) })}
                  />
                </label>
              </div>
              <label>
                {t("prototype.34c15fc4a4ac")}
                <select defaultValue={opaqueId("seeded")}>
                  <option value="seeded">{t("prototype.24a34cec4176")}</option>
                  <option value="random">{t("prototype.89f03f71f3d5")}</option>
                  <option value="cross">{t("prototype.4098276ac00c")}</option>
                </select>
              </label>
              <label>
                {t("prototype.55f1674d4de1")}
                <select value={selected.bestOf} onChange={(e) => updateSelected({ bestOf: Number(e.target.value) })}>
                  <option value="1">{t("prototype.01dfa8bb1f7b")}</option>
                  <option value="3">{t("prototype.43b1b642109c")}</option>
                  <option value="5">{t("prototype.13dcb0a56f1c")}</option>
                </select>
              </label>
              <label>
                {t("prototype.a169492e900b")}
                <textarea
                  value={selected.constraint}
                  onChange={(e) => updateSelected({ constraint: e.target.value })}
                  placeholder={t("prototype.5b87bec56908")}
                />
              </label>
              <button
                type="button"
                className={cx(componentStyles, "button secondary full-width inspector-action")}
                onClick={() => setValidation("invalid")}
              >
                {t("prototype.d499007ecb28")}
              </button>
            </>
          ) : (
            <div className={cx(componentStyles, "inspector-empty")}>
              <CursorClick />
              <h2>{t("prototype.882d04494de8")}</h2>
              <p>{t("prototype.31d72f55168f")}</p>
            </div>
          )}
        </aside>
      </div>

      <div
        className={cx(componentStyles, `validation-rail${validation === "invalid" ? " is-invalid" : ""}`)}
        role="status"
      >
        {validation === "valid" ? <CheckCircle weight="fill" /> : <Warning weight="fill" />}
        <span>
          <strong>{validation === "valid" ? t("prototype.b1de949fcc97") : t("prototype.feb61ed5c02c")}</strong>
          {validation === "valid"
            ? t("prototype.ae5640618a05", {
                stages: stages.length,
                matches: matchCount,
              })
            : t("prototype.551d7508c7fd")}
        </span>
        {validation === "invalid" && (
          <button type="button" onClick={() => setValidation("valid")}>
            {t("prototype.48845bff334a")}
          </button>
        )}
      </div>
    </div>
  );
}

function isStageType(value: string): value is Stage["type"] {
  return stageTypes.has(value as Stage["type"]);
}

function DesignerLoading() {
  return (
    <div className={cx(componentStyles, "designer-loading")} role="status" aria-label={t("prototype.ec56fa0576b7")}>
      <span />
      <span />
      <span />
      <span />
    </div>
  );
}
