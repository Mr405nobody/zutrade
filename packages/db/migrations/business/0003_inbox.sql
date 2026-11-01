-- A2 adds no business table. Original baseline and all applied migrations remain immutable.
ALTER TABLE app.threads ADD COLUMN takeover_member_id uuid;
ALTER TABLE app.threads ADD FOREIGN KEY (workspace_id,takeover_member_id) REFERENCES app.workspace_members(workspace_id,id);
ALTER TABLE app.inbound_events ADD COLUMN requested_factory_id uuid;
ALTER TABLE app.inbound_events ADD COLUMN initiated_by_member_id uuid;
ALTER TABLE app.inbound_events ADD COLUMN normalized_thread_id uuid;
ALTER TABLE app.inbound_events ADD COLUMN normalized_message_id uuid;
ALTER TABLE app.inbound_events ADD FOREIGN KEY (workspace_id,requested_factory_id) REFERENCES app.factories(workspace_id,id);
ALTER TABLE app.inbound_events ADD FOREIGN KEY (workspace_id,initiated_by_member_id) REFERENCES app.workspace_members(workspace_id,id);
ALTER TABLE app.inbound_events ADD FOREIGN KEY (workspace_id,normalized_thread_id) REFERENCES app.threads(workspace_id,id);
ALTER TABLE app.inbound_events ADD FOREIGN KEY (workspace_id,normalized_message_id) REFERENCES app.messages(workspace_id,id);
CREATE TRIGGER inbound_intake_identity_immutable BEFORE UPDATE ON app.inbound_events FOR EACH ROW
  EXECUTE FUNCTION app.guard_identity_fields('requested_factory_id','initiated_by_member_id');

