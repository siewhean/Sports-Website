import { describe, expect, it } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import NotificationsPage from "../../app/notifications/page.js";

describe("RES-032 In-App Notification Center", () => {
  it("renders notification center inbox, title, and categories", () => {
    const html = renderToString(React.createElement(NotificationsPage));

    expect(html).toContain("Notification Center");
    expect(html).toContain("unread");
    expect(html).toContain("Inbox");
    expect(html).toContain("Preferences");
    expect(html).toContain("Schedule Published");
    expect(html).toContain("Takeover Requested");
  });

  it("contains all operational alert categories and mark as read buttons", () => {
    const html = renderToString(React.createElement(NotificationsPage));

    expect(html).toContain("Schedule Updates");
    expect(html).toContain("Result Conflicts");
    expect(html).toContain("Match Reminders");
    expect(html).toContain("Billing");
    expect(html).toContain("Mark as read");
  });
});
