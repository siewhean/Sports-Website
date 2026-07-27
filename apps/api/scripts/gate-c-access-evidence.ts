import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

type PlaywrightResult = {
  status?: string;
};

type PlaywrightTest = {
  expectedStatus?: string;
  projectName?: string;
  results?: PlaywrightResult[];
};

type PlaywrightSpec = {
  tests?: PlaywrightTest[];
};

type PlaywrightSuite = {
  suites?: PlaywrightSuite[];
  specs?: PlaywrightSpec[];
};

type PlaywrightReport = {
  suites?: PlaywrightSuite[];
};

export type RetainedArtifact = {
  path: string;
  sha256: string;
  size_bytes: number;
};

export function redactedIdentifierHash(kind: "postgres" | "redis-namespace", value: string): string {
  if (!value) throw new Error(`${kind} identifier is required`);
  return createHash("sha256").update(`matchday:gate-c-access:${kind}:${value}`, "utf8").digest("hex");
}

export function redisLogicalDatabase(redisUrl: string): number {
  const pathname = new URL(redisUrl).pathname.slice(1);
  if (!/^\d+$/.test(pathname)) throw new Error("Gate C access Redis URL must contain an explicit logical database");
  const database = Number(pathname);
  if (!Number.isSafeInteger(database) || database < 0) {
    throw new Error("Gate C access Redis logical database is invalid");
  }
  return database;
}

function reportTests(suites: PlaywrightSuite[]): PlaywrightTest[] {
  return suites.flatMap((suite) => [
    ...(suite.specs ?? []).flatMap((spec) => spec.tests ?? []),
    ...reportTests(suite.suites ?? []),
  ]);
}

export function passedPlaywrightTestCount(report: unknown, expectedProject: string): number {
  if (!report || typeof report !== "object") throw new Error("Playwright JSON report must be an object");
  const typed = report as PlaywrightReport;
  const tests = reportTests(typed.suites ?? []);
  if (tests.length === 0) throw new Error(`Playwright JSON report contains no tests for ${expectedProject}`);
  if (tests.some((test) => test.projectName !== expectedProject)) {
    throw new Error(`Playwright JSON report project does not match ${expectedProject}`);
  }
  const passed = tests.filter((test) => {
    const last = test.results?.at(-1);
    return test.expectedStatus === "passed" && last?.status === "passed";
  });
  if (passed.length !== tests.length) {
    throw new Error(`Playwright JSON report for ${expectedProject} did not pass all ${tests.length} tests`);
  }
  return passed.length;
}

async function walkFiles(directory: string, relative = ""): Promise<string[]> {
  const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Retained evidence must not contain symlinks: ${child}`);
    if (entry.isDirectory()) files.push(...(await walkFiles(directory, child)));
    else if (entry.isFile()) files.push(child);
  }
  return files.sort();
}

export async function retainedArtifacts(directory: string): Promise<RetainedArtifact[]> {
  const files = await walkFiles(directory);
  return Promise.all(
    files.map(async (relativePath) => {
      const absolutePath = path.join(directory, relativePath);
      const [contents, metadata] = await Promise.all([readFile(absolutePath), stat(absolutePath)]);
      return {
        path: relativePath.split(path.sep).join("/"),
        sha256: createHash("sha256").update(contents).digest("hex"),
        size_bytes: metadata.size,
      };
    }),
  );
}
