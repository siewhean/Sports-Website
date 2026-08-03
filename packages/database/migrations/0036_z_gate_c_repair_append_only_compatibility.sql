-- Compatibility bridge for the already-recorded 0037 and 0040 migrations.
-- 0037 used the historical helper name below.  0040 must add the immutable
-- result-repair parent to rows created before that relationship existed, but
-- 0033 already made schedule_repair_cases append-only.  This migration sorts
-- after 0036 and before 0037/0040, so both clean and populated upgrades work
-- without rewriting either applied migration.

-- The exception is deliberately narrower than an update permission: it is
-- available only while backfilling an absent parent, and only if every other
-- persisted schedule-repair value is unchanged.  Once 0040 applies the NOT
-- NULL column constraint, no row can meet this transition again.
CREATE OR REPLACE FUNCTION phase3_prevent_append_only_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'schedule_repair_cases'
     AND to_jsonb(OLD)->'result_repair_case_id' = 'null'::jsonb
     AND to_jsonb(NEW)->'result_repair_case_id' IS NOT NULL
     AND to_jsonb(NEW)->'result_repair_case_id' <> 'null'::jsonb
     AND (to_jsonb(OLD) - 'result_repair_case_id')
       IS NOT DISTINCT FROM (to_jsonb(NEW) - 'result_repair_case_id') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION phase3_reject_append_only_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
