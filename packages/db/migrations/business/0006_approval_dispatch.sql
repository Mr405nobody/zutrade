-- C: exact-content approvals and independent persistent simulation infrastructure.
CREATE TABLE app.command_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
 command_id uuid NOT NULL,
 member_id uuid NOT NULL,
 command_kind text NOT NULL,
 command_sha256 text NOT NULL CHECK(command_sha256 ~ '^[0-9a-f]{64}$'),
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,command_id),
 FOREIGN KEY(workspace_id,member_id) REFERENCES app.workspace_members(workspace_id,id)
);
ALTER TABLE app.command_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.command_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.command_receipts USING(workspace_id=app.current_workspace_id()) WITH CHECK(workspace_id=app.current_workspace_id());
CREATE POLICY controlled_initialization ON app.command_receipts TO zutrade_migrator USING(true) WITH CHECK(true);
CREATE TRIGGER command_receipts_append_only BEFORE UPDATE OR DELETE ON app.command_receipts FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
GRANT SELECT,INSERT ON app.command_receipts TO zutrade_api,zutrade_worker;
GRANT SELECT,INSERT,UPDATE ON app.approvals TO zutrade_api,zutrade_worker;
GRANT SELECT,INSERT ON app.approval_events,app.payload_evidence TO zutrade_api,zutrade_worker;
GRANT UPDATE ON app.outbound_payload_versions TO zutrade_api;
GRANT UPDATE(id) ON app.outbound_payload_versions TO zutrade_worker;
GRANT INSERT ON app.outbox_events TO zutrade_worker;
GRANT UPDATE(pg_boss_job_id,enqueued_at) ON app.outbox_events TO zutrade_worker;

CREATE POLICY c_approval_access ON app.approvals AS RESTRICTIVE TO zutrade_api,zutrade_worker
 USING(EXISTS(SELECT 1 FROM app.outbound_requests r WHERE r.workspace_id=approvals.workspace_id AND r.id=approvals.outbound_request_id))
 WITH CHECK(EXISTS(SELECT 1 FROM app.outbound_requests r WHERE r.workspace_id=approvals.workspace_id AND r.id=approvals.outbound_request_id));
CREATE POLICY c_approval_event_access ON app.approval_events AS RESTRICTIVE TO zutrade_api,zutrade_worker
 USING(EXISTS(SELECT 1 FROM app.approvals a WHERE a.workspace_id=approval_events.workspace_id AND a.id=approval_events.approval_id))
 WITH CHECK(EXISTS(SELECT 1 FROM app.approvals a WHERE a.workspace_id=approval_events.workspace_id AND a.id=approval_events.approval_id));
CREATE POLICY c_payload_evidence_access ON app.payload_evidence AS RESTRICTIVE TO zutrade_api,zutrade_worker
 USING(EXISTS(SELECT 1 FROM app.outbound_payload_versions p WHERE p.workspace_id=payload_evidence.workspace_id AND p.id=payload_evidence.payload_version_id))
 WITH CHECK(EXISTS(SELECT 1 FROM app.outbound_payload_versions p WHERE p.workspace_id=payload_evidence.workspace_id AND p.id=payload_evidence.payload_version_id));

-- No producer can replace the version/provider identity once a call may be in flight.
CREATE FUNCTION app.c_guard_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.dispatch_claimed_at IS NOT NULL OR EXISTS(SELECT 1 FROM app.delivery_attempts a WHERE a.workspace_id=OLD.workspace_id AND a.outbound_request_id=OLD.id) THEN
  IF NEW.current_payload_version_id IS DISTINCT FROM OLD.current_payload_version_id OR NEW.dispatch_payload_version_id IS DISTINCT FROM OLD.dispatch_payload_version_id THEN
   RAISE EXCEPTION 'Claimed request content cannot be replaced';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER c_dispatch_content BEFORE UPDATE ON app.outbound_requests FOR EACH ROW EXECUTE FUNCTION app.c_guard_dispatch();
CREATE TRIGGER c_attempt_identity BEFORE UPDATE ON app.delivery_attempts FOR EACH ROW EXECUTE FUNCTION app.guard_identity_fields('id','workspace_id','outbound_request_id','payload_version_id','attempt_no','dispatch_token','created_at');

