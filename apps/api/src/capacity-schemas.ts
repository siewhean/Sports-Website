import { Type } from "@sinclair/typebox";

// Per-court-per-day reserve counts, shared by every capacity PUT route. At most one key per day of
// a competition (competitions span far less than a year) and a per-day count no court can exceed
// (a 1-minute grid has 1,440 slots a day). The runtime still checks every date against the
// competition's own dates before computing capacity.
export const DAILY_RESERVE_MAX_DATES = 366;
export const DAILY_RESERVE_MAX_SLOTS_PER_DAY = 1440;

export const DailyReserveSlots = Type.Union([
  Type.Null(),
  Type.Record(
    Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" }),
    Type.Integer({ minimum: 0, maximum: DAILY_RESERVE_MAX_SLOTS_PER_DAY }),
    { maxProperties: DAILY_RESERVE_MAX_DATES },
  ),
]);
