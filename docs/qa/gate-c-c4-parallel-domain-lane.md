# Gate C C4 domain-slice provenance

The original isolated, parallel-safe C4 domain lane was created from the certified C2 evidence commit:

`e1722bcb3cd859c4035c20efe498720fdc23e08a`

Its reviewed commits were then transplanted onto the non-certifying C4 preparation branch based on frozen C3 source:

`3880bbf6c86f7d3da57d673e185787e6aeb86efb`

The C2-based branch remains the audit source. The C3-source preparation branch is not a release-integration branch and cannot receive C4 certification evidence until C3 has an exact-SHA PASS evidence commit.

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

Do not merge either branch directly into the release line while C3 is unresolved. After C3 receives an exact-SHA PASS, create the C4 integration branch from that C3 evidence commit, review this preparation branch again, and transplant its commits before running C4 infrastructure and certification validation.
