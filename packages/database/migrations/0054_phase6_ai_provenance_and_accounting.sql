-- Phase 6: AI-016 / AI-017 Provenance and Cost Accounting & AI Action Extension

ALTER TABLE ai_action_ledger
  ADD COLUMN IF NOT EXISTS prompt_template_version text,
  ADD COLUMN IF NOT EXISTS model_identifier text,
  ADD COLUMN IF NOT EXISTS prompt_tokens integer CHECK (prompt_tokens IS NULL OR prompt_tokens >= 0),
  ADD COLUMN IF NOT EXISTS completion_tokens integer CHECK (completion_tokens IS NULL OR completion_tokens >= 0),
  ADD COLUMN IF NOT EXISTS latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  ADD COLUMN IF NOT EXISTS estimated_cost_usd numeric(10, 6) CHECK (estimated_cost_usd IS NULL OR estimated_cost_usd >= 0);

ALTER TABLE ai_usage_allowances
  DROP CONSTRAINT IF EXISTS ai_usage_allowances_action_check;
ALTER TABLE ai_usage_allowances
  ADD CONSTRAINT ai_usage_allowances_action_check
  CHECK (action IN ('text_to_brief', 'format_recommendations', 'format_modification', 'schedule_preferences', 'repair_recommendations'));

ALTER TABLE ai_action_ledger
  DROP CONSTRAINT IF EXISTS ai_action_ledger_action_check;
ALTER TABLE ai_action_ledger
  ADD CONSTRAINT ai_action_ledger_action_check
  CHECK (action IN ('text_to_brief', 'format_recommendations', 'format_modification', 'schedule_preferences', 'repair_recommendations'));

ALTER TABLE ai_response_cache
  DROP CONSTRAINT IF EXISTS ai_response_cache_action_check;
ALTER TABLE ai_response_cache
  ADD CONSTRAINT ai_response_cache_action_check
  CHECK (action IN ('text_to_brief', 'format_recommendations', 'format_modification', 'schedule_preferences', 'repair_recommendations'));

CREATE OR REPLACE FUNCTION phase4_ai_result_valid(action_value text,result_value jsonb) RETURNS boolean AS $$
DECLARE allowed_missing text[]:=ARRAY['sport','entry_count','division_count','divisions','location','dates.start','dates.end',
  'playing_areas','daily_availability','time_slot_minutes','minimum_matches_per_entry','knockout_required','rank_all_entries',
  'placement_required','cross_group_qualification_allowed','organiser_priority'];
