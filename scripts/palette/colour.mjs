/**
 * Minimal sRGB colour maths shared by the palette check and the token contrast test.
 *
 * Only what the MATCHDAY token block uses is supported: 3/6-digit hex literals and
 * `color-mix(in srgb, A p%, B)` (CSS Color 5). Mixing happens on gamma-encoded sRGB
 * channels, exactly as browsers compute `color-mix(in srgb, ...)`, so the ratios the
 * test reports equal what axe measures in the rendered page.
 */

/** @typedef {{ r: number, g: number, b: number }} Rgb  channels 0..1 */

export function parseHex(value) {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  let hex = match[1];
  if (hex.length === 3) hex = [...hex].map((char) => char + char).join("");
  return {
    r: parseInt(hex.slice(0, 2), 16) / 255,
    g: parseInt(hex.slice(2, 4), 16) / 255,
    b: parseInt(hex.slice(4, 6), 16) / 255,
  };
}

export function toHex({ r, g, b }) {
  const channel = (value) =>
    Math.round(Math.min(1, Math.max(0, value)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/** color-mix(in srgb, a p, b): p is the weight of `a` in 0..1. */
export function mixSrgb(a, b, p) {
  return { r: a.r * p + b.r * (1 - p), g: a.g * p + b.g * (1 - p), b: a.b * p + b.b * (1 - p) };
}

function linear(channel) {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x relative luminance. */
export function luminance({ r, g, b }) {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG 2.x contrast ratio, 1..21. */
export function contrast(a, b) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

/** Hue in degrees (HSL) and chroma 0..1, used to classify a literal into an accent family. */
export function hueChroma({ r, g, b }) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const chroma = max - min;
  if (chroma === 0) return { hue: 0, chroma: 0 };
  let hue;
  if (max === r) hue = ((g - b) / chroma) % 6;
  else if (max === g) hue = (b - r) / chroma + 2;
  else hue = (r - g) / chroma + 4;
  hue *= 60;
  if (hue < 0) hue += 360;
  return { hue, chroma };
}
