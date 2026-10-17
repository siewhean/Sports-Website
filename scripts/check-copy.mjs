#!/usr/bin/env node
/**
 * Copy lint (redesign Phase 2, plan section 6.2): organiser and public copy uses plain words.
 *
 * Scans the string literals of the shared message catalogues and the web copy modules for engineering terms
 * that mean nothing to a volunteer organiser. Only strings that read as sentences (they contain whitespace) are
 * checked, so identifiers, routes and enum values are ignored, and so are messages passed to `Error`, which
 * are for developers and logs, not screens.
 *
 * Usage: node scripts/check-copy.mjs [--root <repo root>]
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** Banned term → the plain word to use instead (shown in the failure message). */
export const BANNED_TERMS = new Map([
  ["canonical", 'say what it is: "official", "saved" or nothing'],
  ["deterministic", '"always the same for the same input" or nothing'],
  ["pinned evidence", '"saved details"'],
  ["solver", '"the scheduler" or "the schedule"'],
  ["revision", '"version"'],
  ["revisions", '"versions"'],
  ["projection", '"public page" or "public results"'],
  ["projections", '"public pages"'],
]);

const SCAN_FILES = ["packages/ui/src/i18n.ts", "packages/ui/src/translate.ts", "packages/ui/src/live-messages.ts"];
const SCAN_DIRS = ["apps/web/lib", "apps/web/components", "apps/web/app"];
const SKIP_FILE = /\.(?:test|spec)\.tsx?$|\.d\.ts$/u;

const termPattern = new RegExp(
  `\\b(${[...BANNED_TERMS.keys()]
    .sort((a, b) => b.length - a.length)
    .map((term) => term.replace(/\s+/gu, "\\s+"))
    .join("|")})\\b`,
  "giu",
);

function listFiles(root) {
  const files = SCAN_FILES.filter((file) => existsSync(path.join(root, file)));
  const walk = (relative) => {
    for (const name of readdirSync(path.join(root, relative))) {
      const child = path.join(relative, name);
      if (statSync(path.join(root, child)).isDirectory()) walk(child);
      else if (/\.tsx?$/u.test(name) && !SKIP_FILE.test(name)) files.push(child);
    }
  };
  for (const dir of SCAN_DIRS) if (existsSync(path.join(root, dir))) walk(dir);
  return files;
}

function isErrorMessage(node) {
  let current = node.parent;
  while (
    current &&
    (ts.isTemplateSpan(current) ||
      ts.isTemplateExpression(current) ||
      ts.isBinaryExpression(current) ||
      ts.isConditionalExpression(current) ||
      ts.isParenthesizedExpression(current))
  ) {
    current = current.parent;
  }
  if (!current || !(ts.isNewExpression(current) || ts.isCallExpression(current))) return false;
  const callee = current.expression;
  return ts.isIdentifier(callee) && /Error$/u.test(callee.text);
}

/** Every banned term in the sentence-like string literals of one source file. */
export function findBannedCopy(source, fileName = "copy.ts") {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const findings = [];
  const visit = (node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      // {placeholder} names are code, not words a reader sees.
      const text = node.text.replace(/\{[^{}]*\}/gu, "{}");
      if (/\s/u.test(text) && !isErrorMessage(node)) {
        for (const match of text.matchAll(termPattern)) {
          const term = match[1].toLowerCase().replace(/\s+/gu, " ");
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          findings.push({ line: line + 1, term, text });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

export function checkCopy(root) {
  const violations = [];
  const files = listFiles(root);
  for (const file of files) {
    for (const finding of findBannedCopy(readFileSync(path.join(root, file), "utf8"), file)) {
      violations.push({ file, ...finding });
    }
  }
  return { violations, filesScanned: files.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rootFlag = process.argv.indexOf("--root");
  const root =
    rootFlag > -1
      ? path.resolve(process.argv[rootFlag + 1])
      : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const { violations, filesScanned } = checkCopy(root);
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(
        `${violation.file}:${violation.line}: "${violation.term}" in ${JSON.stringify(violation.text)}. Use ${BANNED_TERMS.get(violation.term)}.`,
      );
    }
    console.error(`\ncheck-copy: ${violations.length} jargon term(s) in ${filesScanned} files.`);
    process.exit(1);
  }
  console.log(`check-copy: ${filesScanned} files use plain words.`);
}
