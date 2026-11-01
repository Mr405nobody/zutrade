-- B: product source scope, command identity and independent immutable PDF manifest.
ALTER TABLE app.source_documents ADD COLUMN product_id uuid;
ALTER TABLE app.source_documents ADD CONSTRAINT source_product_scope_fk FOREIGN KEY(workspace_id,factory_id,product_id) REFERENCES app.products(workspace_id,factory_id,id);
ALTER TABLE app.quote_versions ADD COLUMN command_id uuid;
ALTER TABLE app.quote_versions ADD COLUMN command_sha256 text CHECK(command_sha256 IS NULL OR command_sha256 ~ '^[0-9a-f]{64}$');
ALTER TABLE app.quote_versions ADD CONSTRAINT quote_command_pair CHECK((command_id IS NULL)=(command_sha256 IS NULL));
ALTER TABLE app.quote_versions ADD CONSTRAINT quote_command_unique UNIQUE(workspace_id,command_id);
CREATE TABLE app.quote_pdf_artifacts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL REFERENCES app.workspaces(id),factory_id uuid NOT NULL,quote_version_id uuid NOT NULL,
 snapshot_sha256 text NOT NULL CHECK(snapshot_sha256 ~ '^[0-9a-f]{64}$'),template_version text NOT NULL CHECK(length(template_version) BETWEEN 1 AND 100),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','ready','failed')),
 object_key text,object_version text,pdf_sha256 text CHECK(pdf_sha256 IS NULL OR pdf_sha256 ~ '^[0-9a-f]{64}$'),
 content_type text NOT NULL DEFAULT 'application/pdf' CHECK(content_type='application/pdf'),byte_length bigint,error_code text,
 created_by_member_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id),UNIQUE(workspace_id,quote_version_id,template_version),
 FOREIGN KEY(workspace_id,factory_id,quote_version_id) REFERENCES app.quote_versions(workspace_id,factory_id,id),
 FOREIGN KEY(workspace_id,created_by_member_id) REFERENCES app.workspace_members(workspace_id,id),
 CHECK((state='ready' AND object_key IS NOT NULL AND object_version IS NOT NULL AND pdf_sha256 IS NOT NULL AND byte_length>0 AND error_code IS NULL) OR (state<>'ready' AND object_key IS NULL AND object_version IS NULL AND pdf_sha256 IS NULL AND byte_length IS NULL)),
 CHECK(state<>'failed' OR error_code IS NOT NULL)
);
CREATE FUNCTION app.guard_pdf_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q record;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PDF manifests are persistent'; END IF;
 IF TG_OP='UPDATE' THEN
  IF OLD.state='ready' THEN RAISE EXCEPTION 'Ready PDF manifest is immutable'; END IF;
  IF (to_jsonb(OLD)-ARRAY['state','object_key','object_version','pdf_sha256','byte_length','error_code','updated_at']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['state','object_key','object_version','pdf_sha256','byte_length','error_code','updated_at']) THEN RAISE EXCEPTION 'PDF identity is immutable'; END IF;
  IF OLD.state='failed' AND NEW.state NOT IN ('pending','failed') THEN RAISE EXCEPTION 'Retry failed PDF before publication'; END IF;
 END IF;
 SELECT snapshot_sha256,frozen_at INTO q FROM app.quote_versions WHERE workspace_id=NEW.workspace_id AND factory_id=NEW.factory_id AND id=NEW.quote_version_id;
 IF q.frozen_at IS NULL OR q.snapshot_sha256 IS DISTINCT FROM NEW.snapshot_sha256 THEN RAISE EXCEPTION 'PDF requires exact frozen quote snapshot'; END IF;
 NEW.updated_at:=now(); RETURN NEW;
END $$;
CREATE TRIGGER pdf_artifact_guard BEFORE INSERT OR UPDATE OR DELETE ON app.quote_pdf_artifacts FOR EACH ROW EXECUTE FUNCTION app.guard_pdf_artifact();
ALTER TABLE app.quote_pdf_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.quote_pdf_artifacts FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_scope ON app.quote_pdf_artifacts FOR ALL USING(workspace_id=app.current_workspace_id()) WITH CHECK(workspace_id=app.current_workspace_id());
CREATE POLICY controlled_initialization ON app.quote_pdf_artifacts TO zutrade_migrator USING(true) WITH CHECK(true);
CREATE POLICY factory_authorization ON app.quote_pdf_artifacts AS RESTRICTIVE TO zutrade_api,zutrade_worker USING(EXISTS(SELECT 1 FROM app.factories f WHERE f.workspace_id=quote_pdf_artifacts.workspace_id AND f.id=quote_pdf_artifacts.factory_id)) WITH CHECK(EXISTS(SELECT 1 FROM app.factories f WHERE f.workspace_id=quote_pdf_artifacts.workspace_id AND f.id=quote_pdf_artifacts.factory_id));
-- All B supply/quote data additionally follows current factory authorization.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['products','source_documents','source_versions','facts','fact_versions','fact_evidence','price_rules','quotes','quote_versions','quote_lines','quote_evidence'] LOOP
  EXECUTE format('CREATE POLICY b_factory_authorization ON app.%I AS RESTRICTIVE TO zutrade_api,zutrade_worker USING(EXISTS(SELECT 1 FROM app.factories f WHERE f.workspace_id=%I.workspace_id AND f.id=%I.factory_id)) WITH CHECK(EXISTS(SELECT 1 FROM app.factories f WHERE f.workspace_id=%I.workspace_id AND f.id=%I.factory_id))',t,t,t,t,t);
 END LOOP;
END $$;
REVOKE ALL ON app.quote_pdf_artifacts FROM PUBLIC;
REVOKE ALL ON FUNCTION app.guard_pdf_artifact() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.guard_pdf_artifact() TO zutrade_api,zutrade_worker;
GRANT SELECT,INSERT,UPDATE ON app.products,app.source_documents,app.source_versions,app.facts,app.fact_versions,app.fact_evidence,app.price_rules,app.quotes,app.quote_versions,app.quote_lines,app.quote_evidence,app.quote_pdf_artifacts TO zutrade_api;
GRANT SELECT,INSERT,UPDATE ON app.quote_pdf_artifacts TO zutrade_worker;
GRANT SELECT ON app.products,app.source_documents,app.source_versions,app.facts,app.fact_versions,app.fact_evidence,app.price_rules,app.quotes,app.quote_versions,app.quote_lines,app.quote_evidence TO zutrade_worker;
