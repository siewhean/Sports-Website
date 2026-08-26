"use client";

import { useEffect, useMemo, useState } from "react";
import { formatDateTime, interpolate, messages } from "@matchday/ui";
import { gateCC4Http } from "@/lib/gate-c-c4-http";
import { notificationPageItems, type InAppNotification, type NotificationCategory } from "@/lib/notifications";

const preferenceTypes = ["match_reminder", "schedule_update", "result_conflict", "billing_receipt"] as const;
type PreferenceType = (typeof preferenceTypes)[number];
type Preferences = Record<PreferenceType, boolean>;
const emptyPreferences: Preferences = {
  match_reminder: false,
  schedule_update: false,
  result_conflict: false,
  billing_receipt: false,
};

export default function NotificationsPage() {
  const [activeTab, setActiveTab] = useState(0);
  const [categoryIndex, setCategoryIndex] = useState(0);
  const [notifications, setNotifications] = useState<InAppNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [preferences, setPreferences] = useState<Preferences>(emptyPreferences);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/notifications", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((page: unknown) => {
        if (!cancelled) setNotifications(notificationPageItems(page));
      })
      .catch(() => {
        if (!cancelled) setNotifications([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      preferenceTypes.map(async (type) => {
        const response = await fetch(`/api/notifications/preferences/${encodeURIComponent(type)}`, { cache: "no-store" });
        const payload = response.ok ? ((await response.json()) as { inAppEnabled?: unknown }) : null;
        return [type, payload?.inAppEnabled === true] as const;
      }),
    )
      .then((entries) => {
        if (!cancelled) setPreferences(Object.fromEntries(entries) as Preferences);
      })
      .catch(() => {
        if (!cancelled) setPreferences(emptyPreferences);
      })
      .finally(() => {
        if (!cancelled) setPreferencesLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const unreadCount = notifications.filter((notification) => !notification.read).length;
  const categories: ReadonlyArray<{ key: NotificationCategory | "all"; label: string }> = useMemo(
    () => [
      { key: "all", label: messages.notifications.categories.all },
      { key: "schedule_update", label: messages.notifications.categories.schedule_update },
      { key: "result_conflict", label: messages.notifications.categories.result_conflict },
      { key: "match_reminder", label: messages.notifications.categories.match_reminder },
      { key: "billing_receipt", label: messages.notifications.categories.billing_receipt },
    ],
    [],
  );
  const selectedCategory = categories[categoryIndex]?.key ?? "all";
  const filteredNotifications = notifications.filter(
    (notification) => selectedCategory === "all" || notification.category === selectedCategory,
  );

  const markAsRead = (id: string) => {
    setNotifications((previous) => previous.map((notification) => (notification.id === id ? { ...notification, read: true } : notification)));
    void fetch(`/api/notifications/${encodeURIComponent(id)}/read`, { method: gateCC4Http.methodPost }).catch(() => {});
  };

  const markAllAsRead = () => {
    setNotifications((previous) => previous.map((notification) => ({ ...notification, read: true })));
    void fetch("/api/notifications/read-all", { method: gateCC4Http.methodPost }).catch(() => {});
  };

  const savePreferences = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaved(false);
    const responses = await Promise.all(
      preferenceTypes.map((type) =>
        fetch(`/api/notifications/preferences/${encodeURIComponent(type)}`, {
          method: "PUT",
          headers: { "content-type": gateCC4Http.jsonContentType },
          body: JSON.stringify({ in_app_enabled: preferences[type], email_enabled: preferences[type] }),
        }),
      ),
    ).catch(() => []);
    if (responses.length === preferenceTypes.length && responses.every((response) => response.ok)) setSaved(true);
  };

  const preferenceRows: ReadonlyArray<{ type: PreferenceType; label: string }> = [
    { type: "match_reminder", label: messages.notifications.matchReminders },
    { type: "schedule_update", label: messages.notifications.scheduleUpdates },
    { type: "result_conflict", label: messages.notifications.resultConflicts },
    { type: "billing_receipt", label: messages.notifications.billingReceipts },
  ];

  return (
    <div className="min-h-screen bg-neutral-950 px-4 py-12 text-neutral-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-3xl">
        <header className="mb-8">
          <div className="flex items-center justify-between">
            <h1 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">{messages.notifications.title}</h1>
            {unreadCount > 0 ? (
              <span className="inline-flex items-center rounded-full border border-indigo-500/30 bg-indigo-500/20 px-3 py-1 text-xs font-semibold text-indigo-400">
                {interpolate(messages.notifications.unreadCount, { count: unreadCount })}
              </span>
            ) : null}
          </div>
          <p className="mt-2 text-base text-neutral-400">{messages.notifications.subtitle}</p>
        </header>

        <div className="mb-6 flex gap-2 border-b border-neutral-800">
          <button type="button" onClick={() => setActiveTab(0)} className={`border-b-2 px-4 pb-3 text-sm font-medium ${activeTab === 0 ? "border-indigo-500 text-white" : "border-transparent text-neutral-400"}`}>
            {messages.notifications.tabs.inbox}
          </button>
          <button type="button" onClick={() => setActiveTab(1)} className={`border-b-2 px-4 pb-3 text-sm font-medium ${activeTab === 1 ? "border-indigo-500 text-white" : "border-transparent text-neutral-400"}`}>
            {messages.notifications.tabs.preferences}
          </button>
        </div>

        {activeTab === 0 ? (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap gap-2">
                {categories.map((category, index) => (
                  <button key={category.key} type="button" onClick={() => setCategoryIndex(index)} className={`rounded-lg px-3 py-1.5 text-xs font-medium ${categoryIndex === index ? "bg-indigo-600 text-white" : "border border-neutral-800 bg-neutral-900 text-neutral-400"}`}>
                    {category.label}
                  </button>
                ))}
              </div>
              {unreadCount > 0 ? (
                <button type="button" onClick={markAllAsRead} className="text-xs font-medium text-indigo-400 hover:text-indigo-300">
                  {messages.notifications.markAllRead}
                </button>
              ) : null}
            </div>

            <div className="space-y-3">
              {loading ? (
                <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-8 text-center text-sm text-neutral-400">{messages.notifications.loading}</div>
              ) : filteredNotifications.length === 0 ? (
                <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-12 text-center">
                  <p className="text-base font-medium text-neutral-300">{messages.notifications.empty}</p>
                  <p className="mt-1 text-sm text-neutral-500">{messages.notifications.emptySubtitle}</p>
                </div>
              ) : (
                filteredNotifications.map((notification) => (
                  <article key={notification.id} className={`rounded-xl border p-4 ${notification.read ? "border-neutral-800/60 bg-neutral-900/50" : "border-neutral-700/80 bg-neutral-900"}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1">
                        <div className="mb-1 flex items-center gap-2">
                          <span className="rounded border border-indigo-500/30 bg-indigo-500/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-indigo-300">{messages.notifications.categories[notification.category]}</span>
                          {!notification.read ? <span className="h-2 w-2 rounded-full bg-indigo-500" /> : null}
                          <span className="text-xs font-mono text-neutral-500">{formatDateTime(notification.timestamp)}</span>
                        </div>
                        <h2 className="text-sm font-semibold text-white">{notification.heading}</h2>
                        <p className="mt-1 text-xs leading-relaxed text-neutral-400">{notification.content}</p>
                      </div>
                      {!notification.read ? (
                        <button type="button" onClick={() => markAsRead(notification.id)} className="whitespace-nowrap rounded-md border border-neutral-800 px-2.5 py-1 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200">
                          {messages.notifications.markRead}
                        </button>
                      ) : null}
                    </div>
                  </article>
                ))
              )}
            </div>
          </div>
        ) : (
          <div>
            {saved ? <div className="mb-6 rounded-lg border border-emerald-800 bg-emerald-950/60 p-4 text-sm text-emerald-200">{messages.notifications.preferencesSaved}</div> : null}
            {!preferencesLoaded ? (
              <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-8 text-center text-sm text-neutral-400">{messages.notifications.loading}</div>
            ) : (
              <form onSubmit={savePreferences} className="space-y-6 rounded-xl border border-neutral-800 bg-neutral-900 p-6 shadow-sm">
                <div className="space-y-4">
                  {preferenceRows.map((row) => (
                    <label key={row.type} className="flex cursor-pointer items-start gap-3">
                      <input type="checkbox" checked={preferences[row.type]} onChange={(event) => setPreferences((previous) => ({ ...previous, [row.type]: event.target.checked }))} className="mt-1 h-4 w-4 rounded border-neutral-700 bg-neutral-800 text-indigo-600 focus:ring-indigo-500" />
                      <span className="text-sm font-medium text-neutral-200">{row.label}</span>
                    </label>
                  ))}
                </div>
                <div className="border-t border-neutral-800 pt-4">
                  <button type="submit" className="inline-flex rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-indigo-500">
                    {messages.notifications.savePreferences}
                  </button>
                </div>
              </form>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
