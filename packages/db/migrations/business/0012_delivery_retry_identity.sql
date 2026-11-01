-- Infrastructure retry is not a fresh business claim. Read the persisted pg-boss attempt.
CREATE OR REPLACE FUNCTION app.c_delivery_job(event_id uuid,job_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE x record;
BEGIN
 IF session_user<>'zutrade_worker' THEN RAISE EXCEPTION 'Worker only'; END IF;
 SELECT e.*,r.dispatch_token,r.dispatch_payload_version_id,r.state AS request_state,r.dispatch_claimed_at INTO x
 FROM app.outbox_events e JOIN app.outbound_requests r ON r.workspace_id=e.workspace_id AND r.id=e.aggregate_id
 WHERE e.id=event_id AND e.pg_boss_job_id=job_id AND e.handler_key='a2.delivery'
 AND e.event_type IN('a2.reply-created','c.delivery-ready','c.reconcile')
 AND e.payload->>'requestId'=r.id::text AND r.transport_mode='simulation';
 IF x.id IS NULL THEN RAISE EXCEPTION 'Delivery job identity mismatch'; END IF;
 PERFORM app.c_lock_workspace(x.workspace_id);
 -- READ COMMITTED re-read after obtaining the lock.
 SELECT e.*,r.dispatch_token,r.dispatch_payload_version_id,r.state AS request_state,r.dispatch_claimed_at INTO x
 FROM app.outbox_events e JOIN app.outbound_requests r ON r.workspace_id=e.workspace_id AND r.id=e.aggregate_id WHERE e.id=event_id;
 RETURN to_jsonb(x)||jsonb_build_object('retry_count',COALESCE((SELECT retry_count FROM pgboss.job WHERE id=job_id AND name='a2.delivery'),0));
END $$;
REVOKE ALL ON FUNCTION app.c_delivery_job(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.c_delivery_job(uuid,uuid) TO zutrade_worker;

