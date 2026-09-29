import { describe, expect, it } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { readFile } from "node:fs/promises";
import NotificationsPageClient from "../../app/notifications/NotificationsPageClient.js";

describe("RES-032 In-App Notification Center", () => {
  it("renders notification center inbox, title, and categories", () => {
    const html = renderToString(React.createElement(NotificationsPageClient, { demoMode: false }));

    expect(html).toContain("Notification Center");
    expect(html).toContain("Inbox");
    expect(html).toContain("Preferences");
    expect(html).toContain("Loading notifications");
  });

  it("contains all operational alert categories and read actions", async () => {
    const html = renderToString(React.createElement(NotificationsPageClient, { demoMode: false }));

    expect(html).toContain("Schedule Updates");
    expect(html).toContain("Result Conflicts");
    expect(html).toContain("Match Reminders");
    expect(html).toContain("Billing");
    const source = await readFile(
      new URL("../../app/notifications/NotificationsPageClient.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain("onClick={() => markAsRead(notification.id)}");
    expect(source).toContain("onClick={markAllAsRead}");
  });
});
