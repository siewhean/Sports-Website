import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";

export default class GateCC5StrictReporter implements Reporter {
  private readonly skipped: string[] = [];

  onTestEnd(test: TestCase, result: TestResult) {
    if (result.status === "skipped") {
      this.skipped.push(`${test.parent.project()?.name ?? "unknown-project"}: ${test.titlePath().join(" > ")}`);
    }
  }

  async onEnd() {
    if (this.skipped.length === 0) return;
    process.stderr.write(`C5 browser certification forbids skipped tests:\n${this.skipped.join("\n")}\n`);
    return { status: "failed" as const };
  }
}
