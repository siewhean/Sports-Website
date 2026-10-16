#!/usr/bin/env node
/**
 * Palette lint (redesign Phase 1, owner decision D12).
 *
 * MATCHDAY uses exactly six colour literals: black and white (the base pair) and four accents, lime (actions),
 * red (errors/urgent), blue (info/live) and amber (warnings). They are declared once, as --palette-* tokens in
 * apps/web/app/globals.css, and listed in scripts/palette/approved-palette.json. Every other colour is a
 * color-mix() of those tokens. This check fails on:
 *   - any colour literal (#hex, rgb(), hsl(), hwb(), lab(), lch(), oklab(), oklch(), color(), CSS named colours)
 *     in CSS, CSS modules, TS/TSX (inline styles, JSX colour props) or SVG files, except the palette
 *     declarations themselves, approved values in token files and SVG assets, and reviewed allowlist entries;
 *   - a --palette-* token that is not approved (a fifth colour) or whose value differs from the approved one;
 *   - an approved palette that does not have exactly two neutrals and four distinct accent hues;
 *   - a dark theme block that is incomplete or differs from its prefers-color-scheme copy;
 *   - a colour token that does not resolve (bad var(), color-mix not "in srgb" or with non-token operands).
 *
 * Usage: node scripts/check-palette.mjs [--root <repo root>]
 * Allowed without a literal: transparent, currentColor, inherit, initial, unset, none,
 * color-mix(in srgb, var(--token) N%, var(--token) | transparent).
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hueChroma, parseHex } from "./palette/colour.mjs";
import { extractRules, customProperties, resolveThemes, DARK_SELECTOR_PREFIX } from "./palette/tokens.mjs";

const TOKEN_CSS = "apps/web/app/globals.css";
const TOKEN_FILES = new Set(["packages/ui/src/tokens.ts"]);
const PALETTE_JSON = "scripts/palette/approved-palette.json";
const ALLOWLIST_JSON = "scripts/palette-allowlist.json";
const SCAN_ROOTS = ["apps/web/app", "apps/web/components", "apps/web/lib", "apps/web/public", "packages/ui/src"];
const SCAN_EXTENSIONS = new Set([".css", ".ts", ".tsx", ".svg"]);
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "coverage", "test-results", "playwright-report"]);
const SKIP_FILE = /\.(?:test|spec)\.(?:ts|tsx|mjs)$/;

// CSS named colours (CSS Color 4). Keywords that are not colours (transparent, currentColor...) are allowed.
const NAMED_COLOURS = new Set(
  (
    "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood " +
    "cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod " +
    "darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon " +
    "darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray " +
    "dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green " +
    "greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon " +
    "lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon " +
    "lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta " +
    "maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen " +
    "mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive " +
    "olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru " +
    "pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen " +
    "seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato " +
    "turquoise violet wheat white whitesmoke yellow yellowgreen"
  ).split(" "),
);
// CSS system colours: only allowed inside @media (forced-colors: active), where the OS palette must win.
const SYSTEM_COLOURS = new Set(
  "canvas canvastext buttonface buttontext buttonborder highlight highlighttext linktext visitedtext activetext graytext field fieldtext mark marktext selecteditem selecteditemtext accentcolor accentcolortext".split(
    " ",
  ),
);
// Tokens removed in Phase 1 (fifth-colour accents and duplicate hues). Using one is a violation.
export const REMOVED_TOKENS = [
  "--success",
  "--success-ink",
  "--success-surface",
  "--success-line",
  "--team-blue",
  "--team-gold",
  "--event-canvas",
  "--event-surface",
  "--event-line",
];
const REMOVED_TOKEN_USE = new RegExp(`var\\((${REMOVED_TOKENS.join("|")})\\s*[,)]`, "g");

function forcedColourRanges(text) {
  const ranges = [];
  for (const match of text.matchAll(/@media[^{]*forced-colors[^{]*\{/g)) {
    let depth = 1;
    let cursor = match.index + match[0].length;
    while (cursor < text.length && depth > 0) {
      if (text[cursor] === "{") depth += 1;
      else if (text[cursor] === "}") depth -= 1;
      cursor += 1;
    }
    ranges.push([match.index, cursor]);
  }
  return ranges;
}

const HEX = /(?<![\w&#/.-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
const COLOUR_FUNCTION =
  /\b(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch)\(|\bcolor\(\s*(?:srgb|srgb-linear|display-p3|a98-rgb|prophoto-rgb|rec2020|xyz)/gi;
const CSS_COLOUR_PROPERTY =
  /(?:^|[;{\s])((?:background(?:-color)?|color|border(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?(?:-color)?|outline(?:-color)?|fill|stroke|box-shadow|text-shadow|text-decoration(?:-color)?|caret-color|accent-color|column-rule(?:-color)?|stop-color|flood-color|lighting-color|scrollbar-color|-webkit-tap-highlight-color)\s*:\s*([^;}]+))/gi;
const JS_COLOUR_PROPERTY =
  /\b(?:color|background|backgroundColor|borderColor|border|borderTop|borderBottom|outline|outlineColor|fill|stroke|stopColor|boxShadow|textShadow|caretColor|accentColor|textDecorationColor)\s*:\s*(["'`])([^"'`]*)\1/g;
const JSX_COLOUR_ATTRIBUTE = /\b(?:fill|stroke|color|stopColor|stop-color|flood-color)\s*=\s*(["'])([^"']*)\1/g;

function lineOf(text, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) if (text.charCodeAt(cursor) === 10) line += 1;
  return line;
}

function stripCssComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

function stripJsComments(text) {
  // Block and line comments; good enough for colour linting (a `//` inside a URL string keeps its line intact).
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (match, lead) => lead + " ".repeat(match.length - lead.length));
}

function namedColoursIn(value, allowSystemColours) {
  const cleaned = value
    .replace(/var\([^)]*\)/gi, " ")
    .replace(/--[\w-]+/g, " ")
    .replace(/url\([^)]*\)/gi, " ")
    .toLowerCase();
  return (cleaned.match(/[a-z]+/g) ?? []).filter(
    (word) => NAMED_COLOURS.has(word) || (!allowSystemColours && SYSTEM_COLOURS.has(word)),
  );
}

function walk(root, relative, files) {
  const absolute = path.join(root, relative);
  if (!existsSync(absolute)) return;
  for (const entry of readdirSync(absolute)) {
    if (SKIP_DIRS.has(entry)) continue;
    const childRelative = path.posix.join(relative, entry);
    const stats = statSync(path.join(root, childRelative));
    if (stats.isDirectory()) {
      if (entry === "tests" || entry === "__tests__") continue;
      walk(root, childRelative, files);
    } else if (SCAN_EXTENSIONS.has(path.extname(entry)) && !SKIP_FILE.test(entry)) {
      files.push(childRelative);
    }
  }
}

export function validatePalette(palette) {
  const problems = [];
  const base = Object.entries(palette.base ?? {});
  const accents = Object.entries(palette.accents ?? {});
  if (base.length !== 2) problems.push(`approved palette must have exactly 2 base colours, found ${base.length}`);
  if (accents.length !== 4) problems.push(`approved palette must have exactly 4 accents, found ${accents.length}`);
  for (const [name, value] of [...base, ...accents]) {
    if (!parseHex(value)) problems.push(`palette colour ${name} must be a #rrggbb literal, got ${value}`);
  }
  for (const [name, value] of base) {
    const rgb = parseHex(value);
    if (rgb && hueChroma(rgb).chroma > 0.08) problems.push(`base colour ${name} ${value} is not a neutral`);
  }
  const hues = [];
  for (const [name, value] of accents) {
    const rgb = parseHex(value);
    if (!rgb) continue;
    const { hue, chroma } = hueChroma(rgb);
    if (chroma < 0.3) problems.push(`accent ${name} ${value} is too grey to be an accent`);
    for (const other of hues) {
      const distance = Math.min(Math.abs(hue - other.hue), 360 - Math.abs(hue - other.hue));
      if (distance < 25) problems.push(`accents ${other.name} and ${name} are the same hue family`);
    }
    hues.push({ name, hue });
  }
  return problems;
}

function approvedValues(palette) {
  return new Map(
    Object.entries({ ...palette.base, ...palette.accents }).map(([name, value]) => [value.toLowerCase(), name]),
  );
}

function checkTokenBlock(css, palette, report) {
  const approved = { ...palette.base, ...palette.accents };
  const rules = extractRules(css);
  const lightRule = rules.find((rule) => rule.media === null && rule.selector === ":root");
  if (!lightRule) {
    report(TOKEN_CSS, 1, ":root", "token block :root not found");
    return new Set();
  }
  const allowedRanges = new Set();
  const declared = new Set();
  for (const match of lightRule.body.matchAll(/--palette-([a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    const [, name, rawValue] = match;
    const value = rawValue.trim().toLowerCase();
    const index = lightRule.start + match.index;
    const line = lineOf(css, index);
    if (!(name in approved)) {
      report(TOKEN_CSS, line, `--palette-${name}`, `--palette-${name} is not an approved colour (fifth colour)`);
      continue;
    }
    if (approved[name].toLowerCase() !== value) {
      report(TOKEN_CSS, line, value, `--palette-${name} must be ${approved[name]}, found ${value}`);
    }
    declared.add(name);
    const literalOffset = index + match[0].indexOf(rawValue);
    allowedRanges.add(literalOffset + rawValue.indexOf(rawValue.trim()));
  }
  for (const name of Object.keys(approved)) {
    if (!declared.has(name)) report(TOKEN_CSS, lineOf(css, lightRule.start), name, `--palette-${name} is missing`);
  }
  for (const rule of rules) {
    if (rule === lightRule) continue;
    if (/--palette-/.test(rule.body.replace(/var\(--palette-[^)]*\)/g, ""))) {
      report(TOKEN_CSS, lineOf(css, rule.start), rule.selector, "--palette-* may only be declared in :root");
    }
  }
  const dark = rules.find((rule) => rule.media === null && rule.selector.startsWith(DARK_SELECTOR_PREFIX));
  const darkMedia = rules.find(
    (rule) => rule.media && /prefers-color-scheme:\s*dark/.test(rule.media) && rule.selector.startsWith(":root:not("),
  );
  if (!dark || !darkMedia) {
    report(TOKEN_CSS, 1, "dark", "dark theme block or its prefers-color-scheme copy is missing");
  } else {
    const darkProps = customProperties(dark.body);
    const mediaProps = customProperties(darkMedia.body);
    const keys = new Set([...darkProps.keys(), ...mediaProps.keys()]);
    for (const key of keys) {
      if (darkProps.get(key) !== mediaProps.get(key)) {
        report(
          TOKEN_CSS,
          lineOf(css, darkMedia.start),
          key,
          `${key} differs between the dark block and its media copy`,
        );
      }
    }
    try {
      const themes = resolveThemes(css);
      for (const name of themes.light.keys()) {
        if (name.startsWith("--palette-")) continue;
        if (!darkProps.has(name)) {
          report(TOKEN_CSS, lineOf(css, dark.start), name, `${name} is not redeclared in the dark theme block`);
        }
      }
    } catch (error) {
      report(TOKEN_CSS, 1, "token", `token does not resolve: ${error.message}`);
    }
  }
  return allowedRanges;
}

/**
 * Runs the check. Returns { violations, filesScanned }.
 * @param {{ root: string }} options
 */
