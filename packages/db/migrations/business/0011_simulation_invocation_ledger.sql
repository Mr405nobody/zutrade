-- Invocation begins before delay/acceptance. A process can die during that window;
-- do not make a committed outcome row the only evidence a call was made.
CREATE TABLE simulation.invocations (
 id uuid PRIMARY KEY,
 account_id uuid NOT NULL,
 request_id uuid NOT NULL,
 provider_key text NOT NULL,
 payload_sha256 text NOT NULL,
 dispatch_token uuid NOT NULL,
 idempotent boolean NOT NULL,
 scenario text NOT NULL,
 invoked_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- Preserve earlier completed simulation facts when upgrading an existing C database.
INSERT INTO simulation.invocations(id,account_id,request_id,provider_key,payload_sha256,dispatch_token,idempotent,scenario,invoked_at)
 SELECT id,account_id,request_id,provider_key,payload_sha256,dispatch_token,idempotent,scenario,called_at FROM simulation.calls;
ALTER TABLE simulation.calls ADD FOREIGN KEY(id) REFERENCES simulation.invocations(id);
GRANT SELECT,INSERT ON simulation.invocations TO zutrade_simulation;
CREATE TRIGGER simulation_invocations_append BEFORE UPDATE OR DELETE ON simulation.invocations FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
