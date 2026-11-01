-- ZuTrade business schema v1 -- 2026-10-28
-- Target PostgreSQL 18; uses syntax also supported by PostgreSQL 17.
-- 42 business tables. Initial migration, not an idempotent upgrade.
-- No extension is required.
-- Better Auth owns a separate auth schema, generated using its official CLI.
-- app.app_users.auth_subject maps to the auth user ID; do not duplicate auth
-- passwords/sessions/organization roles here. Business membership lives here.
--
-- IMPORTANT BOUNDARIES
-- 1. A workspace is a ZuTrade operating organization, NOT a factory. Factories
--    are principals represented by that organization. Factories have no login
--    in this MVP. A communication thread can discuss multiple opportunities.
-- 2. RLS is a tenant-omission backstop, not authentication or role enforcement.
--    The API must verify membership and authorization, then transaction-locally
--    set app.workspace_id and app.user_id. Never trust client tenant settings.
--    Runtime/worker roles must not own these tables and must not be superuser
--    or BYPASSRLS. Use a separate migration owner. SET LOCAL avoids pool leaks.
-- 3. The sending gateway must atomically lock/recheck the selected immutable
--    payload, its approval/batch approval, contact eligibility, channel mode,
--    thread context revision, opportunity requirement revision, current facts,
--    quote validity, factory authority, and membership before dispatch begins.
--    The gateway also verifies semantic claims, disclosure scope, completeness,
--    attachment bytes/hashes, canonical snapshot hashes, totals and rounding.
--    These cross-record/time-dependent business rules are NOT all DB CHECKs.
-- 4. Revocation and authorization claiming must serialize on the same approval
--    and request rows. queued/ready work remains cancellable. Committing state
--    'claimed' is the send-right linearization point (NOT the HTTP call start).
--    After that point a revocation request is too late for that attempt; record
--    it and stop future attempts, but never promise that this send was stopped.
--    A pg-boss job lease alone is not a send-right claim.
--    Unknown provider outcomes require reconciliation; never blindly retry a
--    possibly accepted send without provider-supported idempotency.
--    Before the claim, lock the channel account and check its unprocessed inbox
--    events. The webhook-receive transaction takes the SAME channel lock before
--    storing raw events. Any unnormalized event conservatively blocks automatic
--    sends for that account until normalized/explicitly resolved. This closes
--    the raw-receipt-to-thread-revision gap. Do not clear a failed event merely
--    because retries are exhausted. Facts/approvals/context are rechecked too.
-- 5. Save the business transition, immutable outbox event identity and pg-boss
--    enqueue in ONE Drizzle/node-postgres transaction using its pg-boss adapter.
--    There is no second outbox publisher/retry/lease mechanism. pg-boss owns
--    delivery/retry scheduling; its jobs are wakeups/execution records, not the
--    authoritative approval state. Replays refer to the same immutable event.
--    Its own schema is installed by pg-boss and is not reproduced here.
-- 6. source_documents/source_versions/facts describe factory-authorized supply
--    evidence. Lead-research provenance is a separate research_snapshot; it
--    cannot become a pricing or delivery promise merely by being imported.
-- 7. Frozen versions are immutable except explicit lifecycle fields. Child
--    rows cannot change after their parent freezes. Gateway code must create
--    all children, validate, and freeze within a single transaction.
-- 8. This is an implementable MVP schema, not a complete production deployment:
--    add audited command handlers, provider adapters, role grants, retention,
--    backups, monitoring, migrations, and concurrency/security tests separately.
--    No orders/payments/logistics/commission-settlement system is implemented.
-- 9. MVP enables only owner and sales. admin/viewer are reserved role values.
--    Only the active owner designated by workspaces.approver_member_id may
--    approve business commitments; enforce this in the approval command service.
--
-- Money: decimal NUMERIC, ISO-style uppercase currency codes, explicit scale.
-- JSON decimal values sent through JS should be strings, not binary floats.
-- Time: instants use timestamptz; scheduling also retains an IANA zone name.
-- Simulation and live channels are immutable identities and cannot be switched.

BEGIN;
CREATE SCHEMA IF NOT EXISTS app;

CREATE FUNCTION app.current_workspace_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.workspace_id', true), '')::uuid
$$;

CREATE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

CREATE FUNCTION app.touch_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  NEW.row_version := OLD.row_version + 1;
  RETURN NEW;
END
$$;

-- Lifecycle columns explicitly named in TG_ARGV may change after freezing.
CREATE FUNCTION app.guard_frozen_content() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_content jsonb; new_content jsonb; allowed_column text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.frozen_at IS NOT NULL THEN
      RAISE EXCEPTION 'Frozen %.% row cannot be deleted', TG_TABLE_SCHEMA, TG_TABLE_NAME;
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.frozen_at IS NOT NULL THEN
    old_content := to_jsonb(OLD);
    new_content := to_jsonb(NEW);
    FOREACH allowed_column IN ARRAY TG_ARGV LOOP
      old_content := old_content - allowed_column;
      new_content := new_content - allowed_column;
    END LOOP;
    IF old_content IS DISTINCT FROM new_content THEN
      RAISE EXCEPTION 'Frozen %.% content is immutable; create a new version', TG_TABLE_SCHEMA, TG_TABLE_NAME;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION app.guard_identity_fields() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE field_name text;
BEGIN
  FOREACH field_name IN ARRAY TG_ARGV LOOP
    IF (to_jsonb(OLD) -> field_name) IS DISTINCT FROM (to_jsonb(NEW) -> field_name) THEN
      RAISE EXCEPTION '%.% identity field % is immutable', TG_TABLE_SCHEMA, TG_TABLE_NAME, field_name;
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;

CREATE FUNCTION app.reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%.% is append-only', TG_TABLE_SCHEMA, TG_TABLE_NAME;
END
$$;

-- TG_ARGV = parent table, child FK column. Parent lock serializes child edits
-- against freezing. Moving an existing child to another parent is prohibited.
CREATE FUNCTION app.guard_frozen_parent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_data jsonb; parent_id uuid; ws_id uuid; parent_frozen timestamptz;
BEGIN
  IF TG_OP = 'UPDATE' AND
     ((to_jsonb(OLD) -> TG_ARGV[1]) IS DISTINCT FROM (to_jsonb(NEW) -> TG_ARGV[1]) OR
      OLD.workspace_id IS DISTINCT FROM NEW.workspace_id) THEN
    RAISE EXCEPTION 'Cannot move a version child to another parent/workspace';
  END IF;
  IF TG_OP = 'DELETE' THEN row_data := to_jsonb(OLD); ELSE row_data := to_jsonb(NEW); END IF;
  parent_id := (row_data ->> TG_ARGV[1])::uuid;
  ws_id := (row_data ->> 'workspace_id')::uuid;
  EXECUTE format('SELECT frozen_at FROM app.%I WHERE workspace_id = $1 AND id = $2 FOR UPDATE', TG_ARGV[0])
    INTO parent_frozen USING ws_id, parent_id;
  IF parent_frozen IS NOT NULL THEN
    RAISE EXCEPTION 'Children of frozen app.% row cannot change', TG_ARGV[0];
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

-- 01-05: organization and access scope -------------------------------------
CREATE TABLE app.workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  default_time_zone text NOT NULL DEFAULT 'Asia/Shanghai',
  policy_version bigint NOT NULL DEFAULT 1 CHECK (policy_version > 0),
  policy_config jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(policy_config) = 'object'),
  approver_member_id uuid,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1
);

CREATE TABLE app.app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_subject text NOT NULL UNIQUE,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1
);

CREATE TABLE app.workspace_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  user_id uuid NOT NULL REFERENCES app.app_users(id),
  role text NOT NULL CHECK (role IN ('owner','admin','sales','viewer')),
  all_factories boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1,
  UNIQUE (workspace_id, id), UNIQUE (workspace_id, user_id)
);
ALTER TABLE app.workspaces ADD FOREIGN KEY (id, approver_member_id)
  REFERENCES app.workspace_members(workspace_id, id);

CREATE TABLE app.factories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  name text NOT NULL,
  legal_name text,
  factory_code text NOT NULL,
  confirmation_contact jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(confirmation_contact) = 'object'),
  authorization_scope jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(authorization_scope) = 'object'),
  authority_valid_until timestamptz,
  status text NOT NULL DEFAULT 'onboarding' CHECK (status IN ('onboarding','active','paused','archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1,
  UNIQUE (workspace_id, id), UNIQUE (workspace_id, factory_code)
);

CREATE TABLE app.factory_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  factory_id uuid NOT NULL,
  member_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id), UNIQUE (workspace_id, factory_id, member_id),
  FOREIGN KEY (workspace_id, factory_id) REFERENCES app.factories(workspace_id, id),
  FOREIGN KEY (workspace_id, member_id) REFERENCES app.workspace_members(workspace_id, id)
);

