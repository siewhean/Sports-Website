type ClassValue = string | false | null | undefined;

/** Maps semantic class tokens to their CSS Module names while preserving global utility tokens. */
export function cssModuleClasses(styles: Readonly<Record<string, string>>, ...values: readonly ClassValue[]) {
  return values
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .flatMap((value) => value.split(/\s+/))
    .map((token) => styles[token] ?? token)
    .join(" ");
}
