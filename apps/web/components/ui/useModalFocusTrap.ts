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

  useEffect(() => {
    if (open) {
      triggerRef.current = window.document.activeElement as HTMLElement | null;
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
