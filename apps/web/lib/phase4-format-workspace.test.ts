import { describe, expect, it } from "vitest";
import { resolveFormatWorkspaceRenderState } from "./phase4-format-workspace";

describe("resolveFormatWorkspaceRenderState", () => {
  it.each(["error", "offline", "permission", "conflict", "quota", "plan"] as const)(
    "does not mask %s as an empty workspace when the response has no draft",
    (state) => {
      expect(resolveFormatWorkspaceRenderState(state, false)).toBe("problem");
    },
  );

  it("uses the empty state only for an explicit empty response or a ready response without a draft", () => {
    expect(resolveFormatWorkspaceRenderState("empty", false)).toBe("empty");
    expect(resolveFormatWorkspaceRenderState("ready", false)).toBe("empty");
    expect(resolveFormatWorkspaceRenderState("ready", true)).toBe("editor");
  });
});
