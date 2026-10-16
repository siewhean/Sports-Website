import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { designTokens, palette } from "@matchday/ui";
import { contrast, hueChroma, parseHex, toHex, type Rgb } from "../../../../scripts/palette/colour.mjs";
import { resolveThemes, type ResolvedColour } from "../../../../scripts/palette/tokens.mjs";

/*
 * WCAG 2.2 AA for the colour tokens in both themes (owner decisions D10/D12): text pairs >= 4.5:1, control
 * edges, focus rings and meaningful icons >= 3:1 (1.4.11). Ratios are computed from the token block in
 * app/globals.css exactly as browsers resolve color-mix(in srgb, ...).
 */
const css = readFileSync(path.resolve(__dirname, "../../app/globals.css"), "utf8");
const themes = resolveThemes(css);
type Theme = keyof typeof themes;

function colour(theme: Theme, token: string): Rgb {
  const resolved: ResolvedColour | undefined = themes[theme].get(token);
  if (!resolved) throw new Error(`${token} is not a colour token in the ${theme} theme`);
  expect(resolved.alpha, `${theme} ${token} must be opaque`).toBe(1);
  return resolved.rgb;
}

const TEXT = 4.5;
const NON_TEXT = 3;
const surfaces = ["--canvas", "--surface", "--surface-subtle"];
const pairs: Array<[foreground: string, backgrounds: string[], minimum: number, use: string]> = [
  [
    "--ink",
    [...surfaces, "--surface-hover", "--signal-surface", "--danger-surface", "--warning-surface", "--info-surface"],
    TEXT,
    "body text",
  ],
  ["--ink-muted", [...surfaces, "--surface-hover"], TEXT, "secondary text"],
  ["--signal-ink", ["--signal", "--signal-strong"], TEXT, "primary button label"],
  ["--signal-bright-ink", ["--signal-bright"], TEXT, "text on a lime fill"],
  ["--signal-text", [...surfaces, "--signal-surface"], TEXT, "links and action text"],
  ["--signal", surfaces, TEXT, "action colour used as text"],
  ["--danger-ink", [...surfaces, "--danger-surface"], TEXT, "error text"],
  ["--danger", [...surfaces, "--danger-surface"], TEXT, "error icon/strong text"],
  ["--danger-on-fill", ["--danger"], TEXT, "destructive button label"],
  ["--warning-ink", [...surfaces, "--warning-surface"], TEXT, "warning text"],
  ["--warning-on-fill", ["--warning"], TEXT, "text on an amber fill"],
  ["--info-ink", [...surfaces, "--info-surface"], TEXT, "info/live text"],
  ["--info", [...surfaces, "--info-surface"], TEXT, "info icon/strong text"],
  ["--info-on-fill", ["--info"], TEXT, "text on a blue fill"],
  ["--inverse-ink", ["--inverse-surface"], TEXT, "selected pill text"],
  ["--field-ink", ["--field-bg"], TEXT, "field value"],
  ["--field-placeholder", ["--field-bg"], TEXT, "placeholder"],
  ["--field-disabled-ink", ["--field-disabled-bg"], TEXT, "disabled field text"],
  ["--field-border", ["--field-bg", ...surfaces], NON_TEXT, "control edge"],
  ["--field-border-hover", ["--field-bg", ...surfaces], NON_TEXT, "hovered control edge"],
  ["--field-accent", ["--field-bg", ...surfaces], NON_TEXT, "checkbox/radio fill"],
  ["--focus", ["--field-bg", ...surfaces, "--signal-surface"], NON_TEXT, "focus ring"],
  ["--line-strong", surfaces, NON_TEXT, "strong outline"],
];

describe.each(["light", "dark"] as const)("%s theme token contrast", (theme) => {
  for (const [foreground, backgrounds, minimum, use] of pairs) {
    for (const background of backgrounds) {
      it(`${foreground} on ${background} >= ${minimum}:1 (${use})`, () => {
        const ratio = contrast(colour(theme, foreground), colour(theme, background));
        expect(Number(ratio.toFixed(2)), `${theme}: ${foreground} on ${background}`).toBeGreaterThanOrEqual(minimum);
      });
    }
  }
});

describe("palette discipline", () => {
  const accents = Object.fromEntries(
    (["lime", "red", "blue", "amber"] as const).map((name) => [name, hueChroma(parseHex(palette[name])!).hue]),
  );

  it("every colour token is a neutral or one of the four accent hues", () => {
    for (const theme of ["light", "dark"] as const) {
      for (const [token, { rgb, alpha }] of themes[theme]) {
        if (alpha === 0) continue;
        const { hue, chroma } = hueChroma(rgb);
        if (chroma < 0.06) continue; // a grey: ink/background mix
        const distances = Object.values(accents).map((accent) =>
          Math.min(Math.abs(hue - accent), 360 - Math.abs(hue - accent)),
        );
        expect(Math.min(...distances), `${theme} ${token} ${toHex(rgb)} hue ${hue.toFixed(0)}`).toBeLessThan(12);
      }
    }
  });

  it("lime is never text, a border or an icon on the light theme", () => {
    const lime = parseHex(palette.lime)!;
    for (const token of ["--signal", "--signal-text", "--signal-line", "--field-accent", "--focus"]) {
      expect(toHex(colour("light", token)), token).not.toBe(toHex(lime));
      expect(contrast(colour("light", token), colour("light", "--surface")), token).toBeGreaterThanOrEqual(NON_TEXT);
    }
  });

  it("amber is only a fill: warning text uses --warning-ink in both themes", () => {
    expect(toHex(colour("light", "--warning-ink"))).not.toBe(palette.amber);
    expect(contrast(colour("light", "--warning"), colour("light", "--surface"))).toBeLessThan(TEXT);
  });

  it("the hairline is decorative only and the field border is the control edge", () => {
    for (const theme of ["light", "dark"] as const) {
      const hairline = contrast(colour(theme, "--hairline"), colour(theme, "--surface"));
      const field = contrast(colour(theme, "--field-border"), colour(theme, "--surface"));
      expect(field).toBeGreaterThanOrEqual(NON_TEXT);
      expect(field).toBeGreaterThan(hairline);
    }
  });

  it("packages/ui designTokens equal the CSS tokens", () => {
    const map: Record<string, string> = {
      canvas: "--canvas",
      surface: "--surface",
      surfaceSubtle: "--surface-subtle",
      ink: "--ink",
      muted: "--ink-muted",
      hairline: "--hairline",
      signal: "--signal",
      focus: "--focus",
      danger: "--danger",
      warning: "--warning",
      info: "--info",
    };
    for (const [key, token] of Object.entries(map)) {
      const near = (hex: string, rgb: Rgb) => {
        const expected = parseHex(hex)!;
        return Math.max(Math.abs(expected.r - rgb.r), Math.abs(expected.g - rgb.g), Math.abs(expected.b - rgb.b));
      };
      const light = designTokens.color[key as keyof typeof designTokens.color];
      const dark = designTokens.darkColor[key as keyof typeof designTokens.darkColor];
      expect(near(light, colour("light", token)), `light ${key}`).toBeLessThanOrEqual(1 / 255);
      expect(near(dark, colour("dark", token)), `dark ${key}`).toBeLessThanOrEqual(1 / 255);
    }
    expect(designTokens.themeColor.dark).toBe(toHex(colour("dark", "--canvas")));
    expect(designTokens.themeColor.light).toBe(toHex(colour("light", "--canvas")));
  });
});
