/**
 * Whole-number field helpers shared by NumberField and plain form handlers.
 * Counts, minutes and seeds are typed, never nudged with spinners, and never
 * show leading zeros ("08", "010") once the organiser has typed them.
 */

/** Keeps digits only and drops leading zeros, so "010" becomes "10" and "000" becomes "0". */
export function normaliseIntegerInput(raw: string): string {
  const digits = raw.replace(/\D+/g, "");
  if (digits === "") return "";
  return digits.replace(/^0+(?=\d)/, "");
}

/** Parses a typed whole number, or returns null when the field is empty. */
export function parseIntegerInput(raw: string): number | null {
  const normalised = normaliseIntegerInput(raw);
  if (normalised === "") return null;
  const value = Number(normalised);
  return Number.isSafeInteger(value) ? value : null;
}
