-- A layout move is an authored format change even when the canonical graph is
-- unchanged. Preserve no-op protection while allowing immutable revisions of
-- the same graph with a different complete canvas layout.

ALTER TABLE format_revisions
  DROP CONSTRAINT format_revisions_division_id_definition_hash_key;

CREATE UNIQUE INDEX format_revisions_division_graph_layout_unique
  ON format_revisions(division_id,definition_hash,layout);
