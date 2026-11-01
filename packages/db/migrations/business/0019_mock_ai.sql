-- E: append to the existing AI run ledger. No live model or business approval grant.
ALTER TABLE app.ai_runs
 ADD COLUMN command_id uuid,
 ADD COLUMN created_by_member_id uuid,
 ADD COLUMN scenario_id text,
 ADD COLUMN scenario_version text,
 ADD COLUMN business_clock timestamptz,
 ADD COLUMN duration_ms integer CHECK(duration_ms>=0),
 ADD COLUMN auto_faq boolean NOT NULL DEFAULT false,
 ADD COLUMN decision text CHECK(decision IN('adopt','modify','reject')),
 ADD COLUMN decision_text text CHECK(length(decision_text)<=4000),
 ADD COLUMN decision_result jsonb,
 ADD FOREIGN KEY(workspace_id,created_by_member_id) REFERENCES app.workspace_members(workspace_id,id),
 ADD UNIQUE(workspace_id,command_id),
 ADD CONSTRAINT e_mock_metrics CHECK(provider<>'zutrade-mock' OR (execution_mode='preset' AND input_tokens IS NULL AND output_tokens IS NULL));
CREATE POLICY e_ai_scope ON app.ai_runs AS RESTRICTIVE TO zutrade_api,zutrade_worker
 USING(thread_id IS NOT NULL AND app.can_read_thread(workspace_id,thread_id) AND EXISTS(SELECT 1 FROM app.factories f WHERE f.workspace_id=ai_runs.workspace_id AND f.id=ai_runs.factory_id))
 WITH CHECK(thread_id IS NOT NULL AND app.can_read_thread(workspace_id,thread_id) AND EXISTS(SELECT 1 FROM app.factories f WHERE f.workspace_id=ai_runs.workspace_id AND f.id=ai_runs.factory_id));
GRANT SELECT,INSERT ON app.ai_runs TO zutrade_api;
GRANT SELECT ON app.ai_runs TO zutrade_worker;
GRANT UPDATE(state,completed_at,error_detail,validation_result) ON app.ai_runs TO zutrade_api;
GRANT UPDATE(state,scenario_id,proposed_action,explanation_summary,validation_result,duration_ms,completed_at,error_detail) ON app.ai_runs TO zutrade_worker;
GRANT UPDATE(decision,decision_text,decision_result) ON app.ai_runs TO zutrade_api;
-- Adoption reuses normal domain draft/requirements/followup commands in the worker completion path only for FAQ.
GRANT INSERT ON app.outbound_requests,app.outbound_payload_versions,app.outbox_events TO zutrade_worker;
GRANT UPDATE(current_payload_version_id) ON app.outbound_requests TO zutrade_worker;
GRANT UPDATE(pg_boss_job_id,enqueued_at) ON app.outbox_events TO zutrade_worker;
CREATE FUNCTION app.e_guard_ai_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AI history retained'; END IF;
 IF (to_jsonb(NEW)-ARRAY['state','completed_at','error_detail','validation_result','scenario_id','proposed_action','explanation_summary','duration_ms','decision','decision_text','decision_result']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['state','completed_at','error_detail','validation_result','scenario_id','proposed_action','explanation_summary','duration_ms','decision','decision_text','decision_result']) THEN RAISE EXCEPTION 'AI input identity immutable'; END IF;
 IF OLD.state<>'running' AND (to_jsonb(NEW)-ARRAY['decision','decision_text','decision_result']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['decision','decision_text','decision_result']) THEN RAISE EXCEPTION 'AI result immutable'; END IF;
 IF OLD.decision IS NOT NULL AND (NEW.decision,NEW.decision_text,NEW.decision_result) IS DISTINCT FROM (OLD.decision,OLD.decision_text,OLD.decision_result) THEN RAISE EXCEPTION 'AI decision immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER e_ai_history BEFORE UPDATE OR DELETE ON app.ai_runs FOR EACH ROW EXECUTE FUNCTION app.e_guard_ai_run();
-- Exact persistent job entry; returns metadata only, never facts or message bodies.
CREATE FUNCTION app.e_ai_job(eid uuid,jid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE e record; r record; m record;
BEGIN
 IF session_user<>'zutrade_worker' THEN RAISE EXCEPTION 'Worker only'; END IF;
 SELECT * INTO e FROM app.outbox_events WHERE id=eid AND pg_boss_job_id=jid AND handler_key='e.ai' AND event_type='e.ai-requested' AND aggregate_id::text=payload->>'runId';
 IF e.id IS NULL THEN RAISE EXCEPTION 'AI job mismatch'; END IF;
 PERFORM app.c_lock_workspace(e.workspace_id);
 SELECT * INTO r FROM app.ai_runs WHERE workspace_id=e.workspace_id AND id=e.aggregate_id AND created_by_member_id::text=e.payload->>'memberId';
 IF r.id IS NULL THEN RAISE EXCEPTION 'AI actor mismatch'; END IF;
 SELECT mm.*,u.auth_subject,u.status AS user_status,w.status AS workspace_status INTO m FROM app.workspace_members mm JOIN app.app_users u ON u.id=mm.user_id JOIN app.workspaces w ON w.id=mm.workspace_id WHERE mm.workspace_id=r.workspace_id AND mm.id=r.created_by_member_id;
 PERFORM set_config('app.user_id',m.user_id::text,true); PERFORM set_config('app.workspace_id',r.workspace_id::text,true);
 IF m.status<>'active' OR m.user_status<>'active' OR m.workspace_status<>'active' OR NOT app.can_read_thread(r.workspace_id,r.thread_id) OR NOT EXISTS(SELECT 1 FROM app.factories f WHERE f.workspace_id=r.workspace_id AND f.id=r.factory_id AND f.status='active' AND (m.all_factories OR EXISTS(SELECT 1 FROM app.factory_memberships fm WHERE fm.workspace_id=m.workspace_id AND fm.member_id=m.id AND fm.factory_id=f.id))) THEN
 UPDATE app.ai_runs SET state='failed',completed_at=clock_timestamp(),error_detail='ACTOR_NO_LONGER_AUTHORIZED',validation_result='{"valid":false,"reason":"ACTOR_NO_LONGER_AUTHORIZED"}' WHERE id=r.id AND state='running';
 RETURN NULL;
 END IF;
 RETURN jsonb_build_object('runId',r.id,'workspaceId',r.workspace_id,'subject',m.auth_subject,'memberId',m.id);
END $$;
REVOKE ALL ON FUNCTION app.e_guard_ai_run(),app.e_ai_job(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.e_ai_job(uuid,uuid) TO zutrade_worker;
