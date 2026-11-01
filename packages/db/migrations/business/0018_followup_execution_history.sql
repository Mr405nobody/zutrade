-- Reflect actual C gateway transitions, without changing the frozen plan.
CREATE OR REPLACE FUNCTION app.d2_followup_result() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 IF NEW.state IS DISTINCT FROM OLD.state THEN
  UPDATE app.followups SET state=CASE NEW.state WHEN 'claimed' THEN 'executing' WHEN 'dispatching' THEN 'executing' WHEN 'simulated' THEN 'completed' WHEN 'failed' THEN 'failed' WHEN 'blocked' THEN 'cancelled' WHEN 'cancelled' THEN 'cancelled' ELSE state END,
   stop_reason=CASE WHEN NEW.state IN('blocked','failed','cancelled','unknown') THEN COALESCE(NEW.stop_reason,NEW.state) ELSE stop_reason END,
   completed_at=CASE WHEN NEW.state='simulated' THEN clock_timestamp() ELSE completed_at END
   WHERE workspace_id=NEW.workspace_id AND outbound_request_id=NEW.id;
  INSERT INTO app.audit_events(workspace_id,actor_kind,action,aggregate_type,aggregate_id,details)
   SELECT workspace_id,'system','d2.followup-gateway-state','followup',id,jsonb_build_object('requestId',NEW.id,'requestState',NEW.state,'businessVersion',business_version,'token',NEW.dispatch_token,'reason',NEW.stop_reason)
   FROM app.followups WHERE workspace_id=NEW.workspace_id AND outbound_request_id=NEW.id;
 END IF; RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.d2_followup_result() FROM PUBLIC;
