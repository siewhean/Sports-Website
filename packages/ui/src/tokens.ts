export const designTokens = {
  color: {
    canvas: "#f7f6f0",
    surface: "#ffffff",
    ink: "#171918",
    muted: "#646863",
    signal: "#b7dc22",
    focus: "#5876d8",
    danger: "#c74a43",
  },
  motion: {
    fast: 140,
    standard: 200,
    easeOut: "cubic-bezier(0.23, 1, 0.32, 1)",
    state: "cubic-bezier(0.32, 0.72, 0, 1)",
  },
  space: [0, 4, 8, 12, 16, 24, 32, 48, 64, 96, 128],
} as const;

export const shellKinds = ["organiser", "official", "public"] as const;
export type ShellKind = (typeof shellKinds)[number];
