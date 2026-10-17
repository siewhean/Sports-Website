export type Rgb = { r: number; g: number; b: number };
export function parseHex(value: string): Rgb | null;
export function toHex(rgb: Rgb): string;
export function mixSrgb(a: Rgb, b: Rgb, p: number): Rgb;
export function luminance(rgb: Rgb): number;
export function contrast(a: Rgb, b: Rgb): number;
export function hueChroma(rgb: Rgb): { hue: number; chroma: number };
