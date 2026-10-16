/**
 * The only colour literals in MATCHDAY (owner decision D12), mirrored from the --palette-* tokens in
 * apps/web/app/globals.css and scripts/palette/approved-palette.json: black/white base plus four accents,
 * lime = actions, red = errors/urgent, blue = info/live, amber = warnings.
 */
export const palette = {
  black: "#111513",
  white: "#ffffff",
  lime: "#b7dc22",
  red: "#d4443c",
  blue: "#4f6fd6",
  amber: "#e9a410",
} as const;

export type PaletteColour = keyof typeof palette;

/**
 * Hex equivalent of CSS `color-mix(in srgb, a weight%, b)` for contexts that cannot read CSS tokens (Open Graph
 * images, the web manifest, theme-color meta). `weight` is 0..100, the share of `a`.
 */
export function mixPalette(a: PaletteColour, weight: number, b: PaletteColour): string {
  const channels = (hex: string) => [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
  const share = Math.min(100, Math.max(0, weight)) / 100;
  const from = channels(palette[a]);
  const to = channels(palette[b]);
  return `#${from
    .map((channel, index) =>
      Math.round(channel * share + (to[index] ?? 0) * (1 - share))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** Resolved values of the main theme tokens; apps/web/tests/unit/token-contrast.test.ts keeps them equal to the CSS. */
export const designTokens = {
  color: {
    canvas: mixPalette("black", 3, "white"),
    surface: palette.white,
    surfaceSubtle: mixPalette("black", 6, "white"),
    ink: palette.black,
    muted: mixPalette("black", 72, "white"),
    hairline: mixPalette("black", 16, "white"),
    signal: mixPalette("lime", 45, "black"),
    focus: mixPalette("blue", 85, "black"),
    danger: mixPalette("red", 82, "black"),
    warning: palette.amber,
    info: mixPalette("blue", 85, "black"),
  },
  darkColor: {
    canvas: palette.black,
    surface: mixPalette("white", 6, "black"),
    surfaceSubtle: mixPalette("white", 10, "black"),
    ink: mixPalette("white", 94, "black"),
    muted: mixPalette("white", 72, "black"),
    hairline: mixPalette("white", 22, "black"),
    signal: palette.lime,
    focus: palette.lime,
    danger: mixPalette("red", 60, "white"),
    warning: palette.amber,
    info: mixPalette("blue", 55, "white"),
  },
  /** Browser chrome colour (theme-color meta, manifest) per theme: the page canvas. */
  themeColor: {
    dark: palette.black,
    light: mixPalette("black", 3, "white"),
  },
  layout: {
    contentMax: 1280,
    phoneGutter: 16,
    tabletGutter: 24,
    desktopGutter: 40,
    minimumTouchTarget: 48,
  },
  motion: {
    fast: 140,
    standard: 200,
    easeOut: "cubic-bezier(0.23, 1, 0.32, 1)",
    state: "cubic-bezier(0.32, 0.72, 0, 1)",
  },
  space: [0, 4, 8, 12, 16, 24, 32, 48, 64, 96, 128],
  breakpoints: {
    phone: 375,
    tablet: 768,
    desktop: 1280,
  },
  component: {
    radiusSm: 6,
    radiusMd: 10,
    radiusLg: 16,
    radiusFull: 9999,
    touchTargetMin: 48,
    focusRingWidth: 2,
    focusRingOffset: 2,
  },
} as const;

export const shellKinds = ["organiser", "official", "public"] as const;
export type ShellKind = (typeof shellKinds)[number];

export const surfaceStates = [
  "ready",
  "loading",
  "empty",
  "error",
  "offline",
  "conflict",
  "read-only",
  "permission",
] as const;

export type SurfaceState = (typeof surfaceStates)[number];

// Contract: only failures (error) use role="alert" (assertive interruption).
// Recoverable or informational states — offline, conflict, read-only,
// permission — are rendered with the page, so they use role="status" and rely
// on tone + copy rather than an assertive announcement.
export const stateTokens = {
  ready: { role: "status" as const, tone: "neutral" as const, alert: false },
  loading: { role: "status" as const, tone: "neutral" as const, alert: false },
  empty: { role: "status" as const, tone: "neutral" as const, alert: false },
  error: { role: "alert" as const, tone: "danger" as const, alert: true },
  offline: { role: "status" as const, tone: "warning" as const, alert: false },
  conflict: { role: "status" as const, tone: "warning" as const, alert: false },
  "read-only": { role: "status" as const, tone: "neutral" as const, alert: false },
  permission: { role: "status" as const, tone: "warning" as const, alert: false },
} as const;

export type StateTokenKind = keyof typeof stateTokens;
