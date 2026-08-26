-- Phase 6: organisation-wide purchased AI credits and race-safe finalisation.

CREATE TABLE ai_allowance_base_limits (
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  actor_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  action text NOT NULL,
  period_start date NOT NULL,
  base_limit integer NOT NULL CHECK (base_limit>=0),
  PRIMARY KEY (organisation_id,actor_account_id,action,period_start),
  FOREIGN KEY (organisation_id,actor_account_id,action,period_start)
    REFERENCES ai_usage_allowances(organisation_id,actor_account_id,action,period_start) ON DELETE CASCADE
);

INSERT INTO ai_allowance_base_limits(organisation_id,actor_account_id,action,period_start,base_limit)
SELECT organisation_id,actor_account_id,action,period_start,action_limit FROM ai_usage_allowances
ON CONFLICT DO NOTHING;

CREATE TABLE ai_credit_consumptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  grant_id uuid NOT NULL REFERENCES entitlement_grants(id) ON DELETE RESTRICT,
  ledger_id uuid NOT NULL UNIQUE REFERENCES ai_action_ledger(id) ON DELETE RESTRICT,
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity=1),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_credit_consumptions_org_created_idx ON ai_credit_consumptions(organisation_id,created_at);
CREATE INDEX ai_credit_consumptions_grant_idx ON ai_credit_consumptions(grant_id);

CREATE FUNCTION phase6_shared_ai_credits_remaining(target_organisation uuid) RETURNS integer AS $$
  SELECT COALESCE(sum(GREATEST(g.quantity-COALESCE((
    SELECT sum(c.quantity)::integer FROM ai_credit_consumptions c WHERE c.grant_id=g.id
  ),0),0)),0)::integer
  FROM entitlement_grants g
  WHERE g.organisation_id=target_organisation AND g.feature='ai_actions'
    AND g.source IN ('top_up','admin_grant') AND (g.expires_at IS NULL OR g.expires_at>now())
$$ LANGUAGE sql STABLE;

CREATE FUNCTION phase6_refresh_ai_allowance_headroom(target_organisation uuid) RETURNS void AS $$
DECLARE shared_remaining integer;
BEGIN
  shared_remaining:=phase6_shared_ai_credits_remaining(target_organisation);
  UPDATE ai_usage_allowances a
  SET action_limit=GREATEST(a.used_units,b.base_limit+shared_remaining),updated_at=now()
  FROM ai_allowance_base_limits b
  WHERE a.organisation_id=target_organisation
    AND b.organisation_id=a.organisation_id AND b.actor_account_id=a.actor_account_id
    AND b.action=a.action AND b.period_start=a.period_start;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION phase6_capture_ai_allowance_base() RETURNS trigger AS $$
