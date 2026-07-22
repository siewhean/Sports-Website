ALTER TABLE schedule_generation_jobs
  ADD COLUMN progress_iteration integer CHECK (progress_iteration IS NULL OR progress_iteration>=0),
  ADD COLUMN explored_candidates integer NOT NULL DEFAULT 0 CHECK (explored_candidates>=0),
  ADD COLUMN progress_updated_at timestamptz;

CREATE FUNCTION phase4_record_schedule_job_progress(
  target_job uuid,
  worker text,
  fence uuid,
  iteration_value integer,
  explored_candidates_value integer
) RETURNS schedule_generation_jobs AS $$
DECLARE target schedule_generation_jobs%ROWTYPE;
BEGIN
  IF iteration_value<0 OR explored_candidates_value<1 THEN
    RAISE EXCEPTION 'invalid schedule progress';
  END IF;
  SELECT * INTO target FROM schedule_generation_jobs WHERE id=target_job FOR UPDATE;
  IF target.id IS NULL OR target.worker_id<>worker OR target.fence_token<>fence
     OR target.lease_expires_at<=now() OR target.status NOT IN ('running','valid_best_found') THEN
    RAISE EXCEPTION 'schedule progress lost its worker fence';
  END IF;
  IF target.progress_iteration IS NOT NULL AND iteration_value<=target.progress_iteration THEN
    RAISE EXCEPTION 'schedule progress iteration must increase';
  END IF;
  IF explored_candidates_value<=target.explored_candidates THEN
    RAISE EXCEPTION 'schedule explored candidates must increase';
  END IF;
  UPDATE schedule_generation_jobs
  SET progress_iteration=iteration_value,
      explored_candidates=explored_candidates_value,
      progress_updated_at=now(),
      updated_at=now()
  WHERE id=target_job
  RETURNING * INTO target;
  RETURN target;
END;
$$ LANGUAGE plpgsql;
