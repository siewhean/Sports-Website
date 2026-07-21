import type { Phase4SetupDocument } from "@matchday/contracts";
import type { PostgresJsSql } from "@matchday/identity";
import type { ScheduleEnqueuePort } from "@matchday/scheduler";
import { ApiError } from "./errors.js";
import type { Phase3Actor, Phase3Runtime } from "./phase-3-runtime.js";
import { GateBPhase4Runtime } from "./phase-4-gate-b-runtime.js";
import type { Phase4AiOptions } from "./phase-4-runtime.js";
import {
  decodePhase4Json,
  phase4SetupDocumentFromStorage,
  type Phase4SetupStorageRow,
} from "./phase-4-setup-domain.js";

type ReadAccess = {
  organisation_id: string;
  status: string;
};

function first<T>(rows: readonly T[], code: string, message: string): T {
  const row = rows[0];
  if (!row) throw new ApiError(404, code, message);
  return row;
}

export class ReliableGateBPhase4Runtime extends GateBPhase4Runtime {
  constructor(
    private readonly reliableSql: PostgresJsSql,
    phase3: Phase3Runtime,
    enqueue: ScheduleEnqueuePort,
    ai: Phase4AiOptions,
    now: () => Date = () => new Date(),
  ) {
    super(reliableSql, phase3, enqueue, ai, now);
  }

  override async readSetupDraft(actor: Phase3Actor, competitionId: string): Promise<Phase4SetupDocument> {
    if (!this.reliableSql.begin)
      throw new Error("Phase 4 setup resume requires a transaction-capable PostgreSQL client");
    return this.reliableSql.begin(async (tx) => {
      const access = first(
        await tx.unsafe<ReadAccess>(
          `SELECT competition.organisation_id,competition.status
           FROM competitions competition
           JOIN organisation_memberships membership
             ON membership.organisation_id=competition.organisation_id
           WHERE competition.id=$1
             AND membership.account_id=$2
             AND membership.status='active'
             AND membership.role IN ('owner','organiser','viewer')`,
          [competitionId, actor.accountId],
        ),
        "COMPETITION_ACCESS_DENIED",
        "Competition access denied",
      );

      let row: Phase4SetupStorageRow;
      if (access.status === "archived") {
        row = first(
          await tx.unsafe<Phase4SetupStorageRow>(
            `SELECT draft.*,competition.status competition_status
             FROM setup_drafts draft
             JOIN competitions competition ON competition.id=draft.competition_id
             WHERE draft.competition_id=$1`,
            [competitionId],
          ),
          "SETUP_DRAFT_NOT_FOUND",
          "Setup draft not found",
        );
      } else {
        const refreshed = first(
          await tx.unsafe<{ value: Phase4SetupStorageRow | string }>(
            `SELECT phase4_refresh_setup_draft_references($1,$2,$3,$4) value`,
            [access.organisation_id, competitionId, actor.accountId, `setup-resume:${competitionId}:${actor.accountId}`],
          ),
          "SETUP_REFRESH_FAILED",
          "Setup references could not be refreshed",
        );
        row = decodePhase4Json<Phase4SetupStorageRow>(refreshed.value);
        row.competition_status = access.status;
      }
      return phase4SetupDocumentFromStorage(row);
    });
  }
}