BEGIN
  INSERT INTO ai_allowance_base_limits(organisation_id,actor_account_id,action,period_start,base_limit)
  VALUES(NEW.organisation_id,NEW.actor_account_id,NEW.action,NEW.period_start,NEW.action_limit)
  ON CONFLICT (organisation_id,actor_account_id,action,period_start) DO NOTHING;
  PERFORM phase6_refresh_ai_allowance_headroom(NEW.organisation_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ai_usage_allowances_phase6_base_capture
AFTER INSERT ON ai_usage_allowances FOR EACH ROW EXECUTE FUNCTION phase6_capture_ai_allowance_base();

CREATE FUNCTION phase6_seed_shared_ai_allowances() RETURNS trigger AS $$
BEGIN
  IF NEW.feature<>'ai_actions' OR NEW.source NOT IN ('top_up','admin_grant') THEN RETURN NEW; END IF;
  INSERT INTO ai_usage_allowances(organisation_id,actor_account_id,action,period_start,action_limit)
  SELECT NEW.organisation_id,m.account_id,action_value,current_date,0
  FROM organisation_memberships m
  CROSS JOIN unnest(ARRAY['text_to_brief','format_recommendations','format_modification','schedule_preferences','repair_recommendations']) action_value
  WHERE m.organisation_id=NEW.organisation_id AND m.status='active'
  ON CONFLICT DO NOTHING;
  PERFORM phase6_refresh_ai_allowance_headroom(NEW.organisation_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER entitlement_grants_phase6_ai_headroom
AFTER INSERT ON entitlement_grants FOR EACH ROW EXECUTE FUNCTION phase6_seed_shared_ai_allowances();

SELECT phase6_refresh_ai_allowance_headroom(organisation_id)
FROM (SELECT DISTINCT organisation_id FROM entitlement_grants WHERE feature='ai_actions') organisations;

CREATE OR REPLACE FUNCTION phase4_finalize_ai_action(target_ledger uuid, final_outcome text, final_cache_status text,
  result_value jsonb, result_expires_at timestamptz, attempt_count integer, elapsed_ms integer,
  failure_code_value text DEFAULT NULL,provider_request_id_value text DEFAULT NULL,metadata_value jsonb DEFAULT '{}'::jsonb)
  RETURNS ai_action_ledger AS $$
DECLARE ledger ai_action_ledger%ROWTYPE; allowance ai_usage_allowances%ROWTYPE; base_limit integer:=0; charge smallint:=0;
DECLARE cached ai_response_cache%ROWTYPE; shared_grant entitlement_grants%ROWTYPE;
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
    -- Serialise organisation-wide purchased-credit claims, then re-check the
    -- cache under that same lock before any shared credit can be consumed.
    PERFORM pg_advisory_xact_lock(hashtextextended('phase6-ai-credit:'||ledger.organisation_id::text,0));
    SELECT * INTO cached FROM ai_response_cache WHERE organisation_id=ledger.organisation_id AND action=ledger.action
      AND request_fingerprint=ledger.request_fingerprint AND schema_version=ledger.schema_version AND expires_at>now();
    IF cached.id IS NOT NULL THEN final_cache_status:='hit'; END IF;
  END IF;

  IF final_outcome='success' AND final_cache_status='miss' THEN
    SELECT * INTO allowance FROM ai_usage_allowances WHERE organisation_id=ledger.organisation_id
      AND actor_account_id=ledger.actor_account_id AND action=ledger.action AND period_start<=current_date
    ORDER BY period_start DESC LIMIT 1 FOR UPDATE;
    IF allowance.organisation_id IS NOT NULL THEN
      SELECT b.base_limit INTO base_limit FROM ai_allowance_base_limits b
      WHERE b.organisation_id=allowance.organisation_id AND b.actor_account_id=allowance.actor_account_id
        AND b.action=allowance.action AND b.period_start=allowance.period_start;
      base_limit:=COALESCE(base_limit,allowance.action_limit);
    END IF;

    IF allowance.organisation_id IS NOT NULL AND allowance.used_units<base_limit THEN
      UPDATE ai_usage_allowances SET used_units=used_units+1,revision=revision+1,updated_at=now()
      WHERE organisation_id=allowance.organisation_id AND actor_account_id=allowance.actor_account_id
        AND action=allowance.action AND period_start=allowance.period_start;
      charge:=1;
    ELSE
      SELECT g.* INTO shared_grant
      FROM entitlement_grants g
      WHERE g.organisation_id=ledger.organisation_id AND g.feature='ai_actions'
        AND g.source IN ('top_up','admin_grant') AND (g.expires_at IS NULL OR g.expires_at>now())
        AND COALESCE((SELECT sum(c.quantity) FROM ai_credit_consumptions c WHERE c.grant_id=g.id),0)<g.quantity
      ORDER BY g.created_at,g.id LIMIT 1 FOR UPDATE;
      IF shared_grant.id IS NULL THEN
        -- The last credit may disappear between provider start and finalise.
        -- Treat that race as normal quota exhaustion, never as a 500.
        final_outcome:='manual_fallback';
        final_cache_status:='not_checked';
        failure_code_value:='quota_exhausted';
        result_value:='{}'::jsonb;
      ELSE
        INSERT INTO ai_credit_consumptions(organisation_id,grant_id,ledger_id)
        VALUES(ledger.organisation_id,shared_grant.id,ledger.id);
        charge:=1;
        IF allowance.organisation_id IS NOT NULL THEN
          UPDATE ai_usage_allowances SET used_units=used_units+1,revision=revision+1,updated_at=now()
          WHERE organisation_id=allowance.organisation_id AND actor_account_id=allowance.actor_account_id
            AND action=allowance.action AND period_start=allowance.period_start;
        END IF;
        PERFORM phase6_refresh_ai_allowance_headroom(ledger.organisation_id);
      END IF;
    END IF;

    IF final_outcome='success' THEN
      PERFORM set_config('matchday.phase4_ai_finalize','on',true);
      INSERT INTO ai_response_cache(organisation_id,action,request_fingerprint,schema_version,result,result_hash,validated,created_from_ledger_id,expires_at)
      VALUES(ledger.organisation_id,ledger.action,ledger.request_fingerprint,ledger.schema_version,result_value,
        phase4_sha256_json(result_value),true,ledger.id,result_expires_at);
    END IF;
  END IF;

  PERFORM set_config('matchday.phase4_ai_finalize','on',true);
  UPDATE ai_action_ledger SET outcome=final_outcome,cache_status=final_cache_status,validated=(final_outcome='success'),
    charged_units=charge,attempts=attempt_count,duration_ms=elapsed_ms,failure_code=failure_code_value,
    provider_request_id=provider_request_id_value,
    metadata=jsonb_build_object('provider_mode',COALESCE(metadata_value->>'provider_mode','stub')),
    completed_at=now(),prompt_template_version=metadata_value->>'prompt_template_version',
    model_identifier=metadata_value->>'model_identifier',prompt_tokens=(metadata_value->>'prompt_tokens')::integer,
    completion_tokens=(metadata_value->>'completion_tokens')::integer,
    latency_ms=COALESCE((metadata_value->>'latency_ms')::integer,elapsed_ms),
    estimated_cost_usd=(metadata_value->>'estimated_cost_usd')::numeric
  WHERE id=ledger.id RETURNING * INTO ledger;
  PERFORM set_config('matchday.phase4_ai_finalize','off',true);

  INSERT INTO audit_events(request_id,actor_account_id,actor_type,organisation_id,action,target_type,target_id,metadata)
  VALUES(ledger.request_id,ledger.actor_account_id,'account',ledger.organisation_id,'ai.action.completed','ai_action',ledger.id::text,
    jsonb_build_object('action',ledger.action,'outcome',ledger.outcome,'cache_status',ledger.cache_status,
      'charged_units',ledger.charged_units,'failure_code',ledger.failure_code,
      'prompt_template_version',ledger.prompt_template_version,'model_identifier',ledger.model_identifier,
      'prompt_tokens',ledger.prompt_tokens,'completion_tokens',ledger.completion_tokens,
      'latency_ms',ledger.latency_ms,'estimated_cost_usd',ledger.estimated_cost_usd));
  INSERT INTO outbox_events(aggregate_type,aggregate_id,event_type,payload,idempotency_key)
  VALUES('ai_action',ledger.id::text,'ai.action.completed',
    jsonb_build_object('outcome',ledger.outcome,'charged_units',ledger.charged_units,'failure_code',ledger.failure_code),
    'phase4:ai-action:'||ledger.id::text)
  ON CONFLICT(idempotency_key) DO NOTHING;
  RETURN ledger;
END;
$$ LANGUAGE plpgsql;
