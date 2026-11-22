-- BYOK is disabled. Honor all remaining prepaid plan time with standard AI allowance,
-- including the discounted tail of a mixed plan. Keep the existing monthly spend window,
-- paid-through date, balance, and original payment records unchanged.
-- A discounted Stars payment or BTCPay invoice that settles later gets the same
-- standard coverage at its original price, once per charge; this migration does not replay it.
UPDATE users
SET allowance_until = paid_until, plan_byok = 0, plan_started = COALESCE(plan_started, unixepoch())
WHERE paid_until > unixepoch() AND COALESCE(allowance_until, 0) < paid_until;

-- Keep cancellation work (including completed IDs for deduplication) independent of
-- users.sub_charge_id: a new standard subscription must not erase a pending cancellation.
CREATE TABLE legacy_stars_cancellations (
  charge_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  lease_until INTEGER,
  canceled_at INTEGER
);
CREATE INDEX legacy_stars_pending ON legacy_stars_cancellations(user_id) WHERE canceled_at IS NULL;

INSERT INTO legacy_stars_cancellations (charge_id, user_id, canceled_at)
SELECT p.charge_id, u.id, CASE WHEN u.sub_state = 'canceled' THEN unixepoch() END
FROM users u JOIN payments p ON p.charge_id = u.sub_charge_id AND p.user_id = u.id
WHERE u.sub_state IN ('active', 'failed', 'canceled') AND p.method = 'stars' AND p.kind = 'monthly' AND p.byok = 1;