-- 06-12: buyers, identities, leads, purchase opportunities ------------------
CREATE TABLE app.buyers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  name text NOT NULL,
  legal_name text,
  domain_name text,
  country_code text CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$'),
  time_zone text,
  identity_status text NOT NULL DEFAULT 'unverified' CHECK (identity_status IN ('unverified','verified','disputed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1,
  UNIQUE (workspace_id, id)
);
CREATE INDEX buyers_domain_idx ON app.buyers(workspace_id, domain_name) WHERE domain_name IS NOT NULL;

CREATE TABLE app.contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  buyer_id uuid,
  display_name text NOT NULL,
  job_title text,
  language_code text,
  time_zone text,
  identity_status text NOT NULL DEFAULT 'unverified' CHECK (identity_status IN ('unverified','verified','disputed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, buyer_id) REFERENCES app.buyers(workspace_id, id)
);
CREATE INDEX contacts_buyer_idx ON app.contacts(workspace_id, buyer_id);

-- A provider identity is NOT necessarily a phone number. namespace and
-- scope_key keep email, phone and provider-scoped identities distinguishable.
-- scope_key is canonicalized by an adapter; no name-based automatic merging.
CREATE TABLE app.contact_points (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  contact_id uuid,
  buyer_id uuid,
  kind text NOT NULL CHECK (kind IN ('email','phone','provider_identity')),
  namespace text NOT NULL,
  scope_key text NOT NULL DEFAULT 'global',
  normalized_value text NOT NULL CHECK (length(normalized_value) > 0),
  display_value text,
  verified_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, namespace, scope_key, normalized_value),
  FOREIGN KEY (workspace_id, contact_id) REFERENCES app.contacts(workspace_id, id),
  FOREIGN KEY (workspace_id, buyer_id) REFERENCES app.buyers(workspace_id, id)
);

CREATE TABLE app.contact_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  contact_point_id uuid NOT NULL,
  channel_kind text NOT NULL CHECK (channel_kind IN ('email','whatsapp','simulation')),
  purpose text NOT NULL CHECK (purpose IN ('outreach','service')),
  status text NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown','allowed','denied','revoked')),
  evidence jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(evidence) = 'object'),
  valid_from timestamptz,
  valid_until timestamptz,
  do_not_contact boolean NOT NULL DEFAULT false,
  suppression_reason text,
  changed_by_member_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1,
  UNIQUE (workspace_id, id), UNIQUE (workspace_id, contact_point_id, channel_kind, purpose),
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until > valid_from),
  FOREIGN KEY (workspace_id, contact_point_id) REFERENCES app.contact_points(workspace_id, id),
  FOREIGN KEY (workspace_id, changed_by_member_id) REFERENCES app.workspace_members(workspace_id, id)
);

CREATE TABLE app.leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  factory_id uuid NOT NULL,
  buyer_id uuid NOT NULL,
  primary_contact_id uuid,
  owner_member_id uuid NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('research','factory_inquiry','referral','manual','simulation')),
  research_snapshot jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(research_snapshot) = 'object'),
  research_observed_at timestamptz,
  fit_reason text,
  state text NOT NULL DEFAULT 'unverified' CHECK (state IN ('unverified','qualified','rejected','paused','do_not_contact','converted')),
  state_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1,
  UNIQUE (workspace_id, id), UNIQUE (workspace_id, factory_id, id),
  UNIQUE (workspace_id, factory_id, buyer_id, id),
  FOREIGN KEY (workspace_id, factory_id) REFERENCES app.factories(workspace_id, id),
  FOREIGN KEY (workspace_id, buyer_id) REFERENCES app.buyers(workspace_id, id),
  FOREIGN KEY (workspace_id, primary_contact_id) REFERENCES app.contacts(workspace_id, id),
  FOREIGN KEY (workspace_id, owner_member_id) REFERENCES app.workspace_members(workspace_id, id)
);
CREATE INDEX leads_work_idx ON app.leads(workspace_id, factory_id, state, owner_member_id);

CREATE TABLE app.opportunities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  factory_id uuid,
  buyer_id uuid NOT NULL,
  primary_contact_id uuid,
  lead_id uuid,
  owner_member_id uuid NOT NULL,
  title text NOT NULL,
  stage text NOT NULL DEFAULT 'clarifying' CHECK (stage IN ('clarifying','preparing_quote','awaiting_approval','quoted','following_up','paused','closed')),
  requirements jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(requirements) = 'object'),
  requirements_revision bigint NOT NULL DEFAULT 1 CHECK (requirements_revision > 0),
  closed_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1,
  UNIQUE (workspace_id, id), UNIQUE (workspace_id, factory_id, id),
  UNIQUE (workspace_id, factory_id, buyer_id, id),
  CHECK (lead_id IS NULL OR factory_id IS NOT NULL),
  CHECK (stage NOT IN ('preparing_quote','awaiting_approval','quoted','following_up') OR factory_id IS NOT NULL),
  FOREIGN KEY (workspace_id, factory_id) REFERENCES app.factories(workspace_id, id),
  FOREIGN KEY (workspace_id, buyer_id) REFERENCES app.buyers(workspace_id, id),
  FOREIGN KEY (workspace_id, primary_contact_id) REFERENCES app.contacts(workspace_id, id),
  FOREIGN KEY (workspace_id, factory_id, buyer_id, lead_id) REFERENCES app.leads(workspace_id, factory_id, buyer_id, id),
  FOREIGN KEY (workspace_id, owner_member_id) REFERENCES app.workspace_members(workspace_id, id)
);
CREATE INDEX opportunities_work_idx ON app.opportunities(workspace_id, owner_member_id, stage, updated_at DESC);
CREATE INDEX opportunities_buyer_idx ON app.opportunities(workspace_id, buyer_id, factory_id);

-- 13-14: channel accounts and conversation identity ------------------------
CREATE TABLE app.channel_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  channel_kind text NOT NULL CHECK (channel_kind IN ('email','whatsapp','simulation')),
  transport_mode text NOT NULL CHECK (transport_mode IN ('simulation','live')),
  provider text NOT NULL,
  external_account_key text NOT NULL,
  display_name text NOT NULL,
  credential_secret_ref text,
  configuration jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(configuration) = 'object'),
  state text NOT NULL DEFAULT 'disconnected' CHECK (state IN ('disconnected','active','paused','error')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1,
  UNIQUE (workspace_id, id), UNIQUE (workspace_id, id, transport_mode),
  UNIQUE (workspace_id, provider, external_account_key, transport_mode),
  CHECK (channel_kind <> 'simulation' OR transport_mode = 'simulation')
);

CREATE TABLE app.threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  channel_account_id uuid NOT NULL,
  primary_contact_point_id uuid,
  provider_thread_key text,
  subject text,
  owner_member_id uuid,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','pending','snoozed','closed')),
  control_mode text NOT NULL DEFAULT 'human' CHECK (control_mode IN ('human','assisted')),
  context_revision bigint NOT NULL DEFAULT 1 CHECK (context_revision > 0),
  last_inbound_at timestamptz,
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1,
  UNIQUE (workspace_id, id), UNIQUE (workspace_id, channel_account_id, id),
  FOREIGN KEY (workspace_id, channel_account_id) REFERENCES app.channel_accounts(workspace_id, id),
  FOREIGN KEY (workspace_id, primary_contact_point_id) REFERENCES app.contact_points(workspace_id, id),
  FOREIGN KEY (workspace_id, owner_member_id) REFERENCES app.workspace_members(workspace_id, id)
);
CREATE UNIQUE INDEX threads_provider_key_uq ON app.threads(workspace_id, channel_account_id, provider_thread_key) WHERE provider_thread_key IS NOT NULL;
CREATE INDEX threads_inbox_idx ON app.threads(workspace_id, state, last_activity_at DESC, id);

CREATE TABLE app.opportunity_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  opportunity_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id), UNIQUE (workspace_id, opportunity_id, thread_id),
  FOREIGN KEY (workspace_id, opportunity_id) REFERENCES app.opportunities(workspace_id, id),
  FOREIGN KEY (workspace_id, thread_id) REFERENCES app.threads(workspace_id, id)
);
CREATE INDEX opportunity_threads_thread_idx ON app.opportunity_threads(workspace_id, thread_id);

