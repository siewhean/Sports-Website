# Gate C C1 follow-up implementation pack

This pack is based on:

- certified C1 source: `a896e4f48e005ad16c0360f6f41495d19282f12b`
- C1 evidence commit: `c0aa517e6a34221f480d6b1075010233133a99a5`
- certified Gate B base: `d432cb4f7c8b8c419acb1c8f556ed02dcd48b834`

## Implemented source changes

1. Fallback-code collision handling:
   - unbiased cryptographic 12-digit generation;
   - bounded retries;
   - PostgreSQL savepoint isolation;
   - retry only the active-code uniqueness constraint;
   - unrelated database errors fail immediately;
   - atomic issuance/rotation with no orphan pass;
   - secret-safe audit metadata.

2. Phone access-summary reflow:
   - mobile single-column summary;
   - `min-width: 0` and safe wrapping;
   - 44px target size;
   - 320 CSS-pixel Chromium/WebKit overflow evidence.

3. HMAC rotation decision:
   - full versioned rotation deferred to C5 because a partial change could split/reset abuse counters;
   - C5 must add versioned persistence, multi-key continuity, retirement controls and redaction evidence.

Do not start C2 until the C1 follow-up receives a new clean exact-SHA PASS and fresh independent review with `P0: 0` and `P1: 0`.