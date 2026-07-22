-- Gate B publication expiry follows a calendar month from the latest edit.
-- Keep previously emitted warning evidence append-only while allowing a corrected
-- warning when an active draft's calendar expiry differs from the old 30-day date.

CREATE OR REPLACE FUNCTION phase4_schedule_expiry(base_time timestamptz) RETURNS timestamptz AS $$
  SELECT base_time + interval '1 month'
$$ LANGUAGE sql IMMUTABLE STRICT;

CREATE OR REPLACE FUNCTION phase4_guard_schedule_revision() RETURNS trigger AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    NEW.editable_until:=CASE WHEN NEW.status='published' THEN NULL ELSE phase4_schedule_expiry(NEW.updated_at) END;
    IF NEW.status='expired' OR NEW.expired_at IS NOT NULL THEN RAISE EXCEPTION 'schedule revisions cannot be inserted expired'; END IF;
  ELSE
    IF OLD.status IN ('published','superseded','expired') AND NOT (OLD.status='published' AND NEW.status='superseded'
      AND ((OLD.source_job_id IS NULL AND OLD.source_option_id IS NULL)
        OR current_setting('matchday.phase4_publish_schedule',true) IS NOT DISTINCT FROM 'on')) THEN
      RAISE EXCEPTION 'terminal schedule revisions are immutable';
    END IF;
    IF NEW.id<>OLD.id OR NEW.competition_id<>OLD.competition_id OR NEW.revision<>OLD.revision
       OR NEW.format_revision_id<>OLD.format_revision_id OR NEW.input_hash<>OLD.input_hash
       OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at
       OR NEW.parent_revision_id IS DISTINCT FROM OLD.parent_revision_id
       OR NEW.source_job_id IS DISTINCT FROM OLD.source_job_id OR NEW.source_option_id IS DISTINCT FROM OLD.source_option_id
       OR (NEW.assignment_hash IS DISTINCT FROM OLD.assignment_hash AND NOT (OLD.assignment_hash IS NULL
         AND current_setting('matchday.phase4_accept_schedule',true) IS NOT DISTINCT FROM 'on'))
       OR NEW.quality IS DISTINCT FROM OLD.quality
       OR (OLD.status IN ('published','superseded','expired') AND (NEW.warnings IS DISTINCT FROM OLD.warnings
         OR NEW.published_at IS DISTINCT FROM OLD.published_at OR NEW.expired_at IS DISTINCT FROM OLD.expired_at
         OR NEW.editable_until IS DISTINCT FROM OLD.editable_until)) THEN
      RAISE EXCEPTION 'schedule revision provenance is immutable';
    END IF;
    IF NEW.status='expired' THEN
      IF now()<OLD.editable_until OR NEW.expired_at IS NULL THEN
        RAISE EXCEPTION 'schedule revision cannot expire before its editable-until timestamp';
      END IF;
    ELSIF NEW.status='published' THEN
      IF (OLD.source_job_id IS NOT NULL OR OLD.source_option_id IS NOT NULL) AND (OLD.status<>'ready_for_review'
         OR current_setting('matchday.phase4_publish_schedule',true) IS DISTINCT FROM 'on'
         OR OLD.assignment_hash IS NULL OR OLD.assignment_hash<>phase4_schedule_assignment_hash(OLD.id)) THEN
        RAISE EXCEPTION 'Phase 4 schedule revisions may only be published by the server-owned publication routine';
      END IF;
      NEW.editable_until:=NULL;
    ELSIF NEW.status='superseded' THEN
      IF OLD.status<>'published' OR NOT ((OLD.source_job_id IS NULL AND OLD.source_option_id IS NULL)
        OR current_setting('matchday.phase4_publish_schedule',true) IS NOT DISTINCT FROM 'on') THEN
        RAISE EXCEPTION 'only the schedule publication routine may supersede a published revision';
      END IF;
      NEW.superseded_at:=now();
    ELSIF NEW.status='ready_for_review' THEN
      IF NEW.assignment_hash IS NULL OR NEW.assignment_hash<>phase4_schedule_assignment_hash(NEW.id) THEN
        RAISE EXCEPTION 'ready schedule revision requires a database-verified assignment hash';
      END IF;
    ELSIF NEW.updated_at>OLD.updated_at THEN
      NEW.editable_until:=phase4_schedule_expiry(NEW.updated_at);
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $drop_old_warning_unique$
DECLARE constraint_name text;
BEGIN
  SELECT conname INTO constraint_name
  FROM pg_constraint
  WHERE conrelid='schedule_revision_warnings'::regclass
    AND contype='u'
    AND conkey=ARRAY[
      (SELECT attnum FROM pg_attribute WHERE attrelid='schedule_revision_warnings'::regclass AND attname='schedule_revision_id'),
      (SELECT attnum FROM pg_attribute WHERE attrelid='schedule_revision_warnings'::regclass AND attname='warning_days'),
      (SELECT attnum FROM pg_attribute WHERE attrelid='schedule_revision_warnings'::regclass AND attname='notified_account_id')
    ]::smallint[];
  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE schedule_revision_warnings DROP CONSTRAINT %I',constraint_name);
  END IF;
