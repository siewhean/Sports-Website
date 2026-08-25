import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import ts from "typescript";

const webRoot = path.resolve(import.meta.dirname, "..");
const workspaceRoot = path.resolve(webRoot, "../..");
const cataloguePath = path.join(workspaceRoot, "packages/ui/src/translate.ts");
const sourceRoots = [path.join(webRoot, "app"), path.join(webRoot, "components")];

const userAttributes = new Set(["aria-label", "aria-description", "alt", "title", "placeholder"]);
const structuralAttributes = new Set([
  "className",
  "code",
  "id",
  "type",
  "name",
  "value",
  "role",
  "href",
  "src",
  "key",
  "htmlFor",
  "dateTime",
  "min",
  "max",
  "step",
  "target",
  "rel",
  "sizes",
  "viewBox",
  "preserveAspectRatio",
  "d",
  "weight",
  "autoComplete",
  "autoCapitalize",
  "inputMode",
  "kind",
  "lang",
  "tone",
]);
const userPropertyNames = new Set([
  "actionLabel",
  "body",
  "constraint",
  "copy",
  "description",
  "error",
  "hint",
  "label",
  "meta",
  "name",
  "note",
  "short_name",
  "subtitle",
  "text",
  "title",
]);
const nonUserCallNames = new Set([
  "CustomEvent",
  "Error",
  "console.error",
  "console.info",
  "console.log",
  "console.warn",
  "document.querySelector",
  "document.querySelectorAll",
  "endsWith",
  "gsap.fromTo",
  "gsap.set",
  "gsap.to",
  "gsap.utils.toArray",
  "includes",
  "indexOf",
  "lastIndexOf",
  "matchMedia",
  "opaqueId",
  "replace",
  "replaceAll",
  "split",
  "startsWith",
  "window.matchMedia",
]);
const machineCallNames = new Set([
  "addEventListener",
  "addGoal",
  "addStage",
  "addCorrection",
  "document.documentElement.setAttribute",
  "getItem",
  "localStorage.getItem",
  "localStorage.setItem",
  "removeEventListener",
  "removeItem",
  "resolveStaleEvent",
  "sessionStorage.getItem",
  "sessionStorage.setItem",
  "setItem",
  "setMode",
  "setFinalState",
  "setPhase",
  "setPreviewState",
  "setSyncState",
  "setValidation",
  "setWriterState",
  "window.addEventListener",
  "window.removeEventListener",
]);
const cssStylePropertyNames = new Set(["clip", "overflow", "position", "whiteSpace"]);
const httpMethods = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]);
const nextDynamicRouteValues = new Set(["auto", "force-dynamic", "force-static", "error"]);

function isNextDynamicRouteConfig(node) {
  if (!nextDynamicRouteValues.has(node.text)) return false;
  const declaration = node.parent;
  if (!ts.isVariableDeclaration(declaration) || declaration.initializer !== node) return false;
  return ts.isIdentifier(declaration.name) && declaration.name.text === "dynamic";
}

function isInsideCssStyleObject(node, source) {
  if (!ts.isPropertyAssignment(node.parent) || node.parent.initializer !== node) return false;
  let container = node.parent.parent;
  if (!ts.isObjectLiteralExpression(container)) return false;
  let parent = container.parent;
  while (ts.isAsExpression(parent) || ts.isSatisfiesExpression(parent) || ts.isParenthesizedExpression(parent)) {
    container = parent;
    parent = parent.parent;
  }
  if (ts.isVariableDeclaration(parent)) return /Styles?$/.test(parent.name.getText(source));
  return (
    ts.isJsxExpression(parent) && ts.isJsxAttribute(parent.parent) && parent.parent.name.getText(source) === "style"
  );
}

function collectFiles(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return collectFiles(fullPath);
      if (
        !/\.[cm]?[jt]sx?$/.test(entry.name) ||
        /(?:\.test\.|\.spec\.)/.test(entry.name) ||
        /(?:robots|sitemap)\.ts$/.test(entry.name)
      )
        return [];
      return [fullPath];
    })
    .sort();
}

