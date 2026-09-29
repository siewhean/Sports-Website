import type { CasualGame, CasualSettings } from "./casual-client";

const base = "/api/v1/casual";

async function request<T>(path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
  const identity = body === undefined ? null : await fetch("/api/v1/identity/me", { cache: "no-store" });
  const session = identity?.ok ? ((await identity.json()) as { csrf_token?: string }) : null;
  if (body !== undefined && !session?.csrf_token) throw new Error("Sign in to use this feature.");
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json", "x-csrf-token": session!.csrf_token! }),
      ...extraHeaders,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok)
    throw new Error(typeof payload?.message === "string" ? payload.message : `Request failed (${response.status}).`);
  return payload as T;
}

export function getSavedGames() {
  return request<CasualGame[] | { games: CasualGame[] }>("/me/games").then((value) =>
    Array.isArray(value) ? value : value.games,
  );
}

export function getSharedGames() {
  return request<CasualGame[] | { games: CasualGame[] }>("/friends/shared-games").then((value) =>
    Array.isArray(value) ? value : value.games,
  );
}

export function savePreset(name: string, settings: CasualSettings) {
  return request<unknown>("/me/presets", { name, settings });
}

export type CasualPreset = { id: string; name: string; settings: CasualSettings; created_at: string };

export function getPresets() {
  return request<CasualPreset[] | { presets: CasualPreset[] }>("/me/presets").then((value) =>
    Array.isArray(value) ? value : value.presets,
  );
}

export function claimGame(id: string, hostToken: string) {
  return request<unknown>(`/games/${encodeURIComponent(id)}/claim`, {}, { "x-casual-host-token": hostToken });
}

export type CasualFriend = { id: string; display_name: string };
export type CasualFriendRequest = {
  id: string;
  sender_id: string;
  recipient_id: string;
  status: string;
  created_at: string;
  sender_name: string;
};

export function getFriends() {
  return request<CasualFriend[] | { friends: CasualFriend[] }>("/friends").then((value) =>
    Array.isArray(value) ? value : value.friends,
  );
}

export function getFriendRequests() {
  return request<CasualFriendRequest[] | { requests: CasualFriendRequest[] }>("/friends/requests").then((value) =>
    Array.isArray(value) ? value : value.requests,
  );
}

export function sendFriendRequest(email: string) {
  return request<unknown>("/friends/requests", { recipient_email: email });
}

export function acceptFriendRequest(id: string) {
  return request<unknown>(`/friends/requests/${encodeURIComponent(id)}/accept`, {});
}

export function shareGameWithFriend(gameId: string, accountId: string) {
  return request<unknown>(`/games/${encodeURIComponent(gameId)}/share`, { friend_account_id: accountId });
}