export function checkPalette({ root }) {
  const violations = [];
  const report = (file, line, literal, message) => violations.push({ file, line, literal, message });
  const palette = JSON.parse(readFileSync(path.join(root, PALETTE_JSON), "utf8"));
  for (const problem of validatePalette(palette)) report(PALETTE_JSON, 1, "palette", problem);
  const approved = approvedValues(palette);

  const allowlistPath = path.join(root, ALLOWLIST_JSON);
  const allowlist = existsSync(allowlistPath) ? (JSON.parse(readFileSync(allowlistPath, "utf8")).entries ?? []) : [];
  const allowUsed = new Set();
  allowlist.forEach((entry, index) => {
    if (!entry.file || !entry.literal || !entry.reason || String(entry.reason).trim().length < 10) {
      report(
        ALLOWLIST_JSON,
        1,
        String(entry.literal ?? ""),
        `allowlist entry ${index} needs file, literal and a reason`,
      );
    }
  });
  const isAllowlisted = (file, literal) => {
    const index = allowlist.findIndex(
      (entry) => entry.file === file && String(entry.literal).toLowerCase() === literal.toLowerCase() && entry.reason,
    );
    if (index === -1) return false;
    allowUsed.add(index);
    return true;
  };

  const files = [];
  for (const scanRoot of SCAN_ROOTS) walk(root, scanRoot, files);

  for (const file of files) {
    const raw = readFileSync(path.join(root, file), "utf8");
    const extension = path.extname(file);
    const text = extension === ".css" ? stripCssComments(raw) : extension === ".svg" ? raw : stripJsComments(raw);
    let allowedOffsets = new Set();
    if (file === TOKEN_CSS) allowedOffsets = checkTokenBlock(raw, palette, report);
    const isTokenFile = TOKEN_FILES.has(file);
    const isSvg = extension === ".svg";
    const flag = (index, literal, message) => {
      if (isAllowlisted(file, literal)) return;
      report(file, lineOf(text, index), literal, message);
    };

    for (const match of text.matchAll(HEX)) {
      const literal = match[0];
      if (allowedOffsets.has(match.index)) continue;
      const normalized = literal.length === 4 ? `#${[...literal.slice(1)].map((c) => c + c).join("")}` : literal;
      if ((isTokenFile || isSvg) && approved.has(normalized.toLowerCase())) continue;
      flag(
        match.index,
        literal,
        isSvg || isTokenFile ? "not an approved palette value" : "colour literal; use a token",
      );
    }
    for (const match of text.matchAll(COLOUR_FUNCTION)) {
      flag(match.index, match[0], "colour function literal; use a token or color-mix() of tokens");
    }
    const namedPatterns = extension === ".css" ? [CSS_COLOUR_PROPERTY] : [JS_COLOUR_PROPERTY, JSX_COLOUR_ATTRIBUTE];
    const forced = extension === ".css" ? forcedColourRanges(text) : [];
    for (const pattern of namedPatterns) {
      for (const match of text.matchAll(pattern)) {
        const inForcedColours = forced.some(([start, end]) => match.index >= start && match.index < end);
        for (const name of namedColoursIn(match[2], inForcedColours)) {
          flag(match.index, name, `named colour "${name}"; use a token`);
        }
      }
    }
    for (const match of text.matchAll(REMOVED_TOKEN_USE)) {
      flag(match.index, match[1], `${match[1]} was removed (one hue per job); use --signal-*, --info-* or neutrals`);
    }
  }

  allowlist.forEach((entry, index) => {
    if (!allowUsed.has(index)) report(ALLOWLIST_JSON, 1, String(entry.literal), `allowlist entry ${index} is unused`);
  });
  return { violations, filesScanned: files.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rootFlag = process.argv.indexOf("--root");
  const root =
    rootFlag !== -1 ? path.resolve(process.argv[rootFlag + 1]) : path.resolve(fileURLToPath(import.meta.url), "../..");
  const { violations, filesScanned } = checkPalette({ root });
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`${violation.file}:${violation.line}  ${violation.literal}  ${violation.message}`);
    }
    console.error(`\ncheck-palette: ${violations.length} violation(s) in ${filesScanned} files.`);
    process.exit(1);
  }
  console.log(`check-palette: ${filesScanned} files use only the approved palette.`);
}
