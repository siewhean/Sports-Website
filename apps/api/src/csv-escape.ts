/**
 * RFC 4180 cell escaping plus spreadsheet formula-injection neutralisation (CWE-1236).
 *
 * Team, player and competition names are user controlled. Excel, Numbers, LibreOffice and Google
 * Sheets evaluate a cell that starts with `=`, `+`, `-`, `@`, TAB or CR as a formula (DDE/HYPERLINK
 * payloads), so such text cells are prefixed with an apostrophe, which spreadsheets treat as "this is
 * text" and hide on display. Real numbers (typeof number) are left alone so negative values such as
 * goal difference stay numeric.
 */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/u;

export function escapeCsvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (typeof value === "string" && FORMULA_TRIGGER.test(text)) text = `'${text}`;
  return /[",\n\r]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}
