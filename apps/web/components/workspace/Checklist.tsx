"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { messages } from "@matchday/ui";
import { Check } from "@phosphor-icons/react";
import styles from "./Checklist.module.css";

const STORAGE_KEY = "matchday-checklist-only-left";
const copy = messages.organiserShell;

export type ChecklistStep = Readonly<{
  id: string;
  label: string;
  done: boolean;
  href: string;
}>;

export type ChecklistProps = {
  steps: readonly ChecklistStep[];
  title?: string;
  registrationStep?: ChecklistStep | null;
};

const storageEventName = "matchday-checklist-storage";
let memoryShowOnlyLeft: boolean | null = null;

function subscribeChecklistStorage(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", onChange);
  window.addEventListener(storageEventName, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(storageEventName, onChange);
  };
}

function readShowOnlyLeftSnapshot(): boolean {
  if (memoryShowOnlyLeft !== null) return memoryShowOnlyLeft;
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function getServerSnapshot(): boolean {
  return false;
}

function writeShowOnlyLeft(checked: boolean): void {
  memoryShowOnlyLeft = checked;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, checked ? "true" : "false");
    } catch {
      // Ignore localStorage errors
    }
    window.dispatchEvent(new Event(storageEventName));
  }
}

export function Checklist({ steps, title = copy.checklistTitle, registrationStep = null }: ChecklistProps) {
  const showOnlyLeft = useSyncExternalStore(subscribeChecklistStorage, readShowOnlyLeftSnapshot, getServerSnapshot);

  const allSteps = registrationStep ? [...steps, registrationStep] : steps;
  const doneCount = allSteps.filter((s) => s.done).length;

  // Next step is the first incomplete step
  const nextStep = allSteps.find((s) => !s.done);
  const visibleSteps = showOnlyLeft ? allSteps.filter((s) => !s.done) : allSteps;

  return (
    <section className={styles.container} aria-labelledby="checklist-title">
      <header className={styles.header}>
        <div className={styles.titleGroup}>
          <h2 id="checklist-title" className={styles.title}>
            {title}
          </h2>
          <span className={styles.progressBadge}>
            {doneCount} / {allSteps.length}
          </span>
        </div>

        <label className={styles.filterToggle}>
          <input
            type="checkbox"
            className={styles.filterCheckbox}
            checked={showOnlyLeft}
            onChange={(e) => writeShowOnlyLeft(e.target.checked)}
            data-testid="checklist-show-only-left"
          />
          {copy.checklistOnlyLeft}
        </label>
      </header>

      <ol className={styles.list}>
        {visibleSteps.map((step, index) => {
          const isNext = nextStep?.id === step.id;
          return (
            <li
              key={step.id}
              className={`${styles.item} ${step.done ? styles.itemDone : ""} ${isNext ? styles.itemNext : ""}`}
              data-done={step.done}
              data-step-id={step.id}
              data-next-step={isNext ? "true" : undefined}
            >
              <div className={styles.leftGroup}>
                <span
                  className={`${styles.iconMark} ${step.done ? styles.iconMarkDone : ""} ${
                    isNext ? styles.iconMarkNext : ""
                  }`}
                  aria-hidden="true"
                >
                  {step.done ? <Check weight="bold" /> : index + 1}
                </span>
                <div className={styles.textGroup}>
                  <strong className={styles.itemLabel}>{step.label}</strong>
                  <span className={`${styles.itemStatus} ${isNext ? styles.itemStatusNext : ""}`}>
                    {step.done ? copy.stepDone : isNext ? copy.stepNext : copy.stepToDo}
                  </span>
                </div>
              </div>

              <Link
                href={step.href}
                className={`${styles.actionLink} ${isNext ? styles.actionLinkNext : ""}`}
                aria-label={copy.open}
              >
                {copy.open}
              </Link>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