BEGIN
  IF jsonb_typeof(result_value)<>'object' THEN RETURN false; END IF;
  IF action_value='text_to_brief' THEN
    IF (SELECT count(*)<>18 OR NOT bool_and(key=ANY(ARRAY['schema_version','name','sport','entry_count','division_count','divisions',
      'location','dates','playing_areas','daily_availability','time_slot_minutes','minimum_matches_per_entry','knockout_required',
      'rank_all_entries','placement_required','cross_group_qualification_allowed','organiser_priority','missing_fields']))
      FROM jsonb_object_keys(result_value) key) OR result_value->>'schema_version'<>'1.0'
      OR (result_value->'sport'<>'null'::jsonb AND result_value->>'sport' NOT IN ('canoe_polo','badminton','table_tennis','volleyball','basketball'))
      OR (result_value->'entry_count'<>'null'::jsonb AND (NOT phase3_json_positive_integer(result_value->'entry_count') OR (result_value->>'entry_count')::integer>48))
      OR (result_value->'division_count'<>'null'::jsonb AND NOT phase3_json_positive_integer(result_value->'division_count'))
      OR jsonb_typeof(result_value->'dates')<>'object' OR jsonb_typeof(result_value->'missing_fields')<>'array'
      OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(result_value->'missing_fields') item WHERE NOT item=ANY(allowed_missing))
      OR (SELECT count(*)<>count(DISTINCT item) FROM jsonb_array_elements_text(result_value->'missing_fields') item)
      OR (result_value->'organiser_priority'<>'null'::jsonb AND result_value->>'organiser_priority' NOT IN ('speed','simplicity','participation')) THEN RETURN false; END IF;
    RETURN true;
  ELSIF action_value='format_recommendations' THEN
    RETURN (SELECT count(*)=10 AND bool_and(key=ANY(ARRAY['sport','entryCount','divisionCount','availableMatchSlots',
      'minimumMatchesPerEntry','rankAllEntries','knockoutRequired','placementRequired','crossGroupQualificationAllowed','organiserPriority']))
      FROM jsonb_object_keys(result_value) key)
      AND result_value->>'sport' IN ('canoe_polo','badminton','table_tennis','volleyball','basketball')
      AND phase3_json_positive_integer(result_value->'entryCount') AND (result_value->>'entryCount')::integer BETWEEN 2 AND 48
      AND phase3_json_positive_integer(result_value->'divisionCount') AND (result_value->>'divisionCount')::integer BETWEEN 1 AND 16
      AND (result_value->>'divisionCount')::integer<=(result_value->>'entryCount')::integer
      AND jsonb_typeof(result_value->'availableMatchSlots')='number' AND (result_value->>'availableMatchSlots')::numeric>=0
      AND phase3_json_positive_integer(result_value->'minimumMatchesPerEntry')
      AND (result_value->>'minimumMatchesPerEntry')::integer<(result_value->>'entryCount')::integer
      AND jsonb_typeof(result_value->'rankAllEntries')='boolean' AND jsonb_typeof(result_value->'knockoutRequired')='boolean'
      AND jsonb_typeof(result_value->'placementRequired')='boolean' AND jsonb_typeof(result_value->'crossGroupQualificationAllowed')='boolean'
      AND result_value->>'organiserPriority' IN ('speed','simplicity','participation');
  ELSIF action_value='format_modification' THEN
    RETURN (result_value ? 'proposedDocument') AND jsonb_typeof(result_value->'proposedDocument') = 'object';
  ELSIF action_value='schedule_preferences' THEN
    RETURN (result_value ? 'proposedPreferences') AND jsonb_typeof(result_value->'proposedPreferences') = 'object';
  ELSIF action_value='repair_recommendations' THEN
    RETURN (result_value ? 'recommendedActions') AND jsonb_typeof(result_value->'recommendedActions') = 'array';
  END IF;
  RETURN false;
EXCEPTION WHEN others THEN RETURN false;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION phase4_finalize_ai_action(target_ledger uuid, final_outcome text, final_cache_status text,
  result_value jsonb, result_expires_at timestamptz, attempt_count integer, elapsed_ms integer,
  failure_code_value text DEFAULT NULL,provider_request_id_value text DEFAULT NULL,metadata_value jsonb DEFAULT '{}'::jsonb)
  RETURNS ai_action_ledger AS $$
