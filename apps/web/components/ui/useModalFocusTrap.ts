"use client";

import { useCallback, useEffect, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

/**
 * Keyboard behaviour for a modal dialog: focus moves into the dialog when it opens (first control, or the container
 * itself when there is none, so give the container tabIndex={-1}), Tab/Shift+Tab stay inside, Escape calls onEscape,
 * and focus goes back to whatever had it before the dialog opened.
 */
export function useModalFocusTrap<T extends HTMLElement = HTMLDivElement>(open: boolean, onEscape: () => void) {
  const modalRef = useRef<T>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const onEscapeRef = useRef(onEscape);
  useEffect(() => {
    onEscapeRef.current = onEscape;
  });

  // The trigger is often disabled while its request runs, which drops focus to <body> before the dialog opens.
  // Remember the last element focused outside the dialog so focus can still go back to it.
  const lastFocusedRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    function remember(event: FocusEvent) {
      const target = event.target;
      if (target instanceof HTMLElement && !modalRef.current?.contains(target)) lastFocusedRef.current = target;
    }
    window.document.addEventListener("focusin", remember);
    return () => window.document.removeEventListener("focusin", remember);
  }, []);

  useEffect(() => {
    if (open) {
      const active = window.document.activeElement;
      triggerRef.current =
        active instanceof HTMLElement && active !== window.document.body ? active : lastFocusedRef.current;
      const container = modalRef.current;
      const first = container?.querySelector<HTMLElement>("button:not([disabled]), [tabindex]:not([tabindex='-1'])");
      (first ?? container)?.focus();
    } else {
      triggerRef.current?.focus();
      triggerRef.current = null;
    }
  }, [open]);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<T>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onEscapeRef.current();
      return;
    }
    if (event.key !== "Tab") return;
    const container = modalRef.current;
    const controls = Array.from(
      container?.querySelectorAll<HTMLElement>("button:not([disabled]), [tabindex]:not([tabindex='-1'])") ?? [],
    );
    const first = controls[0];
    const last = controls.at(-1);
    if (!first || !last) {
      // Nothing focusable inside: keep focus on the container rather than letting Tab escape the dialog.
      event.preventDefault();
      container?.focus();
      return;
    }
    const active = window.document.activeElement;
    const outside = !container?.contains(active);
    if (event.shiftKey && (active === first || active === container || outside)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || outside)) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  return { modalRef, onKeyDown };
}
