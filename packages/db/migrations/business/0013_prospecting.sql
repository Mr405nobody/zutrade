-- D1: a single new app table. Existing B/C tables and all applied migrations remain.
CREATE TABLE app.prospecting_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
 factory_id uuid NOT NULL,
 initiated_by_member_id uuid NOT NULL,
 provider text NOT NULL CHECK(provider IN('public_directory','brave_search')),
 data_origin text NOT NULL DEFAULT 'live_network' CHECK(data_origin IN('live_network','offline_fixture')),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN('queued','running','completed','partial','failed','cancelled')),
 idempotency_key uuid NOT NULL,
 request jsonb NOT NULL CHECK(jsonb_typeof(request)='object' AND octet_length(request::text)<=8192),
 request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
 execution_version integer NOT NULL DEFAULT 0 CHECK(execution_version>=0),
 execution_token uuid,
 provider_version text,
 job_retry_count integer NOT NULL DEFAULT -1,
 result_version integer NOT NULL DEFAULT 1 CHECK(result_version>0),
 results_snapshot jsonb NOT NULL DEFAULT '{"candidates":[],"errors":[],"truncationReason":null}' CHECK(jsonb_typeof(results_snapshot)='object' AND jsonb_typeof(results_snapshot->'candidates')='array' AND jsonb_array_length(results_snapshot->'candidates')<=50 AND octet_length(results_snapshot::text)<=524288),
 review_decisions jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(review_decisions)='object' AND octet_length(review_decisions::text)<=65536),
 review_revision bigint NOT NULL DEFAULT 0 CHECK(review_revision>=0),
 checkpoint jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(checkpoint)='object' AND octet_length(checkpoint::text)<=1048576),
 candidate_count integer NOT NULL DEFAULT 0 CHECK(candidate_count BETWEEN 0 AND 50),
 request_count integer NOT NULL DEFAULT 0 CHECK(request_count BETWEEN 0 AND 80),
 first_started_at timestamptz,
 deadline timestamptz,
 finished_at timestamptz,
 error text CHECK(length(error)<=240),
 outbox_event_id uuid,
 pg_boss_job_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 row_version bigint NOT NULL DEFAULT 1,
 UNIQUE(workspace_id,id), UNIQUE(workspace_id,factory_id,id),
 UNIQUE(workspace_id,idempotency_key),
 FOREIGN KEY(workspace_id,factory_id) REFERENCES app.factories(workspace_id,id),
 FOREIGN KEY(workspace_id,initiated_by_member_id) REFERENCES app.workspace_members(workspace_id,id),
 FOREIGN KEY(workspace_id,outbox_event_id) REFERENCES app.outbox_events(workspace_id,id),
 CHECK((first_started_at IS NULL AND deadline IS NULL) OR (first_started_at IS NOT NULL AND deadline=first_started_at+interval '180 seconds')),
 CHECK((state IN('completed','partial','failed','cancelled'))=(finished_at IS NOT NULL))
);
CREATE INDEX prospecting_factory_time_idx ON app.prospecting_runs(workspace_id,factory_id,created_at DESC);
CREATE INDEX prospecting_pending_idx ON app.prospecting_runs(state,deadline) WHERE state IN('queued','running');
ALTER TABLE app.prospecting_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.prospecting_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_scope ON app.prospecting_runs USING(workspace_id=app.current_workspace_id()) WITH CHECK(workspace_id=app.current_workspace_id());
CREATE POLICY controlled_initialization ON app.prospecting_runs TO zutrade_migrator USING(true) WITH CHECK(true);
CREATE POLICY factory_authorization ON app.prospecting_runs AS RESTRICTIVE TO zutrade_api,zutrade_worker
 USING(EXISTS(SELECT 1 FROM app.factories f WHERE f.workspace_id=prospecting_runs.workspace_id AND f.id=prospecting_runs.factory_id))
 WITH CHECK(EXISTS(SELECT 1 FROM app.factories f WHERE f.workspace_id=prospecting_runs.workspace_id AND f.id=prospecting_runs.factory_id));
