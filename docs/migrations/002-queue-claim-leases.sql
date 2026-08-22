-- Reclaim queue work after a worker exits before acknowledging it.

ALTER TABLE outbound_queue
  ADD COLUMN IF NOT EXISTS claimed_by text NULL,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz NULL;

CREATE INDEX IF NOT EXISTS outbound_queue_claim_idx
  ON outbound_queue (status, lease_expires_at, next_retry_at)
  WHERE status IN ('pending', 'in_flight');

CREATE OR REPLACE FUNCTION claim_queue_items(p_max int, p_worker_id text)
RETURNS SETOF outbound_queue
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE outbound_queue q
     SET status = 'in_flight',
         claimed_by = p_worker_id,
         lease_expires_at = now() + interval '5 minutes',
         updated_at = now()
   WHERE q.id IN (
     SELECT id
       FROM outbound_queue
      WHERE (status = 'pending' AND next_retry_at <= now())
         OR (
           status = 'in_flight'
           AND (lease_expires_at IS NULL OR lease_expires_at <= now())
         )
      ORDER BY next_retry_at
      FOR UPDATE SKIP LOCKED
      LIMIT p_max
   )
   RETURNING q.*;
END;
$$;
