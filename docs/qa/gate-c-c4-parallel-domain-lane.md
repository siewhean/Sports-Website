# Gate C C4 parallel domain lane

This branch is an isolated, parallel-safe C4 implementation lane created from the certified C2 evidence commit:

`e1722bcb3cd859c4035c20efe498720fdc23e08a`

## Included

- versioned repair/public-freshness contracts;
- deterministic affected-match dependency traversal;
- protected-match and manual-slot classification;
- dependency-path retention;
- canonical analysis fingerprint input;
- focused domain tests.

## Excluded

- database migrations and repair persistence;
- correction/publication runtime changes;
- organiser repair UI;
- PDF generation;
- C3 source, service-worker, IndexedDB, replay or evidence files;
- C4 certification claims.

## Integration rule

Do not merge this branch directly into the release line while C3 is unresolved. After C3 receives an exact-SHA PASS, review and transplant the C4 commits onto a branch created from the certified C3 evidence commit, then rerun format, lint, typecheck, unit, infrastructure and dedicated C4 validation.
