/** Machine values used by the spectator components (kept out of components so i18n linting stays strict). */
export const publicUi = {
  col: "col",
  row: "row",
  push: "push",
  replace: "replace",
  locale: "en-SG",
} as const;
export type LiveTone = "live" | "warn" | "idle";
