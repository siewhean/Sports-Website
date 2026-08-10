import path from "node:path";

export const GATE_C_C5_PROJECT_NAMES = [
  "desktop-chromium",
  "desktop-firefox",
  "desktop-webkit",
  "phone-chromium",
  "phone-webkit",
  "tablet-webkit",
] as const;

export function resolveGateCC5BrowserEvidence(input: { evidenceDirectory?: string; sourceSha?: string }) {
  if (!input.sourceSha || !/^[0-9a-f]{40}$/u.test(input.sourceSha)) {
    throw new Error("GATE_C_C5_SOURCE_SHA must be the exact lowercase 40-character source SHA.");
  }
  if (!input.evidenceDirectory?.trim()) {
    throw new Error("GATE_C_C5_EVIDENCE_DIR is required for C5 browser evidence.");
  }

  const runDirectory = path.resolve(input.evidenceDirectory, input.sourceSha, "browser-matrix");
  return {
    jsonReport: path.join(runDirectory, "playwright-results.json"),
    outputDirectory: path.join(runDirectory, "artifacts"),
    runDirectory,
    sourceSha: input.sourceSha,
  };
}
