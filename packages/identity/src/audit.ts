import { randomUUID } from "node:crypto";
import { UnsafeAuditPayloadError } from "./errors.js";
import { requirePermission, type Principal } from "./rbac.js";

export type AuditActorType = "account" | "access_pass" | "system" | "platform_admin";
export type AuditJson = null | boolean | number | string | AuditJson[] | { [key: string]: AuditJson };

export type AuditEvent = {
  id: string;
  occurredAt: Date;
  requestId: string;
  actorAccountId: string | null;
  actorType: AuditActorType;
  organisationId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  reason: string | null;
  beforeState: AuditJson;
  afterState: AuditJson;
  metadata: AuditJson;
};

export type WriteAuditEvent = Omit<AuditEvent, "id" | "occurredAt"> & {
  id?: string;
  occurredAt?: Date;
};

export type AuditCursor = { occurredAt: Date; id: string };
export type AuditQuery = {
  organisationId: string | null;
  targetType?: string;
  targetId?: string;
  actorAccountId?: string;
  action?: string;
  before?: AuditCursor;
  limit?: number;
};

export interface AuditAppendPort {
  append(event: AuditEvent): Promise<void>;
}

export interface AuditReadPort {
  list(
    query: Required<Pick<AuditQuery, "organisationId" | "limit">> & Omit<AuditQuery, "limit">,
  ): Promise<readonly AuditEvent[]>;
}

export interface PostgresQueryPort {
  query<T>(text: string, values: readonly unknown[]): Promise<{ rows: T[] }>;
}

const PROHIBITED_KEYS = new Set([
  "apikey",
  "authorization",
  "clientsecret",
  "cookie",
  "credential",
  "password",
  "passwordhash",
  "privatekey",
  "refreshtoken",
  "secret",
  "secrethash",
  "sessiontoken",
  "token",
  "accesstoken",
]);

function keyFingerprint(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function assertAuditSafe(value: AuditJson, path = "$", seen = new Set<object>()): void {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) throw new UnsafeAuditPayloadError(path);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertAuditSafe(item, `${path}[${index}]`, seen));
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (PROHIBITED_KEYS.has(keyFingerprint(key))) throw new UnsafeAuditPayloadError(`${path}.${key}`);
      assertAuditSafe(item, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function validateText(label: string, value: string, maxLength: number): void {
  if (!value.trim() || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
}

export class AuditWriter {
  constructor(
    private readonly events: AuditAppendPort,
    private readonly now: () => Date = () => new Date(),
    private readonly id: () => string = randomUUID,
  ) {}

  async write(input: WriteAuditEvent): Promise<AuditEvent> {
    validateText("requestId", input.requestId, 128);
    validateText("action", input.action, 160);
    validateText("targetType", input.targetType, 100);
    validateText("targetId", input.targetId, 256);
    if (input.reason !== null) validateText("reason", input.reason, 1_000);
    if ((input.actorType === "account" || input.actorType === "platform_admin") && !input.actorAccountId) {
      throw new Error("Account actors require an actorAccountId.");
    }
    assertAuditSafe(input.beforeState);
    assertAuditSafe(input.afterState);
    assertAuditSafe(input.metadata);
    const event: AuditEvent = {
      ...input,
      id: input.id ?? this.id(),
      occurredAt: input.occurredAt ?? this.now(),
    };
    await this.events.append(event);
    return event;
  }
}

export class AuditViewer {
  constructor(private readonly events: AuditReadPort) {}

  async list(principal: Principal, query: AuditQuery): Promise<readonly AuditEvent[]> {
    if (query.organisationId) {
      requirePermission(principal, "audit.read", {
        kind: "organisation",
        id: query.organisationId,
        organisationId: query.organisationId,
      });
    } else {
      requirePermission(principal, "platform.read", { kind: "platform" });
    }
    const limit = query.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Audit query limit must be an integer between 1 and 100.");
    }
    return this.events.list({ ...query, limit });
  }
}

type AuditRow = {
  id: string;
  occurredAt: Date | string;
  requestId: string;
  actorAccountId: string | null;
  actorType: AuditActorType;
  organisationId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  reason: string | null;
  beforeState: AuditJson;
  afterState: AuditJson;
  metadata: AuditJson;
};

function rowToEvent(row: AuditRow): AuditEvent {
  return { ...row, occurredAt: row.occurredAt instanceof Date ? row.occurredAt : new Date(row.occurredAt) };
}

export class PostgresAuditRepository implements AuditAppendPort, AuditReadPort {
  constructor(private readonly database: PostgresQueryPort) {}

  async append(event: AuditEvent): Promise<void> {
    await this.database.query(
      `INSERT INTO audit_events (
        id, occurred_at, request_id, actor_account_id, actor_type, organisation_id,
        action, target_type, target_id, reason, before_state, after_state, metadata
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb
      )`,
      [
        event.id,
        event.occurredAt,
        event.requestId,
        event.actorAccountId,
        event.actorType,
        event.organisationId,
        event.action,
        event.targetType,
        event.targetId,
        event.reason,
        JSON.stringify(event.beforeState),
        JSON.stringify(event.afterState),
        JSON.stringify(event.metadata),
      ],
    );
  }

  async list(query: Required<Pick<AuditQuery, "organisationId" | "limit">> & Omit<AuditQuery, "limit">) {
    const values: unknown[] = [query.organisationId];
    const clauses = ["organisation_id IS NOT DISTINCT FROM $1"];
    const add = (sql: string, value: unknown) => {
      values.push(value);
      clauses.push(sql.replace("?", `$${values.length}`));
    };
    if (query.targetType) add("target_type = ?", query.targetType);
    if (query.targetId) add("target_id = ?", query.targetId);
    if (query.actorAccountId) add("actor_account_id = ?", query.actorAccountId);
    if (query.action) add("action = ?", query.action);
    if (query.before) {
      values.push(query.before.occurredAt, query.before.id);
      clauses.push(`(occurred_at, id) < ($${values.length - 1}, $${values.length})`);
    }
    values.push(query.limit);
    const result = await this.database.query<AuditRow>(
      `SELECT
        id, occurred_at AS "occurredAt", request_id AS "requestId",
        actor_account_id AS "actorAccountId", actor_type AS "actorType",
        organisation_id AS "organisationId", action,
        target_type AS "targetType", target_id AS "targetId", reason,
        before_state AS "beforeState", after_state AS "afterState", metadata
      FROM audit_events
      WHERE ${clauses.join(" AND ")}
      ORDER BY occurred_at DESC, id DESC
      LIMIT $${values.length}`,
      values,
    );
    return result.rows.map(rowToEvent);
  }
}
