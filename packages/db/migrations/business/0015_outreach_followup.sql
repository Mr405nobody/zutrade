-- D2 reuses the baseline batch/approval/followup tables. No live transport.
ALTER TABLE app.contact_points ADD COLUMN source_evidence jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(source_evidence)='object'), ADD COLUMN lead_id uuid,
 ADD FOREIGN KEY(workspace_id,lead_id) REFERENCES app.leads(workspace_id,id);
CREATE UNIQUE INDEX d2_demo_point ON app.contact_points(workspace_id,lead_id,scope_key) WHERE lead_id IS NOT NULL AND namespace='zutrade-simulation';
ALTER TABLE app.channel_accounts ADD COLUMN next_claim_at timestamptz, ADD COLUMN min_interval_ms integer NOT NULL DEFAULT 1000 CHECK(min_interval_ms BETWEEN 1000 AND 3600000);
ALTER TABLE app.threads ADD COLUMN outbound_paused boolean NOT NULL DEFAULT false;
ALTER TABLE app.outreach_batches ADD COLUMN draft jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(draft)='object' AND octet_length(draft::text)<=262144), ADD COLUMN next_claim_at timestamptz;
ALTER TABLE app.outreach_batch_items ADD COLUMN lead_id uuid, ADD FOREIGN KEY(workspace_id,factory_id,lead_id) REFERENCES app.leads(workspace_id,factory_id,id);
CREATE UNIQUE INDEX d2_request_one_batch_item ON app.outreach_batch_items(workspace_id,outbound_request_id);
ALTER TABLE app.followups ADD COLUMN business_version bigint NOT NULL DEFAULT 1 CHECK(business_version>0), ADD COLUMN internal_draft text NOT NULL DEFAULT '' CHECK(length(internal_draft)<=10000), ADD COLUMN plan_snapshot jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(plan_snapshot)='object'), ADD COLUMN created_by_member_id uuid,
 ADD FOREIGN KEY(workspace_id,created_by_member_id) REFERENCES app.workspace_members(workspace_id,id);
GRANT SELECT ON app.outreach_batches,app.outreach_batch_versions,app.outreach_batch_items,app.followups TO zutrade_api,zutrade_worker;
GRANT INSERT,UPDATE ON app.outreach_batches,app.outreach_batch_versions,app.followups TO zutrade_api;
GRANT INSERT ON app.outreach_batch_items,app.contacts,app.contact_points,app.contact_permissions,app.threads TO zutrade_api;
GRANT UPDATE(status,evidence,do_not_contact,suppression_reason,changed_by_member_id) ON app.contact_permissions TO zutrade_api;
GRANT UPDATE(next_claim_at) ON app.channel_accounts TO zutrade_worker;
GRANT UPDATE(next_claim_at) ON app.outreach_batches TO zutrade_worker;
GRANT UPDATE(state,stop_reason,completed_at) ON app.followups TO zutrade_worker;
GRANT UPDATE(id) ON app.outreach_batch_versions,app.outreach_batch_items TO zutrade_worker;
CREATE POLICY d2_batch_factory ON app.outreach_batches AS RESTRICTIVE TO zutrade_api,zutrade_worker
 USING(EXISTS(SELECT 1 FROM app.factories f WHERE f.workspace_id=outreach_batches.workspace_id AND f.id=outreach_batches.factory_id)) WITH CHECK(EXISTS(SELECT 1 FROM app.factories f WHERE f.workspace_id=outreach_batches.workspace_id AND f.id=outreach_batches.factory_id));
CREATE POLICY d2_version_factory ON app.outreach_batch_versions AS RESTRICTIVE TO zutrade_api,zutrade_worker
 USING(EXISTS(SELECT 1 FROM app.outreach_batches b WHERE b.workspace_id=outreach_batch_versions.workspace_id AND b.id=outreach_batch_versions.batch_id)) WITH CHECK(EXISTS(SELECT 1 FROM app.outreach_batches b WHERE b.workspace_id=outreach_batch_versions.workspace_id AND b.id=outreach_batch_versions.batch_id));
CREATE POLICY d2_item_factory ON app.outreach_batch_items AS RESTRICTIVE TO zutrade_api,zutrade_worker
 USING(EXISTS(SELECT 1 FROM app.outbound_requests r WHERE r.workspace_id=outreach_batch_items.workspace_id AND r.id=outreach_batch_items.outbound_request_id)) WITH CHECK(EXISTS(SELECT 1 FROM app.outbound_requests r WHERE r.workspace_id=outreach_batch_items.workspace_id AND r.id=outreach_batch_items.outbound_request_id));
CREATE POLICY d2_followup_thread ON app.followups AS RESTRICTIVE TO zutrade_api,zutrade_worker
 USING(EXISTS(SELECT 1 FROM app.threads t WHERE t.workspace_id=followups.workspace_id AND t.id=followups.thread_id)) WITH CHECK(EXISTS(SELECT 1 FROM app.threads t WHERE t.workspace_id=followups.workspace_id AND t.id=followups.thread_id));
DROP POLICY c_approval_access ON app.approvals;
CREATE POLICY c_approval_access ON app.approvals AS RESTRICTIVE TO zutrade_api,zutrade_worker
 USING(EXISTS(SELECT 1 FROM app.outbound_requests r WHERE r.workspace_id=approvals.workspace_id AND r.id=approvals.outbound_request_id) OR EXISTS(SELECT 1 FROM app.outreach_batch_versions v WHERE v.workspace_id=approvals.workspace_id AND v.id=approvals.batch_version_id))
 WITH CHECK(EXISTS(SELECT 1 FROM app.outbound_requests r WHERE r.workspace_id=approvals.workspace_id AND r.id=approvals.outbound_request_id) OR EXISTS(SELECT 1 FROM app.outreach_batch_versions v WHERE v.workspace_id=approvals.workspace_id AND v.id=approvals.batch_version_id));