-- 20-25 + 40: catalog, immutable evidence, typed prices ---------------------
CREATE TABLE app.products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  factory_id uuid NOT NULL,
  sku text NOT NULL,
  name text NOT NULL,
  unit_code text NOT NULL DEFAULT 'piece',
  configuration_schema jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(configuration_schema) = 'object'),
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','active','paused','archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1,
  UNIQUE (workspace_id, id), UNIQUE (workspace_id, factory_id, id), UNIQUE (workspace_id, factory_id, sku),
  FOREIGN KEY (workspace_id, factory_id) REFERENCES app.factories(workspace_id, id)
);

CREATE TABLE app.source_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  factory_id uuid NOT NULL,
  title text NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('file','web_page','factory_confirmation','manual','simulation')),
  current_version_id uuid,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','withdrawn','archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1,
  UNIQUE (workspace_id, id), UNIQUE (workspace_id, factory_id, id),
  FOREIGN KEY (workspace_id, factory_id) REFERENCES app.factories(workspace_id, id)
);

CREATE TABLE app.source_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  factory_id uuid NOT NULL,
  source_document_id uuid NOT NULL,
  version_no integer NOT NULL CHECK (version_no > 0),
  source_url text,
  object_key text,
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  content_type text,
  content_size bigint CHECK (content_size IS NULL OR content_size >= 0),
  extracted_snapshot jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(extracted_snapshot) = 'object'),
  observed_at timestamptz NOT NULL,
  valid_until timestamptz,
  recorded_by_member_id uuid,
  frozen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revocation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id), UNIQUE (workspace_id, factory_id, id),
  UNIQUE (workspace_id, source_document_id, id), UNIQUE (workspace_id, source_document_id, version_no),
  CHECK (valid_until IS NULL OR valid_until > observed_at),
  FOREIGN KEY (workspace_id, factory_id, source_document_id) REFERENCES app.source_documents(workspace_id, factory_id, id),
  FOREIGN KEY (workspace_id, recorded_by_member_id) REFERENCES app.workspace_members(workspace_id, id)
);
ALTER TABLE app.source_documents ADD FOREIGN KEY (workspace_id, id, current_version_id)
  REFERENCES app.source_versions(workspace_id, source_document_id, id);

CREATE TABLE app.facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  factory_id uuid NOT NULL,
  product_id uuid,
  fact_key text NOT NULL,
  scope_key text NOT NULL DEFAULT 'default',
  current_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1,
  UNIQUE (workspace_id, id), UNIQUE (workspace_id, factory_id, id),
  UNIQUE NULLS NOT DISTINCT (workspace_id, factory_id, product_id, fact_key, scope_key),
  FOREIGN KEY (workspace_id, factory_id) REFERENCES app.factories(workspace_id, id),
  FOREIGN KEY (workspace_id, factory_id, product_id) REFERENCES app.products(workspace_id, factory_id, id)
);

CREATE TABLE app.fact_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  factory_id uuid NOT NULL,
  fact_id uuid NOT NULL,
  version_no integer NOT NULL CHECK (version_no > 0),
  value_kind text NOT NULL CHECK (value_kind IN ('text','number','boolean','structured','price_rule','stock_snapshot','lead_time')),
  value jsonb NOT NULL,
  applicability jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(applicability) = 'object'),
  disclosure text NOT NULL DEFAULT 'internal' CHECK (disclosure IN ('internal','buyer_visible')),
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','published','superseded','revoked')),
  verified_by_member_id uuid,
  verified_at timestamptz,
  valid_from timestamptz,
  valid_until timestamptz,
  snapshot_sha256 text CHECK (snapshot_sha256 IS NULL OR snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  frozen_at timestamptz,
  invalidated_at timestamptz,
  invalidation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id), UNIQUE (workspace_id, factory_id, id),
  UNIQUE (workspace_id, fact_id, id), UNIQUE (workspace_id, fact_id, version_no),
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until > valid_from),
  CHECK (frozen_at IS NULL OR (snapshot_sha256 IS NOT NULL AND verified_by_member_id IS NOT NULL AND verified_at IS NOT NULL)),
  CHECK (state <> 'published' OR frozen_at IS NOT NULL),
  FOREIGN KEY (workspace_id, factory_id, fact_id) REFERENCES app.facts(workspace_id, factory_id, id),
  FOREIGN KEY (workspace_id, verified_by_member_id) REFERENCES app.workspace_members(workspace_id, id)
);
ALTER TABLE app.facts ADD FOREIGN KEY (workspace_id, id, current_version_id)
  REFERENCES app.fact_versions(workspace_id, fact_id, id);

CREATE TABLE app.fact_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  factory_id uuid NOT NULL,
  fact_version_id uuid NOT NULL,
  source_version_id uuid NOT NULL,
  locator text NOT NULL,
  excerpt text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id), UNIQUE (workspace_id, fact_version_id, source_version_id, locator),
  FOREIGN KEY (workspace_id, factory_id, fact_version_id) REFERENCES app.fact_versions(workspace_id, factory_id, id),
  FOREIGN KEY (workspace_id, factory_id, source_version_id) REFERENCES app.source_versions(workspace_id, factory_id, id)
);
CREATE INDEX fact_evidence_source_idx ON app.fact_evidence(workspace_id, source_version_id, fact_version_id);

-- qty_min is inclusive; qty_max is exclusive, NULL means no upper bound.
-- Publishing code rejects overlapping applicable tiers while locking the
-- product/fact identity. Price arithmetic never reads arbitrary prose JSON.
CREATE TABLE app.price_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  factory_id uuid NOT NULL,
  product_id uuid NOT NULL,
  fact_version_id uuid NOT NULL,
  scope_key text NOT NULL DEFAULT 'default',
  qty_min numeric(18,3) NOT NULL CHECK (qty_min > 0 AND qty_min <> 'NaN'::numeric),
  qty_max numeric(18,3) CHECK (qty_max IS NULL OR (qty_max > qty_min AND qty_max <> 'NaN'::numeric)),
  unit_code text NOT NULL,
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  unit_price numeric(20,6) NOT NULL CHECK (unit_price >= 0 AND unit_price <> 'NaN'::numeric),
  setup_fee numeric(20,6) NOT NULL DEFAULT 0 CHECK (setup_fee >= 0 AND setup_fee <> 'NaN'::numeric),
  tax_scope text NOT NULL DEFAULT 'unconfirmed' CHECK (tax_scope IN ('included','excluded','unconfirmed')),
  shipping_scope text NOT NULL DEFAULT 'unconfirmed' CHECK (shipping_scope IN ('included','excluded','unconfirmed')),
  terms jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(terms) = 'object'),
  valid_from timestamptz NOT NULL,
  valid_until timestamptz,
  frozen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id), UNIQUE (workspace_id, factory_id, id),
  UNIQUE (workspace_id, factory_id, product_id, id),
  UNIQUE (workspace_id, fact_version_id, scope_key, currency_code, qty_min),
  CHECK (valid_until IS NULL OR valid_until > valid_from),
  FOREIGN KEY (workspace_id, factory_id, product_id) REFERENCES app.products(workspace_id, factory_id, id),
  FOREIGN KEY (workspace_id, factory_id, fact_version_id) REFERENCES app.fact_versions(workspace_id, factory_id, id)
);
CREATE INDEX price_rules_lookup_idx ON app.price_rules(workspace_id, factory_id, product_id, scope_key, currency_code, qty_min);

-- 28-30 + 27: quote business snapshots -------------------------------------
CREATE TABLE app.quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  factory_id uuid NOT NULL,
  opportunity_id uuid NOT NULL,
  buyer_id uuid NOT NULL,
  quote_number text NOT NULL,
  current_version_id uuid,
  created_by_member_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1,
  UNIQUE (workspace_id, id), UNIQUE (workspace_id, factory_id, id), UNIQUE (workspace_id, quote_number),
  FOREIGN KEY (workspace_id, factory_id, buyer_id, opportunity_id) REFERENCES app.opportunities(workspace_id, factory_id, buyer_id, id),
  FOREIGN KEY (workspace_id, created_by_member_id) REFERENCES app.workspace_members(workspace_id, id)
);