-- Definer functions read the complete association set despite row filtering on callers.
-- Their owner remains the migration role under FORCE RLS, with controlled_initialization.
CREATE FUNCTION app.can_read_thread(ws uuid,tid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT ws=app.current_workspace_id() AND EXISTS (
   SELECT 1 FROM app.workspace_members m
   JOIN app.app_users u ON u.id=m.user_id AND u.status='active'
   JOIN app.workspaces w ON w.id=m.workspace_id AND w.status='active'
   JOIN app.threads t ON t.workspace_id=m.workspace_id AND t.id=tid
   WHERE m.workspace_id=ws AND m.user_id=app.current_user_id() AND m.status='active'
   AND m.role IN ('owner','sales')
   AND (m.role='owner' OR EXISTS (SELECT 1 FROM app.opportunity_threads ot WHERE ot.workspace_id=ws AND ot.thread_id=tid))
   AND NOT EXISTS (
     SELECT 1 FROM app.opportunity_threads ot
     JOIN app.opportunities o ON o.workspace_id=ot.workspace_id AND o.id=ot.opportunity_id
     WHERE ot.workspace_id=ws AND ot.thread_id=tid AND
       ((o.factory_id IS NULL AND m.role<>'owner') OR
        (o.factory_id IS NOT NULL AND NOT (m.all_factories OR EXISTS (
          SELECT 1 FROM app.factory_memberships fm WHERE fm.workspace_id=ws AND fm.member_id=m.id AND fm.factory_id=o.factory_id))))
   )
 )
$$;
CREATE FUNCTION app.a2_system_account(ws uuid,account_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT session_user='zutrade_worker' AND ws=app.current_workspace_id() AND EXISTS (
   SELECT 1 FROM app.inbound_events e JOIN app.channel_accounts a ON a.workspace_id=e.workspace_id AND a.id=e.channel_account_id
   JOIN app.outbox_events x ON x.workspace_id=e.workspace_id AND x.aggregate_id=e.id AND x.handler_key='a2.inbound'
   WHERE e.id=NULLIF(current_setting('app.inbound_event_id',true),'')::uuid AND e.workspace_id=ws AND e.channel_account_id=account_id
   AND a.provider='zutrade-mock' AND a.channel_kind='simulation' AND a.transport_mode='simulation'
   AND x.pg_boss_job_id IS NOT NULL
 )
$$;
CREATE FUNCTION app.a2_system_workspace(ws uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT EXISTS (SELECT 1 FROM app.inbound_events e WHERE e.id=NULLIF(current_setting('app.inbound_event_id',true),'')::uuid
   AND e.workspace_id=ws AND app.a2_system_account(ws,e.channel_account_id))
$$;
CREATE FUNCTION app.a2_delivery_result(ws uuid,rid uuid,tid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT session_user='zutrade_worker' AND ws=app.current_workspace_id()
 AND rid=NULLIF(current_setting('app.delivery_result_request_id',true),'')::uuid
 AND tid=NULLIF(current_setting('app.delivery_result_thread_id',true),'')::uuid
 AND EXISTS (SELECT 1 FROM app.outbound_requests r WHERE r.workspace_id=ws AND r.id=rid AND r.thread_id=tid
   AND r.transport_mode='simulation' AND r.dispatch_token=NULLIF(current_setting('app.delivery_result_token',true),'')::uuid
   AND r.state IN ('claimed','dispatching','unknown','simulated'))
$$;
CREATE FUNCTION app.a2_result_thread(ws uuid,tid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT app.a2_delivery_result(ws,NULLIF(current_setting('app.delivery_result_request_id',true),'')::uuid,tid)
$$;
CREATE FUNCTION app.begin_inbound_task(event_id uuid,job_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE ws uuid; aid uuid;
BEGIN
 IF session_user<>'zutrade_worker' THEN RAISE EXCEPTION 'Only inbound worker may establish task context'; END IF;
 SELECT e.workspace_id,e.channel_account_id INTO ws,aid FROM app.inbound_events e
 JOIN app.outbox_events x ON x.workspace_id=e.workspace_id AND x.aggregate_id=e.id AND x.handler_key='a2.inbound'
 JOIN app.channel_accounts a ON a.workspace_id=e.workspace_id AND a.id=e.channel_account_id
 JOIN app.workspaces w ON w.id=e.workspace_id AND w.status='active'
 WHERE x.id=event_id AND x.pg_boss_job_id=job_id AND x.event_type='a2.inbound-received'
 AND x.payload->>'inboundEventId'=e.id::text AND x.payload->>'channelAccountId'=a.id::text
 AND a.provider='zutrade-mock' AND a.external_account_key='a2-inbox'
 AND a.transport_mode='simulation' AND a.channel_kind='simulation' AND a.state='active';
 IF ws IS NULL THEN RAISE EXCEPTION 'Inbound event/job/account identity mismatch'; END IF;
 PERFORM set_config('app.workspace_id',ws::text,true);
 PERFORM set_config('app.inbound_event_id',(SELECT e.id::text FROM app.inbound_events e JOIN app.outbox_events x ON x.workspace_id=e.workspace_id AND x.aggregate_id=e.id WHERE x.id=event_id),true);
END $$;
CREATE FUNCTION app.begin_delivery_result(request_id uuid,token uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE ws uuid; tid uuid;
BEGIN
 IF session_user<>'zutrade_worker' THEN RAISE EXCEPTION 'Only delivery worker may record results'; END IF;
 SELECT r.workspace_id,r.thread_id INTO ws,tid FROM app.outbound_requests r JOIN app.channel_accounts a ON a.workspace_id=r.workspace_id AND a.id=r.channel_account_id
 WHERE r.id=request_id AND r.dispatch_token=token AND r.transport_mode='simulation' AND a.provider='zutrade-mock'
 AND a.channel_kind='simulation' AND a.transport_mode='simulation' AND r.state IN ('claimed','dispatching','unknown','simulated');
 IF ws IS NULL THEN RAISE EXCEPTION 'Delivery result identity mismatch'; END IF;
 PERFORM set_config('app.workspace_id',ws::text,true);
 PERFORM set_config('app.delivery_result_request_id',request_id::text,true);
 PERFORM set_config('app.delivery_result_thread_id',tid::text,true);
 PERFORM set_config('app.delivery_result_token',token::text,true);
END $$;

CREATE POLICY a2_thread_access ON app.threads AS RESTRICTIVE TO zutrade_api,zutrade_worker
 USING (app.can_read_thread(workspace_id,id) OR app.a2_system_account(workspace_id,channel_account_id) OR app.a2_result_thread(workspace_id,id))
 WITH CHECK (app.can_read_thread(workspace_id,id) OR app.a2_system_account(workspace_id,channel_account_id) OR app.a2_result_thread(workspace_id,id));
CREATE POLICY a2_message_access ON app.messages AS RESTRICTIVE TO zutrade_api,zutrade_worker
 USING (app.can_read_thread(workspace_id,thread_id) OR app.a2_system_account(workspace_id,channel_account_id) OR app.a2_delivery_result(workspace_id,outbound_request_id,thread_id))
 WITH CHECK (app.can_read_thread(workspace_id,thread_id) OR app.a2_system_account(workspace_id,channel_account_id) OR app.a2_delivery_result(workspace_id,outbound_request_id,thread_id));
CREATE POLICY a2_note_access ON app.team_notes AS RESTRICTIVE TO zutrade_api,zutrade_worker
 USING (thread_id IS NOT NULL AND app.can_read_thread(workspace_id,thread_id))
 WITH CHECK (thread_id IS NOT NULL AND app.can_read_thread(workspace_id,thread_id) AND author_member_id IN (SELECT id FROM app.workspace_members WHERE user_id=app.current_user_id() AND status='active'));
CREATE POLICY a2_read_access ON app.thread_reads AS RESTRICTIVE TO zutrade_api,zutrade_worker
 USING (app.can_read_thread(workspace_id,thread_id) AND member_id IN (SELECT id FROM app.workspace_members WHERE user_id=app.current_user_id() AND status='active'))
 WITH CHECK (app.can_read_thread(workspace_id,thread_id) AND member_id IN (SELECT id FROM app.workspace_members WHERE user_id=app.current_user_id() AND status='active'));
CREATE POLICY a2_request_access ON app.outbound_requests AS RESTRICTIVE TO zutrade_api,zutrade_worker
 USING (app.can_read_thread(workspace_id,thread_id) OR app.a2_delivery_result(workspace_id,id,thread_id))
 WITH CHECK (app.can_read_thread(workspace_id,thread_id) OR app.a2_delivery_result(workspace_id,id,thread_id));
CREATE POLICY a2_payload_access ON app.outbound_payload_versions AS RESTRICTIVE TO zutrade_api,zutrade_worker
 USING (EXISTS (SELECT 1 FROM app.outbound_requests r WHERE r.workspace_id=outbound_payload_versions.workspace_id AND r.id=outbound_payload_versions.outbound_request_id))
 WITH CHECK (EXISTS (SELECT 1 FROM app.outbound_requests r WHERE r.workspace_id=outbound_payload_versions.workspace_id AND r.id=outbound_payload_versions.outbound_request_id));

GRANT SELECT ON app.channel_accounts,app.contacts,app.contact_points,app.contact_permissions,app.buyers,app.threads,app.messages,app.team_notes,app.thread_reads,app.opportunities,app.opportunity_threads,app.inbound_events,app.outbound_requests,app.outbound_payload_versions,app.delivery_attempts TO zutrade_api,zutrade_worker;
GRANT INSERT ON app.channel_accounts,app.inbound_events,app.team_notes,app.thread_reads,app.opportunities,app.opportunity_threads,app.outbound_requests,app.outbound_payload_versions TO zutrade_api;
GRANT UPDATE ON app.threads,app.thread_reads,app.opportunities,app.outbound_requests TO zutrade_api;
GRANT UPDATE (id) ON app.channel_accounts,app.contact_points,app.contact_permissions TO zutrade_api,zutrade_worker;
GRANT INSERT ON app.contacts,app.contact_points,app.contact_permissions,app.buyers,app.threads,app.messages,app.opportunities,app.opportunity_threads,app.delivery_attempts TO zutrade_worker;
GRANT UPDATE ON app.threads,app.inbound_events,app.delivery_attempts,app.outbound_requests TO zutrade_worker;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA app TO zutrade_worker;
REVOKE ALL ON FUNCTION app.can_read_thread(uuid,uuid),app.a2_system_account(uuid,uuid),app.a2_system_workspace(uuid),app.a2_delivery_result(uuid,uuid,uuid),app.a2_result_thread(uuid,uuid),app.begin_inbound_task(uuid,uuid),app.begin_delivery_result(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.can_read_thread(uuid,uuid),app.a2_system_account(uuid,uuid),app.a2_system_workspace(uuid),app.a2_delivery_result(uuid,uuid,uuid),app.a2_result_thread(uuid,uuid) TO zutrade_api,zutrade_worker;
GRANT EXECUTE ON FUNCTION app.begin_inbound_task(uuid,uuid),app.begin_delivery_result(uuid,uuid) TO zutrade_worker;

CREATE FUNCTION app.a2_can_access_factory(ws uuid,fid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT ws=app.current_workspace_id() AND EXISTS (
   SELECT 1 FROM app.workspace_members m JOIN app.app_users u ON u.id=m.user_id AND u.status='active'
   JOIN app.workspaces w ON w.id=m.workspace_id AND w.status='active'
   WHERE m.workspace_id=ws AND m.user_id=app.current_user_id() AND m.status='active' AND m.role IN ('owner','sales')
   AND ((fid IS NULL AND m.role='owner') OR (fid IS NOT NULL AND (m.all_factories OR EXISTS (
     SELECT 1 FROM app.factory_memberships fm WHERE fm.workspace_id=ws AND fm.factory_id=fid AND fm.member_id=m.id))))
 )
$$;
CREATE POLICY a2_receipt_access ON app.inbound_events AS RESTRICTIVE TO zutrade_api,zutrade_worker
 USING (app.a2_can_access_factory(workspace_id,requested_factory_id) OR
   (id=NULLIF(current_setting('app.inbound_event_id',true),'')::uuid AND app.a2_system_account(workspace_id,channel_account_id)))
 WITH CHECK (app.a2_can_access_factory(workspace_id,requested_factory_id) OR
   (id=NULLIF(current_setting('app.inbound_event_id',true),'')::uuid AND app.a2_system_account(workspace_id,channel_account_id)));
CREATE POLICY a2_attempt_access ON app.delivery_attempts AS RESTRICTIVE TO zutrade_api,zutrade_worker
 USING (EXISTS (SELECT 1 FROM app.outbound_requests r WHERE r.workspace_id=delivery_attempts.workspace_id AND r.id=delivery_attempts.outbound_request_id))
 WITH CHECK (EXISTS (SELECT 1 FROM app.outbound_requests r WHERE r.workspace_id=delivery_attempts.workspace_id AND r.id=delivery_attempts.outbound_request_id));

-- Association changes share the thread row lock with claim and all context commands.
-- Definer is necessary so the invalidation still happens after adding an invisible factory.
CREATE FUNCTION app.a2_invalidate_thread_links() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE ws uuid; tid uuid;
BEGIN
 IF TG_OP='UPDATE' AND (NEW.workspace_id,NEW.thread_id,NEW.opportunity_id) IS NOT DISTINCT FROM (OLD.workspace_id,OLD.thread_id,OLD.opportunity_id) THEN RETURN NEW; END IF;
 IF TG_OP='DELETE' THEN ws:=OLD.workspace_id;tid:=OLD.thread_id;
 ELSE ws:=NEW.workspace_id;tid:=NEW.thread_id; END IF;
 UPDATE app.threads SET context_revision=context_revision+1 WHERE workspace_id=ws AND id=tid;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF TG_OP='UPDATE' AND (OLD.workspace_id,OLD.thread_id) IS DISTINCT FROM (NEW.workspace_id,NEW.thread_id) THEN
   UPDATE app.threads SET context_revision=context_revision+1 WHERE workspace_id=OLD.workspace_id AND id=OLD.thread_id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER a2_thread_link_invalidation BEFORE INSERT OR UPDATE OR DELETE ON app.opportunity_threads
 FOR EACH ROW EXECUTE FUNCTION app.a2_invalidate_thread_links();
CREATE FUNCTION app.a2_invalidate_opportunity_factory() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE target record;
BEGIN
 IF NEW.factory_id IS NOT DISTINCT FROM OLD.factory_id THEN RETURN NEW; END IF;
 FOR target IN SELECT t.id FROM app.threads t JOIN app.opportunity_threads ot ON ot.workspace_id=t.workspace_id AND ot.thread_id=t.id
 WHERE ot.workspace_id=OLD.workspace_id AND ot.opportunity_id=OLD.id ORDER BY t.id FOR UPDATE OF t LOOP
   UPDATE app.threads SET context_revision=context_revision+1 WHERE workspace_id=OLD.workspace_id AND id=target.id;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER a2_factory_link_invalidation BEFORE UPDATE OF factory_id ON app.opportunities
 FOR EACH ROW EXECUTE FUNCTION app.a2_invalidate_opportunity_factory();
REVOKE ALL ON FUNCTION app.a2_can_access_factory(uuid,uuid),app.a2_invalidate_thread_links(),app.a2_invalidate_opportunity_factory() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.a2_can_access_factory(uuid,uuid) TO zutrade_api,zutrade_worker;

-- A receipt hidden from a sales member still blocks the entire shared account.
-- Return a fail-closed boolean, never a receipt ID or payload from another factory.
CREATE FUNCTION app.a2_has_inbound_barrier(ws uuid,aid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT NOT (ws=app.current_workspace_id() AND (
   app.a2_system_account(ws,aid) OR EXISTS (
     SELECT 1 FROM app.threads t WHERE t.workspace_id=ws AND t.channel_account_id=aid AND app.can_read_thread(ws,t.id)
   )
 )) OR EXISTS (SELECT 1 FROM app.inbound_events e WHERE e.workspace_id=ws AND e.channel_account_id=aid AND e.processed_at IS NULL)
$$;
REVOKE ALL ON FUNCTION app.a2_has_inbound_barrier(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.a2_has_inbound_barrier(uuid,uuid) TO zutrade_worker;

-- Background intake reads identities only inside its trusted simulation account.
-- INSERT is separately granted because the point/contact/buyer trio is assembled
-- in one transaction before those new rows have an existing thread association.
CREATE POLICY a2_point_system_read ON app.contact_points AS RESTRICTIVE FOR SELECT TO zutrade_api,zutrade_worker
 USING (app.current_user_id() IS NOT NULL OR (namespace='zutrade-simulation' AND app.a2_system_account(workspace_id,NULLIF(scope_key,'')::uuid)));
CREATE POLICY a2_contact_system_read ON app.contacts AS RESTRICTIVE FOR SELECT TO zutrade_api,zutrade_worker
 USING (app.current_user_id() IS NOT NULL OR EXISTS (SELECT 1 FROM app.contact_points cp WHERE cp.workspace_id=contacts.workspace_id AND cp.contact_id=contacts.id));
CREATE POLICY a2_buyer_system_read ON app.buyers AS RESTRICTIVE FOR SELECT TO zutrade_api,zutrade_worker
 USING (app.current_user_id() IS NOT NULL OR EXISTS (SELECT 1 FROM app.contact_points cp WHERE cp.workspace_id=buyers.workspace_id AND cp.buyer_id=buyers.id));
CREATE POLICY a2_opportunity_system_read ON app.opportunities AS RESTRICTIVE FOR SELECT TO zutrade_api,zutrade_worker
 USING (app.current_user_id() IS NOT NULL OR EXISTS (SELECT 1 FROM app.opportunity_threads ot WHERE ot.workspace_id=opportunities.workspace_id AND ot.opportunity_id=opportunities.id));
CREATE POLICY a2_link_system_read ON app.opportunity_threads AS RESTRICTIVE FOR SELECT TO zutrade_api,zutrade_worker
 USING (app.current_user_id() IS NOT NULL OR EXISTS (SELECT 1 FROM app.threads t WHERE t.workspace_id=opportunity_threads.workspace_id AND t.id=opportunity_threads.thread_id AND app.a2_system_account(t.workspace_id,t.channel_account_id)));
