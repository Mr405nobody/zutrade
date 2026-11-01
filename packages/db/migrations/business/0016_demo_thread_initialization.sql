-- A thread has no persisted association during INSERT. Permit only a designated
-- owner to initialize a lead-bound internal simulation identity; never waive
-- the complete-thread authorization check for other rows or members.
CREATE FUNCTION app.d2_demo_thread_allowed(ws uuid,tid uuid,point_id uuid,account_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT ws=app.current_workspace_id() AND session_user='zutrade_api' AND NOT EXISTS(SELECT 1 FROM app.opportunity_threads ot WHERE ot.workspace_id=ws AND ot.thread_id=tid) AND EXISTS(
 SELECT 1 FROM app.workspaces w JOIN app.workspace_members m ON m.workspace_id=w.id AND m.id=w.approver_member_id
 JOIN app.app_users u ON u.id=m.user_id
 JOIN app.contact_points p ON p.workspace_id=w.id AND p.id=point_id
 JOIN app.leads l ON l.workspace_id=p.workspace_id AND l.id=p.lead_id
 JOIN app.factories f ON f.workspace_id=l.workspace_id AND f.id=l.factory_id
 JOIN app.channel_accounts a ON a.workspace_id=p.workspace_id AND a.id=account_id
 WHERE w.id=ws AND w.status='active' AND m.user_id=app.current_user_id() AND m.role='owner' AND m.status='active' AND u.status='active'
 AND p.namespace='zutrade-simulation' AND p.scope_key=a.id::text AND p.source_evidence->>'origin'='internal_demo'
 AND a.channel_kind='simulation' AND a.transport_mode='simulation' AND a.provider='zutrade-mock' AND a.state='active'
 AND l.source_kind='research' AND l.research_snapshot->>'identityConfirmedBy' IS NOT NULL AND f.status='active'
 AND (m.all_factories OR EXISTS(SELECT 1 FROM app.factory_memberships fm WHERE fm.workspace_id=ws AND fm.member_id=m.id AND fm.factory_id=f.id)))
$$;
REVOKE ALL ON FUNCTION app.d2_demo_thread_allowed(uuid,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.d2_demo_thread_allowed(uuid,uuid,uuid,uuid) TO zutrade_api,zutrade_worker;
DROP POLICY a2_thread_access ON app.threads;
CREATE POLICY a2_thread_access ON app.threads AS RESTRICTIVE TO zutrade_api,zutrade_worker
 USING(app.can_read_thread(workspace_id,id) OR app.a2_system_account(workspace_id,channel_account_id) OR app.a2_result_thread(workspace_id,id) OR app.d2_demo_thread_allowed(workspace_id,id,primary_contact_point_id,channel_account_id))
 WITH CHECK(app.can_read_thread(workspace_id,id) OR app.a2_system_account(workspace_id,channel_account_id) OR app.a2_result_thread(workspace_id,id) OR app.d2_demo_thread_allowed(workspace_id,id,primary_contact_point_id,channel_account_id));
