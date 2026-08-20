-- ============================================================================
-- 001-state-and-queue.sql
--
-- Purpose
--   Initial Supabase schema for the apointoo-headless-booking kit:
--     1. `booking_state`   — durable lifecycle state per submission
--                            (BookingStateStore — src/adapters/state/supabase.ts)
--     2. `outbound_queue`  — durable notification queue
--                            (OutboundQueue   — src/queue/supabase.ts)
--     3. `claim_queue_items(p_max int, p_worker_id text)` — atomic worker claim
--                            via SELECT FOR UPDATE SKIP LOCKED.
--
-- Cross-references
--   docs/architecture.md — queue, state, and multi-tenant boundaries
--   SECURITY.md — deployment responsibilities
--
-- PHI minimization
--   The state table is metadata-only. It MUST NOT carry name, phone, email,
--   message, date-of-birth, or appointment free-text. Those stay in the
--   vendor (BLVD / OpenDental) and the operator email.
--   Queue rows DO carry PHI (rendered email/WhatsApp payloads). HIPAA-bound
--   tenants must use a Supabase project with a BAA (Enterprise plan) or
--   encrypt-at-rest at the application layer before enqueue.
--
-- How to run
--   Option A (CLI):       supabase db push
--   Option B (dashboard): paste this file into the Supabase SQL editor and run.
--
-- Idempotency
--   Uses `IF NOT EXISTS` where supported so the script is safe to re-run.
--   `CREATE OR REPLACE FUNCTION` makes the RPC safe to re-run too.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. booking_state — durable lifecycle state per submission
-- ---------------------------------------------------------------------------
-- Source of truth for columns: src/adapters/state/supabase.ts (the kit's
-- adapter is what reads/writes this table — the ADR text is descriptive,
-- the code is normative).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS booking_state (
  submission_id           text PRIMARY KEY,
  tenant_id               text NOT NULL,
  status                  text NOT NULL
                            CHECK (status IN ('pending','confirmed','cancelled','failed','abandoned')),
  vendor                  text NOT NULL,
  vendor_appointment_id   text NULL,
  appointment_start_iso   timestamptz NULL,
  gclid                   text NULL,
  fbclid                  text NULL,
  msclkid                 text NULL,
  rwg_token               text NULL,
  utm_source              text NULL,
  utm_medium              text NULL,
  utm_campaign            text NULL,
  attribution             jsonb NULL,
  error_code              text NULL,
  retry_count             int NOT NULL DEFAULT 0,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  conversion_sent_at      timestamptz NULL
);

-- Back-compat for projects created before the `attribution` column existed.
-- Safe to re-run; no-op once the column is present. The kit persists the FULL
-- BookingAttribution snapshot here (the flat gclid/utm_* columns above stay for
-- back-compat). PHI-minimization holds: attribution carries no name/phone/email.
ALTER TABLE booking_state
  ADD COLUMN IF NOT EXISTS attribution jsonb NULL;

-- Sweeper input (BookingStateStore.findStale): pending rows older than TTL.
CREATE INDEX IF NOT EXISTS booking_state_pending_idx
  ON booking_state (status, created_at)
  WHERE status = 'pending';

-- Conversion uploader input (BookingStateStore.findForConversion):
-- confirmed rows that have not yet been uploaded to ad networks.
CREATE INDEX IF NOT EXISTS booking_state_for_conversion_idx
  ON booking_state (status, conversion_sent_at)
  WHERE status = 'confirmed' AND conversion_sent_at IS NULL;

-- Tenant-scoped listings + health-counts (ADR-007 multi-tenant resolver).
CREATE INDEX IF NOT EXISTS booking_state_tenant_idx
  ON booking_state (tenant_id, created_at);

-- ---- RLS ----
-- Per ADR-015, RLS is the multi-tenant isolation boundary on Supabase.
-- The kit itself talks to Supabase exclusively via the SERVICE_ROLE key,
-- which BYPASSES RLS automatically — no policy is required for kit internals.
--
-- We still ENABLE RLS so that the anon/public key CANNOT read state rows
-- (defense-in-depth: an accidentally-leaked anon key must not expose
-- submission metadata, attribution IDs, or per-tenant counts).
--
-- If a consumer later wants to expose booking state to a signed-in operator
-- via the anon key + Supabase Auth, they add a policy of their own — the kit
-- does not ship one because it never reads state from the anon side.
ALTER TABLE booking_state ENABLE ROW LEVEL SECURITY;


-- ---------------------------------------------------------------------------
-- 2. outbound_queue — durable notification queue
-- ---------------------------------------------------------------------------
-- Source of truth for columns: src/queue/supabase.ts. Note that `id` is
-- TEXT (not uuid) because the adapter generates application-side IDs of
-- shape `q_<base36-ts>_<base36-rand>` and POSTs them; using `uuid` here
-- would force a server-side default and break that round-trip.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS outbound_queue (
  id              text PRIMARY KEY,
  tenant_id       text NOT NULL,
  submission_id   text NOT NULL,
  channel         text NOT NULL
                    CHECK (channel IN ('email','whatsapp','sms','webhook')),
  payload         jsonb NOT NULL,
  status          text NOT NULL
                    CHECK (status IN ('pending','in_flight','done','failed','dead'))
                    DEFAULT 'pending',
  attempts        int NOT NULL DEFAULT 0,
  last_error      text NULL,
  next_retry_at   timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Hot path for `claim_queue_items`: only pending rows, ordered by readiness.
CREATE INDEX IF NOT EXISTS outbound_queue_ready_idx
  ON outbound_queue (next_retry_at)
  WHERE status = 'pending';

-- ---- RLS ----
-- Same rationale as booking_state: service_role bypasses, anon must NOT read.
-- Queue payloads contain PHI (rendered email/WhatsApp bodies) — leaking the
-- anon key must not expose them.
ALTER TABLE outbound_queue ENABLE ROW LEVEL SECURITY;


-- ---------------------------------------------------------------------------
-- 3. claim_queue_items(p_max int, p_worker_id text)
-- ---------------------------------------------------------------------------
-- Atomic claim used by `supabaseQueue.claim()` (src/queue/supabase.ts). The
-- adapter POSTs to /rpc/claim_queue_items with `{ p_max, p_worker_id }` and
-- expects the updated rows back, shaped exactly like `outbound_queue` (the
-- adapter maps snake_case -> camelCase in `rowToItem`).
--
-- `p_worker_id` is currently unused inside the function — kept in the
-- signature for forward compatibility (visibility/lease tracking later)
-- and because the calling adapter always sends it.
--
-- Concurrency: `FOR UPDATE SKIP LOCKED` is the whole point. Two workers
-- calling claim() at the same time must never receive the same row.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION claim_queue_items(p_max int, p_worker_id text)
RETURNS SETOF outbound_queue
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  UPDATE outbound_queue q
     SET status = 'in_flight',
         updated_at = now()
   WHERE q.id IN (
     SELECT id
       FROM outbound_queue
      WHERE status = 'pending'
        AND next_retry_at <= now()
      ORDER BY next_retry_at
      FOR UPDATE SKIP LOCKED
      LIMIT p_max
   )
   RETURNING q.*;
END;
$$;


-- ============================================================================
-- Rollback (manual — run in reverse order)
-- ============================================================================
--   DROP FUNCTION IF EXISTS claim_queue_items(int, text);
--   DROP TABLE    IF EXISTS outbound_queue;
--   DROP TABLE    IF EXISTS booking_state;
--
-- Note: dropping the tables drops their indexes and RLS state with them.
-- ============================================================================
