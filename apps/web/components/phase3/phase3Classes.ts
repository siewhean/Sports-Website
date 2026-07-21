type Phase3ClassValue = string | false | null | undefined;

/** Maps stable Phase 3 tokens to their locally scoped CSS Module names. */
export function phase3Classes(styles: Readonly<Record<string, string>>, ...values: readonly Phase3ClassValue[]) {
  return values
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .flatMap((value) => value.split(/\s+/))
    .map((token) => styles[token] ?? token)
    .join(" ");
}
