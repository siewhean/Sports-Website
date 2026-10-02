"use client";

import { useEffect, useMemo, useState } from "react";
import { formatDateTime, interpolate, messages } from "@matchday/ui";
import { gateCC4Http } from "@/lib/gate-c-c4-http";
import { AncillaryPage } from "@/components/ancillary/AncillaryPage";
import styles from "./NotificationsPage.module.css";
import {
  emptyPreferences,
  notificationMachine,
  notificationPageItems,
  preferenceTypes,
  type InAppNotification,
  type NotificationCategory,
  type PreferenceType,
  type Preferences,
} from "@/lib/notifications";

export default function NotificationsPageClient({ demoMode }: { demoMode: boolean }) {
  const [activeTab, setActiveTab] = useState(0);
  const [categoryIndex, setCategoryIndex] = useState(0);
  const [notifications, setNotifications] = useState<InAppNotification[]>([]);
  const [loading, setLoading] = useState(!demoMode);
  const [preferences, setPreferences] = useState<Preferences>(emptyPreferences);
  const [preferencesLoaded, setPreferencesLoaded] = useState(demoMode);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (demoMode) return;
    let cancelled = false;
    void fetch("/api/notifications", { cache: gateCC4Http.cacheNoStore })
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
  }, [demoMode]);

  useEffect(() => {
    if (demoMode) return;
    let cancelled = false;
    void Promise.all(
      preferenceTypes.map(async (type) => {
        const response = await fetch(`/api/notifications/preferences/${encodeURIComponent(type)}`, {
          cache: gateCC4Http.cacheNoStore,
        });
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
  }, [demoMode]);

  const unreadCount = notifications.filter((notification) => !notification.read).length;
  const categories: ReadonlyArray<{ key: NotificationCategory | typeof notificationMachine.all; label: string }> =
    useMemo(
      () => [
        { key: notificationMachine.all, label: messages.notifications.categories.all },
        { key: notificationMachine.scheduleUpdate, label: messages.notifications.categories.schedule_update },
        { key: notificationMachine.resultConflict, label: messages.notifications.categories.result_conflict },
        { key: notificationMachine.matchReminder, label: messages.notifications.categories.match_reminder },
        { key: notificationMachine.billingReceipt, label: messages.notifications.categories.billing_receipt },
      ],
      [],
    );
  const selectedCategory = categories[categoryIndex]?.key ?? notificationMachine.all;
  const filteredNotifications = notifications.filter(
    (notification) => selectedCategory === notificationMachine.all || notification.category === selectedCategory,
  );

  const markAsRead = (id: string) => {
    setNotifications((previous) =>
      previous.map((notification) => (notification.id === id ? { ...notification, read: true } : notification)),
    );
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
          method: gateCC4Http.methodPut,
          headers: { "content-type": gateCC4Http.jsonContentType },
          body: JSON.stringify({ in_app_enabled: preferences[type], email_enabled: preferences[type] }),
        }),
      ),
    ).catch(() => []);
    if (responses.length === preferenceTypes.length && responses.every((response) => response.ok)) setSaved(true);
  };

  const preferenceRows: ReadonlyArray<{ type: PreferenceType; label: string }> = [
    { type: notificationMachine.matchReminder, label: messages.notifications.matchReminders },
    { type: notificationMachine.scheduleUpdate, label: messages.notifications.scheduleUpdates },
    { type: notificationMachine.resultConflict, label: messages.notifications.resultConflicts },
    { type: notificationMachine.billingReceipt, label: messages.notifications.billingReceipts },
  ];

  return (
    <AncillaryPage title={messages.notifications.title} intro={messages.notifications.subtitle} narrow>
      <div className={styles.workspace}>
        {unreadCount > 0 ? (
          <p className={styles.unreadCount}>
            {interpolate(messages.notifications.unreadCount, { count: unreadCount })}
          </p>
        ) : null}
        <div className={styles.tabs} role="tablist" aria-label={messages.notifications.title}>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 0}
            className={activeTab === 0 ? styles.activeTab : ""}
            onClick={() => setActiveTab(0)}
          >
            {messages.notifications.tabs.inbox}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 1}
            className={activeTab === 1 ? styles.activeTab : ""}
            onClick={() => setActiveTab(1)}
          >
            {messages.notifications.tabs.preferences}
          </button>
        </div>
        {activeTab === 0 ? (
          <div className={styles.stack} role="tabpanel">
            <div className={styles.toolbar}>
              <div className={styles.filters} aria-label={messages.notifications.title}>
                {categories.map((category, index) => (
                  <button
                    key={category.key}
                    type="button"
                    aria-pressed={categoryIndex === index}
                    className={categoryIndex === index ? styles.selectedFilter : ""}
                    onClick={() => setCategoryIndex(index)}
                  >
                    {category.label}
                  </button>
                ))}
              </div>
              {unreadCount > 0 ? (
                <button type="button" className={styles.textButton} onClick={markAllAsRead}>
                  {messages.notifications.markAllRead}
                </button>
              ) : null}
            </div>
            {loading ? (
              <div className={styles.empty} role="status">
                {messages.notifications.loading}
              </div>
            ) : filteredNotifications.length === 0 ? (
              <div className={styles.empty}>
                <strong>{messages.notifications.empty}</strong>
                <p>{messages.notifications.emptySubtitle}</p>
              </div>
            ) : (
              filteredNotifications.map((notification) => (
                <article
                  key={notification.id}
                  className={`${styles.notification} ${!notification.read ? styles.unread : ""}`}
                >
                  <div className={styles.notificationBody}>
                    <div className={styles.meta}>
                      <span className={styles.category}>
                        {messages.notifications.categories[notification.category]}
                      </span>
                      <time dateTime={notification.timestamp}>{formatDateTime(notification.timestamp)}</time>
                    </div>
                    <h2>{notification.heading}</h2>
                    <p>{notification.content}</p>
                  </div>
                  {!notification.read ? (
                    <button
                      type="button"
                      className={styles.secondaryButton}
                      onClick={() => markAsRead(notification.id)}
                    >
                      {messages.notifications.markRead}
                    </button>
                  ) : null}
                </article>
              ))
            )}
          </div>
        ) : (
          <div role="tabpanel" className={styles.stack}>
            {saved ? (
              <p className={styles.saved} role="status">
                {messages.notifications.preferencesSaved}
              </p>
            ) : null}
            {!preferencesLoaded ? (
              <div className={styles.empty} role="status">
                {messages.notifications.loading}
              </div>
            ) : (
              <form onSubmit={savePreferences} className={styles.preferenceForm}>
                {preferenceRows.map((row) => (
                  <label key={row.type} className={styles.preferenceRow}>
                    <input
                      type="checkbox"
                      checked={preferences[row.type]}
                      onChange={(event) =>
                        setPreferences((previous) => ({ ...previous, [row.type]: event.target.checked }))
                      }
                    />
                    <span>{row.label}</span>
                  </label>
                ))}
                <button type="submit" className={styles.primaryButton} disabled={demoMode}>
                  {messages.notifications.savePreferences}
                </button>
              </form>
            )}
          </div>
        )}
      </div>
    </AncillaryPage>
  );
}
