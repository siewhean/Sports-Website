import { describe, expect, it } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { SurfaceStatePanel } from "../../components/phase2/SurfaceState";

type PanelState = Parameters<typeof SurfaceStatePanel>[0]["state"];

function roleOf(state: PanelState): string | null {
  const html = renderToString(React.createElement(SurfaceStatePanel, { state }));
  return /<section[^>]*\brole="([^"]+)"/.exec(html)?.[1] ?? null;
}

describe("SurfaceStatePanel ARIA roles (design-system contract: errors alert, states status)", () => {
  it("announces only the error state assertively", () => {
    expect(roleOf("error")).toBe("alert");
  });

  it.each<PanelState>(["loading", "empty", "offline", "conflict", "read-only", "permission"])(
    "renders %s as a polite status region",
    (state) => {
      expect(roleOf(state)).toBe("status");
    },
  );
});
