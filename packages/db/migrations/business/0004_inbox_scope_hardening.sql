-- Scope keys from other providers may be non-UUID strings; never cast them.
ALTER POLICY a2_point_system_read ON app.contact_points
 USING (app.current_user_id() IS NOT NULL OR (namespace='zutrade-simulation' AND EXISTS (
   SELECT 1 FROM app.channel_accounts a WHERE a.workspace_id=contact_points.workspace_id
   AND a.id::text=contact_points.scope_key AND app.a2_system_account(a.workspace_id,a.id))));
CREATE POLICY a2_account_system_read ON app.channel_accounts AS RESTRICTIVE FOR SELECT TO zutrade_api,zutrade_worker
 USING (app.current_user_id() IS NOT NULL OR app.a2_system_account(workspace_id,id) OR EXISTS (
   SELECT 1 FROM app.outbound_requests r WHERE r.workspace_id=channel_accounts.workspace_id AND r.channel_account_id=channel_accounts.id
   AND app.a2_delivery_result(r.workspace_id,r.id,r.thread_id)));
CREATE POLICY a2_permission_system_read ON app.contact_permissions AS RESTRICTIVE FOR SELECT TO zutrade_api,zutrade_worker
 USING (app.current_user_id() IS NOT NULL OR EXISTS (SELECT 1 FROM app.contact_points cp WHERE cp.workspace_id=contact_permissions.workspace_id AND cp.id=contact_permissions.contact_point_id));
CREATE POLICY a2_outbox_system_read ON app.outbox_events AS RESTRICTIVE FOR SELECT TO zutrade_api,zutrade_worker
 USING (app.current_user_id() IS NOT NULL OR (handler_key='a2.inbound' AND aggregate_id=NULLIF(current_setting('app.inbound_event_id',true),'')::uuid AND app.a2_system_workspace(workspace_id)));
CREATE POLICY a2_audit_system_read ON app.audit_events AS RESTRICTIVE FOR SELECT TO zutrade_api,zutrade_worker
 USING (app.current_user_id() IS NOT NULL OR EXISTS (SELECT 1 FROM app.outbox_events x WHERE x.workspace_id=audit_events.workspace_id AND x.id=audit_events.correlation_id AND x.handler_key='a2.inbound'));
-- Intake has no need to read organization members or unrelated user profiles.
-- Normal verified-subject identity discovery is preserved before user_id is set.
CREATE POLICY a2_user_system_read ON app.app_users AS RESTRICTIVE FOR SELECT TO zutrade_api,zutrade_worker
 USING (app.current_user_id() IS NOT NULL OR auth_subject=NULLIF(current_setting('app.auth_subject',true),''));
CREATE POLICY a2_member_system_read ON app.workspace_members AS RESTRICTIVE FOR SELECT TO zutrade_api,zutrade_worker
 USING (app.current_user_id() IS NOT NULL);
CREATE POLICY a2_workspace_system_read ON app.workspaces AS RESTRICTIVE FOR SELECT TO zutrade_api,zutrade_worker
 USING (app.current_user_id() IS NOT NULL);
-- The frozen-target validation trigger uses FOR SHARE on the payload row.
-- Column-level lock permission does not allow changing frozen payload content.
GRANT UPDATE (id) ON app.outbound_payload_versions TO zutrade_worker;

-- Revoked members cannot claim; record an exact persisted job as blocked without
-- minting a member context or allowing this path to revoke a committed claim.
CREATE FUNCTION app.block_delivery_job(event_id uuid,job_id uuid,reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE target record; changed uuid; safe_reason text;
BEGIN
 IF session_user<>'zutrade_worker' THEN RAISE EXCEPTION 'Only delivery worker may block queued jobs'; END IF;
 SELECT r.workspace_id,r.id,r.thread_id INTO target
 FROM app.outbox_events x JOIN app.outbound_requests r ON r.workspace_id=x.workspace_id AND r.id=x.aggregate_id
 JOIN app.channel_accounts a ON a.workspace_id=r.workspace_id AND a.id=r.channel_account_id
 WHERE x.id=event_id AND x.pg_boss_job_id=job_id AND x.handler_key='a2.delivery' AND x.event_type='a2.reply-created'
 AND x.aggregate_type='outbound_request' AND x.payload->>'requestId'=r.id::text
 AND r.transport_mode='simulation' AND a.provider='zutrade-mock' AND a.channel_kind='simulation' AND a.transport_mode='simulation'
 FOR UPDATE OF r;
 IF target.id IS NULL THEN RAISE EXCEPTION 'Delivery event/job/account identity mismatch'; END IF;
 safe_reason:=left(COALESCE(NULLIF(reason,''),'发送前权限或成员资格已失效'),200);
 UPDATE app.outbound_requests SET state='blocked',stop_reason=safe_reason
 WHERE workspace_id=target.workspace_id AND id=target.id AND state IN ('ready','queued') RETURNING id INTO changed;
 IF changed IS NOT NULL THEN
   INSERT INTO app.audit_events(workspace_id,actor_kind,action,aggregate_type,aggregate_id,correlation_id,details)
   VALUES(target.workspace_id,'system','a2.delivery-blocked','outbound_request',target.id,event_id,
     jsonb_build_object('jobId',job_id,'reason',safe_reason,'simulation',true));
 END IF;
END $$;
REVOKE ALL ON FUNCTION app.block_delivery_job(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.block_delivery_job(uuid,uuid,text) TO zutrade_worker;
