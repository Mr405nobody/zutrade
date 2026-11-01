ALTER TABLE app.outbound_requests ADD COLUMN provider_capabilities jsonb;
ALTER TABLE app.outbound_requests ADD COLUMN provider_guarantee_until timestamptz;
CREATE FUNCTION app.c_guard_provider() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.dispatch_claimed_at IS NOT NULL AND (NEW.provider_capabilities IS DISTINCT FROM OLD.provider_capabilities OR NEW.provider_guarantee_until IS DISTINCT FROM OLD.provider_guarantee_until) THEN
  RAISE EXCEPTION 'Provider guarantee is fixed at first claim';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER c_provider_identity BEFORE UPDATE ON app.outbound_requests FOR EACH ROW EXECUTE FUNCTION app.c_guard_provider();
ALTER TABLE simulation.acceptances ADD COLUMN dispatch_token uuid NOT NULL;
ALTER TABLE simulation.calls ADD COLUMN dispatch_token uuid NOT NULL;
GRANT EXECUTE ON FUNCTION app.a2_has_inbound_barrier(uuid,uuid) TO zutrade_api;
CREATE FUNCTION app.c_fence_delivery(rid uuid,expected_token uuid,reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE r record; replacement uuid:=gen_random_uuid();
BEGIN
 IF session_user<>'zutrade_worker' THEN RAISE EXCEPTION 'Worker only'; END IF;
 SELECT * INTO r FROM app.outbound_requests WHERE id=rid AND dispatch_token=expected_token AND transport_mode='simulation' AND dispatch_claimed_at IS NOT NULL;
 IF r.id IS NULL THEN RAISE EXCEPTION 'Execution identity mismatch'; END IF;
 PERFORM app.c_lock_workspace(r.workspace_id);
 UPDATE app.outbound_requests SET dispatch_token=replacement,state='unknown',stop_reason=left(reason,200)
 WHERE id=rid AND dispatch_token=expected_token AND state IN('claimed','dispatching','unknown');
 IF NOT FOUND THEN RETURN expected_token; END IF;
 UPDATE app.delivery_attempts SET state='unknown',error_class='ambiguous_outcome',error_detail=left(reason,200) WHERE workspace_id=r.workspace_id AND outbound_request_id=rid AND state IN('prepared','started');
 INSERT INTO app.audit_events(workspace_id,actor_kind,action,aggregate_type,aggregate_id,details)
 VALUES(r.workspace_id,'system','c.execution-fenced','outbound_request',rid,jsonb_build_object('previousToken',expected_token,'currentToken',replacement,'reason',left(reason,200)));
 RETURN replacement;
END $$;
REVOKE ALL ON FUNCTION app.c_fence_delivery(uuid,uuid,text),app.c_guard_provider() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.c_fence_delivery(uuid,uuid,text) TO zutrade_worker;
