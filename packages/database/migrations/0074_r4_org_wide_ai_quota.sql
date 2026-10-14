-- R4.4: one organisation-wide AI quota calculation.
--
-- phase6_org_ai_quota() is the single source of truth used by:
--   * the API pre-check before an AI action runs (phase-4-runtime.ts),
--   * the finalise charge below (replacing the 0059 per-actor gate), and
--   * the billing summary ai_quota display (entitlement-runtime.ts).
-- Per-actor ai_usage_allowances rows are kept as an audit ledger only; they
-- no longer decide whether an action may be charged.
--
-- Base limits mirror packages/domain/src/entitlements.ts TIER_FEATURE_LIMITS
-- and EntitlementRuntime.getSubscriptionTier: organiser_pro (active/trialing,
-- unexpired) = 100 per calendar month, everything else = free = 5.
-- Organisation-level event_pass subscriptions are rejected since 0061, so the
-- old 0059 event_pass=25 branch is intentionally dropped.
--
-- Merge order: main ends at 0071; #100 adds 0072, #103 adds 0073; this is 0074.

CREATE OR REPLACE FUNCTION phase6_org_ai_quota(target_organisation uuid)
  RETURNS TABLE(base_limit integer, base_used integer, credits_granted integer, credits_remaining integer, remaining integer)
AS $$
#variable_conflict use_column
BEGIN
  -- plpgsql (not LANGUAGE sql) so the body is resolved at call time via search_path,
  -- like the other phase4/phase6 functions; schema-scoped migration runs depend on it.
  RETURN QUERY
  WITH base AS (
    SELECT COALESCE((
      SELECT 100 FROM organisation_subscriptions s
      WHERE s.organisation_id=target_organisation AND s.tier='organiser_pro'
        AND s.status IN ('active','trialing')
        AND (s.current_period_end IS NULL OR s.current_period_end>now())
      LIMIT 1
    ),5)::integer AS base_limit,
    (SELECT count(*)::integer FROM ai_action_ledger l
      WHERE l.organisation_id=target_organisation AND l.outcome='success' AND l.charged_units>0
        AND l.created_at>=date_trunc('month',now())
        AND NOT EXISTS (SELECT 1 FROM ai_credit_consumptions c WHERE c.ledger_id=l.id)) AS base_used
  ), credits AS (
    SELECT COALESCE(sum(g.quantity),0)::integer AS granted,
           phase6_shared_ai_credits_remaining(target_organisation) AS remaining
    FROM entitlement_grants g
    WHERE g.organisation_id=target_organisation AND g.feature='ai_actions'
      AND g.source IN ('top_up','admin_grant') AND (g.expires_at IS NULL OR g.expires_at>now())
  )
  SELECT b.base_limit,b.base_used,c.granted,c.remaining,
    (GREATEST(b.base_limit-b.base_used,0)+c.remaining)::integer
  FROM base b CROSS JOIN credits c;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION phase4_finalize_ai_action(target_ledger uuid, final_outcome text, final_cache_status text,
  result_value jsonb, result_expires_at timestamptz, attempt_count integer, elapsed_ms integer,
  failure_code_value text DEFAULT NULL,provider_request_id_value text DEFAULT NULL,metadata_value jsonb DEFAULT '{}'::jsonb)
  RETURNS ai_action_ledger AS $$
DECLARE ledger ai_action_ledger%ROWTYPE; charge smallint:=0;
DECLARE cached ai_response_cache%ROWTYPE; shared_grant entitlement_grants%ROWTYPE;
DECLARE org_base_used integer:=0; org_base_limit integer:=5;
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
    -- R4.4: the organisation-wide quota is the only decision-maker. Per-actor
    -- ai_usage_allowances rows are bumped afterwards purely as an audit trail.
    SELECT q.base_limit,q.base_used INTO org_base_limit,org_base_used
    FROM phase6_org_ai_quota(ledger.organisation_id) q;

    IF org_base_used<org_base_limit THEN
      charge:=1;
    ELSE
      SELECT g.* INTO shared_grant
      FROM entitlement_grants g
      WHERE g.organisation_id=ledger.organisation_id AND g.feature='ai_actions'
        AND g.source IN ('top_up','admin_grant') AND (g.expires_at IS NULL OR g.expires_at>now())
        AND COALESCE((SELECT sum(c.quantity) FROM ai_credit_consumptions c WHERE c.grant_id=g.id),0)<g.quantity
      ORDER BY g.created_at,g.id LIMIT 1 FOR UPDATE;
      IF shared_grant.id IS NULL THEN
        -- The last unit may disappear between pre-check and finalise.
        -- Treat that race as normal quota exhaustion, never as a 500.
        final_outcome:='manual_fallback';
        final_cache_status:='not_checked';
        failure_code_value:='quota_exhausted';
        result_value:='{}'::jsonb;
      ELSE
        INSERT INTO ai_credit_consumptions(organisation_id,grant_id,ledger_id)
        VALUES(ledger.organisation_id,shared_grant.id,ledger.id);
        charge:=1;
      END IF;
    END IF;

    IF charge=1 THEN
      -- Audit only: bump the actor's current allowance row (or open one for this month).
      UPDATE ai_usage_allowances a SET used_units=a.used_units+1,
        action_limit=GREATEST(a.action_limit,a.used_units+1),revision=a.revision+1,updated_at=now()
      WHERE (a.organisation_id,a.actor_account_id,a.action,a.period_start)=(
        SELECT x.organisation_id,x.actor_account_id,x.action,x.period_start FROM ai_usage_allowances x
        WHERE x.organisation_id=ledger.organisation_id AND x.actor_account_id=ledger.actor_account_id
          AND x.action=ledger.action AND x.period_start<=current_date
          AND x.period_start>=date_trunc('month',current_date)::date
        ORDER BY x.period_start DESC LIMIT 1);
      IF NOT FOUND THEN
        INSERT INTO ai_usage_allowances(organisation_id,actor_account_id,action,period_start,action_limit,used_units)
        VALUES(ledger.organisation_id,ledger.actor_account_id,ledger.action,date_trunc('month',current_date)::date,1,1)
        ON CONFLICT (organisation_id,actor_account_id,action,period_start) DO UPDATE SET
          used_units=ai_usage_allowances.used_units+1,
          action_limit=GREATEST(ai_usage_allowances.action_limit,ai_usage_allowances.used_units+1),
          revision=ai_usage_allowances.revision+1,updated_at=now();
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
