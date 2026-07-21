export const STAGE_NODE_SIZE = {
  width: 180,
  height: 100,
} as const;

export const CANVAS_PADDING = 24;
export const KEYBOARD_MOVE_STEP = 24;

export type CanvasSize = {
  width: number;
  height: number;
};

export type StagePosition = {
  x: number;
  y: number;
};

export type AdvancementConnection = {
  id: string;
  sourceStageId: string;
  targetStageId: string;
};

export function clampStagePosition(position: StagePosition, canvas: CanvasSize): StagePosition {
  return {
    x: Math.max(CANVAS_PADDING, Math.min(canvas.width - STAGE_NODE_SIZE.width - CANVAS_PADDING, position.x)),
    y: Math.max(CANVAS_PADDING, Math.min(canvas.height - STAGE_NODE_SIZE.height - CANVAS_PADDING, position.y)),
  };
}

export function findAvailableStagePosition(
  stages: StagePosition[],
  canvas: CanvasSize,
  preferredPosition: StagePosition = { x: 80, y: 88 },
): StagePosition {
  const searchStep = 24;
  const maximumX = Math.max(CANVAS_PADDING, canvas.width - STAGE_NODE_SIZE.width - CANVAS_PADDING);
  const maximumY = Math.max(CANVAS_PADDING, canvas.height - STAGE_NODE_SIZE.height - CANVAS_PADDING);
  const candidates: StagePosition[] = [];

  for (let y = CANVAS_PADDING; y <= maximumY; y += searchStep) {
    for (let x = CANVAS_PADDING; x <= maximumX; x += searchStep) {
      const position = { x, y };
      if (isPositionAvailable(position, stages)) candidates.push(position);
    }
  }

  candidates.sort((left, right) => {
    const leftDistance = distanceSquared(left, preferredPosition);
    const rightDistance = distanceSquared(right, preferredPosition);
    return leftDistance - rightDistance || left.y - right.y || left.x - right.x;
  });
  if (candidates[0]) return candidates[0];

  return clampStagePosition(
    {
      x: preferredPosition.x + (stages.length % 3) * (STAGE_NODE_SIZE.width / 2),
      y: preferredPosition.y + (stages.length % 4) * (STAGE_NODE_SIZE.height / 2),
    },
    canvas,
  );
}

export function resolveDroppedStagePosition(
  requestedPosition: StagePosition,
  stages: StagePosition[],
  canvas: CanvasSize,
): StagePosition {
  const position = clampStagePosition(requestedPosition, canvas);
  const overlaps = !isPositionAvailable(position, stages);

  return overlaps ? findAvailableStagePosition(stages, canvas, position) : position;
}

export function getAdvancementPath(from: StagePosition, to: StagePosition): string {
  const startX = from.x + STAGE_NODE_SIZE.width;
  const startY = from.y + STAGE_NODE_SIZE.height / 2;
  const endX = to.x;
  const endY = to.y + STAGE_NODE_SIZE.height / 2;
  const direction = endX >= startX ? 1 : -1;
  const controlDistance = Math.max(12, Math.abs(endX - startX) * 0.45);
  const firstControlX = startX + controlDistance * direction;
  const secondControlX = endX - controlDistance * direction;

  return `M ${round(startX)} ${round(startY)} C ${round(firstControlX)} ${round(startY)} ${round(secondControlX)} ${round(endY)} ${round(endX)} ${round(endY)}`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function isPositionAvailable(position: StagePosition, stages: StagePosition[]): boolean {
  return stages.every(
    (stage) =>
      Math.abs(stage.x - position.x) >= STAGE_NODE_SIZE.width + 16 ||
      Math.abs(stage.y - position.y) >= STAGE_NODE_SIZE.height + 16,
  );
}

function distanceSquared(left: StagePosition, right: StagePosition): number {
  return (left.x - right.x) ** 2 + (left.y - right.y) ** 2;
}