CREATE TABLE app.quote_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  factory_id uuid NOT NULL,
  quote_id uuid NOT NULL,
  version_no integer NOT NULL CHECK (version_no > 0),
  requirements_revision bigint NOT NULL CHECK (requirements_revision > 0),
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','validated','superseded','invalidated')),
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  currency_scale smallint NOT NULL DEFAULT 2 CHECK (currency_scale BETWEEN 0 AND 6),
  total_amount numeric(20,6) CHECK (total_amount IS NULL OR (total_amount >= 0 AND total_amount <> 'NaN'::numeric)),
  rounding_policy text NOT NULL DEFAULT 'half_up_per_line',
  calculation_version text NOT NULL DEFAULT 'v1',
  seller_snapshot jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(seller_snapshot) = 'object'),
  buyer_snapshot jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(buyer_snapshot) = 'object'),
  scope text NOT NULL DEFAULT 'product_only' CHECK (scope IN ('product_only','delivered','custom')),
  shipping_scope text NOT NULL DEFAULT 'unconfirmed' CHECK (shipping_scope IN ('included','excluded','unconfirmed')),
  tax_scope text NOT NULL DEFAULT 'unconfirmed' CHECK (tax_scope IN ('included','excluded','unconfirmed')),
  incoterm text,
  named_place text,
  payment_terms text,
  sample_terms text,
  production_days integer CHECK (production_days IS NULL OR production_days >= 0),
  production_day_kind text CHECK (production_day_kind IS NULL OR production_day_kind IN ('calendar','business')),
  production_start_conditions text,
  committed_arrival_date date,
  terms_snapshot jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(terms_snapshot) = 'object'),
  valid_until timestamptz,
  validity_time_zone text,
  snapshot_sha256 text CHECK (snapshot_sha256 IS NULL OR snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  frozen_at timestamptz,
  invalidated_at timestamptz,
  invalidation_reason text,
  created_by_member_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id), UNIQUE (workspace_id, factory_id, id),
  UNIQUE (workspace_id, quote_id, id), UNIQUE (workspace_id, quote_id, version_no),
  UNIQUE (workspace_id, factory_id, id, snapshot_sha256),
  CHECK (frozen_at IS NULL OR (total_amount IS NOT NULL AND valid_until IS NOT NULL AND snapshot_sha256 IS NOT NULL)),
  CHECK (state <> 'validated' OR frozen_at IS NOT NULL),
  FOREIGN KEY (workspace_id, factory_id, quote_id) REFERENCES app.quotes(workspace_id, factory_id, id),
  FOREIGN KEY (workspace_id, created_by_member_id) REFERENCES app.workspace_members(workspace_id, id)
);
ALTER TABLE app.quotes ADD FOREIGN KEY (workspace_id, id, current_version_id)
  REFERENCES app.quote_versions(workspace_id, quote_id, id);

CREATE TABLE app.quote_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  factory_id uuid NOT NULL,
  quote_version_id uuid NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  line_kind text NOT NULL CHECK (line_kind IN ('product','setup_fee','sample_fee','shipping','tax','discount','other_fee')),
  product_id uuid,
  price_rule_id uuid,
  description text NOT NULL,
  specification_snapshot jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(specification_snapshot) = 'object'),
  quantity numeric(18,3) NOT NULL CHECK (quantity > 0 AND quantity <> 'NaN'::numeric),
  unit_code text NOT NULL,
  unit_price numeric(20,6) NOT NULL CHECK (unit_price >= 0 AND unit_price <> 'NaN'::numeric),
  line_amount numeric(20,6) NOT NULL CHECK (line_amount >= 0 AND line_amount <> 'NaN'::numeric),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id), UNIQUE (workspace_id, quote_version_id, position),
  CHECK (price_rule_id IS NULL OR product_id IS NOT NULL),
  CHECK (line_kind <> 'product' OR product_id IS NOT NULL),
  FOREIGN KEY (workspace_id, factory_id, quote_version_id) REFERENCES app.quote_versions(workspace_id, factory_id, id),
  FOREIGN KEY (workspace_id, factory_id, product_id) REFERENCES app.products(workspace_id, factory_id, id),
  FOREIGN KEY (workspace_id, factory_id, product_id, price_rule_id) REFERENCES app.price_rules(workspace_id, factory_id, product_id, id)
);

CREATE TABLE app.quote_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  factory_id uuid NOT NULL,
  quote_version_id uuid NOT NULL,
  fact_version_id uuid NOT NULL,
  usage_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id), UNIQUE (workspace_id, quote_version_id, fact_version_id, usage_key),
  FOREIGN KEY (workspace_id, factory_id, quote_version_id) REFERENCES app.quote_versions(workspace_id, factory_id, id),
  FOREIGN KEY (workspace_id, factory_id, fact_version_id) REFERENCES app.fact_versions(workspace_id, factory_id, id)
);
CREATE INDEX quote_evidence_fact_idx ON app.quote_evidence(workspace_id, fact_version_id, quote_version_id);

-- 17-18 + 26: transport command separate from immutable buyer payload -------
CREATE TABLE app.outbound_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  factory_id uuid,
  opportunity_id uuid,
  thread_id uuid NOT NULL,
  channel_account_id uuid NOT NULL,
  transport_mode text NOT NULL CHECK (transport_mode IN ('simulation','live')),
  contact_point_id uuid NOT NULL,
  intent text NOT NULL CHECK (intent IN ('outreach','faq','clarification','quote','followup','human_reply')),
  authorization_mode text NOT NULL CHECK (authorization_mode IN ('human_approval','batch_approval','verified_faq_policy','member_send')),
  current_payload_version_id uuid,
  dispatch_payload_version_id uuid,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','awaiting_approval','ready','queued','claimed','dispatching','submitted','delivered','read','failed','unknown','cancelled','blocked','simulated')),
  idempotency_key text NOT NULL,
  command_sha256 text NOT NULL CHECK (command_sha256 ~ '^[0-9a-f]{64}$'),
  provider_idempotency_key text NOT NULL,
  scheduled_at timestamptz,
  schedule_time_zone text,
  dispatch_claimed_at timestamptz,
  dispatch_started_at timestamptz,
  dispatch_token uuid,
  cancel_requested_at timestamptz,
  stop_reason text,
  created_by_member_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1,
  UNIQUE (workspace_id, id), UNIQUE (workspace_id, factory_id, id),
  UNIQUE (workspace_id, channel_account_id, id),
  UNIQUE (workspace_id, channel_account_id, thread_id, id),
  UNIQUE (workspace_id, factory_id, opportunity_id, thread_id, id),
  UNIQUE (workspace_id, idempotency_key), UNIQUE (workspace_id, channel_account_id, provider_idempotency_key),
  CHECK (intent <> 'quote' OR (factory_id IS NOT NULL AND opportunity_id IS NOT NULL AND authorization_mode = 'human_approval')),
  CHECK (authorization_mode <> 'verified_faq_policy' OR intent IN ('faq','clarification')),
  CHECK (authorization_mode <> 'member_send' OR intent = 'human_reply'),
  CHECK (transport_mode <> 'simulation' OR state NOT IN ('submitted','delivered','read')),
  CHECK (transport_mode <> 'live' OR state <> 'simulated'),
  FOREIGN KEY (workspace_id, factory_id) REFERENCES app.factories(workspace_id, id),
  FOREIGN KEY (workspace_id, opportunity_id) REFERENCES app.opportunities(workspace_id, id),
  FOREIGN KEY (workspace_id, factory_id, opportunity_id) REFERENCES app.opportunities(workspace_id, factory_id, id),
  FOREIGN KEY (workspace_id, opportunity_id, thread_id) REFERENCES app.opportunity_threads(workspace_id, opportunity_id, thread_id),
  FOREIGN KEY (workspace_id, channel_account_id, thread_id) REFERENCES app.threads(workspace_id, channel_account_id, id),
  FOREIGN KEY (workspace_id, channel_account_id, transport_mode) REFERENCES app.channel_accounts(workspace_id, id, transport_mode),
  FOREIGN KEY (workspace_id, contact_point_id) REFERENCES app.contact_points(workspace_id, id),
  FOREIGN KEY (workspace_id, created_by_member_id) REFERENCES app.workspace_members(workspace_id, id)
);
CREATE INDEX outbound_ready_idx ON app.outbound_requests(workspace_id, scheduled_at, id) WHERE state IN ('ready','queued');
CREATE INDEX outbound_thread_idx ON app.outbound_requests(workspace_id, thread_id, created_at DESC);

