import type { Rgb } from "./colour.mjs";

export type ResolvedColour = { rgb: Rgb; alpha: number };
export type Rule = { selector: string; body: string; media: string | null; start: number };

export const LIGHT_SELECTOR: string;
export const DARK_SELECTOR_PREFIX: string;
export const DARK_MEDIA_SELECTOR: string;
export function extractRules(css: string): Rule[];
export function customProperties(body: string): Map<string, string>;
export function tokenBlocks(css: string): {
  light: Map<string, string>;
  dark: Map<string, string>;
  darkMedia: Map<string, string>;
  darkSelector: string | null;
};
export function createResolver(declarations: Map<string, string>): {
  resolveToken(name: string): ResolvedColour | null;
  names(): string[];
};
export function resolveThemes(css: string): { light: Map<string, ResolvedColour>; dark: Map<string, ResolvedColour> };
