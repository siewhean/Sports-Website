export const designTokens = {
  color: {
    canvas: "#f7f6f0",
    surface: "#ffffff",
    surfaceSubtle: "#efeee8",
    ink: "#171918",
    muted: "#646863",
    hairline: "#d3d4ce",
    signal: "#b7dc22",
    focus: "#5876d8",
    danger: "#c74a43",
  },
  darkColor: {
    canvas: "#111513",
    surface: "#1b211e",
    surfaceSubtle: "#242b26",
    ink: "#f0f3ed",
    muted: "#bbc5ba",
    hairline: "#4b594e",
    signal: "#b7dc22",
    focus: "#9db2ff",
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