CREATE TABLE app.outbound_payload_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  factory_id uuid,
  outbound_request_id uuid NOT NULL,
  version_no integer NOT NULL CHECK (version_no > 0),
  quote_version_id uuid,
  quote_snapshot_sha256 text,
  thread_context_revision bigint NOT NULL CHECK (thread_context_revision > 0),
  requirements_revision bigint CHECK (requirements_revision IS NULL OR requirements_revision > 0),
  policy_version bigint NOT NULL CHECK (policy_version > 0),
  language_code text NOT NULL,
  subject text,
  body_text text NOT NULL,
  body_html text,
  sender_snapshot jsonb NOT NULL CHECK (jsonb_typeof(sender_snapshot) = 'object'),
  recipients_snapshot jsonb NOT NULL CHECK (jsonb_typeof(recipients_snapshot) = 'array' AND jsonb_array_length(recipients_snapshot) > 0),
  attachment_manifest jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(attachment_manifest) = 'array'),
  channel_payload jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(channel_payload) = 'object'),
  snapshot_sha256 text CHECK (snapshot_sha256 IS NULL OR snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  frozen_at timestamptz,
  invalidated_at timestamptz,
  invalidation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id), UNIQUE (workspace_id, factory_id, id),
  UNIQUE (workspace_id, outbound_request_id, id),
  UNIQUE (workspace_id, outbound_request_id, id, snapshot_sha256),
  UNIQUE (workspace_id, outbound_request_id, version_no),
  CHECK (frozen_at IS NULL OR snapshot_sha256 IS NOT NULL),
  CHECK ((quote_version_id IS NULL AND quote_snapshot_sha256 IS NULL) OR
         (quote_version_id IS NOT NULL AND quote_snapshot_sha256 IS NOT NULL AND factory_id IS NOT NULL AND requirements_revision IS NOT NULL)),
  FOREIGN KEY (workspace_id, outbound_request_id) REFERENCES app.outbound_requests(workspace_id, id),
  FOREIGN KEY (workspace_id, factory_id, outbound_request_id) REFERENCES app.outbound_requests(workspace_id, factory_id, id),
  FOREIGN KEY (workspace_id, factory_id, quote_version_id, quote_snapshot_sha256) REFERENCES app.quote_versions(workspace_id, factory_id, id, snapshot_sha256)
);
ALTER TABLE app.outbound_requests ADD FOREIGN KEY (workspace_id, id, current_payload_version_id)
  REFERENCES app.outbound_payload_versions(workspace_id, outbound_request_id, id);
ALTER TABLE app.outbound_requests ADD FOREIGN KEY (workspace_id, id, dispatch_payload_version_id)
  REFERENCES app.outbound_payload_versions(workspace_id, outbound_request_id, id);

CREATE TABLE app.payload_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  factory_id uuid NOT NULL,
  payload_version_id uuid NOT NULL,
  fact_version_id uuid NOT NULL,
  usage_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id), UNIQUE (workspace_id, payload_version_id, fact_version_id, usage_key),
  FOREIGN KEY (workspace_id, factory_id, payload_version_id) REFERENCES app.outbound_payload_versions(workspace_id, factory_id, id),
  FOREIGN KEY (workspace_id, factory_id, fact_version_id) REFERENCES app.fact_versions(workspace_id, factory_id, id)
);
CREATE INDEX payload_evidence_fact_idx ON app.payload_evidence(workspace_id, fact_version_id, payload_version_id);

-- 15-16 + 19: public conversation, inbound inbox, individual attempts -------
-- Internal AI/team content has NO row type in messages; use ai_runs/team_notes.
CREATE TABLE app.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  channel_account_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  transport_mode text NOT NULL CHECK (transport_mode IN ('simulation','live')),
  direction text NOT NULL CHECK (direction IN ('inbound','outbound')),
  sender_kind text NOT NULL CHECK (sender_kind IN ('buyer','operator','assistant','external_operator')),
  provider_message_id text,
  ingest_seq bigint GENERATED ALWAYS AS IDENTITY,
  outbound_request_id uuid,
  body_text text,
  attachment_manifest jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(attachment_manifest) = 'array'),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  delivery_state text NOT NULL CHECK (delivery_state IN ('received','pending','submitted','delivered','read','failed','unknown','simulated')),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id), UNIQUE (workspace_id, thread_id, id),
  CHECK (direction <> 'inbound' OR outbound_request_id IS NULL),
  CHECK (transport_mode <> 'simulation' OR delivery_state NOT IN ('submitted','delivered','read')),
  CHECK (transport_mode <> 'live' OR delivery_state <> 'simulated'),
  FOREIGN KEY (workspace_id, channel_account_id, thread_id) REFERENCES app.threads(workspace_id, channel_account_id, id),
  FOREIGN KEY (workspace_id, channel_account_id, transport_mode) REFERENCES app.channel_accounts(workspace_id, id, transport_mode),
  FOREIGN KEY (workspace_id, channel_account_id, thread_id, outbound_request_id) REFERENCES app.outbound_requests(workspace_id, channel_account_id, thread_id, id)
);
CREATE UNIQUE INDEX messages_provider_uq ON app.messages(workspace_id, channel_account_id, provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE UNIQUE INDEX messages_outbound_request_uq ON app.messages(workspace_id, outbound_request_id) WHERE outbound_request_id IS NOT NULL;
CREATE INDEX messages_thread_idx ON app.messages(workspace_id, thread_id, occurred_at, id);
CREATE INDEX messages_read_cursor_idx ON app.messages(workspace_id, thread_id, ingest_seq);

-- Each member has an independent cursor. The command service advances it
-- monotonically by messages.ingest_seq; provider timestamps may arrive late.
CREATE TABLE app.thread_reads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  thread_id uuid NOT NULL,
  member_id uuid NOT NULL,
  last_read_message_id uuid,
  read_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1,
  UNIQUE (workspace_id, id), UNIQUE (workspace_id, thread_id, member_id),
  FOREIGN KEY (workspace_id, thread_id) REFERENCES app.threads(workspace_id, id),
  FOREIGN KEY (workspace_id, member_id) REFERENCES app.workspace_members(workspace_id, id),
  FOREIGN KEY (workspace_id, thread_id, last_read_message_id) REFERENCES app.messages(workspace_id, thread_id, id)
);

CREATE TABLE app.inbound_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  channel_account_id uuid NOT NULL,
  event_key text NOT NULL,
  event_kind text NOT NULL,
  provider_message_id text,
  payload jsonb NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processing','processed','retry','dead')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  last_error text,
  UNIQUE (workspace_id, id), UNIQUE (workspace_id, channel_account_id, event_key),
  CHECK ((state = 'processed') = (processed_at IS NOT NULL)),
  FOREIGN KEY (workspace_id, channel_account_id) REFERENCES app.channel_accounts(workspace_id, id)
);
CREATE INDEX inbound_events_ready_idx ON app.inbound_events(workspace_id, next_attempt_at, id) WHERE state IN ('pending','retry');
CREATE INDEX inbound_events_channel_barrier_idx ON app.inbound_events(workspace_id, channel_account_id, received_at, id) WHERE processed_at IS NULL;

CREATE TABLE app.delivery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  outbound_request_id uuid NOT NULL,
  payload_version_id uuid NOT NULL,
  attempt_no integer NOT NULL CHECK (attempt_no > 0),
  dispatch_token uuid NOT NULL,
  state text NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared','started','accepted','rejected','unknown','simulated')),
  provider_message_id text,
  response_code text,
  response_snapshot jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  next_retry_at timestamptz,
  error_class text CHECK (error_class IS NULL OR error_class IN ('retryable_rejection','permanent_rejection','ambiguous_outcome')),
  error_detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id), UNIQUE (workspace_id, outbound_request_id, attempt_no),
  FOREIGN KEY (workspace_id, outbound_request_id, payload_version_id) REFERENCES app.outbound_payload_versions(workspace_id, outbound_request_id, id)
);
CREATE INDEX delivery_attempts_request_idx ON app.delivery_attempts(workspace_id, outbound_request_id, created_at DESC);

-- 31-33: final recipient/message/rules snapshots for batch approval ---------
CREATE TABLE app.outreach_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  factory_id uuid NOT NULL,
  owner_member_id uuid NOT NULL,
  name text NOT NULL,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','active','paused','completed','cancelled')),
  current_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1,
  UNIQUE (workspace_id, id), UNIQUE (workspace_id, factory_id, id),
  FOREIGN KEY (workspace_id, factory_id) REFERENCES app.factories(workspace_id, id),
  FOREIGN KEY (workspace_id, owner_member_id) REFERENCES app.workspace_members(workspace_id, id)
);

