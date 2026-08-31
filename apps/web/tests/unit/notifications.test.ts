import { describe, expect, it } from "vitest";
import { notificationPageItems, toInAppNotification } from "../../lib/notifications";

describe("notification presentation", () => {
  it("starts from backend records only and preserves read state", () => {
    expect(notificationPageItems(null)).toEqual([]);
    expect(notificationPageItems({ items: [] })).toEqual([]);
    expect(
      notificationPageItems({
        items: [
          {
            id: "n-1",
            type: "match_reminder",
            payload: { heading: "h", content: "c" },
            createdAt: "2026-08-26T00:00:00.000Z",
            readAt: null,
          },
        ],
      }),
    ).toEqual([
      {
        id: "n-1",
        category: "match_reminder",
        heading: "h",
        content: "c",
        timestamp: "2026-08-26T00:00:00.000Z",
        read: false,
      },
    ]);
  });

  it("maps unknown server types without depending on sample alerts", () => {
    expect(
      toInAppNotification({
        id: "n-2",
        type: "new_server_type",
        payload: {},
        createdAt: "2026-08-26T00:00:00.000Z",
        readAt: "2026-08-26T01:00:00.000Z",
      }),
    ).toMatchObject({ category: "schedule_update", heading: "new_server_type", read: true });
  });
});
