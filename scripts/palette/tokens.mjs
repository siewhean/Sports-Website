/**
 * Reads the colour token block in apps/web/app/globals.css and resolves every colour token to sRGB for the
 * light and the dark theme. Used by scripts/check-palette.mjs and the token contrast unit test.
 *
 * Token block contract (enforced by check-palette):
 *   :root { --palette-<name>: #hex; ...light tokens }                        light theme (also the base)
 *   :root[data-theme="dark"], .theme-dark, ... { ...dark tokens }           explicit dark theme
 *   @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ...same dark tokens } }
 * Derived tokens may only be `var(--token)` or `color-mix(in srgb, <token|transparent> [p%], <token|transparent> [p%])`.
 */
import { parseHex, mixSrgb } from "./colour.mjs";

export const LIGHT_SELECTOR = ":root";
export const DARK_SELECTOR_PREFIX = ':root[data-theme="dark"]';
export const DARK_MEDIA_SELECTOR = ':root:not([data-theme="light"])';

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

/** Top-level and one-level-nested (inside @media) rule blocks: { selector, body, media, start }. */
export function extractRules(css) {
  const source = stripComments(css);
  const rules = [];
  const walk = (text, offset, media) => {
    let index = 0;
    while (index < text.length) {
      const open = text.indexOf("{", index);
      if (open === -1) break;
      const prelude = text.slice(index, open).trim();
      let depth = 1;
      let cursor = open + 1;
      while (cursor < text.length && depth > 0) {
        if (text[cursor] === "{") depth += 1;
        else if (text[cursor] === "}") depth -= 1;
        cursor += 1;
      }
      const body = text.slice(open + 1, cursor - 1);
      const selector = prelude.split(/;/).pop().trim();
      if (selector.startsWith("@media") || selector.startsWith("@supports") || selector.startsWith("@layer")) {
        walk(body, offset + open + 1, selector);
      } else {
        rules.push({ selector, body, media: media ?? null, start: offset + open + 1 });
      }
      index = cursor;
    }
  };
  walk(source, 0, null);
  return rules;
}

/** Custom-property declarations in a rule body, in order. */
export function customProperties(body) {
  const declarations = new Map();
  const pattern = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  for (const match of body.matchAll(pattern)) declarations.set(match[1], match[2].trim().replace(/\s+/g, " "));
  return declarations;
}

export function tokenBlocks(css) {
  const rules = extractRules(css);
  const light = rules.find((rule) => rule.media === null && rule.selector === LIGHT_SELECTOR);
  const dark = rules.find((rule) => rule.media === null && rule.selector.startsWith(DARK_SELECTOR_PREFIX));
  const darkMedia = rules.find(
    (rule) => rule.media && /prefers-color-scheme:\s*dark/.test(rule.media) && rule.selector === DARK_MEDIA_SELECTOR,
  );
  return {
    light: light ? customProperties(light.body) : new Map(),
    dark: dark ? customProperties(dark.body) : new Map(),
    darkMedia: darkMedia ? customProperties(darkMedia.body) : new Map(),
    darkSelector: dark?.selector ?? null,
  };
}

const TRANSPARENT = { rgb: { r: 0, g: 0, b: 0 }, alpha: 0 };

/**
 * Resolves one token to { rgb, alpha } or null when it is not a colour (fonts, radii, shadows...).
 * Throws on a colour expression the contract does not allow, so a bad token cannot silently pass.
 */
export function createResolver(declarations) {
  const cache = new Map();
  const resolveValue = (value, seen) => {
    const text = value.trim();
    if (text === "transparent") return TRANSPARENT;
    const hex = parseHex(text);
    if (hex) return { rgb: hex, alpha: 1 };
    const variable = /^var\((--[a-z0-9-]+)\)$/i.exec(text);
    if (variable) return resolveToken(variable[1], seen);
    const mix =
      /^color-mix\(\s*in\s+srgb\s*,\s*([^,()]*(?:\([^()]*\))?[^,()]*)\s*,\s*([^,()]*(?:\([^()]*\))?[^,()]*)\s*\)$/i.exec(
        text,
      );
    if (mix) {
      const side = (part) => {
        const weighted = /^(.+?)\s+(\d+(?:\.\d+)?)%$/.exec(part.trim());
        return weighted
          ? { value: weighted[1], weight: Number(weighted[2]) / 100 }
          : { value: part.trim(), weight: null };
      };
      const a = side(mix[1]);
      const b = side(mix[2]);
      const wa = a.weight ?? (b.weight === null ? 0.5 : 1 - b.weight);
      const ca = resolveValue(a.value, seen);
      const cb = resolveValue(b.value, seen);
      if (!ca || !cb) throw new Error(`color-mix operand is not a colour token: ${text}`);
      // Premultiplied interpolation, as CSS Color 5 specifies for color-mix.
      const alpha = ca.alpha * wa + cb.alpha * (1 - wa);
      if (alpha === 0) return TRANSPARENT;
      const pa = (ca.alpha * wa) / alpha;
      return { rgb: mixSrgb(ca.rgb, cb.rgb, pa), alpha };
    }
    if (/^color-mix\(/i.test(text)) throw new Error(`color-mix must use "in srgb" with token operands: ${text}`);
    // Composite values (shadows, gradients) are not colour tokens; their colour parts are linted as literals.
    return null;
  };
  const resolveToken = (name, seen = new Set()) => {
    if (cache.has(name)) return cache.get(name);
    if (seen.has(name)) throw new Error(`Circular colour token ${name}`);
    const value = declarations.get(name);
    if (value === undefined) throw new Error(`Unknown token ${name}`);
    const next = new Set(seen).add(name);
    const resolved = resolveValue(value, next);
    cache.set(name, resolved);
    return resolved;
  };
  return { resolveToken, names: () => [...declarations.keys()] };
}

/** { light: Map<token, {rgb, alpha}>, dark: Map<...> } for every colour token. */
export function resolveThemes(css) {
  const blocks = tokenBlocks(css);
  const themes = {
    light: new Map(blocks.light),
    dark: new Map([...blocks.light, ...blocks.dark]),
  };
  const out = {};
  for (const [theme, declarations] of Object.entries(themes)) {
    const resolver = createResolver(declarations);
    const colours = new Map();
    for (const name of resolver.names()) {
      const resolved = resolver.resolveToken(name);
      if (resolved) colours.set(name, resolved);
    }
    out[theme] = colours;
  }
  return out;
}