CREATE TABLE app.outreach_batch_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  factory_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  version_no integer NOT NULL CHECK (version_no > 0),
  policy_version bigint NOT NULL CHECK (policy_version > 0),
  send_rules jsonb NOT NULL CHECK (jsonb_typeof(send_rules) = 'object'),
  max_followups integer NOT NULL DEFAULT 0 CHECK (max_followups >= 0),
  stop_on_reply boolean NOT NULL DEFAULT true CHECK (stop_on_reply),
  valid_until timestamptz NOT NULL,
  snapshot_sha256 text CHECK (snapshot_sha256 IS NULL OR snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  frozen_at timestamptz,
  invalidated_at timestamptz,
  invalidation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id), UNIQUE (workspace_id, factory_id, id),
  UNIQUE (workspace_id, batch_id, id), UNIQUE (workspace_id, batch_id, version_no),
  UNIQUE (workspace_id, id, snapshot_sha256),
  CHECK (frozen_at IS NULL OR snapshot_sha256 IS NOT NULL),
  FOREIGN KEY (workspace_id, factory_id, batch_id) REFERENCES app.outreach_batches(workspace_id, factory_id, id)
);
ALTER TABLE app.outreach_batches ADD FOREIGN KEY (workspace_id, id, current_version_id)
  REFERENCES app.outreach_batch_versions(workspace_id, batch_id, id);

CREATE TABLE app.outreach_batch_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  factory_id uuid NOT NULL,
  batch_version_id uuid NOT NULL,
  outbound_request_id uuid NOT NULL,
  payload_version_id uuid NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  contact_point_id uuid NOT NULL,
  step_no integer NOT NULL DEFAULT 0 CHECK (step_no >= 0),
  scheduled_at timestamptz NOT NULL,
  schedule_time_zone text NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id), UNIQUE (workspace_id, batch_version_id, position),
  UNIQUE (workspace_id, batch_version_id, outbound_request_id),
  UNIQUE (workspace_id, batch_version_id, contact_point_id, step_no),
  FOREIGN KEY (workspace_id, factory_id, batch_version_id) REFERENCES app.outreach_batch_versions(workspace_id, factory_id, id),
  FOREIGN KEY (workspace_id, factory_id, outbound_request_id) REFERENCES app.outbound_requests(workspace_id, factory_id, id),
  FOREIGN KEY (workspace_id, outbound_request_id, payload_version_id, payload_sha256) REFERENCES app.outbound_payload_versions(workspace_id, outbound_request_id, id, snapshot_sha256),
  FOREIGN KEY (workspace_id, contact_point_id) REFERENCES app.contact_points(workspace_id, id)
);
CREATE INDEX outreach_batch_items_request_idx ON app.outreach_batch_items(workspace_id, outbound_request_id);

-- 34-35: approval is tied to an actual FK target, never loose subject_id ----
CREATE TABLE app.approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  outbound_request_id uuid,
  payload_version_id uuid,
  batch_version_id uuid,
  snapshot_sha256 text NOT NULL CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  requested_by_member_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','rejected','revoked','expired','invalidated')),
  approved_by_member_id uuid,
  approved_at timestamptz,
  revoked_by_member_id uuid,
  revoked_at timestamptz,
  expires_at timestamptz NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1,
  UNIQUE (workspace_id, id),
  CHECK ((outbound_request_id IS NOT NULL AND payload_version_id IS NOT NULL AND batch_version_id IS NULL) OR
         (outbound_request_id IS NULL AND payload_version_id IS NULL AND batch_version_id IS NOT NULL)),
  CHECK (state <> 'approved' OR (approved_by_member_id IS NOT NULL AND approved_at IS NOT NULL AND revoked_at IS NULL)),
  CHECK (state <> 'revoked' OR (revoked_by_member_id IS NOT NULL AND revoked_at IS NOT NULL)),
  CHECK (expires_at > created_at),
  FOREIGN KEY (workspace_id, outbound_request_id, payload_version_id, snapshot_sha256) REFERENCES app.outbound_payload_versions(workspace_id, outbound_request_id, id, snapshot_sha256),
  FOREIGN KEY (workspace_id, batch_version_id, snapshot_sha256) REFERENCES app.outreach_batch_versions(workspace_id, id, snapshot_sha256),
  FOREIGN KEY (workspace_id, requested_by_member_id) REFERENCES app.workspace_members(workspace_id, id),
  FOREIGN KEY (workspace_id, approved_by_member_id) REFERENCES app.workspace_members(workspace_id, id),
  FOREIGN KEY (workspace_id, revoked_by_member_id) REFERENCES app.workspace_members(workspace_id, id)
);
CREATE UNIQUE INDEX approvals_live_payload_uq ON app.approvals(workspace_id, outbound_request_id, payload_version_id)
  WHERE state IN ('pending','approved') AND outbound_request_id IS NOT NULL;
CREATE UNIQUE INDEX approvals_live_batch_uq ON app.approvals(workspace_id, batch_version_id)
  WHERE state IN ('pending','approved') AND batch_version_id IS NOT NULL;
CREATE INDEX approvals_pending_idx ON app.approvals(workspace_id, created_at, id) WHERE state = 'pending';

CREATE TABLE app.approval_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  approval_id uuid NOT NULL,
  event_no integer NOT NULL CHECK (event_no > 0),
  event_kind text NOT NULL CHECK (event_kind IN ('requested','approved','rejected','revoked','expired','invalidated','revocation_too_late')),
  actor_member_id uuid,
  reason text,
  details jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id), UNIQUE (workspace_id, approval_id, event_no),
  FOREIGN KEY (workspace_id, approval_id) REFERENCES app.approvals(workspace_id, id),
  FOREIGN KEY (workspace_id, actor_member_id) REFERENCES app.workspace_members(workspace_id, id)
);

-- 36: a scheduled next action is not synonymous with permission to send ----
CREATE TABLE app.followups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  factory_id uuid NOT NULL,
  opportunity_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  owner_member_id uuid NOT NULL,
  quote_version_id uuid,
  outbound_request_id uuid,
  purpose text NOT NULL,
  execution_mode text NOT NULL DEFAULT 'manual' CHECK (execution_mode IN ('manual','approved_automatic')),
  state text NOT NULL DEFAULT 'scheduled' CHECK (state IN ('scheduled','ready','executing','completed','paused','cancelled','failed')),
  due_at timestamptz NOT NULL,
  time_zone text NOT NULL,
  baseline_thread_revision bigint NOT NULL CHECK (baseline_thread_revision > 0),
  baseline_requirements_revision bigint NOT NULL CHECK (baseline_requirements_revision > 0),
  stop_on_reply boolean NOT NULL DEFAULT true CHECK (stop_on_reply),
  stop_conditions jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(stop_conditions) = 'object'),
  stop_reason text,
  completed_at timestamptz,
  dedupe_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1,
  UNIQUE (workspace_id, id), UNIQUE (workspace_id, dedupe_key),
  FOREIGN KEY (workspace_id, factory_id, opportunity_id) REFERENCES app.opportunities(workspace_id, factory_id, id),
  FOREIGN KEY (workspace_id, opportunity_id, thread_id) REFERENCES app.opportunity_threads(workspace_id, opportunity_id, thread_id),
  FOREIGN KEY (workspace_id, owner_member_id) REFERENCES app.workspace_members(workspace_id, id),
  FOREIGN KEY (workspace_id, factory_id, quote_version_id) REFERENCES app.quote_versions(workspace_id, factory_id, id),
  FOREIGN KEY (workspace_id, factory_id, opportunity_id, thread_id, outbound_request_id) REFERENCES app.outbound_requests(workspace_id, factory_id, opportunity_id, thread_id, id)
);
CREATE INDEX followups_due_idx ON app.followups(workspace_id, due_at, id) WHERE state IN ('scheduled','ready');
CREATE INDEX followups_opportunity_idx ON app.followups(workspace_id, opportunity_id, state);

-- 37-39 + 41: reliable jobs, audit, internal AI and notes -------------------
CREATE TABLE app.outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  event_type text NOT NULL,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  aggregate_version bigint,
  handler_key text NOT NULL,
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL,
  pg_boss_job_id uuid,
  enqueued_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id), UNIQUE (workspace_id, handler_key, idempotency_key),
  CHECK ((pg_boss_job_id IS NULL) = (enqueued_at IS NULL))
);
CREATE INDEX outbox_aggregate_idx ON app.outbox_events(workspace_id, aggregate_type, aggregate_id, created_at);

CREATE TABLE app.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  actor_member_id uuid,
  actor_kind text NOT NULL CHECK (actor_kind IN ('member','system','provider')),
  action text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  correlation_id uuid,
  details jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(details) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  CHECK (actor_kind <> 'member' OR actor_member_id IS NOT NULL),
  FOREIGN KEY (workspace_id, actor_member_id) REFERENCES app.workspace_members(workspace_id, id)
);
CREATE INDEX audit_aggregate_idx ON app.audit_events(workspace_id, aggregate_type, aggregate_id, occurred_at DESC);