function loadCatalogue() {
  const text = fs.readFileSync(cataloguePath, "utf8");
  const source = ts.createSourceFile(cataloguePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const messages = new Map();

  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "prototypeMessages" && node.initializer) {
      const object = ts.isAsExpression(node.initializer) ? node.initializer.expression : node.initializer;
      if (!ts.isObjectLiteralExpression(object)) throw new Error("prototypeMessages must be an object literal");
      for (const property of object.properties) {
        if (!ts.isPropertyAssignment(property) || !ts.isStringLiteralLike(property.name)) continue;
        if (!ts.isStringLiteralLike(property.initializer)) {
          throw new Error(`Catalogue value for ${property.name.text} must be a string literal`);
        }
        const expectedId = `prototype.${crypto.createHash("sha256").update(property.initializer.text).digest("hex").slice(0, 12)}`;
        if (property.name.text !== expectedId) {
          throw new Error(`Catalogue ID drift: ${property.name.text} must be ${expectedId}`);
        }
        messages.set(property.name.text, property.initializer.text);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  if (messages.size === 0) throw new Error("prototypeMessages catalogue is empty or missing");
  return messages;
}

function callName(node, source) {
  return ts.isCallExpression(node.parent) && node.parent.expression ? node.parent.expression.getText(source) : "";
}

function propertyName(node, source) {
  if (!ts.isPropertyAssignment(node.parent) || node.parent.initializer !== node) return "";
  return node.parent.name.getText(source).replace(/^['"]|['"]$/g, "");
}

function isMachineCall(expression, source) {
  const name = expression.getText(source);
  if (nonUserCallNames.has(name) || machineCallNames.has(name)) return true;
  if (ts.isPropertyAccessExpression(expression)) {
    const prop = expression.name.text;
    if (nonUserCallNames.has(prop) || machineCallNames.has(prop)) return true;
    if (prop === "querySelector" || prop === "querySelectorAll") return true;
  }
  return /(?:^|\.)(?:addEventListener|removeEventListener|setAttribute)$/.test(name);
}

function isInsideTranslate(node) {
  let current = node.parent;
  while (current && !ts.isStatement(current)) {
    if (ts.isCallExpression(current) && ts.isIdentifier(current.expression) && current.expression.text === "t")
      return true;
    current = current.parent;
  }
  return false;
}

function isInsideRenderedJsxExpression(node) {
  let current = node.parent;
  while (current && !ts.isStatement(current)) {
    if (ts.isJsxExpression(current)) return !ts.isJsxAttribute(current.parent);
    current = current.parent;
  }
  return false;
}

function isRenderedMachineLiteral(node, source) {
  if (!node.text.trim() || !/[\p{L}\p{N}]/u.test(node.text) || /^\d+(?:\.\d+)?$/.test(node.text)) return true;
  if (ts.isBinaryExpression(node.parent) || ts.isCaseClause(node.parent) || ts.isLiteralTypeNode(node.parent))
    return true;
  if (ts.isJsxAttribute(node.parent)) {
    const name = node.parent.name.getText(source);
    if (
      structuralAttributes.has(name) ||
      name.startsWith("data-") ||
      (name.startsWith("aria-") && !userAttributes.has(name))
    ) {
      return true;
    }
  }
  if (ts.isPropertyAssignment(node.parent) && ["id", "kind", "type", "value"].includes(propertyName(node, source))) {
    return true;
  }
  if (nonUserCallNames.has(callName(node, source))) return true;
  if (/^(?:https?:|mailto:|tel:|\/|\.\/|\.\.\/|@\/|[.#[])/.test(node.text)) return true;
  if (/^(?:\d{2}:\d{2}|\d{4}-\d{2}-\d{2}|[A-Z][A-Z0-9_-]*-\d+)$/.test(node.text)) return true;
  return false;
}

function isMachineLiteral(node, source) {
  const value = node.text;
  if (!/[\p{L}\p{N}]/u.test(value) || /^\s*$/.test(value)) return true;
  if (value === "use client" || value === "use server") return true;
  if (isNextDynamicRouteConfig(node)) return true;
  if (ts.isPropertyAssignment(node.parent) && node.parent.name === node) return true;
  if (
    ts.isPropertyAssignment(node.parent) &&
    node.parent.initializer === node &&
    cssStylePropertyNames.has(propertyName(node, source)) &&
    isInsideCssStyleObject(node, source)
  ) {
    return true;
  }
  if (
    httpMethods.has(value) &&
    ts.isCallExpression(node.parent) &&
    node.parent.arguments[0] === node &&
    node.parent.expression.getText(source) === "sendMutation"
  ) {
    return true;
  }
  if (/^(?:https?:|mailto:|tel:|\/|\.\/|\.\.\/|@\/|matchday[-_])/.test(value)) return true;
  if (/^(?:\.?[#[]|[.#][A-Za-z_-])/.test(value)) return true;
  if (/^(?:\d{2}:\d{2}|\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2}T.*|[A-Z][A-Z0-9_-]*-\d+)$/.test(value)) return true;
  if (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent) || ts.isLiteralTypeNode(node.parent)) {
    return true;
  }
  if (ts.isJsxAttribute(node.parent)) {
    const name = node.parent.name.getText(source);
    if (name.startsWith("data-") || (name.startsWith("aria-") && !userAttributes.has(name))) return true;
    if (structuralAttributes.has(name)) return true;
    if (name === "defaultValue") return /^(?:\d|\d{2}:\d{2}|\d{4}-\d{2}-\d{2})$/.test(value);
  }
  let ancestor = node.parent;
  while (ancestor && !ts.isStatement(ancestor)) {
    if (ts.isJsxAttribute(ancestor)) {
      const name = ancestor.name.getText(source);
      if (
        structuralAttributes.has(name) ||
        name.startsWith("data-") ||
        (name.startsWith("aria-") && !userAttributes.has(name))
      )
        return true;
      break;
    }
    if (ts.isPropertyAssignment(ancestor)) {
      const name = ancestor.name.getText(source).replace(/^['"]|['"]$/g, "");
      if (
        [
          "id",
          "kind",
          "type",
          "tier",
          "section",
          "choice",
          "all",
          "essential",
          "team",
          "sync",
          "resolution",
          "value",
          "clearProps",
        ].includes(name)
      )
        return true;
    }
    if (ts.isCallExpression(ancestor)) {
      if (isMachineCall(ancestor.expression, source)) return true;
    }
    ancestor = ancestor.parent;
  }
  const parentCall = callName(node, source);
  if (nonUserCallNames.has(parentCall) || machineCallNames.has(parentCall)) return true;
  if (ts.isPropertyAssignment(node.parent)) {
    const name = propertyName(node, source);
    if (
      [
        "dateStyle",
        "display",
        "id",
        "kind",
        "type",
        "tier",
        "section",
        "choice",
        "all",
        "essential",
        "team",
        "sync",
        "resolution",
        "value",
        "x",
        "y",
        "start",
        "end",
        "ease",
        "hour",
        "minute",
        "timeStyle",
        "timeZoneName",
        "transform",
      ].includes(name)
    ) {
      return true;
    }
  }
  if (ts.isNewExpression(node.parent) && node.parent.expression.getText(source) === "CustomEvent") return true;
  if (ts.isBinaryExpression(node.parent) || ts.isCaseClause(node.parent)) return true;
  return false;
}

function placeholders(message) {
  return [...message.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((match) => match[1]).sort();
}

function auditSource(file, text, catalogue) {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const findings = [];

  function report(node, rule, detail) {
    const location = source.getLineAndCharacterOfPosition(node.getStart(source));
    findings.push({ file, line: location.line + 1, column: location.character + 1, rule, detail });
  }

  function checkTranslate(node) {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== "t") return;
    const idNode = node.arguments[0];
    if (!idNode || !ts.isStringLiteralLike(idNode)) {
      report(node, "dynamic-message-id", "t() requires a literal registered message ID");
      return;
    }
    if (!idNode.text.startsWith("prototype.")) {
      report(idNode, "source-text-message-id", `arbitrary source text passed to t(): ${JSON.stringify(idNode.text)}`);
      return;
    }
    const message = catalogue.get(idNode.text);
    if (message === undefined) {
      report(idNode, "unknown-message-id", `message ID is absent from prototypeMessages: ${idNode.text}`);
      return;
    }
    const expected = placeholders(message);
    const valuesNode = node.arguments[1];
    if (valuesNode && ts.isObjectLiteralExpression(valuesNode)) {
      for (const property of valuesNode.properties) {
        if (
          ts.isPropertyAssignment(property) &&
          ts.isStringLiteralLike(property.initializer) &&
          property.initializer.text
        ) {
          report(
            property.initializer,
            "hardcoded-interpolation-value",
            `literal interpolation values must come from a catalogue or runtime data: ${JSON.stringify(property.initializer.text)}`,
          );
        }
      }
    }
    const actual =
      valuesNode && ts.isObjectLiteralExpression(valuesNode)
        ? valuesNode.properties
            .filter((property) => ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))
            .map((property) => property.name.getText(source).replace(/^['"]|['"]$/g, ""))
            .sort()
        : [];
    if (expected.join("|") !== actual.join("|")) {
      report(node, "placeholder-mismatch", `expected {${expected.join(", ")}} but received {${actual.join(", ")}}`);
    }
  }

  function visit(node) {
    checkTranslate(node);

    if (ts.isJsxText(node) && /\p{L}/u.test(node.text)) {
      report(node, "hardcoded-jsx-text", JSON.stringify(node.text.trim()));
    }

    if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
      const name = node.name.getText(source);
      if (userAttributes.has(name) && node.initializer.text.trim()) {
        report(node.initializer, "hardcoded-user-attribute", `${name}=${JSON.stringify(node.initializer.text)}`);
      } else if (!isMachineLiteral(node.initializer, source)) {
        report(node.initializer, "hardcoded-user-prop", `${name}=${JSON.stringify(node.initializer.text)}`);
      }
    }

    if (
      node.parent &&
      ts.isJsxExpression(node.parent) &&
      node.parent.expression === node &&
      ts.isStringLiteralLike(node)
    ) {
      if (!isMachineLiteral(node, source)) report(node, "hardcoded-jsx-expression", JSON.stringify(node.text));
    }

    if (
      ts.isStringLiteralLike(node) &&
      isInsideRenderedJsxExpression(node) &&
      !isInsideTranslate(node) &&
      !isRenderedMachineLiteral(node, source)
    ) {
      report(node, "hardcoded-rendered-branch", JSON.stringify(node.text));
    }

    if (ts.isTemplateExpression(node) && node.parent && ts.isJsxExpression(node.parent)) {
      const raw = node.getText(source);
      if (/[\p{L}\p{N}]/u.test(raw) && !isMachineLiteral(node.head, source)) {
        report(node, "hardcoded-jsx-template", raw);
      }
    }

    if (
      ts.isStringLiteralLike(node) &&
      !isInsideTranslate(node) &&
      /\p{L}/u.test(node.text) &&
      !isMachineLiteral(node, source)
    ) {
      report(node, "hardcoded-user-literal", JSON.stringify(node.text));
    }

    if (
      ts.isStringLiteralLike(node) &&
      node.text.trim() &&
      !isInsideTranslate(node) &&
      userPropertyNames.has(propertyName(node, source))
    ) {
      report(node, "hardcoded-user-data", `${propertyName(node, source)}=${JSON.stringify(node.text)}`);
    }

    if (ts.isStringLiteralLike(node) && !isInsideTranslate(node) && ts.isReturnStatement(node.parent)) {
      const fn = node.parent.parent;
      if (
        fn &&
        ts.isBlock(fn) &&
        fn.parent &&
        /(?:Label|Message|Text|Copy|Title|Description)$/.test(fn.parent.name?.getText(source) ?? "")
      ) {
        report(node, "hardcoded-helper-return", JSON.stringify(node.text));
      }
    }

    if (ts.isCallExpression(node)) {
      const name = node.expression.getText(source);
      if (/^set(?:Announcement|AccessError|Error|Message|Label|Title|Description|Copy|Hint|StatusText)$/.test(name)) {
        const argument = node.arguments[0];
        if (
          argument &&
          (!ts.isStringLiteralLike(argument) || argument.text.trim()) &&
          (ts.isStringLiteralLike(argument) || ts.isTemplateExpression(argument)) &&
          !isInsideTranslate(argument)
        ) {
          report(argument, "hardcoded-user-state", argument.getText(source));
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(source);
  return findings;
}

function runSelfTest(catalogue) {
  const registered = catalogue.keys().next().value;
  const templateEntry = [...catalogue].find(([, message]) => placeholders(message).length > 0);
  if (!templateEntry) throw new Error("i18n audit self-test requires a message with a placeholder");
  const [templateId, templateMessage] = templateEntry;
  const templateKey = placeholders(templateMessage)[0];
  const cases = [
    ["direct JSX", "export const A=()=> <p>Visible copy</p>", true],
    ["accessible prop", 'export const A=()=> <button aria-label="Open menu" />', true],
    ["custom prop", 'export const A=()=> <Shell routeLabel="Route label" />', true],
    ["mapped data", 'const rows=[{label:"Visible label"}]; export const A=()=>rows.map(x=><p>{x.label}</p>)', true],
    ["helper return", 'function syncLabel(){return "Pending sync"} export const A=()=> <p>{syncLabel()}</p>', true],
    ["announcement", 'function f(){setAnnouncement("Saved locally")}', true],
    ["template", "export const A=({n})=> <p>{`Count ${n}`}</p>", true],
    ["conditional branch", 'export const A=({ok})=> <p>{ok ? "Ready" : "Not ready"}</p>', true],
    ["plural suffix", 'export const A=({n})=> <p>{n} event{n === 1 ? "" : "s"}</p>', true],
    ["source key", 'const x=t("English sentence")', true],
    ["unknown key", 'const x=t("prototype.ffffffffffff")', true],
    ["proper noun", 'export const A=()=> <input defaultValue="Marina Sports Centre" />', true],
    [
      "standalone declaration",
      'const standaloneLabel="Visible standalone label"; export const A=()=> <button>{standaloneLabel}</button>',
      true,
    ],
    ["tuple data", 'const tupleCopy=["Visible tuple label"]; export const A=()=> <p>{tupleCopy[0]}</p>', true],
    ["lowercase default", 'export const A=()=> <input defaultValue="singapore" />', true],
    [
      "lowercase standalone",
      'const lowercaseStandalone="submit"; export const A=()=> <button>{lowercaseStandalone}</button>',
      true,
    ],
    ["Unicode standalone", 'const unicodeStandalone="比赛"; export const A=()=> <p>{unicodeStandalone}</p>', true],
    ["literal interpolation", `const x=t(${JSON.stringify(templateId)},{${templateKey}:"Visible value"})`, true],
    ["registered", `const x=t(${JSON.stringify(registered)})`, false],
    ["catalogue", "export const A=()=> <p>{messages.home.title}</p>", false],
    ["machine attributes", 'export const A=()=> <input className="field-row" value="ready" />', false],
    ["selector and log", 'matchMedia("(max-width: 767px)"); console.error("route error")', false],
    [
      "optional member selector",
      'ref.current?.querySelectorAll<HTMLElement>("a[href], button:not([disabled])")',
      false,
    ],
    ["logic discriminant", 'const x = state === "ready"', false],
    [
      "CSS-in-JS machine values",
      'const visuallyHiddenStyle={position:"absolute",overflow:"hidden",clip:"rect(0, 0, 0, 0)",whiteSpace:"nowrap"}',
      false,
    ],
    [
      "visible style-named property",
      'const copy={position:"Visible position"}; export const A=()=> <p>{copy.position}</p>',
      true,
    ],
    ["HTTP mutation method", 'sendMutation("PATCH", body)', false],
    ["Next dynamic route config", 'export const dynamic="force-dynamic"', false],
    ["visible HTTP-looking text", "export const A=()=> <button>PUT</button>", true],
  ];

  const failures = cases.filter(([name, sourceText, shouldFail]) => {
    const didFail = auditSource(`${name}.tsx`, sourceText, catalogue).length > 0;
    return didFail !== shouldFail;
  });
  if (failures.length) throw new Error(`i18n audit self-test failed: ${failures.map(([name]) => name).join(", ")}`);
  process.stdout.write(`i18n audit fixtures: ${cases.length}/${cases.length} passed\n`);
}

const catalogue = loadCatalogue();
if (process.argv.includes("--self-test")) runSelfTest(catalogue);

const files = sourceRoots.flatMap(collectFiles);
const findings = files
  .flatMap((file) => auditSource(file, fs.readFileSync(file, "utf8"), catalogue))
  .sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.rule.localeCompare(b.rule),
  );

if (findings.length) {
  for (const finding of findings) {
    process.stderr.write(
      `${path.relative(workspaceRoot, finding.file)}:${finding.line}:${finding.column} [${finding.rule}] ${finding.detail}\n`,
    );
  }
  process.stderr.write(`Found ${findings.length} hard-coded or invalid user-facing string(s).\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `i18n audit: ${files.length} route/component files, ${catalogue.size} registered prototype messages, 0 findings\n`,
  );
}
