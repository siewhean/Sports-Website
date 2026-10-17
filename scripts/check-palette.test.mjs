import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkPalette, validatePalette } from "./check-palette.mjs";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const approved = JSON.parse(readFileSync(path.join(repoRoot, "scripts/palette/approved-palette.json"), "utf8"));

const darkTokens = `
  --canvas: var(--palette-black);
  --ink: color-mix(in srgb, var(--palette-white) 94%, var(--palette-black));
  --muted: color-mix(in srgb, var(--ink) 20%, var(--canvas));
  --signal: var(--palette-lime);
`;
const tokenCss = ({ extraPalette = "", lightExtra = "", darkMedia = darkTokens } = {}) => `
:root {
  --palette-black: #111513;
  --palette-white: #ffffff;
  --palette-lime: #b7dc22;
  --palette-red: #d4443c;
  --palette-blue: #4f6fd6;
  --palette-amber: #e9a410;${extraPalette}
  --canvas: var(--palette-white);
  --ink: var(--palette-black);
  --muted: color-mix(in srgb, var(--ink) 20%, var(--canvas));
  --signal: color-mix(in srgb, var(--palette-lime) 45%, var(--palette-black));${lightExtra}
}
:root[data-theme="dark"], .theme-dark {${darkTokens}}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {${darkMedia}}
}
body { background: var(--canvas); color: var(--ink); }
`;

/** Builds a throwaway repo layout the checker understands and returns its violations. */
function run(files, { palette = approved, allowlist = [] } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "palette-"));
  try {
    const all = {
      "scripts/palette/approved-palette.json": JSON.stringify(palette),
      "scripts/palette-allowlist.json": JSON.stringify({ entries: allowlist }),
      "apps/web/app/globals.css": tokenCss(),
      ...files,
    };
    for (const [file, content] of Object.entries(all)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), content);
    }
    return checkPalette({ root }).violations;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a clean fixture passes, including color-mix of approved tokens", () => {
  const violations = run({
    "apps/web/components/Card.module.css": [
      ".card { color: var(--ink); background: color-mix(in srgb, var(--ink) 20%, var(--canvas)); }",
      ".card:hover { border-color: currentColor; outline: 2px solid transparent; }",
      ".shadow { box-shadow: 0 2px 8px color-mix(in srgb, var(--palette-black) 30%, transparent); }",
      "@media (forced-colors: active) { .card { border-color: CanvasText; } }",
    ].join("\n"),
    "apps/web/components/Card.tsx": 'export const Card = () => <div style={{ color: "var(--ink)" }} id="main" />;',
    "apps/web/public/logo.svg": '<svg><rect fill="#111513"/><path stroke="#b7dc22" fill="none"/></svg>',
  });
  assert.deepEqual(violations, []);
});

test("a stray #ff00ff in a CSS module fails", () => {
  const violations = run({ "apps/web/components/Card.module.css": ".card { color: #ff00ff; }" });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].literal, "#ff00ff");
  assert.equal(violations[0].file, "apps/web/components/Card.module.css");
  assert.equal(violations[0].line, 1);
});

test("an approved value hard-coded outside the token block still fails (use the token)", () => {
  const violations = run({ "apps/web/components/Card.module.css": ".card { color: #b7dc22; }" });
  assert.equal(violations.length, 1);
});

test("a fifth accent in the token block fails", () => {
  const violations = run({ "apps/web/app/globals.css": tokenCss({ extraPalette: "\n  --palette-teal: #14b8a6;" }) });
  assert.ok(violations.some((violation) => /--palette-teal is not an approved colour/.test(violation.message)));
});

test("a fifth accent in the approved palette fails", () => {
  const palette = { ...approved, accents: { ...approved.accents, teal: "#14b8a6" } };
  assert.ok(validatePalette(palette).some((problem) => /exactly 4 accents/.test(problem)));
  assert.ok(run({}, { palette }).some((violation) => /exactly 4 accents/.test(violation.message)));
});

test("an accent that duplicates a hue family or is grey fails", () => {
  const duplicate = { ...approved, accents: { ...approved.accents, amber: "#e9c010" } };
  duplicate.accents.amber = "#dfe12a"; // yellow-green next to lime
  assert.ok(validatePalette(duplicate).some((problem) => /same hue family/.test(problem)));
  const grey = { ...approved, accents: { ...approved.accents, blue: "#7a7f86" } };
  assert.ok(validatePalette(grey).some((problem) => /too grey/.test(problem)));
});

