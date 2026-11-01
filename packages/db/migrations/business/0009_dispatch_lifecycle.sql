CREATE TRIGGER c_request_creator_identity BEFORE UPDATE ON app.outbound_requests FOR EACH ROW EXECUTE FUNCTION app.guard_identity_fields('created_by_member_id');
CREATE OR REPLACE FUNCTION app.block_delivery_job(event_id uuid,job_id uuid,reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE x jsonb; rid uuid; ws uuid; p uuid; a record; lifecycle text;
BEGIN
 x:=app.c_delivery_job(event_id,job_id);rid:=(x->>'aggregate_id')::uuid;ws:=(x->>'workspace_id')::uuid;
 SELECT current_payload_version_id INTO p FROM app.outbound_requests WHERE id=rid;
 IF x->'payload'->>'payloadId' IS NOT NULL AND x->'payload'->>'payloadId'<>p::text THEN RETURN; END IF;
 UPDATE app.outbound_requests SET state='blocked',stop_reason=left(reason,200) WHERE workspace_id=ws AND id=rid AND state IN('ready','queued');
 IF FOUND THEN
  FOR a IN SELECT * FROM app.approvals WHERE workspace_id=ws AND outbound_request_id=rid AND payload_version_id=p AND state IN('pending','approved') FOR UPDATE LOOP
   lifecycle:=CASE WHEN a.expires_at<=clock_timestamp() THEN 'expired' ELSE 'invalidated' END;
   UPDATE app.approvals SET state=lifecycle,reason=left(reason,200) WHERE id=a.id;
   INSERT INTO app.approval_events(workspace_id,approval_id,event_no,event_kind,reason,details)
   SELECT ws,a.id,COALESCE(max(event_no),0)+1,lifecycle,left(reason,200),jsonb_build_object('actor','system','eventId',event_id) FROM app.approval_events WHERE workspace_id=ws AND approval_id=a.id;
  END LOOP;
  INSERT INTO app.audit_events(workspace_id,actor_kind,action,aggregate_type,aggregate_id,correlation_id,details)
  VALUES(ws,'system','c.delivery-blocked','outbound_request',rid,event_id,jsonb_build_object('reason',left(reason,200)));
 END IF;
END $$;
