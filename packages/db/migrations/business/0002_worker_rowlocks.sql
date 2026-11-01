-- PostgreSQL requires UPDATE on at least one column for SELECT ... FOR SHARE.
-- The worker may lock these records to serialize revocation but cannot mutate them.
GRANT UPDATE (id) ON app.workspace_members,app.factories TO zutrade_worker;
CREATE TRIGGER worker_member_read_only BEFORE UPDATE ON app.workspace_members FOR EACH ROW
  WHEN (current_user = 'zutrade_worker') EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER worker_factory_read_only BEFORE UPDATE ON app.factories FOR EACH ROW
  WHEN (current_user = 'zutrade_worker') EXECUTE FUNCTION app.reject_mutation();
