// ════════════════════════════════════════════════════════════════
// Checkout Champ order state — dedup + PARTIAL→COMPLETE transition store
// ────────────────────────────────────────────────────────────────
// Serverless functions share no memory between invocations, so "record a
// purchase exactly once" and "dedupe retries by orderId" need a durable store.
// This uses Neon Postgres (Vercel Marketplace) via @neondatabase/serverless.
//
// One row per orderId in `processed_orders`:
//   - the row EXISTING       = "we have seen this order" (any status). A PARTIAL
//                              order is remembered here, never permanently
//                              ignored — its status is refreshed on every
//                              postback so a later COMPLETE is re-evaluated.
//   - purchase_recorded_at   = set EXACTLY ONCE, the first time the order
//                              satisfies COMPLETE + NEW_SALE. This single
//                              timestamp is both the dedup key (retries find it
//                              already set) and the transition marker (it flips
//                              null→now the moment PARTIAL becomes COMPLETE).
// ════════════════════════════════════════════════════════════════

const CONNECTION_STRING =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.POSTGRES_URL_NON_POOLING;

let _neon = null;
let _sql = null;

// Lazy so importing this module never crashes if the dep/env is absent —
// callers get a thrown error only when they actually try to use the store,
// which the webhook turns into a fail-closed 500 (see checkout-champ.js).
function db() {
  if (!CONNECTION_STRING) return null;
  if (!_sql) {
    if (!_neon) ({ neon: _neon } = require('@neondatabase/serverless'));
    _sql = _neon(CONNECTION_STRING);
  }
  return _sql;
}

function storeConfigured() {
  return !!CONNECTION_STRING;
}

// Idempotent auto-migration, memoized per warm instance so the DDL runs at most
// once per cold start (CREATE TABLE IF NOT EXISTS is a no-op afterwards).
let _schemaReady = null;
function ensureSchema(sql) {
  if (!_schemaReady) {
    _schemaReady = sql`
      CREATE TABLE IF NOT EXISTS processed_orders (
        order_id             TEXT PRIMARY KEY,
        status               TEXT,
        order_type           TEXT,
        value                NUMERIC,
        currency             TEXT,
        purchase_recorded_at TIMESTAMPTZ,
        first_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
      )`.then(() => true).catch((err) => {
        _schemaReady = null; // allow a retry on the next request
        throw err;
      });
  }
  return _schemaReady;
}

// Upsert the "seen" row for an order at its current status. Never records a
// purchase — it only guarantees the row exists and reflects the latest status,
// which is what lets a PARTIAL order be re-checked on its next postback.
function markSeen(sql, { orderId, status, orderType, value, currency }) {
  return sql`
    INSERT INTO processed_orders (order_id, status, order_type, value, currency)
    VALUES (${orderId}, ${status}, ${orderType}, ${value}, ${currency})
    ON CONFLICT (order_id) DO UPDATE SET
      status     = ${status},
      order_type = ${orderType},
      value      = ${value},
      currency   = ${currency},
      updated_at = now()`;
}

// Atomically claim the one-time purchase record for this order.
// The WHERE guard makes this race-safe: concurrent retries serialize on the row
// lock, and only the first UPDATE sees purchase_recorded_at IS NULL, so exactly
// one caller gets a row back. Returns true iff THIS call won the claim.
async function claimPurchase(sql, orderId) {
  const rows = await sql`
    UPDATE processed_orders
       SET purchase_recorded_at = now(),
           updated_at = now()
     WHERE order_id = ${orderId}
       AND purchase_recorded_at IS NULL
    RETURNING order_id`;
  return rows.length > 0;
}

// Full decision for one incoming postback.
//   1. mark the order seen (so PARTIAL is remembered, status refreshed)
//   2. if it is a COMPLETE + NEW_SALE, atomically claim the purchase
// Returns { shouldForward, reason }:
//   shouldForward=true  → this postback is the single authoritative purchase;
//                         forward to Meta CAPI + TikTok + PostHog.
//   shouldForward=false → PARTIAL / non-NEW_SALE (reason 'not_completed_new_sale')
//                         or a retry of an already-recorded order ('duplicate').
async function recordOrder({ orderId, status, orderType, value, currency, isCompletedNewSale }) {
  const sql = db();
  if (!sql) throw new Error('orders store not configured (set DATABASE_URL / POSTGRES_URL)');
  await ensureSchema(sql);
  await markSeen(sql, { orderId, status, orderType, value, currency });

  if (!isCompletedNewSale) {
    return { shouldForward: false, reason: 'not_completed_new_sale' };
  }
  const won = await claimPurchase(sql, orderId);
  return { shouldForward: won, reason: won ? 'recorded' : 'duplicate' };
}

module.exports = { storeConfigured, recordOrder };
