export type AccessExchange = {
  session_id?: unknown;
  session_token?: unknown;
  match_id?: unknown;
  mode?: unknown;
  generation?: unknown;
};

export function requireWriterAccessExchange(
  value: AccessExchange,
  expectedMatchId: string,
): {
  sessionId: string;
  sessionToken: string;
  generation: number;
} {
  if (
    value.match_id !== expectedMatchId ||
    value.mode !== "writer" ||
    typeof value.session_id !== "string" ||
    value.session_id.length === 0 ||
    typeof value.session_token !== "string" ||
    value.session_token.length === 0 ||
    !Number.isInteger(value.generation) ||
    Number(value.generation) < 1
  ) {
    throw new Error(
      `Access exchange for ${expectedMatchId} did not return the required writer session contract (match_id, mode, credentials, generation)`,
    );
  }
  return {
    sessionId: value.session_id,
    sessionToken: value.session_token,
    generation: Number(value.generation),
  };
}
