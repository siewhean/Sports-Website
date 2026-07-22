import type { FormatSurfaceState } from "./phase4-format";

export type FormatWorkspaceRenderState = "loading" | "empty" | "problem" | "editor";

export function resolveFormatWorkspaceRenderState(
  viewState: FormatSurfaceState,
  hasDraft: boolean,
): FormatWorkspaceRenderState {
  if (viewState === "loading") return "loading";
  if (viewState === "empty") return "empty";
  if (viewState !== "ready" && viewState !== "read-only") return "problem";
  return hasDraft ? "editor" : "empty";
}
