-- Result recording may outlive member permissions. Only the precise current
-- C result token can extend account/batch pacing; it cannot authorize a send.
CREATE FUNCTION app.d2_settle_pacing(rid uuid,token uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE r record;
BEGIN
 IF session_user<>'zutrade_worker' OR NULLIF(current_setting('app.delivery_result_request_id',true),'')::uuid IS DISTINCT FROM rid OR NULLIF(current_setting('app.delivery_result_token',true),'')::uuid IS DISTINCT FROM token THEN RAISE EXCEPTION 'Exact result context required'; END IF;
 SELECT q.* INTO r FROM app.outbound_requests q JOIN app.outbound_payload_versions p ON p.workspace_id=q.workspace_id AND p.id=q.dispatch_payload_version_id
 WHERE q.id=rid AND q.dispatch_token=token AND q.transport_mode='simulation' AND p.channel_payload ? 'd2';
 IF r.id IS NULL THEN RAISE EXCEPTION 'D2 result identity mismatch'; END IF;
 PERFORM app.c_lock_workspace(r.workspace_id);
 UPDATE app.channel_accounts SET next_claim_at=GREATEST(COALESCE(next_claim_at,clock_timestamp()),clock_timestamp()+min_interval_ms*interval '1 millisecond') WHERE workspace_id=r.workspace_id AND id=r.channel_account_id;
 UPDATE app.outreach_batches b SET next_claim_at=GREATEST(COALESCE(b.next_claim_at,clock_timestamp()),clock_timestamp()+(v.send_rules->>'intervalMs')::integer*interval '1 millisecond')
 FROM app.outreach_batch_versions v JOIN app.outreach_batch_items i ON i.workspace_id=v.workspace_id AND i.batch_version_id=v.id
 WHERE b.workspace_id=v.workspace_id AND b.id=v.batch_id AND i.outbound_request_id=rid AND b.workspace_id=r.workspace_id;
END $$;
REVOKE ALL ON FUNCTION app.d2_settle_pacing(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.d2_settle_pacing(uuid,uuid) TO zutrade_worker;
