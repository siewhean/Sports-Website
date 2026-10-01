import type { SportId } from "@matchday/domain";

export type CasualGame = {
  id: string;
  sport_id: SportId;
  home_name: string;
  away_name: string;
  home_score: number;
  away_score: number;
  home_sets: number;
  away_sets: number;
  current_set: number;
  sets: { home: number; away: number }[];
  target_points: number | null;
  best_of_sets: number | null;
  period_minutes: number | null;
  elapsed_seconds: number;
  timer_running: boolean;
  status: "live" | "finished" | string;
  version: number;
  updated_at: string;
  observed_at: string;
  viewer_token?: string;
};

export type CasualSettings = {
  sport_id: SportId;
  home_name: string;
  away_name: string;
  target_points?: number;
  best_of_sets?: number;
  period_minutes?: number;
};

const base = "/api/v1/casual";
const hostKey = (id: string) => `matchday:casual:host:${id}`;
const viewerKey = (id: string) => `matchday:casual:viewer:${id}`;

function unwrapGame(value: unknown): CasualGame {
  if (!value || typeof value !== "object") throw new Error("The game response was incomplete.");
  const record = value as Record<string, unknown>;
  return (record.game ?? value) as CasualGame;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", credentials: "same-origin", ...init });
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const nestedError = body?.error;
    const message =
      body?.message ??
      (nestedError && typeof nestedError === "object" ? (nestedError as Record<string, unknown>).message : nestedError);
    throw new Error(typeof message === "string" ? message : `Request failed (${response.status}).`);
  }
  return body as T;
}

export function saveGuestCredentials(id: string, hostToken: string, viewerToken: string) {
  localStorage.setItem(hostKey(id), hostToken);
  localStorage.setItem(viewerKey(id), viewerToken);
}

export function hostTokenFor(id: string) {
  return localStorage.getItem(hostKey(id));
}

export function viewerTokenFor(id: string) {
  return localStorage.getItem(viewerKey(id));
}

export async function createCasualGame(settings: CasualSettings): Promise<CasualGame> {
  const response = await json<Record<string, unknown>>(`${base}/games`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(settings),
  });
  const game = unwrapGame(response);
  if (typeof response.host_token !== "string" || typeof response.viewer_token !== "string") {
    throw new Error("The game could not be opened safely. Please try again.");
  }
  saveGuestCredentials(game.id, response.host_token, response.viewer_token);
  return game;
}

export async function readCasualGame(id: string, mode: "host" | "viewer", viewerToken?: string): Promise<CasualGame> {
  const token = mode === "host" ? hostTokenFor(id) : viewerToken;
  const url = `${base}/games/${encodeURIComponent(id)}${mode === "viewer" && token ? `?viewer_token=${encodeURIComponent(token)}` : ""}`;
  const response = await json<unknown>(
    url,
    mode === "host" && token ? { headers: { "x-casual-host-token": token } } : undefined,
  );
  return unwrapGame(response);
}

export async function changeCasualGame(
  id: string,
  action: "actions" | "undo" | "timer" | "finish",
  body?: Record<string, unknown>,
): Promise<CasualGame> {
  const token = hostTokenFor(id);
  if (!token) throw new Error("Host access is unavailable on this device.");
  const response = await json<unknown>(`${base}/games/${encodeURIComponent(id)}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-casual-host-token": token },
    body: JSON.stringify(body ?? {}),
  });
  return unwrapGame(response);
}

export function casualViewerHref(id: string, viewerToken: string): string {
  return `/play/${encodeURIComponent(id)}/watch?viewer_token=${encodeURIComponent(viewerToken)}`;
}
