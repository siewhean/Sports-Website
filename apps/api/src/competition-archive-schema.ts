import { Type } from "@sinclair/typebox";

/**
 * Size caps for competition archive import. They bound transaction size and row counts so one
 * request cannot hold a long write transaction or bloat the database (the free-plan 16-entry DB
 * trigger still applies on top of these).
 */
export const ARCHIVE_LIMITS = {
  divisions: 32,
  entriesPerDivision: 256,
  totalEntries: 1_024,
  matchesPerDivision: 1_024,
  totalMatches: 4_096,
  sponsors: 50,
  bodyBytes: 2 * 1024 * 1024,
} as const;

/** Branding/sponsor links are rendered on public pages, so only https URLs are accepted. */
export const ARCHIVE_HTTPS_URL_PATTERN = "^https://[^\\s]+$";
const HttpsUrl = Type.String({ format: "uri", pattern: ARCHIVE_HTTPS_URL_PATTERN, maxLength: 2_048 });
const Color = Type.String({ pattern: "^#[0-9a-fA-F]{6}$" });
const Nullable = <T extends ReturnType<typeof Type.String>>(schema: T) =>
  Type.Optional(Type.Union([schema, Type.Null()]));
const ArchiveId = Type.String({ minLength: 1, maxLength: 64 });

export const SponsorTier = Type.Union([
  Type.Literal("headline"),
  Type.Literal("tier1"),
  Type.Literal("tier2"),
  Type.Literal("community"),
]);

export const CompetitionArchiveSchema = Type.Object(
  {
    schema_version: Type.Literal("1.0"),
    exported_at: Type.Optional(Type.String({ maxLength: 64 })),
    competition: Type.Object(
      {
        id: ArchiveId,
        name: Type.String({ minLength: 1, maxLength: 160 }),
        sport_code: Type.String({ minLength: 1, maxLength: 40, pattern: "^[a-z][a-z0-9_]*$" }),
        // Accepted for round-tripping but ignored: imports always start as a draft.
        status: Type.Optional(Type.String({ maxLength: 40 })),
        created_at: Type.Optional(Type.String({ maxLength: 64 })),
      },
      { additionalProperties: false },
    ),
    branding: Type.Optional(
      Type.Union([
        Type.Object(
          {
            primary_color: Nullable(Color),
            secondary_color: Nullable(Color),
            logo_url: Nullable(HttpsUrl),
            banner_url: Nullable(HttpsUrl),
            hide_platform_badge: Type.Optional(Type.Boolean()),
          },
          { additionalProperties: false },
        ),
        Type.Null(),
      ]),
    ),
    sponsors: Type.Optional(
      Type.Array(
        Type.Object(
          {
            name: Type.String({ minLength: 1, maxLength: 100 }),
            tier: SponsorTier,
            logo_url: Nullable(HttpsUrl),
            website_url: Nullable(HttpsUrl),
            sort_order: Type.Integer({ minimum: 0, maximum: 32_767 }),
          },
          { additionalProperties: false },
        ),
        { maxItems: ARCHIVE_LIMITS.sponsors },
      ),
    ),
    divisions: Type.Array(
      Type.Object(
        {
          id: Type.Optional(ArchiveId),
          name: Type.String({ minLength: 1, maxLength: 120 }),
          entries: Type.Optional(
            Type.Array(
              Type.Object(
                {
                  id: ArchiveId,
                  name: Type.String({ minLength: 1, maxLength: 120 }),
                  seed: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 10_000 }), Type.Null()])),
                },
                { additionalProperties: false },
              ),
              { maxItems: ARCHIVE_LIMITS.entriesPerDivision },
            ),
          ),
          matches: Type.Optional(
            Type.Array(
              Type.Object(
                {
                  id: Type.Optional(ArchiveId),
                  code: Type.String({ minLength: 1, maxLength: 40 }),
                  stage: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
                  home_entry_id: Type.Optional(Type.Union([ArchiveId, Type.Null()])),
                  away_entry_id: Type.Optional(Type.Union([ArchiveId, Type.Null()])),
                  // Accepted but ignored: imported matches always start pending.
                  state: Type.Optional(Type.String({ maxLength: 40 })),
                  scheduled_start: Type.Optional(Type.Union([Type.String({ maxLength: 64 }), Type.Null()])),
                },
                { additionalProperties: false },
              ),
              { maxItems: ARCHIVE_LIMITS.matchesPerDivision },
            ),
          ),
        },
        { additionalProperties: false },
      ),
      { maxItems: ARCHIVE_LIMITS.divisions },
    ),
  },
  { additionalProperties: false },
);