CREATE SCHEMA simulation;
CREATE TABLE simulation.acceptances (
 id uuid PRIMARY KEY,
 account_id uuid NOT NULL,
 request_id uuid NOT NULL,
 provider_key text NOT NULL,
 payload_sha256 text NOT NULL,
 idempotent boolean NOT NULL,
 guarantee_until timestamptz NOT NULL,
 content jsonb NOT NULL,
 attachment_digests jsonb NOT NULL,
 accepted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX simulation_provider_key ON simulation.acceptances(account_id,provider_key) WHERE idempotent;
CREATE TABLE simulation.calls (
 id uuid PRIMARY KEY,
 account_id uuid NOT NULL,
 request_id uuid NOT NULL,
 provider_key text NOT NULL,
 payload_sha256 text NOT NULL,
 idempotent boolean NOT NULL,
 scenario text NOT NULL,
 outcome text NOT NULL,
 acceptance_id uuid REFERENCES simulation.acceptances(id),
 called_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE simulation.callbacks (
 id uuid PRIMARY KEY,
 acceptance_id uuid NOT NULL REFERENCES simulation.acceptances(id),
 kind text NOT NULL CHECK(kind IN('accepted','delayed','rejected')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON SCHEMA simulation FROM PUBLIC,zutrade_api,zutrade_worker;
GRANT USAGE ON SCHEMA simulation TO zutrade_simulation;
GRANT SELECT,INSERT ON ALL TABLES IN SCHEMA simulation TO zutrade_simulation;
CREATE TRIGGER simulation_acceptance_append BEFORE UPDATE OR DELETE ON simulation.acceptances FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER simulation_calls_append BEFORE UPDATE OR DELETE ON simulation.calls FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER simulation_callbacks_append BEFORE UPDATE OR DELETE ON simulation.callbacks FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- The sole workspace lock is always acquired before account/thread/request/approval/product.
CREATE FUNCTION app.c_lock_workspace(ws uuid) RETURNS void LANGUAGE sql AS $$
 SELECT pg_advisory_xact_lock(hashtextextended('c-workspace:'||ws::text,0))
$$;
REVOKE ALL ON FUNCTION app.c_lock_workspace(uuid),app.c_guard_dispatch() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.c_lock_workspace(uuid) TO zutrade_api,zutrade_worker;

-- Authenticate exact persisted queue identities without assuming the initiating member
-- is still active. This function supplies metadata only; it grants no send rights.
CREATE FUNCTION app.c_delivery_job(event_id uuid,job_id uuid) RETURNS jsonb
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
 RETURN to_jsonb(x);
END $$;
REVOKE ALL ON FUNCTION app.c_delivery_job(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.c_delivery_job(uuid,uuid) TO zutrade_worker;

CREATE FUNCTION app.c_late_evidence(rid uuid,attempt_token uuid,evidence jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE r record;
BEGIN
 IF session_user<>'zutrade_worker' THEN RAISE EXCEPTION 'Worker only'; END IF;
 SELECT q.* INTO r FROM app.outbound_requests q JOIN app.delivery_attempts a ON a.workspace_id=q.workspace_id AND a.outbound_request_id=q.id
 WHERE q.id=rid AND a.dispatch_token=attempt_token AND q.transport_mode='simulation';
 IF r.id IS NULL THEN RAISE EXCEPTION 'Attempt identity mismatch'; END IF;
 PERFORM app.c_lock_workspace(r.workspace_id);
 INSERT INTO app.audit_events(workspace_id,actor_kind,action,aggregate_type,aggregate_id,details)
 VALUES(r.workspace_id,'provider','c.late-evidence','outbound_request',rid,jsonb_build_object('attemptToken',attempt_token,'evidence',evidence));
END $$;
REVOKE ALL ON FUNCTION app.c_late_evidence(uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.c_late_evidence(uuid,uuid,jsonb) TO zutrade_worker;

CREATE OR REPLACE FUNCTION app.block_delivery_job(event_id uuid,job_id uuid,reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE x jsonb; rid uuid; ws uuid;
BEGIN
 x:=app.c_delivery_job(event_id,job_id);rid:=(x->>'aggregate_id')::uuid;ws:=(x->>'workspace_id')::uuid;
 UPDATE app.outbound_requests SET state='blocked',stop_reason=left(reason,200) WHERE workspace_id=ws AND id=rid AND state IN('ready','queued');
 IF FOUND THEN
 INSERT INTO app.audit_events(workspace_id,actor_kind,action,aggregate_type,aggregate_id,correlation_id,details)
 VALUES(ws,'system','c.delivery-blocked','outbound_request',rid,event_id,jsonb_build_object('reason',left(reason,200)));
 END IF;
END $$;
