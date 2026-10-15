import { cloneElement, type ReactElement } from "react";

/** A single form control element that a field wrapper labels and describes. */
export type FieldControl = ReactElement<{
  id?: string | undefined;
  "aria-describedby"?: string | undefined;
  "aria-invalid"?: boolean | undefined;
}>;

/**
 * Wires a control to its field wrapper: gives it the id the <label htmlFor> points
 * at, appends helper/error ids to any aria-describedby it already has, and marks
 * it invalid when the field shows an error.
 */
export function withFieldControl(
  control: FieldControl,
  {
    id,
    describedBy = [],
    invalid = false,
  }: { id: string; describedBy?: readonly (string | undefined)[]; invalid?: boolean },
): FieldControl {
  const ids = [control.props["aria-describedby"], ...describedBy].filter(Boolean).join(" ");
  return cloneElement(control, {
    id,
    "aria-describedby": ids || undefined,
    ...(invalid ? { "aria-invalid": true } : {}),
  });
}

/** The id a field wrapper should use for its control: the control's own id, else a stable fallback. */
export function fieldControlId(control: FieldControl, fallback: string): string {
  return control.props.id ?? fallback;
}