test("a changed palette value fails", () => {
  const css = tokenCss().replace("--palette-red: #d4443c", "--palette-red: #ff0000");
  const violations = run({ "apps/web/app/globals.css": css });
  assert.ok(violations.some((violation) => /--palette-red must be #d4443c/.test(violation.message)));
});

test("colour functions, named colours, inline styles and JSX colour props fail", () => {
  const violations = run({
    "apps/web/components/A.module.css": ".a { background: rgb(0 0 0 / 10%); border: 1px solid red; }",
    "apps/web/components/B.module.css": ".b { color: oklch(70% 0.1 200); }",
    "apps/web/components/C.tsx":
      'export const C = () => <svg><path fill="white" style={{ color: "#123456" }} /></svg>;',
    "packages/ui/src/D.ts": 'export const d = { backgroundColor: "hsl(10 50% 50%)" };',
  });
  const literals = violations.map((violation) => violation.literal).sort();
  assert.deepEqual(literals, ["#123456", "hsl(", "oklch(", "red", "rgb(", "white"].sort());
});

test("system colours are only allowed inside forced-colors media queries", () => {
  const violations = run({ "apps/web/components/A.module.css": ".a { border-color: CanvasText; }" });
  assert.equal(violations.length, 1);
});

test("removed tokens fail", () => {
  const violations = run({ "apps/web/components/A.module.css": ".a { color: var(--success-ink); }" });
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /--success-ink was removed/);
});

test("an unapproved SVG colour fails, approved palette values pass", () => {
  const violations = run({ "apps/web/public/a.svg": '<svg><rect fill="#111513"/><rect fill="#2364d9"/></svg>' });
  assert.deepEqual(
    violations.map((violation) => violation.literal),
    ["#2364d9"],
  );
});

test("a token block whose dark media copy drifts fails", () => {
  const css = tokenCss({ darkMedia: darkTokens.replace("94%", "90%") });
  const violations = run({ "apps/web/app/globals.css": css });
  assert.ok(violations.some((violation) => /differs between the dark block/.test(violation.message)));
});

test("a light token missing from the dark block fails", () => {
  const css = tokenCss({ lightExtra: "\n  --line: color-mix(in srgb, var(--ink) 16%, var(--canvas));" });
  const violations = run({ "apps/web/app/globals.css": css });
  assert.ok(violations.some((violation) => /--line is not redeclared/.test(violation.message)));
});

test("color-mix must be in srgb with token operands", () => {
  const css = tokenCss({ lightExtra: "\n  --tint: color-mix(in oklab, var(--ink) 16%, var(--canvas));" });
  const violations = run({ "apps/web/app/globals.css": css });
  assert.ok(violations.some((violation) => /does not resolve/.test(violation.message)));
});

test("allowlist entries need a reason and must be used", () => {
  const css = { "apps/web/components/A.module.css": ".a { color: #123456; }" };
  assert.deepEqual(
    run(css, {
      allowlist: [{ file: "apps/web/components/A.module.css", literal: "#123456", reason: "third-party brand mark" }],
    }),
    [],
  );
  assert.ok(
    run(css, { allowlist: [{ file: "apps/web/components/A.module.css", literal: "#123456", reason: "" }] }).some(
      (violation) => /needs file, literal and a reason/.test(violation.message),
    ),
  );
  assert.ok(
    run({}, { allowlist: [{ file: "x.css", literal: "#000000", reason: "stale entry for a removed file" }] }).some(
      (violation) => /is unused/.test(violation.message),
    ),
  );
});

test("a color-mix of two mixed tokens fails (WebKit crash), one mixed token passes", () => {
  const nested = run({
    "apps/web/components/A.module.css": ".a { background: color-mix(in srgb, var(--signal) 12%, var(--muted)); }",
  });
  assert.equal(nested.length, 1);
  assert.match(nested[0].message, /crashes WebKit/);
  const single = run({
    "apps/web/components/A.module.css": ".a { background: color-mix(in srgb, var(--signal) 12%, var(--canvas)); }",
  });
  assert.deepEqual(single, []);
});

test("the repository itself passes", () => {
  assert.deepEqual(checkPalette({ root: repoRoot }).violations, []);
});
