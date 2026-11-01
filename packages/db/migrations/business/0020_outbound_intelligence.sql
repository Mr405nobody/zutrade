-- Outbound MVP reuses immutable research snapshots, evidence, budgets and pg-boss.
ALTER TABLE app.prospecting_runs DROP CONSTRAINT prospecting_runs_provider_check;
ALTER TABLE app.prospecting_runs ADD CONSTRAINT prospecting_runs_provider_check CHECK(provider IN('public_directory','brave_search','outbound_manual','outbound_unavailable'));
CREATE TABLE app.outbound_companies (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
 factory_id uuid NOT NULL,
 domain text NOT NULL CHECK(length(domain) BETWEEN 3 AND 253 AND domain=lower(domain)),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 240),
 run_id uuid NOT NULL,
 candidate_key text NOT NULL CHECK(candidate_key ~ '^[a-f0-9]{64}$'),
 review_status text NOT NULL DEFAULT 'pending' CHECK(review_status IN('pending','approved','rejected','needs_info')),
 corrections jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(corrections)='object' AND octet_length(corrections::text)<=8192),
 review_notes text NOT NULL DEFAULT '' CHECK(length(review_notes)<=1000),
 reviewed_by uuid,
 reviewed_at timestamptz,
 revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id), UNIQUE(workspace_id,factory_id,domain),
 FOREIGN KEY(workspace_id,factory_id,run_id) REFERENCES app.prospecting_runs(workspace_id,factory_id,id),
 FOREIGN KEY(workspace_id,reviewed_by) REFERENCES app.workspace_members(workspace_id,id),
 CHECK((review_status='pending' AND reviewed_by IS NULL AND reviewed_at IS NULL AND revision=0) OR (review_status<>'pending' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND revision>0))
);
CREATE INDEX outbound_company_list_idx ON app.outbound_companies(workspace_id,factory_id,created_at DESC);
ALTER TABLE app.outbound_companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.outbound_companies FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_scope ON app.outbound_companies USING(workspace_id=app.current_workspace_id()) WITH CHECK(workspace_id=app.current_workspace_id());
CREATE POLICY controlled_initialization ON app.outbound_companies TO zutrade_migrator USING(true) WITH CHECK(true);
CREATE POLICY factory_authorization ON app.outbound_companies AS RESTRICTIVE TO zutrade_api,zutrade_worker
 USING(EXISTS(SELECT 1 FROM app.factories f WHERE f.workspace_id=outbound_companies.workspace_id AND f.id=outbound_companies.factory_id))
 WITH CHECK(EXISTS(SELECT 1 FROM app.factories f WHERE f.workspace_id=outbound_companies.workspace_id AND f.id=outbound_companies.factory_id));
CREATE FUNCTION app.outbound_company_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Outbound company history cannot be deleted'; END IF;
 IF TG_OP='INSERT' THEN
  IF NOT EXISTS(SELECT 1 FROM app.prospecting_runs r, jsonb_array_elements(r.results_snapshot->'candidates') c WHERE r.workspace_id=NEW.workspace_id AND r.factory_id=NEW.factory_id AND r.id=NEW.run_id AND r.finished_at IS NOT NULL AND r.provider='outbound_manual' AND c->>'key'=NEW.candidate_key AND c->>'domain'=NEW.domain AND c->>'name'=NEW.name) THEN RAISE EXCEPTION 'Outbound company requires frozen source candidate'; END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['review_status','corrections','review_notes','reviewed_by','reviewed_at','revision']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['review_status','corrections','review_notes','reviewed_by','reviewed_at','revision']) THEN RAISE EXCEPTION 'Outbound source identity immutable'; END IF;
  IF NEW.revision<>OLD.revision+1 OR NOT EXISTS(SELECT 1 FROM app.workspace_members m WHERE m.workspace_id=NEW.workspace_id AND m.id=NEW.reviewed_by AND m.user_id=app.current_user_id() AND m.status='active') THEN RAISE EXCEPTION 'Outbound review requires current member and revision'; END IF;
  NEW.reviewed_at:=clock_timestamp();
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER outbound_company_guard BEFORE INSERT OR UPDATE OR DELETE ON app.outbound_companies FOR EACH ROW EXECUTE FUNCTION app.outbound_company_guard();
REVOKE ALL ON app.outbound_companies FROM PUBLIC;
REVOKE ALL ON FUNCTION app.outbound_company_guard() FROM PUBLIC;
GRANT SELECT ON app.outbound_companies TO zutrade_api,zutrade_worker;
GRANT INSERT(workspace_id,factory_id,domain,name,run_id,candidate_key) ON app.outbound_companies TO zutrade_worker;
GRANT UPDATE(review_status,corrections,review_notes,reviewed_by,reviewed_at,revision) ON app.outbound_companies TO zutrade_api;