CREATE TRIGGER d2_point_source BEFORE UPDATE ON app.contact_points FOR EACH ROW EXECUTE FUNCTION app.guard_identity_fields('source_evidence','lead_id');
CREATE TRIGGER d2_batch_identity BEFORE UPDATE ON app.outreach_batches FOR EACH ROW EXECUTE FUNCTION app.guard_identity_fields('id','workspace_id','factory_id','created_at');
CREATE FUNCTION app.d2_guard_followup() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Followup history retained'; END IF;
 IF NEW.id<>OLD.id OR NEW.workspace_id<>OLD.workspace_id OR NEW.factory_id<>OLD.factory_id OR NEW.thread_id<>OLD.thread_id OR NEW.opportunity_id<>OLD.opportunity_id OR NEW.created_by_member_id IS DISTINCT FROM OLD.created_by_member_id OR NEW.dedupe_key<>OLD.dedupe_key THEN RAISE EXCEPTION 'Followup identity immutable'; END IF;
 IF (to_jsonb(NEW)-ARRAY['row_version','updated_at','state','stop_reason','completed_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['row_version','updated_at','state','stop_reason','completed_at']) AND NEW.business_version<>OLD.business_version+1 THEN RAISE EXCEPTION 'Changed plan requires next business version'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER d2_followup_guard BEFORE UPDATE OR DELETE ON app.followups FOR EACH ROW EXECUTE FUNCTION app.d2_guard_followup();
-- Followup projection follows actual gateway outcomes, including worker/system blocking.
CREATE FUNCTION app.d2_followup_result() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 IF NEW.state IS DISTINCT FROM OLD.state THEN
 UPDATE app.followups SET state=CASE NEW.state WHEN 'simulated' THEN 'completed' WHEN 'failed' THEN 'failed' WHEN 'blocked' THEN 'cancelled' WHEN 'cancelled' THEN 'cancelled' ELSE state END,
 stop_reason=CASE WHEN NEW.state IN('blocked','failed','cancelled','unknown') THEN COALESCE(NEW.stop_reason,NEW.state) ELSE stop_reason END,
 completed_at=CASE WHEN NEW.state='simulated' THEN clock_timestamp() ELSE completed_at END
 WHERE workspace_id=NEW.workspace_id AND outbound_request_id=NEW.id;
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER d2_followup_projection AFTER UPDATE ON app.outbound_requests FOR EACH ROW EXECUTE FUNCTION app.d2_followup_result();
-- Queue metadata grants no send permission. Revoked actors can only stop their exact plan.
CREATE FUNCTION app.d2_followup_job(eid uuid,jid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE e record;
BEGIN
 IF session_user<>'zutrade_worker' THEN RAISE EXCEPTION 'Worker only'; END IF;
 SELECT * INTO e FROM app.outbox_events WHERE id=eid AND pg_boss_job_id=jid AND handler_key='d2.followup' AND event_type='d2.followup-due' AND aggregate_id::text=payload->>'followupId';
 IF e.id IS NULL THEN RAISE EXCEPTION 'Followup job identity mismatch'; END IF;
 PERFORM app.c_lock_workspace(e.workspace_id); RETURN to_jsonb(e);
END $$;
CREATE FUNCTION app.d2_stop_revoked_followup(eid uuid,jid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE e jsonb; f record;
BEGIN
 e:=app.d2_followup_job(eid,jid);
 SELECT * INTO f FROM app.followups WHERE id=(e->>'aggregate_id')::uuid AND workspace_id=(e->>'workspace_id')::uuid AND business_version::text=e->'payload'->>'businessVersion';
 IF f.id IS NULL THEN RETURN; END IF;
 IF EXISTS(SELECT 1 FROM app.workspace_members m JOIN app.app_users u ON u.id=m.user_id JOIN app.workspaces w ON w.id=m.workspace_id JOIN app.factories x ON x.workspace_id=m.workspace_id AND x.id=f.factory_id WHERE m.id=(e->'payload'->>'memberId')::uuid AND m.workspace_id=f.workspace_id AND m.status='active' AND u.status='active' AND w.status='active' AND x.status='active' AND (m.all_factories OR EXISTS(SELECT 1 FROM app.factory_memberships a WHERE a.workspace_id=m.workspace_id AND a.member_id=m.id AND a.factory_id=f.factory_id))) THEN RETURN; END IF;
 UPDATE app.followups SET state='cancelled',stop_reason='ACTOR_NO_LONGER_AUTHORIZED' WHERE id=f.id AND state IN('scheduled','ready');
 UPDATE app.outbound_requests SET state=CASE WHEN dispatch_claimed_at IS NULL THEN 'cancelled' ELSE state END,cancel_requested_at=clock_timestamp(),stop_reason='ACTOR_NO_LONGER_AUTHORIZED' WHERE id=f.outbound_request_id AND state NOT IN('simulated','failed','cancelled');
 INSERT INTO app.audit_events(workspace_id,actor_kind,action,aggregate_type,aggregate_id,details) VALUES(f.workspace_id,'system','d2.followup-stopped','followup',f.id,jsonb_build_object('reason','ACTOR_NO_LONGER_AUTHORIZED','businessVersion',f.business_version));
END $$;
REVOKE ALL ON FUNCTION app.d2_guard_followup(),app.d2_followup_result(),app.d2_followup_job(uuid,uuid),app.d2_stop_revoked_followup(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.d2_followup_job(uuid,uuid),app.d2_stop_revoked_followup(uuid,uuid) TO zutrade_worker;
