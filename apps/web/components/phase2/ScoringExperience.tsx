"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { SportId } from "@matchday/domain";
import { scoringControlPanelCopy } from "@/lib/scoring-control-panel-copy";
import { PhoneScoring } from "./PhoneScoring";
import styles from "./ScoringExperience.module.css";

type ScoringExperienceProps = Readonly<{
  initialWriterState?:
    | "active"
    | "candidate"
    | "checking"
    | "conflict"
    | "expired"
    | "expiring"
    | "rate-limited"
    | "read-only"
    | "revoked"
    | "transferred";
  mode?: "api" | "demo";
  recoverOnLoad?: boolean;
  demoSportId?: SportId;
}>;

const swipeThreshold = 36;

export function ScoringExperience(props: ScoringExperienceProps) {
  const [historyAvailable, setHistoryAvailable] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [eventCount, setEventCount] = useState(0);
  const handleRef = useRef<HTMLButtonElement>(null);
  const pointerStartRef = useRef<{ id: number; y: number } | null>(null);

  useEffect(() => {
    let eventLog: HTMLElement | null = null;
    let eventObserver: MutationObserver | null = null;

    const updateEventCount = () => {
      if (!eventLog) {
        setEventCount(0);
        return;
      }
      setEventCount(eventLog.querySelectorAll("ol > li").length);
    };

    const bindEventLog = () => {
      const nextEventLog = document.querySelector<HTMLElement>(".p2-event-log");
      if (nextEventLog === eventLog) return;

      eventObserver?.disconnect();
      eventObserver = null;
      eventLog = nextEventLog;
      setHistoryAvailable(Boolean(eventLog));

      if (!eventLog) {
        setHistoryOpen(false);
        setEventCount(0);
        return;
      }

      eventLog.id = "score-event-history";
      eventLog.tabIndex = -1;
      eventLog.dataset.historyDrawer = "true";
      updateEventCount();
      eventObserver = new MutationObserver(updateEventCount);
      eventObserver.observe(eventLog, { childList: true, subtree: true, characterData: true });
    };

    bindEventLog();
    const pageObserver = new MutationObserver(bindEventLog);
    pageObserver.observe(document.body, { childList: true, subtree: true });

    return () => {
      pageObserver.disconnect();
      eventObserver?.disconnect();
      if (eventLog) {
        eventLog.removeAttribute("id");
        eventLog.removeAttribute("tabindex");
        delete eventLog.dataset.historyDrawer;
        eventLog.removeAttribute("aria-hidden");
        eventLog.removeAttribute("inert");
      }
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.scoringHistoryOpen = historyOpen ? "true" : "false";
    const eventLog = document.querySelector<HTMLElement>(".p2-event-log");
    if (eventLog) {
      eventLog.setAttribute("aria-hidden", historyOpen ? "false" : "true");
      if (historyOpen) eventLog.removeAttribute("inert");
      else eventLog.setAttribute("inert", "");
    }

    if (historyOpen) {
      window.requestAnimationFrame(() => eventLog?.focus({ preventScroll: true }));
    }

    return () => {
      delete document.documentElement.dataset.scoringHistoryOpen;
    };
  }, [historyAvailable, historyOpen]);

  useEffect(() => {
    if (!historyOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setHistoryOpen(false);
      window.requestAnimationFrame(() => handleRef.current?.focus({ preventScroll: true }));
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [historyOpen]);

  const toggleHistory = () => setHistoryOpen((open) => !open);

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    pointerStartRef.current = { id: event.pointerId, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const start = pointerStartRef.current;
    pointerStartRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!start || start.id !== event.pointerId) return;
    const distance = event.clientY - start.y;
    if (distance >= swipeThreshold) {
      setHistoryOpen(true);
      return;
    }
    if (Math.abs(distance) < 8) toggleHistory();
  };

  const closeHistory = () => {
    setHistoryOpen(false);
    window.requestAnimationFrame(() => handleRef.current?.focus({ preventScroll: true }));
  };

  return (
    <div className={styles.experience}>
      <PhoneScoring {...props} />
      {historyAvailable ? (
        <>
          <button
            ref={handleRef}
            className={styles.historyHandle}
            type="button"
            aria-controls="score-event-history"
            aria-expanded={historyOpen}
            data-open={historyOpen ? "true" : "false"}
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp}
            onPointerCancel={() => {
              pointerStartRef.current = null;
            }}
          >
            <span className={styles.pullMark} aria-hidden="true" />
            <span>
              <strong>
                {historyOpen ? scoringControlPanelCopy.matchEventsOpen : scoringControlPanelCopy.swipeDownForEvents}
              </strong>
              <small>
                {scoringControlPanelCopy.recordedEvents(eventCount)} · {scoringControlPanelCopy.tapAlsoWorks}
              </small>
            </span>
          </button>
          {historyOpen ? (
            <>
              <button
                className={styles.backdrop}
                type="button"
                aria-label={scoringControlPanelCopy.closeMatchEvents}
                onClick={closeHistory}
              />
              <button className={styles.closeHistory} type="button" onClick={closeHistory}>
                {scoringControlPanelCopy.closeEvents}
              </button>
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
