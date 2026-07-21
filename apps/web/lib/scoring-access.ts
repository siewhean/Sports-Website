export const scoringAccessTokenLength = { minimum: 32, maximum: 256 } as const;

export function isScoringAccessToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= scoringAccessTokenLength.minimum &&
    value.length <= scoringAccessTokenLength.maximum
  );
}