CREATE TABLE app.ai_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  factory_id uuid,
  thread_id uuid,
  opportunity_id uuid,
  trigger_message_id uuid,
  provider text NOT NULL,
  model_id text NOT NULL,
  prompt_version text NOT NULL,
  execution_mode text NOT NULL CHECK (execution_mode IN ('preset','model')),
  state text NOT NULL CHECK (state IN ('running','succeeded','failed','cancelled')),
  input_references jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(input_references) = 'object'),
  proposed_action jsonb,
  explanation_summary text,
  validation_result jsonb,
  input_tokens bigint CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens bigint CHECK (output_tokens IS NULL OR output_tokens >= 0),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  error_detail text,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, factory_id) REFERENCES app.factories(workspace_id, id),
  FOREIGN KEY (workspace_id, thread_id) REFERENCES app.threads(workspace_id, id),
  FOREIGN KEY (workspace_id, opportunity_id) REFERENCES app.opportunities(workspace_id, id),
  FOREIGN KEY (workspace_id, factory_id, opportunity_id) REFERENCES app.opportunities(workspace_id, factory_id, id),
  FOREIGN KEY (workspace_id, trigger_message_id) REFERENCES app.messages(workspace_id, id)
);
CREATE INDEX ai_runs_thread_idx ON app.ai_runs(workspace_id, thread_id, started_at DESC);

CREATE TABLE app.team_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  thread_id uuid,
  opportunity_id uuid,
  author_member_id uuid NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1,
  UNIQUE (workspace_id, id),
  CHECK (num_nonnulls(thread_id, opportunity_id) >= 1),
  FOREIGN KEY (workspace_id, thread_id) REFERENCES app.threads(workspace_id, id),
  FOREIGN KEY (workspace_id, opportunity_id) REFERENCES app.opportunities(workspace_id, id),
  FOREIGN KEY (workspace_id, author_member_id) REFERENCES app.workspace_members(workspace_id, id)
);
CREATE INDEX team_notes_thread_idx ON app.team_notes(workspace_id, thread_id, created_at);

-- Mandatory target-freeze gate. Foreign keys above additionally bind hashes.
CREATE FUNCTION app.require_frozen_approval_target() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_frozen timestamptz; target_auth_mode text;
BEGIN
  IF NEW.payload_version_id IS NOT NULL THEN
    SELECT frozen_at INTO target_frozen FROM app.outbound_payload_versions
      WHERE workspace_id = NEW.workspace_id AND id = NEW.payload_version_id FOR SHARE;
    SELECT authorization_mode INTO target_auth_mode FROM app.outbound_requests
      WHERE workspace_id = NEW.workspace_id AND id = NEW.outbound_request_id;
    IF target_auth_mode IS DISTINCT FROM 'human_approval' THEN
      RAISE EXCEPTION 'Individual approval requires a human_approval request';
    END IF;
  ELSE
    SELECT frozen_at INTO target_frozen FROM app.outreach_batch_versions
      WHERE workspace_id = NEW.workspace_id AND id = NEW.batch_version_id FOR SHARE;
  END IF;
  IF target_frozen IS NULL THEN RAISE EXCEPTION 'Approval target must already be frozen'; END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION app.require_frozen_batch_payload() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_frozen timestamptz;
BEGIN
  SELECT frozen_at INTO target_frozen FROM app.outbound_payload_versions
    WHERE workspace_id = NEW.workspace_id AND id = NEW.payload_version_id FOR SHARE;
  IF target_frozen IS NULL THEN RAISE EXCEPTION 'Referenced outgoing payload must already be frozen'; END IF;
  RETURN NEW;
END
$$;

-- Coherence checks bridge nullable intake context to immutable quote context.
-- These check identity relationships, not the changing send-eligibility rules.
CREATE FUNCTION app.validate_payload_context() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request_row record; quote_row record;
BEGIN
  SELECT factory_id, opportunity_id, intent INTO request_row
    FROM app.outbound_requests
    WHERE workspace_id = NEW.workspace_id AND id = NEW.outbound_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Outgoing request does not exist in workspace'; END IF;
  IF NEW.factory_id IS DISTINCT FROM request_row.factory_id THEN
    RAISE EXCEPTION 'Payload factory must equal its request factory, including NULL';
  END IF;
  IF NEW.quote_version_id IS NOT NULL THEN
    SELECT q.opportunity_id, v.requirements_revision, v.frozen_at INTO quote_row
      FROM app.quote_versions v JOIN app.quotes q
        ON q.workspace_id = v.workspace_id AND q.id = v.quote_id
      WHERE v.workspace_id = NEW.workspace_id AND v.id = NEW.quote_version_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Quote version does not exist in workspace'; END IF;
    IF quote_row.opportunity_id IS DISTINCT FROM request_row.opportunity_id OR
       quote_row.requirements_revision IS DISTINCT FROM NEW.requirements_revision THEN
      RAISE EXCEPTION 'Payload quote must belong to the request opportunity and requirement revision';
    END IF;
    IF NEW.frozen_at IS NOT NULL AND quote_row.frozen_at IS NULL THEN
      RAISE EXCEPTION 'Freeze quote business snapshot before freezing outgoing payload';
    END IF;
  ELSIF NEW.frozen_at IS NOT NULL AND request_row.intent = 'quote' THEN
    RAISE EXCEPTION 'A frozen quote payload requires a quote version';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION app.validate_batch_item_context() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request_row record;
BEGIN
  SELECT contact_point_id, authorization_mode INTO request_row
    FROM app.outbound_requests
    WHERE workspace_id = NEW.workspace_id AND id = NEW.outbound_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch outgoing request does not exist'; END IF;
  IF NEW.contact_point_id IS DISTINCT FROM request_row.contact_point_id OR
     request_row.authorization_mode <> 'batch_approval' THEN
    RAISE EXCEPTION 'Batch item must match its recipient and batch-approved request';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION app.validate_followup_quote_context() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE quote_opportunity_id uuid;
BEGIN
  IF NEW.quote_version_id IS NOT NULL THEN
    SELECT q.opportunity_id INTO quote_opportunity_id
      FROM app.quote_versions v JOIN app.quotes q
        ON q.workspace_id = v.workspace_id AND q.id = v.quote_id
      WHERE v.workspace_id = NEW.workspace_id AND v.id = NEW.quote_version_id;
    IF quote_opportunity_id IS DISTINCT FROM NEW.opportunity_id THEN
      RAISE EXCEPTION 'Follow-up quote must belong to its opportunity';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- Automatic revision bumps for meaningful inbound context / requirement edits
-- are command-handler responsibilities: avoid bumping on delivery receipts or
-- unrelated UI edits. These triggers only maintain generic row_version.
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'workspaces','app_users','workspace_members','factories','buyers','contacts',
    'contact_points','contact_permissions','leads','opportunities','channel_accounts',
    'threads','products','source_documents','facts','quotes','outbound_requests',
    'outreach_batches','approvals','followups','team_notes','thread_reads'
  ] LOOP
    EXECUTE format('CREATE TRIGGER touch_row BEFORE UPDATE ON app.%I FOR EACH ROW EXECUTE FUNCTION app.touch_row()', table_name);
  END LOOP;
END
$$;

CREATE TRIGGER source_version_frozen BEFORE UPDATE OR DELETE ON app.source_versions FOR EACH ROW
  EXECUTE FUNCTION app.guard_frozen_content('revoked_at','revocation_reason');
CREATE TRIGGER fact_version_frozen BEFORE UPDATE OR DELETE ON app.fact_versions FOR EACH ROW
  EXECUTE FUNCTION app.guard_frozen_content('state','invalidated_at','invalidation_reason');
CREATE TRIGGER price_rule_frozen BEFORE UPDATE OR DELETE ON app.price_rules FOR EACH ROW
  EXECUTE FUNCTION app.guard_frozen_content();
CREATE TRIGGER quote_version_frozen BEFORE UPDATE OR DELETE ON app.quote_versions FOR EACH ROW
  EXECUTE FUNCTION app.guard_frozen_content('state','invalidated_at','invalidation_reason');
CREATE TRIGGER payload_version_frozen BEFORE UPDATE OR DELETE ON app.outbound_payload_versions FOR EACH ROW
  EXECUTE FUNCTION app.guard_frozen_content('invalidated_at','invalidation_reason');
CREATE TRIGGER batch_version_frozen BEFORE UPDATE OR DELETE ON app.outreach_batch_versions FOR EACH ROW
  EXECUTE FUNCTION app.guard_frozen_content('invalidated_at','invalidation_reason');

