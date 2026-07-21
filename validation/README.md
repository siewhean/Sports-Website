# Canonical competition fixtures

`canonical-competitions.json` is the stable Phase 0 input and numerical oracle for 8, 12, 16, 24, and 48-entry Canoe Polo competitions. It also carries a two-division round-robin scenario with entry-availability constraints.

An entry factory materialises `entry_count` entries in seed order and assigns each to the declared canonical division. For example, `cp12-team-` produces `cp12-team-01` through `cp12-team-12`. This keeps the source pack reviewable while preserving deterministic IDs and exactly one initial placement per entry.

Each format oracle declares:

- round-robin group count and size, or `null`;
- number of entries qualifying into a single-elimination bracket;
- the exact per-group and best-remaining qualification rule;
- explicit byes where the bracket is not a power of two;
- third-place inclusion;
- deterministic total and guaranteed match counts;
- aggregate multi-division match counts and entry-availability date/time bounds;
- remaining capacity after applying operating windows and unavailable periods.

Run:

```sh
pnpm validate:fixtures
```

The validator independently recomputes group, knockout, and aggregate multi-division match counts. It rejects missing sizes/modes, absence of a round-robin-only format, duplicate fixture IDs, invalid entry placement or availability references, qualifier/bracket mismatches, wrong bye counts, match-count drift, capacity drift, and over-capacity templates.

Execution Phase 3 adds independently checked graph structures, invalid-graph cases, recommendations, capacity boundaries, and standings fixtures under `validation/phase-3`. Source-backlog Phase 6, owned by execution Phase 4, adds schedule snapshots and hard-constraint assertions. Those outputs must consume these fixture IDs rather than create a competing fixture set.

Run the Gate A fixture oracle with:

```sh
pnpm validate:phase3
```

Phase 4 adds frozen single-elimination schedule oracles for 8, 12, 16, 24, and
48 entries plus a shared-area, two-division assignment oracle. Validate them
with:

```sh
pnpm validate:phase4
```
