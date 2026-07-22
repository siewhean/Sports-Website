-- A format template is reusable only inside the organisation and sport that
-- produced it. Keep this invariant in PostgreSQL so direct API, worker, or
-- support-tool writes cannot attach a graph from another sport.

CREATE FUNCTION phase4_guard_format_template_application() RETURNS trigger AS $$
DECLARE
  target_sport text;
  target_organisation uuid;
  template_sport text;
  template_organisation uuid;
  template_status text;
BEGIN
  IF NEW.template_version_id IS NULL THEN
    IF NEW.source_kind='template' THEN
      RAISE EXCEPTION 'template format revision requires a template version';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.source_kind<>'template' THEN
    RAISE EXCEPTION 'template version may only be used by a template format revision';
  END IF;

  SELECT c.sport_code,c.organisation_id
    INTO target_sport,target_organisation
    FROM competitions c
    WHERE c.id=NEW.competition_id;

  SELECT t.sport_code,t.organisation_id,t.status
    INTO template_sport,template_organisation,template_status
    FROM format_template_versions v
    JOIN format_templates t ON t.id=v.template_id
    WHERE v.id=NEW.template_version_id;

  IF target_sport IS NULL OR template_sport IS NULL THEN
    RAISE EXCEPTION 'template application requires an existing competition and template version';
  END IF;
  IF template_organisation<>target_organisation THEN
    RAISE EXCEPTION 'template application must remain in the same organisation';
  END IF;
  IF template_sport<>target_sport THEN
    RAISE EXCEPTION 'template application sport must match the competition sport';
  END IF;
  IF template_status<>'active' THEN
    RAISE EXCEPTION 'archived format templates cannot be applied';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER format_revisions_phase4_template_sport_guard
BEFORE INSERT OR UPDATE OF template_version_id,source_kind,competition_id
ON format_revisions
FOR EACH ROW EXECUTE FUNCTION phase4_guard_format_template_application();
