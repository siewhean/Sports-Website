export type PublicProjectionKind = "results" | "schedule";

export type EdgePurgeRequest = {
  competitionId: string;
  projection: PublicProjectionKind;
  publicationState: "published";
  previousPublishedVersion: number;
  publishedVersion: number;
  correlationId: string;
};

export type EdgePurgeResult = {
  purgedAt: string;
  providerRequestId?: string;
};

export interface EdgeCachePurgePort {
  purge(request: EdgePurgeRequest): Promise<EdgePurgeResult>;
}

export class EdgePurgeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EdgePurgeValidationError";
  }
}

export class EdgePurgeRetryableError extends Error {
  constructor(message = "Edge purge temporarily unavailable") {
    super(message);
    this.name = "EdgePurgeRetryableError";
  }
}

export class EdgePurgePermanentError extends Error {
  constructor(message = "Edge purge request was rejected") {
    super(message);
    this.name = "EdgePurgePermanentError";
  }
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const correlationPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function assertEdgePurgeRequest(value: EdgePurgeRequest): void {
  if (!uuidPattern.test(value.competitionId)) {
    throw new EdgePurgeValidationError("competitionId must be a UUID");
  }
  if (value.projection !== "results" && value.projection !== "schedule") {
    throw new EdgePurgeValidationError("projection must be results or schedule");
  }
  if (value.publicationState !== "published") {
    throw new EdgePurgeValidationError("draft projections cannot be purged through the public edge adapter");
  }
  if (!Number.isSafeInteger(value.previousPublishedVersion) || value.previousPublishedVersion < 0) {
    throw new EdgePurgeValidationError("previousPublishedVersion must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(value.publishedVersion) || value.publishedVersion < 1) {
    throw new EdgePurgeValidationError("publishedVersion must be a positive safe integer");
  }
  if (value.publishedVersion <= value.previousPublishedVersion) {
    throw new EdgePurgeValidationError("publishedVersion must advance the previous published version");
  }
  if (!correlationPattern.test(value.correlationId)) {
    throw new EdgePurgeValidationError("correlationId has an invalid format");
  }
}

export function edgePurgeIdempotencyKey(request: EdgePurgeRequest): string {
  assertEdgePurgeRequest(request);
  return `purge:${request.competitionId}:${request.projection}:${request.previousPublishedVersion}`;
}
