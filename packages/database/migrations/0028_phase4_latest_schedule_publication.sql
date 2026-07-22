-- Organisers may deliberately publish a stable review-ready revision while a
-- newer repair remains private, then publish that repair later. Prevent only a
-- true rollback over a newer revision that is already public.

CREATE FUNCTION phase4_require_latest_schedule_publication() RETURNS trigger AS $$
BEGIN
  IF OLD.status='ready_for_review' AND NEW.status='published' AND EXISTS (
    SELECT 1
    FROM schedule_revisions newer
    WHERE newer.competition_id=OLD.competition_id
      AND newer.revision>OLD.revision
      AND newer.status='published'
  ) THEN
    RAISE EXCEPTION 'schedule revision conflict: cannot replace a newer published revision with an older revision';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ab_schedule_revisions_latest_publication_guard
BEFORE UPDATE OF status ON schedule_revisions
FOR EACH ROW EXECUTE FUNCTION phase4_require_latest_schedule_publication();

CREATE OR REPLACE FUNCTION phase4_publish_schedule_revision(target_revision uuid,actor uuid,request_id_value text)
RETURNS schedule_revisions AS $$
DECLARE candidate schedule_revisions%ROWTYPE; previous_id uuid; target_org uuid;
BEGIN
  SELECT * INTO candidate FROM schedule_revisions WHERE id=target_revision FOR UPDATE;
  IF candidate.id IS NULL OR candidate.status<>'ready_for_review' OR candidate.assignment_hash IS NULL
     OR candidate.assignment_hash<>phase4_schedule_assignment_hash(candidate.id) THEN
    RAISE EXCEPTION 'schedule publication requires an accepted immutable revision';
  END IF;

  PERFORM 1 FROM competitions WHERE id=candidate.competition_id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM schedule_revisions newer
    WHERE newer.competition_id=candidate.competition_id
      AND newer.revision>candidate.revision
      AND newer.status='published'
  ) THEN
    RAISE EXCEPTION 'schedule revision conflict: cannot replace a newer published revision with an older revision';
  END IF;

  SELECT organisation_id INTO target_org FROM competitions WHERE id=candidate.competition_id;
  SELECT id INTO previous_id FROM schedule_revisions
  WHERE competition_id=candidate.competition_id AND status='published' FOR UPDATE;
  PERFORM set_config('matchday.phase4_publish_schedule','on',true);
  IF previous_id IS NOT NULL THEN
    UPDATE schedule_revisions SET status='superseded',superseded_at=now(),updated_at=now() WHERE id=previous_id;
  END IF;
  UPDATE schedule_revisions SET status='published',published_at=now(),updated_at=now()
  WHERE id=target_revision RETURNING * INTO candidate;
  PERFORM set_config('matchday.phase4_publish_schedule','off',true);
  INSERT INTO competition_publications(
    competition_id,published_schedule_revision_id,schedule_version,schedule_published_at,updated_at
  ) VALUES(candidate.competition_id,candidate.id,1,now(),now())
  ON CONFLICT(competition_id) DO UPDATE SET
    published_schedule_revision_id=excluded.published_schedule_revision_id,
    schedule_version=competition_publications.schedule_version+1,
    schedule_published_at=excluded.schedule_published_at,
    updated_at=now();
  INSERT INTO audit_events(
    request_id,actor_account_id,actor_type,organisation_id,action,target_type,target_id,metadata
  ) VALUES(
    request_id_value,actor,'account',target_org,'schedule.published','schedule_revision',candidate.id::text,
    jsonb_build_object('superseded_revision_id',previous_id)
  );
  INSERT INTO outbox_events(aggregate_type,aggregate_id,event_type,payload,idempotency_key)
  VALUES(
    'schedule_revision',candidate.id::text,'schedule.published',
    jsonb_build_object('competition_id',candidate.competition_id),
    'phase4:schedule-published:'||candidate.id::text
  );
  RETURN candidate;
END;
$$ LANGUAGE plpgsql;
