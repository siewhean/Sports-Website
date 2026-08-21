CREATE FUNCTION gate_c_assign_result_repair_parent() RETURNS trigger AS $$
BEGIN
  IF NEW.result_repair_case_id IS NULL THEN
    SELECT id INTO STRICT NEW.result_repair_case_id
    FROM result_repair_cases
    WHERE correction_transaction_id=NEW.correction_transaction_id
      AND competition_id=NEW.competition_id
    FOR KEY SHARE;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER schedule_repair_cases_assign_result_case
BEFORE INSERT ON schedule_repair_cases
FOR EACH ROW EXECUTE FUNCTION gate_c_assign_result_repair_parent();
