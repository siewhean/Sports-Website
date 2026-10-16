"use client";

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

export type InfoTipProps = {
  /** Accessible name of the (i) button, for example "About match slot length". */
  label: string;
  /** The secondary explanation shown in the popover. */
  children: ReactNode;
  className?: string;
  /** Renders the popover open initially. Intended for tests and previews. */
  defaultOpen?: boolean;
  /**
   * Id for the popover, so a field can keep `aria-describedby` pointing at a hint
   * that moved into the tip (a hidden description is still announced).
   */
  id?: string;
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

/** Delay before a hovered (i) opens, so passing the pointer over it does not flash the popover. */
export const INFO_TIP_OPEN_DELAY_MS = 150;
/** Delay before a hover-opened popover closes, long enough to cross from the button into the panel. */
export const INFO_TIP_CLOSE_DELAY_MS = 250;

/**
 * `open` is whether the popover shows. `pinned` is true once the person clicked,
 * tapped or pressed Enter/Space: a pinned tip ignores pointer leave and focus
 * loss and only closes on another activation, Escape or an outside press.
 */
export type InfoTipState = { open: boolean; pinned: boolean };

export type InfoTipController = {
  readonly state: InfoTipState;
  /** Pointer entered the tip (button or panel). Only a mouse starts the hover timer. */
  pointerEnter(pointerType: string): void;
  /** Pointer left the whole tip. Starts the close timer for a hover-opened tip. */
  pointerLeave(pointerType: string): void;
  /** Button activation: click, tap, Enter or Space. */
  activate(): void;
  /** Escape or a press outside: close regardless of how it opened. */
  dismiss(): void;
  /** Focus moved outside the tip: close unless pinned. */
  focusOut(): void;
  /** Clear any pending timers. */
  dispose(): void;
};

/**
 * Framework-free state machine behind InfoTip, exported for unit tests.
 * Uses the global timer functions at call time so fake timers apply.
 */
export function createInfoTipController(options: {
  onChange: (state: InfoTipState) => void;
  initial?: InfoTipState;
  openDelay?: number;
  closeDelay?: number;
}): InfoTipController {
  const openDelay = options.openDelay ?? INFO_TIP_OPEN_DELAY_MS;
  const closeDelay = options.closeDelay ?? INFO_TIP_CLOSE_DELAY_MS;
  let state: InfoTipState = options.initial ?? { open: false, pinned: false };
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  const set = (next: InfoTipState) => {
    if (next.open === state.open && next.pinned === state.pinned) return;
    state = next;
    options.onChange(state);
  };
  const clearOpen = () => {
    if (openTimer !== undefined) clearTimeout(openTimer);
    openTimer = undefined;
  };
  const clearClose = () => {
    if (closeTimer !== undefined) clearTimeout(closeTimer);
    closeTimer = undefined;
  };
  const close = () => {
    clearOpen();
    clearClose();
    set({ open: false, pinned: false });
  };

  return {
    get state() {
      return state;
    },
    pointerEnter(pointerType) {
      if (pointerType !== "mouse") return;
      clearClose();
      if (state.open || openTimer !== undefined) return;
      openTimer = setTimeout(() => {
        openTimer = undefined;
        set({ open: true, pinned: false });
      }, openDelay);
    },
    pointerLeave(pointerType) {
      if (pointerType !== "mouse") return;
      clearOpen();
      if (!state.open || state.pinned || closeTimer !== undefined) return;
      closeTimer = setTimeout(() => {
        closeTimer = undefined;
        set({ open: false, pinned: false });
      }, closeDelay);
    },
    activate() {
      clearOpen();
      clearClose();
      // A click on a hover-opened tip pins it instead of toggling it shut.
      if (state.open && !state.pinned) set({ open: true, pinned: true });
      else if (state.open) set({ open: false, pinned: false });
      else set({ open: true, pinned: true });
    },
    dismiss: close,
    focusOut() {
      clearOpen();
      if (state.open && !state.pinned) close();
    },
    dispose() {
      clearOpen();
      clearClose();
    },
  };
}

/**
 * An (i) button placed next to a label or heading that discloses a longer,
 * secondary explanation.
 *
 * - Mouse: hovering opens after a short delay; moving into the popover keeps
 *   it open; leaving closes it. A click pins it open (or toggles a pinned one).
 * - Touch: a tap toggles it. There is no hover emulation.
 * - Keyboard: Enter or Space toggles it; Escape closes it from the button or
 *   the popover and returns focus to the button. Focus leaving the tip closes
 *   an unpinned (hover-opened) popover.
 * - A press outside closes it.
 *
 * Keep errors and short essential hints inline; use this only for supporting
 * detail. Place it beside the <label>, not inside it, so the explanation never
 * becomes part of the field's accessible name.
 */
export function InfoTip({ label, children, className, defaultOpen = false, id }: InfoTipProps) {
  const reactId = useId();
  const panelId = id ?? `infotip-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [state, setState] = useState<InfoTipState>({ open: defaultOpen, pinned: defaultOpen });
  const open = state.open;
  const rootRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLSpanElement>(null);
  const controllerRef = useRef<InfoTipController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createInfoTipController({
      initial: { open: defaultOpen, pinned: defaultOpen },
      onChange: setState,
    });
  }
  const controller = controllerRef.current;

  useEffect(() => () => controller.dispose(), [controller]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      controller.dismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      controller.dismiss();
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, controller]);

  // Nudge the popover sideways so it never causes horizontal scrolling on phones.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel) return;
    panel.style.setProperty("--infotip-shift", "0px");
    const rect = panel.getBoundingClientRect();
    const shift = infoTipShift(rect.left, rect.width, document.documentElement.clientWidth);
    panel.style.setProperty("--infotip-shift", `${shift}px`);
  }, [open]);

  const onPointerEnter = (event: ReactPointerEvent<HTMLSpanElement>) => controller.pointerEnter(event.pointerType);
  const onPointerLeave = (event: ReactPointerEvent<HTMLSpanElement>) => controller.pointerLeave(event.pointerType);
  const onBlur = (event: FocusEvent<HTMLSpanElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && rootRef.current?.contains(next)) return;
    controller.focusOut();
  };

  return (
    <span
      ref={rootRef}
      className={className ? `md-infotip ${className}` : "md-infotip"}
      data-open={open || undefined}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onBlur={onBlur}
    >
      <button
        ref={buttonRef}
        type="button"
        className="md-infotip__button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={panelId}
        aria-describedby={open ? panelId : undefined}
        onClick={() => controller.activate()}
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
