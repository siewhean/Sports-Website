"use client";

import { useState } from "react";
import { formatDateTime, interpolate, messages } from "@matchday/ui";

export interface InAppNotification {
  id: string;
  category: keyof typeof messages.notifications.categories;
  heading: string;
  content: string;
  timestamp: string;
  read: boolean;
}

const INITIAL_NOTIFICATIONS: InAppNotification[] = messages.notifications.sampleAlerts.map((alert, index) => ({
  id: alert.id,
  category: alert.category,
  heading: alert.heading,
  content: alert.content,
  timestamp: alert.timestamp,
  read: index >= 2,
}));

export default function NotificationsPage() {
  const [activeTab, setActiveTab] = useState<number>(0);
  const [categoryIndex, setCategoryIndex] = useState<number>(0);
  const [notifications, setNotifications] = useState<InAppNotification[]>(INITIAL_NOTIFICATIONS);
  const [saved, setSaved] = useState(false);
  const [preferences, setPreferences] = useState({
    matchReminders: true,
    scheduleUpdates: true,
    resultConflicts: true,
    billingReceipts: true,
  });

  const unreadCount = notifications.filter((n) => !n.read).length;

  const categories = [
    messages.notifications.categories.all,
    messages.notifications.categories.schedule_update,
    messages.notifications.categories.result_conflict,
    messages.notifications.categories.match_reminder,
    messages.notifications.categories.billing_receipt,
  ];

  const filteredNotifications = notifications.filter((n) => {
    if (categoryIndex === 0) return true;
    const categoryName = categories[categoryIndex];
    return messages.notifications.categories[n.category] === categoryName;
  });

  const markAsRead = (id: string) => {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
  };

  const markAllAsRead = () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  };

  const handleSubmitPreferences = (e: React.FormEvent) => {
    e.preventDefault();
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-3xl mx-auto">
        <header className="mb-8">
          <div className="flex items-center justify-between">
            <h1 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">{messages.notifications.title}</h1>
            {unreadCount > 0 && (
              <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold bg-indigo-500/20 text-indigo-400 border border-indigo-500/30">
                {interpolate(messages.notifications.unreadCount, { count: unreadCount })}
              </span>
            )}
          </div>
          <p className="mt-2 text-base text-neutral-400">{messages.notifications.subtitle}</p>
        </header>

        {/* Tab Navigation */}
        <div className="flex border-b border-neutral-800 mb-6 gap-2">
          <button
            type="button"
            onClick={() => setActiveTab(0)}
            className={`pb-3 px-4 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 0
                ? "border-indigo-500 text-white font-semibold"
                : "border-transparent text-neutral-400 hover:text-neutral-200"
            }`}
          >
            {messages.notifications.tabs.inbox}
            {unreadCount > 0 && (
              <span className="ml-2 px-1.5 py-0.5 rounded-full text-xs bg-indigo-600 text-white font-mono">
                {unreadCount}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab(1)}
            className={`pb-3 px-4 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 1
                ? "border-indigo-500 text-white font-semibold"
                : "border-transparent text-neutral-400 hover:text-neutral-200"
            }`}
          >
            {messages.notifications.tabs.preferences}
          </button>
        </div>

        {activeTab === 0 ? (
          <div className="space-y-6">
            {/* Category Filter Pills & Mark All Read */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap gap-2">
                {categories.map((label, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => setCategoryIndex(idx)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                      categoryIndex === idx
                        ? "bg-indigo-600 text-white"
                        : "bg-neutral-900 border border-neutral-800 text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {unreadCount > 0 && (
                <button
                  type="button"
                  onClick={markAllAsRead}
                  className="text-xs font-medium text-indigo-400 hover:text-indigo-300 transition-colors"
                >
                  {messages.notifications.markAllRead}
                </button>
              )}
            </div>

            {/* Notification List */}
            <div className="space-y-3">
              {filteredNotifications.length === 0 ? (
                <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-12 text-center">
                  <p className="text-base font-medium text-neutral-300">{messages.notifications.empty}</p>
                  <p className="text-sm text-neutral-500 mt-1">{messages.notifications.emptySubtitle}</p>
                </div>
              ) : (
                filteredNotifications.map((notif) => (
                  <div
                    key={notif.id}
                    className={`p-4 rounded-xl border transition-all ${
                      notif.read
                        ? "bg-neutral-900/50 border-neutral-800/60 opacity-80"
                        : "bg-neutral-900 border-neutral-700/80 shadow-sm"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                            {messages.notifications.categories[notif.category]}
                          </span>
                          {!notif.read && <span className="h-2 w-2 rounded-full bg-indigo-500 animate-pulse" />}
                          <span className="text-xs text-neutral-500 font-mono">{formatDateTime(notif.timestamp)}</span>
                        </div>
                        <h3 className="text-sm font-semibold text-white">{notif.heading}</h3>
                        <p className="text-xs text-neutral-400 mt-1 leading-relaxed">{notif.content}</p>
                      </div>

                      {!notif.read && (
                        <button
                          type="button"
                          onClick={() => markAsRead(notif.id)}
                          className="text-xs text-neutral-400 hover:text-neutral-200 border border-neutral-800 hover:bg-neutral-800 px-2.5 py-1 rounded-md transition-colors whitespace-nowrap"
                        >
                          {messages.notifications.markRead}
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        ) : (
          <div>
            {saved && (
              <div className="mb-6 p-4 rounded-lg bg-emerald-950/60 border border-emerald-800 text-emerald-200 text-sm">
                {messages.notifications.preferencesSaved}
              </div>
            )}

            <form
              onSubmit={handleSubmitPreferences}
              className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 space-y-6 shadow-sm"
            >
              <div className="space-y-4">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={preferences.matchReminders}
                    onChange={(e) => setPreferences((prev) => ({ ...prev, matchReminders: e.target.checked }))}
                    className="mt-1 h-4 w-4 rounded border-neutral-700 text-indigo-600 focus:ring-indigo-500 bg-neutral-800"
                  />
                  <span className="text-sm font-medium text-neutral-200">{messages.notifications.matchReminders}</span>
                </label>

                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={preferences.scheduleUpdates}
                    onChange={(e) => setPreferences((prev) => ({ ...prev, scheduleUpdates: e.target.checked }))}
                    className="mt-1 h-4 w-4 rounded border-neutral-700 text-indigo-600 focus:ring-indigo-500 bg-neutral-800"
                  />
                  <span className="text-sm font-medium text-neutral-200">{messages.notifications.scheduleUpdates}</span>
                </label>

                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={preferences.resultConflicts}
                    onChange={(e) => setPreferences((prev) => ({ ...prev, resultConflicts: e.target.checked }))}
                    className="mt-1 h-4 w-4 rounded border-neutral-700 text-indigo-600 focus:ring-indigo-500 bg-neutral-800"
                  />
                  <span className="text-sm font-medium text-neutral-200">{messages.notifications.resultConflicts}</span>
                </label>

                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={preferences.billingReceipts}
                    onChange={(e) => setPreferences((prev) => ({ ...prev, billingReceipts: e.target.checked }))}
                    className="mt-1 h-4 w-4 rounded border-neutral-700 text-indigo-600 focus:ring-indigo-500 bg-neutral-800"
                  />
                  <span className="text-sm font-medium text-neutral-200">{messages.notifications.billingReceipts}</span>
                </label>
              </div>

              <div className="pt-4 border-t border-neutral-800">
                <button
                  type="submit"
                  className="inline-flex justify-center py-2.5 px-5 border border-transparent rounded-lg shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 transition-colors"
                >
                  {messages.notifications.savePreferences}
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