DECLARE ledger ai_action_ledger%ROWTYPE; allowance ai_usage_allowances%ROWTYPE; charge smallint:=0;
DECLARE cached ai_response_cache%ROWTYPE;
BEGIN
  SELECT * INTO ledger FROM ai_action_ledger WHERE id=target_ledger FOR UPDATE;
  IF ledger.id IS NULL THEN RAISE EXCEPTION 'AI action does not exist'; END IF;
  IF ledger.outcome<>'pending' THEN RETURN ledger; END IF;
  IF final_outcome NOT IN ('success','failed','manual_fallback') OR final_cache_status NOT IN ('hit','miss','not_checked') THEN
    RAISE EXCEPTION 'invalid AI final outcome';
  END IF;
  IF final_outcome='success' AND NOT phase4_ai_result_valid(ledger.action,result_value) THEN
    RAISE EXCEPTION 'successful AI action requires validated structured result';
  END IF;
  IF final_outcome='success' AND final_cache_status='miss' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws(':',ledger.organisation_id,ledger.action,ledger.request_fingerprint,ledger.schema_version),0));
    SELECT * INTO cached FROM ai_response_cache WHERE organisation_id=ledger.organisation_id AND action=ledger.action
      AND request_fingerprint=ledger.request_fingerprint AND schema_version=ledger.schema_version AND expires_at>now();
    IF cached.id IS NOT NULL THEN final_cache_status:='hit'; END IF;
  END IF;
  IF final_outcome='success' AND final_cache_status='miss' THEN
    SELECT * INTO allowance FROM ai_usage_allowances WHERE organisation_id=ledger.organisation_id
      AND actor_account_id=ledger.actor_account_id AND action=ledger.action AND period_start<=current_date
    ORDER BY period_start DESC LIMIT 1 FOR UPDATE;
    IF allowance.organisation_id IS NULL OR allowance.used_units>=allowance.action_limit THEN RAISE EXCEPTION 'AI action quota exhausted'; END IF;
    charge:=1;
    UPDATE ai_usage_allowances SET used_units=used_units+1,revision=revision+1,updated_at=now()
    WHERE organisation_id=allowance.organisation_id AND actor_account_id=allowance.actor_account_id
      AND action=allowance.action AND period_start=allowance.period_start;
    PERFORM set_config('matchday.phase4_ai_finalize','on',true);
    INSERT INTO ai_response_cache(organisation_id,action,request_fingerprint,schema_version,result,result_hash,validated,created_from_ledger_id,expires_at)
    VALUES(ledger.organisation_id,ledger.action,ledger.request_fingerprint,ledger.schema_version,result_value,
      phase4_sha256_json(result_value),true,ledger.id,result_expires_at)
    ;
  END IF;
  PERFORM set_config('matchday.phase4_ai_finalize','on',true);
  UPDATE ai_action_ledger SET outcome=final_outcome,cache_status=final_cache_status,validated=(final_outcome='success'),
    charged_units=charge,attempts=attempt_count,duration_ms=elapsed_ms,failure_code=failure_code_value,
    provider_request_id=provider_request_id_value,
    metadata=jsonb_build_object('provider_mode', COALESCE(metadata_value->>'provider_mode', 'stub')),
    completed_at=now(),
    prompt_template_version=metadata_value->>'prompt_template_version',
    model_identifier=metadata_value->>'model_identifier',
    prompt_tokens=(metadata_value->>'prompt_tokens')::integer,
    completion_tokens=(metadata_value->>'completion_tokens')::integer,
    latency_ms=COALESCE((metadata_value->>'latency_ms')::integer, elapsed_ms),
    estimated_cost_usd=(metadata_value->>'estimated_cost_usd')::numeric
  WHERE id=ledger.id RETURNING * INTO ledger;
  INSERT INTO audit_events(request_id,actor_account_id,actor_type,organisation_id,action,target_type,target_id,metadata)
  VALUES(ledger.request_id,ledger.actor_account_id,'account',ledger.organisation_id,'ai.action.completed','ai_action',ledger.id::text,
    jsonb_build_object(
      'action',ledger.action,
      'outcome',ledger.outcome,
      'cache_status',ledger.cache_status,
      'charged_units',ledger.charged_units,
      'prompt_template_version',ledger.prompt_template_version,
      'model_identifier',ledger.model_identifier,
      'prompt_tokens',ledger.prompt_tokens,
      'completion_tokens',ledger.completion_tokens,
      'latency_ms',ledger.latency_ms,
      'estimated_cost_usd',ledger.estimated_cost_usd
    ));
  INSERT INTO outbox_events(aggregate_type,aggregate_id,event_type,payload,idempotency_key)
  VALUES('ai_action',ledger.id::text,'ai.action.completed',jsonb_build_object('outcome',ledger.outcome,'charged_units',ledger.charged_units),
    'phase4:ai-action:'||ledger.id::text);
  RETURN ledger;
END;
$$ LANGUAGE plpgsql;
