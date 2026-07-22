-- Gate B: quota exhaustion is an accounting outcome, not an unknown provider
-- failure. Persist it distinctly so idempotent replays remain truthful.

ALTER TABLE ai_action_ledger DROP CONSTRAINT ai_action_ledger_failure_code_check;
ALTER TABLE ai_action_ledger ADD CONSTRAINT ai_action_ledger_failure_code_check
  CHECK (failure_code IS NULL OR failure_code IN (
    'aborted',
    'invalid_input',
    'invalid_response',
    'provider_authentication',
    'provider_rate_limited',
    'provider_unavailable',
    'quota_exhausted',
    'timeout',
    'unknown'
  ));
