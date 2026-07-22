-- Setup selection now publishes the selected format atomically. A later caller
-- may safely repeat publication of that exact revision; return the immutable
-- row without duplicating audit or outbox evidence.

CREATE OR REPLACE FUNCTION phase4_publish_format_revision(target_revision uuid, actor uuid, request_id_value text)
RETURNS format_revisions AS $$
DECLARE candidate format_revisions%ROWTYPE; previous_id uuid;
BEGIN
  SELECT * INTO candidate FROM format_revisions WHERE id=target_revision FOR UPDATE;
  IF candidate.id IS NULL THEN RAISE EXCEPTION 'format revision does not exist'; END IF;

  IF candidate.status='published' THEN
    IF candidate.graph_materialized_at IS NULL
       OR NOT phase4_materialization_is_exact(candidate.id)
       OR candidate.graph_materialization_hash<>phase4_expected_materialization_hash(candidate.id)
       OR candidate.graph_match_count<>jsonb_array_length(candidate.definition->'matches')
       OR (SELECT count(*) FROM matches WHERE format_revision_id=candidate.id)<>candidate.graph_match_count
       OR (SELECT count(*) FROM format_match_sources WHERE format_revision_id=candidate.id)<>candidate.graph_match_count*2 THEN
      RAISE EXCEPTION 'published format revision failed immutable materialisation validation';
    END IF;
    RETURN candidate;
  END IF;

  IF candidate.status<>'draft' OR candidate.graph_materialized_at IS NULL
     OR NOT phase4_materialization_is_exact(candidate.id)
     OR candidate.graph_materialization_hash<>phase4_expected_materialization_hash(candidate.id)
     OR candidate.graph_match_count<>jsonb_array_length(candidate.definition->'matches')
     OR (SELECT count(*) FROM matches WHERE format_revision_id=candidate.id)<>candidate.graph_match_count
     OR (SELECT count(*) FROM format_match_sources WHERE format_revision_id=candidate.id)<>candidate.graph_match_count*2 THEN
    RAISE EXCEPTION 'format publication requires a completely materialised draft';
  END IF;

  PERFORM 1 FROM divisions WHERE id=candidate.division_id FOR UPDATE;
  SELECT id INTO previous_id FROM format_revisions
  WHERE division_id=candidate.division_id AND status='published' FOR UPDATE;
  IF previous_id IS NOT NULL THEN UPDATE format_revisions SET status='superseded' WHERE id=previous_id; END IF;

  UPDATE format_revisions SET status='published',published_at=now()
  WHERE id=target_revision RETURNING * INTO candidate;

  INSERT INTO audit_events(request_id,actor_account_id,actor_type,organisation_id,action,target_type,target_id,metadata)
  SELECT request_id_value,actor,'account',c.organisation_id,'format.published','format_revision',candidate.id::text,
    jsonb_build_object('division_id',candidate.division_id,'superseded_revision_id',previous_id)
  FROM competitions c WHERE c.id=candidate.competition_id;

  INSERT INTO outbox_events(aggregate_type,aggregate_id,event_type,payload,idempotency_key)
  VALUES('format_revision',candidate.id::text,'format.published',
    jsonb_build_object('competition_id',candidate.competition_id,'division_id',candidate.division_id),
    'phase4:format-published:'||candidate.id::text);
  RETURN candidate;
END;
$$ LANGUAGE plpgsql;