CREATE TRIGGER fact_evidence_parent BEFORE INSERT OR UPDATE OR DELETE ON app.fact_evidence FOR EACH ROW
  EXECUTE FUNCTION app.guard_frozen_parent('fact_versions','fact_version_id');
CREATE TRIGGER quote_lines_parent BEFORE INSERT OR UPDATE OR DELETE ON app.quote_lines FOR EACH ROW
  EXECUTE FUNCTION app.guard_frozen_parent('quote_versions','quote_version_id');
CREATE TRIGGER quote_evidence_parent BEFORE INSERT OR UPDATE OR DELETE ON app.quote_evidence FOR EACH ROW
  EXECUTE FUNCTION app.guard_frozen_parent('quote_versions','quote_version_id');
CREATE TRIGGER payload_evidence_parent BEFORE INSERT OR UPDATE OR DELETE ON app.payload_evidence FOR EACH ROW
  EXECUTE FUNCTION app.guard_frozen_parent('outbound_payload_versions','payload_version_id');
CREATE TRIGGER batch_items_parent BEFORE INSERT OR UPDATE OR DELETE ON app.outreach_batch_items FOR EACH ROW
  EXECUTE FUNCTION app.guard_frozen_parent('outreach_batch_versions','batch_version_id');
CREATE TRIGGER batch_item_payload_frozen BEFORE INSERT OR UPDATE ON app.outreach_batch_items FOR EACH ROW
  EXECUTE FUNCTION app.require_frozen_batch_payload();
CREATE TRIGGER approval_target_frozen BEFORE INSERT ON app.approvals FOR EACH ROW
  EXECUTE FUNCTION app.require_frozen_approval_target();
CREATE TRIGGER delivery_payload_frozen BEFORE INSERT ON app.delivery_attempts FOR EACH ROW
  EXECUTE FUNCTION app.require_frozen_batch_payload();
CREATE TRIGGER payload_context BEFORE INSERT OR UPDATE ON app.outbound_payload_versions FOR EACH ROW
  EXECUTE FUNCTION app.validate_payload_context();
CREATE TRIGGER batch_item_context BEFORE INSERT OR UPDATE ON app.outreach_batch_items FOR EACH ROW
  EXECUTE FUNCTION app.validate_batch_item_context();
CREATE TRIGGER followup_quote_context BEFORE INSERT OR UPDATE ON app.followups FOR EACH ROW
  EXECUTE FUNCTION app.validate_followup_quote_context();

CREATE TRIGGER approval_target_immutable BEFORE UPDATE ON app.approvals FOR EACH ROW
  EXECUTE FUNCTION app.guard_identity_fields('id','workspace_id','outbound_request_id','payload_version_id','batch_version_id','snapshot_sha256','requested_by_member_id','expires_at','created_at');
CREATE TRIGGER channel_identity_immutable BEFORE UPDATE ON app.channel_accounts FOR EACH ROW
  EXECUTE FUNCTION app.guard_identity_fields('id','workspace_id','channel_kind','transport_mode','provider','external_account_key');
CREATE TRIGGER quote_identity_immutable BEFORE UPDATE ON app.quotes FOR EACH ROW
  EXECUTE FUNCTION app.guard_identity_fields('id','workspace_id','factory_id','opportunity_id','buyer_id');
CREATE TRIGGER request_identity_immutable BEFORE UPDATE ON app.outbound_requests FOR EACH ROW
  EXECUTE FUNCTION app.guard_identity_fields('id','workspace_id','factory_id','opportunity_id','thread_id','channel_account_id','transport_mode','contact_point_id','intent','authorization_mode','idempotency_key','command_sha256','provider_idempotency_key');
CREATE TRIGGER message_content_immutable BEFORE UPDATE ON app.messages FOR EACH ROW
  EXECUTE FUNCTION app.guard_identity_fields('id','workspace_id','channel_account_id','thread_id','transport_mode','direction','sender_kind','outbound_request_id','body_text','attachment_manifest','content_sha256','ingest_seq','occurred_at','received_at','created_at');
CREATE TRIGGER inbound_event_content_immutable BEFORE UPDATE ON app.inbound_events FOR EACH ROW
  EXECUTE FUNCTION app.guard_identity_fields('id','workspace_id','channel_account_id','event_key','event_kind','provider_message_id','payload','payload_sha256','occurred_at','received_at');
CREATE TRIGGER outbox_event_content_immutable BEFORE UPDATE ON app.outbox_events FOR EACH ROW
  EXECUTE FUNCTION app.guard_identity_fields('id','workspace_id','event_type','schema_version','aggregate_type','aggregate_id','aggregate_version','handler_key','idempotency_key','payload','created_at');
CREATE TRIGGER approval_events_append_only BEFORE UPDATE OR DELETE ON app.approval_events FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON app.audit_events FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- Tenant guard on every workspace-owned business table. RLS does not replace
-- factory access checks, disclosure filtering, approver policy or auth checks.
DO $$
DECLARE table_name text;
BEGIN
  FOR table_name IN
    SELECT t.table_name FROM information_schema.tables t
      WHERE t.table_schema = 'app' AND t.table_type = 'BASE TABLE'
        AND t.table_name NOT IN ('workspaces','app_users')
  LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY workspace_scope ON app.%I FOR ALL USING (workspace_id = app.current_workspace_id()) WITH CHECK (workspace_id = app.current_workspace_id())', table_name);
  END LOOP;
END
$$;

ALTER TABLE app.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_scope ON app.workspaces FOR ALL
  USING (id = app.current_workspace_id()) WITH CHECK (id = app.current_workspace_id());

ALTER TABLE app.app_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.app_users FORCE ROW LEVEL SECURITY;
CREATE POLICY user_read_scope ON app.app_users FOR SELECT USING (
  id = app.current_user_id() OR EXISTS (
    SELECT 1 FROM app.workspace_members m
    WHERE m.workspace_id = app.current_workspace_id() AND m.user_id = app.app_users.id
  )
);
CREATE POLICY user_insert_scope ON app.app_users FOR INSERT WITH CHECK (id = app.current_user_id());
CREATE POLICY user_update_scope ON app.app_users FOR UPDATE
  USING (id = app.current_user_id()) WITH CHECK (id = app.current_user_id());

-- Restrict PUBLIC explicitly; production deploy grants named roles only.
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA app FROM PUBLIC;

COMMENT ON TABLE app.messages IS 'External inbound/outbound history only. Internal content belongs to team_notes and ai_runs.';
COMMENT ON TABLE app.approvals IS 'Revocable authorization of an exact frozen payload or exact frozen batch; never general permission to send.';
COMMENT ON TABLE app.outbox_events IS 'Immutable event identity/replay audit, inserted atomically with business change and pg-boss enqueue. No independent publisher; handlers are idempotent.';
COMMENT ON TABLE app.price_rules IS 'Immutable typed tiers using [qty_min, qty_max); validity and fact status must be rechecked when quoting/sending.';
COMMENT ON TABLE app.fact_evidence IS 'Immutable published fact-to-source-version dependency; source invalidation must propagate and be checked at dispatch.';
COMMENT ON COLUMN app.outbound_payload_versions.attachment_manifest IS 'Frozen array of object_key, object_version, sha256, filename, content_type and size; gateway must verify bytes and authorization.';
COMMENT ON COLUMN app.messages.provider_message_id IS 'Provider identity is scoped by channel_account_id. Provider callbacks update state; they do not create duplicate messages.';
COMMENT ON COLUMN app.inbound_events.event_key IS 'Adapter canonical dedupe key includes event kind/status where needed; do not dedupe all delivery receipts by message ID alone.';
COMMENT ON COLUMN app.contact_permissions.do_not_contact IS 'Suppression wins over allow. Gateway checks applicable scopes and current channel policy before every attempt.';
COMMENT ON COLUMN app.followups.time_zone IS 'Retain IANA zone separately: timestamptz stores an instant and does not retain the original zone.';
COMMENT ON COLUMN app.quote_lines.line_amount IS 'Unsigned component; discount rows subtract. Server recomputes all line amounts and totals before freezing.';
COMMENT ON COLUMN app.outbound_requests.authorization_mode IS 'member_send is ordinary authorized human reply only. Commercial claims still require owner approval and the same sending gateway.';
COMMENT ON COLUMN app.outbound_requests.dispatch_claimed_at IS 'Committed acquisition of send rights; this is the revocation cutoff, before actual HTTP start.';
COMMENT ON TABLE app.thread_reads IS 'Per-member read cursor; moving one member cursor does not mark a thread read for other members.';

COMMIT;