END;
$drop_old_warning_unique$;
ALTER TABLE schedule_revision_warnings
  ADD CONSTRAINT schedule_revision_warnings_revision_warning_account_expiry_key
  UNIQUE(schedule_revision_id,warning_days,notified_account_id,expires_at);

UPDATE schedule_revisions revision
SET editable_until=phase4_schedule_expiry(revision.updated_at)
FROM competitions competition
WHERE competition.id=revision.competition_id
  AND competition.status<>'archived'
  AND revision.status IN ('draft','ready_for_review')
  AND revision.editable_until IS DISTINCT FROM phase4_schedule_expiry(revision.updated_at);

CREATE OR REPLACE FUNCTION phase4_emit_schedule_expiry_warning(target_revision uuid,days_remaining integer,
  target_account uuid,request_id_value text) RETURNS schedule_revision_warnings AS $$
DECLARE revision_row schedule_revisions%ROWTYPE; warning_row schedule_revision_warnings%ROWTYPE;
DECLARE target_org uuid; notification_value uuid:=gen_random_uuid(); warning_key text;
BEGIN
  IF days_remaining NOT IN (7,1) THEN RAISE EXCEPTION 'schedule warning must be seven or one day'; END IF;
  SELECT * INTO revision_row FROM schedule_revisions WHERE id=target_revision FOR UPDATE;
  IF revision_row.id IS NULL OR revision_row.status NOT IN ('draft','ready_for_review') OR revision_row.editable_until IS NULL
     OR current_date<>(revision_row.editable_until AT TIME ZONE 'UTC')::date-days_remaining THEN
    RAISE EXCEPTION 'schedule revision is not due for this expiry warning';
  END IF;
  SELECT organisation_id INTO target_org FROM competitions WHERE id=revision_row.competition_id;
  SELECT * INTO warning_row FROM schedule_revision_warnings WHERE schedule_revision_id=revision_row.id
    AND warning_days=days_remaining AND notified_account_id=target_account AND expires_at=revision_row.editable_until;
  IF warning_row.id IS NOT NULL THEN RETURN warning_row; END IF;
  warning_key:='phase4:schedule-expiry-warning:'||revision_row.id::text||':'||days_remaining||':'||target_account::text
    ||':'||extract(epoch FROM revision_row.editable_until)::bigint::text;
  INSERT INTO notifications(id,account_id,type,payload,idempotency_key)
  VALUES(notification_value,target_account,'schedule_draft_expiry',jsonb_build_object('competition_id',revision_row.competition_id,
    'schedule_revision_id',revision_row.id,'days_remaining',days_remaining,'expires_at',revision_row.editable_until),warning_key);
  INSERT INTO schedule_revision_warnings(schedule_revision_id,competition_id,warning_days,expires_at,notified_account_id,notification_id,idempotency_key)
  VALUES(revision_row.id,revision_row.competition_id,days_remaining,revision_row.editable_until,target_account,notification_value,warning_key)
  RETURNING * INTO warning_row;
  INSERT INTO audit_events(request_id,actor_type,organisation_id,action,target_type,target_id,metadata)
  VALUES(request_id_value,'system',target_org,'schedule.expiry_warning_emitted','schedule_revision',revision_row.id::text,
    jsonb_build_object('days_remaining',days_remaining,'account_id',target_account,'expires_at',revision_row.editable_until));
  INSERT INTO outbox_events(aggregate_type,aggregate_id,event_type,payload,idempotency_key)
  VALUES('schedule_revision',revision_row.id::text,'schedule.expiry_warning',jsonb_build_object('days_remaining',days_remaining,
    'account_id',target_account,'expires_at',revision_row.editable_until),warning_key);
  RETURN warning_row;
END;
$$ LANGUAGE plpgsql;
