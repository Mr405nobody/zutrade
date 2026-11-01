-- A revoked actor cannot establish member RLS. This exact-job entry may only stop
-- that actor's research; it grants no read or result-write capability.
CREATE FUNCTION app.d1_stop_revoked_job(event_id uuid,job_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE x record;
BEGIN
 IF session_user<>'zutrade_worker' THEN RAISE EXCEPTION 'Worker only'; END IF;
 SELECT r.* INTO x FROM app.prospecting_runs r JOIN app.outbox_events e ON e.workspace_id=r.workspace_id AND e.id=r.outbox_event_id
 WHERE e.id=event_id AND e.pg_boss_job_id=job_id AND r.pg_boss_job_id=job_id AND e.handler_key='d1.research' AND e.event_type='d1.research-requested' AND e.aggregate_id=r.id AND e.payload->>'runId'=r.id::text AND e.payload->>'memberId'=r.initiated_by_member_id::text;
 IF x.id IS NULL THEN RAISE EXCEPTION 'Research job identity mismatch'; END IF;
 PERFORM app.c_lock_workspace(x.workspace_id);
 IF EXISTS(SELECT 1 FROM app.workspace_members m JOIN app.app_users u ON u.id=m.user_id JOIN app.workspaces w ON w.id=m.workspace_id JOIN app.factories f ON f.workspace_id=w.id AND f.id=x.factory_id
 WHERE m.id=x.initiated_by_member_id AND m.workspace_id=x.workspace_id AND m.status='active' AND u.status='active' AND w.status='active' AND f.status='active' AND (m.all_factories OR EXISTS(SELECT 1 FROM app.factory_memberships fm WHERE fm.workspace_id=m.workspace_id AND fm.member_id=m.id AND fm.factory_id=f.id))) THEN RETURN; END IF;
 UPDATE app.prospecting_runs SET state=CASE WHEN candidate_count>0 THEN 'partial' ELSE 'failed' END,finished_at=clock_timestamp(),error='ACTOR_NO_LONGER_AUTHORIZED' WHERE id=x.id AND state IN('queued','running');
 IF FOUND THEN
 INSERT INTO app.audit_events(workspace_id,actor_kind,action,aggregate_type,aggregate_id,details) VALUES(x.workspace_id,'system','d1.research-actor-revoked','prospecting_run',x.id,jsonb_build_object('jobId',job_id));
 END IF;
END $$;
REVOKE ALL ON FUNCTION app.d1_stop_revoked_job(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.d1_stop_revoked_job(uuid,uuid) TO zutrade_worker;