CREATE FUNCTION app.d1_guard_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Research history cannot be deleted'; END IF;
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-ARRAY['state','data_origin','execution_version','execution_token','provider_version','job_retry_count','results_snapshot','review_decisions','review_revision','checkpoint','candidate_count','request_count','first_started_at','deadline','finished_at','error','outbox_event_id','pg_boss_job_id','updated_at','row_version']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['state','data_origin','execution_version','execution_token','provider_version','job_retry_count','results_snapshot','review_decisions','review_revision','checkpoint','candidate_count','request_count','first_started_at','deadline','finished_at','error','outbox_event_id','pg_boss_job_id','updated_at','row_version']) THEN RAISE EXCEPTION 'Research identity immutable'; END IF;
  IF OLD.outbox_event_id IS NOT NULL AND (NEW.outbox_event_id IS DISTINCT FROM OLD.outbox_event_id OR NEW.pg_boss_job_id IS DISTINCT FROM OLD.pg_boss_job_id) THEN RAISE EXCEPTION 'Research queue identity immutable'; END IF;
  IF OLD.first_started_at IS NOT NULL AND (NEW.first_started_at IS DISTINCT FROM OLD.first_started_at OR NEW.deadline IS DISTINCT FROM OLD.deadline OR NEW.data_origin<>OLD.data_origin OR NEW.provider_version<>OLD.provider_version) THEN RAISE EXCEPTION 'Original research budget immutable'; END IF;
  IF NEW.request_count<OLD.request_count OR NEW.request_count>OLD.request_count+1 THEN RAISE EXCEPTION 'Atomic request budget only'; END IF;
  IF OLD.finished_at IS NOT NULL AND (to_jsonb(NEW)-ARRAY['review_decisions','review_revision','updated_at','row_version']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['review_decisions','review_revision','updated_at','row_version']) THEN RAISE EXCEPTION 'Terminal research snapshot frozen'; END IF;
  IF NEW.results_snapshot IS DISTINCT FROM OLD.results_snapshot OR NEW.checkpoint IS DISTINCT FROM OLD.checkpoint OR NEW.request_count<>OLD.request_count THEN
   IF OLD.state<>'running' OR OLD.deadline<=clock_timestamp() OR OLD.execution_token::text IS DISTINCT FROM nullif(current_setting('app.d1_token',true),'') THEN RAISE EXCEPTION 'Research execution fenced or expired'; END IF;
  END IF;
  IF NEW.review_decisions IS DISTINCT FROM OLD.review_decisions THEN
   IF OLD.finished_at IS NULL OR NEW.review_revision<>OLD.review_revision+1 THEN RAISE EXCEPTION 'Review requires frozen results and CAS revision'; END IF;
  ELSIF NEW.review_revision<>OLD.review_revision THEN RAISE EXCEPTION 'Review revision without decision'; END IF;
  NEW.row_version:=OLD.row_version+1;
 END IF;
 NEW.updated_at:=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER d1_run_guard BEFORE INSERT OR UPDATE OR DELETE ON app.prospecting_runs FOR EACH ROW EXECUTE FUNCTION app.d1_guard_run();
REVOKE ALL ON app.prospecting_runs FROM PUBLIC;
REVOKE ALL ON FUNCTION app.d1_guard_run() FROM PUBLIC;
GRANT SELECT ON app.prospecting_runs TO zutrade_api,zutrade_worker;
GRANT INSERT(workspace_id,factory_id,initiated_by_member_id,provider,idempotency_key,request,request_sha256) ON app.prospecting_runs TO zutrade_api;
GRANT UPDATE(state,finished_at,error,review_decisions,review_revision,outbox_event_id,pg_boss_job_id) ON app.prospecting_runs TO zutrade_api;
GRANT UPDATE(state,data_origin,execution_version,execution_token,provider_version,job_retry_count,results_snapshot,checkpoint,candidate_count,request_count,first_started_at,deadline,finished_at,error) ON app.prospecting_runs TO zutrade_worker;
ALTER TABLE app.leads ADD COLUMN prospecting_run_id uuid, ADD COLUMN prospecting_candidate_key text;
ALTER TABLE app.leads ADD CONSTRAINT d1_lead_candidate_pair CHECK((prospecting_run_id IS NULL)=(prospecting_candidate_key IS NULL));
ALTER TABLE app.leads ADD CONSTRAINT d1_lead_candidate_key CHECK(prospecting_candidate_key IS NULL OR prospecting_candidate_key ~ '^[a-f0-9]{64}$');
ALTER TABLE app.leads ADD CONSTRAINT d1_lead_run_factory_fk FOREIGN KEY(workspace_id,factory_id,prospecting_run_id) REFERENCES app.prospecting_runs(workspace_id,factory_id,id);
ALTER TABLE app.leads ADD CONSTRAINT d1_lead_candidate_unique UNIQUE(workspace_id,prospecting_run_id,prospecting_candidate_key);
CREATE INDEX d1_lead_run_idx ON app.leads(workspace_id,factory_id,prospecting_run_id);
CREATE POLICY d1_lead_factory ON app.leads AS RESTRICTIVE TO zutrade_api,zutrade_worker USING(EXISTS(SELECT 1 FROM app.factories f WHERE f.workspace_id=leads.workspace_id AND f.id=leads.factory_id)) WITH CHECK(EXISTS(SELECT 1 FROM app.factories f WHERE f.workspace_id=leads.workspace_id AND f.id=leads.factory_id));
GRANT SELECT ON app.leads TO zutrade_api,zutrade_worker;
GRANT INSERT ON app.leads TO zutrade_api;
GRANT INSERT(name,domain_name,country_code,workspace_id) ON app.buyers TO zutrade_api;
-- D1 creates company-only leads. Public mail addresses stay evidence, not verified contacts.
CREATE TRIGGER d1_lead_source_identity BEFORE UPDATE ON app.leads FOR EACH ROW EXECUTE FUNCTION app.guard_identity_fields('prospecting_run_id','prospecting_candidate_key','research_snapshot','research_observed_at');
