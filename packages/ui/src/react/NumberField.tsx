"use client";

import { useState, type InputHTMLAttributes } from "react";
import { normaliseIntegerInput, parseIntegerInput } from "../number-input.js";

export type NumberFieldProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "value" | "defaultValue" | "onChange" | "inputMode" | "pattern" | "min" | "max" | "step"
> & {
  /** Controlled value. Pair with onValueChange. */
  value?: number | null;
  /** Initial value for uncontrolled use inside a FormData form. */
  defaultValue?: number | null;
  /** Receives the parsed whole number, or null while the field is empty. */
  onValueChange?: (value: number | null) => void;
};

const format = (value: number | null | undefined) => (value === null || value === undefined ? "" : String(value));

/**
 * Whole-number text field: numeric keypad on touch devices, no spin buttons,
 * and leading zeros dropped as the organiser types. Clearing a controlled field
 * and leaving it restores the last value the parent accepted.
 */
export function NumberField({ value, defaultValue, onValueChange, onBlur, autoComplete, ...props }: NumberFieldProps) {
  const controlled = value !== undefined;
  const [draft, setDraft] = useState(() => format(controlled ? value : defaultValue));
  const [previous, setPrevious] = useState(value);

  // Follow external changes (reset, server data) without fighting the draft being typed.
  if (controlled && value !== previous) {
    setPrevious(value);
    if (parseIntegerInput(draft) !== value) setDraft(format(value));
  }

  const shared = {
    ...props,
    type: "text",
    inputMode: "numeric",
    pattern: "[0-9]*",
    autoComplete: autoComplete ?? "off",
  } as const;

  if (!controlled) {
    // Truly uncontrolled so FormData and form.reset() keep working.
    return (
      <input
        {...shared}
        defaultValue={format(defaultValue)}
        onBlur={onBlur}
        onChange={(event) => {
          const next = normaliseIntegerInput(event.currentTarget.value);
          if (next !== event.currentTarget.value) event.currentTarget.value = next;
          onValueChange?.(parseIntegerInput(next));
        }}
      />
    );
  }

  return (
    <input
      {...shared}
      value={draft}
      onChange={(event) => {
        const next = normaliseIntegerInput(event.target.value);
        setDraft(next);
        onValueChange?.(parseIntegerInput(next));
      }}
      onBlur={(event) => {
        if (draft === "" && value !== null) setDraft(format(value));
        onBlur?.(event);
      }}
    />
  );
}
