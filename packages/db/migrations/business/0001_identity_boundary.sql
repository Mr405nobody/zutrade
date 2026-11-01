-- RLS bootstrap is SELECT-only and flows subject -> user -> own membership -> workspace.
DROP POLICY user_read_scope ON app.app_users;
DROP POLICY user_insert_scope ON app.app_users;
DROP POLICY user_update_scope ON app.app_users;
CREATE POLICY verified_subject_read ON app.app_users FOR SELECT USING (
  auth_subject = NULLIF(current_setting('app.auth_subject', true), '') OR
  EXISTS (SELECT 1 FROM app.workspace_members m WHERE m.workspace_id = app.current_workspace_id() AND m.user_id = app.app_users.id)
);
CREATE POLICY verified_subject_insert ON app.app_users FOR INSERT WITH CHECK (
  auth_subject = NULLIF(current_setting('app.auth_subject', true), '') AND status = 'active'
);
CREATE POLICY self_profile_update ON app.app_users FOR UPDATE
  USING (id = app.current_user_id() AND auth_subject = NULLIF(current_setting('app.auth_subject', true), ''))
  WITH CHECK (id = app.current_user_id() AND auth_subject = NULLIF(current_setting('app.auth_subject', true), ''));
CREATE POLICY own_active_membership ON app.workspace_members FOR SELECT USING (
  user_id = app.current_user_id() AND status = 'active'
);
CREATE POLICY own_active_workspace ON app.workspaces FOR SELECT USING (
  status = 'active' AND EXISTS (SELECT 1 FROM app.workspace_members m WHERE m.workspace_id = workspaces.id AND m.user_id = app.current_user_id() AND m.status = 'active')
);
-- The migration identity alone may perform explicit initialization under FORCE RLS.
DO $$ DECLARE t text; BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'app' LOOP
    EXECUTE format('CREATE POLICY controlled_initialization ON app.%I TO zutrade_migrator USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
ALTER TABLE app.workspace_members ADD CONSTRAINT a1_enabled_roles CHECK (role IN ('owner','sales'));
CREATE TRIGGER user_identity_immutable BEFORE UPDATE ON app.app_users FOR EACH ROW
  EXECUTE FUNCTION app.guard_identity_fields('id','auth_subject');
-- Factory row access is also enforced in PostgreSQL for the A1 endpoints.
CREATE POLICY factory_authorization ON app.factories AS RESTRICTIVE TO zutrade_api, zutrade_worker
  USING (EXISTS (SELECT 1 FROM app.workspace_members m WHERE m.workspace_id = factories.workspace_id AND m.user_id = app.current_user_id() AND m.status = 'active' AND
    (m.all_factories OR EXISTS (SELECT 1 FROM app.factory_memberships fm WHERE fm.workspace_id = m.workspace_id AND fm.member_id = m.id AND fm.factory_id = factories.id))))
  WITH CHECK (EXISTS (SELECT 1 FROM app.workspace_members m WHERE m.workspace_id = factories.workspace_id AND m.user_id = app.current_user_id() AND m.status = 'active' AND
    (m.all_factories OR EXISTS (SELECT 1 FROM app.factory_memberships fm WHERE fm.workspace_id = m.workspace_id AND fm.member_id = m.id AND fm.factory_id = factories.id))));
REVOKE ALL ON SCHEMA app FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO zutrade_api, zutrade_worker;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO zutrade_api, zutrade_worker;
GRANT SELECT ON app.app_users, app.workspace_members, app.workspaces, app.factories, app.factory_memberships, app.outbox_events, app.audit_events TO zutrade_api, zutrade_worker;
GRANT INSERT (auth_subject, display_name) ON app.app_users TO zutrade_api;
GRANT UPDATE (display_name) ON app.app_users TO zutrade_api;
GRANT UPDATE (name) ON app.factories TO zutrade_api;
GRANT UPDATE (role, status, all_factories) ON app.workspace_members TO zutrade_api;
GRANT INSERT, DELETE ON app.factory_memberships TO zutrade_api;
GRANT UPDATE (approver_member_id) ON app.workspaces TO zutrade_api;
GRANT INSERT ON app.outbox_events, app.audit_events TO zutrade_api;
GRANT INSERT ON app.audit_events TO zutrade_worker;
GRANT UPDATE (pg_boss_job_id, enqueued_at) ON app.outbox_events TO zutrade_api;
