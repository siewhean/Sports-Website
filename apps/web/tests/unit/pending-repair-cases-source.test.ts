import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../components/gate-c/PendingRepairCases.tsx", import.meta.url), "utf8");
const workspaceSource = readFileSync(new URL("../../components/gate-c/RepairWorkspace.tsx", import.meta.url), "utf8");

describe("pending repair intake navigation boundary", () => {
  it("opens the newly created workspace without a document reload", () => {
    expect(source).toContain("new CustomEvent(gateCC4UiMachine.repairCreatedEvent");
    expect(workspaceSource).toContain(
      "window.addEventListener(gateCC4UiMachine.repairCreatedEvent, handleOpenWorkspace)",
    );
    expect(workspaceSource).toContain("void Promise.resolve().then(() => openWorkspace(repairId))");
    expect(workspaceSource).toContain("workspaceHeadingRef.current?.focus()");
    expect(workspaceSource).toContain('className={styles.live} aria-live="polite" aria-atomic="true"');
    expect(source).not.toContain("window.location.reload");
    expect(source).not.toContain("window.location.assign");
    expect(source).not.toContain("window.location.replace");
  });

  it("uses the shared C4 copy and protocol catalogue", () => {
    expect(source).toContain("gateCC4PendingCopy.title");
    expect(source).toContain("gateCC4Http.cacheNoStore");
    expect(source).toContain("gateCC4Http.jsonContentType");
  });
});
