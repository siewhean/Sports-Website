"use client";

import { useState } from "react";
import { messages } from "@matchday/ui";

export default function NotificationsPage() {
  const [saved, setSaved] = useState(false);
  const [preferences, setPreferences] = useState({
    matchReminders: true,
    scheduleUpdates: true,
    resultConflicts: true,
    billingReceipts: true,
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-2xl mx-auto">
        <header className="mb-10">
          <h1 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">{messages.notifications.title}</h1>
          <p className="mt-3 text-lg text-neutral-400">{messages.notifications.subtitle}</p>
        </header>

        {saved && (
          <div className="mb-6 p-4 rounded-lg bg-emerald-950/60 border border-emerald-800 text-emerald-200 text-sm">
            {messages.notifications.preferencesSaved}
          </div>
        )}

        <form
          onSubmit={handleSubmit}
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
    </div>
  );
}
