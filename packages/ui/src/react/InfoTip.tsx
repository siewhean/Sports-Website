"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export type InfoTipProps = {
  /** Accessible name of the (i) button, for example "About match slot length". */
  label: string;
  /** The secondary explanation shown in the popover. */
  children: ReactNode;
  className?: string;
  /** Renders the popover open initially. Intended for tests and previews. */
  defaultOpen?: boolean;
};

export type InfoTipAction = "toggle" | "dismiss";

/** Pure open/close transition, exported for unit tests. */
export function infoTipReducer(open: boolean, action: InfoTipAction): boolean {
  return action === "toggle" ? !open : false;
}

/** Keeps a popover of `width` starting at `left` inside a viewport with a 16px gutter. */
export function infoTipShift(left: number, width: number, viewportWidth: number, gutter = 16): number {
  const right = left + width;
  if (right > viewportWidth - gutter) {
    const shifted = viewportWidth - gutter - right;
    return left + shifted < gutter ? gutter - left : shifted;
  }
  return left < gutter ? gutter - left : 0;
}

/**
 * An (i) button placed next to a field label that discloses a longer, secondary
 * explanation. Tap or click toggles it (never hover-only); Escape and a click
 * outside close it, and Escape returns focus to the button. Keep errors and
 * short essential hints inline; use this only for supporting detail.
 *
 * Place it beside the <label>, not inside it, so the explanation never becomes
 * part of the field's accessible name.
 */
export function InfoTip({ label, children, className, defaultOpen = false }: InfoTipProps) {
  const reactId = useId();
  const panelId = `infotip-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [open, setOpen] = useState(defaultOpen);
  const rootRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      setOpen((current) => infoTipReducer(current, "dismiss"));
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen((current) => infoTipReducer(current, "dismiss"));
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Nudge the popover sideways so it never causes horizontal scrolling on phones.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel) return;
    panel.style.setProperty("--infotip-shift", "0px");
    const rect = panel.getBoundingClientRect();
    const shift = infoTipShift(rect.left, rect.width, document.documentElement.clientWidth);
    panel.style.setProperty("--infotip-shift", `${shift}px`);
  }, [open]);

  return (
    <span ref={rootRef} className={className ? `md-infotip ${className}` : "md-infotip"} data-open={open || undefined}>
      <button
        ref={buttonRef}
        type="button"
        className="md-infotip__button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={panelId}
        aria-describedby={open ? panelId : undefined}
        onClick={() => setOpen((current) => infoTipReducer(current, "toggle"))}
      >
        <svg aria-hidden="true" focusable="false" viewBox="0 0 20 20" width="18" height="18">
          <circle cx="10" cy="10" r="8.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10 8.75v5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="10" cy="6.1" r="1" fill="currentColor" />
        </svg>
      </button>
      <span ref={panelRef} id={panelId} role="note" className="md-infotip__panel" hidden={!open}>
        {children}
      </span>
    </span>
  );
}
