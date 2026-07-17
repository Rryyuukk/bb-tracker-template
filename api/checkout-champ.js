const crypto = require('crypto');
const {
  pixelByKey, metaPixelByKey, sha256, clientIp,
  sendCapiEvent, buildMetaUserData, sendMetaCapiEvent, phCapture,
} = require('./capi/_lib.js');
const { recordOrder } = require('./capi/_orders.js');

// ════════════════════════════════════════════════════════════════
// Checkout Champ → Meta CAPI + TikTok CAPI + PostHog (dashboard)
// ────────────────────────────────────────────────────────────────
// Checkout Champ posts back order/upsell/rebill events (GET query string or
// POST JSON). Unlike Shopify there is no HMAC signature, so we authenticate
// with a shared token (CHECKOUT_CHAMP_WEBHOOK_SECRET) — fail-closed.
//
// Pixel routing (which product/market KEY to use), in priority order:
//   1. explicit `pixel_key` / `page_id` field in the postback
//   2. CHECKOUT_CHAMP_CAMPAIGN_MAPPING  (JSON: { "<campaignId>": "<KEY>" })
//   3. CHECKOUT_CHAMP_DEFAULT_KEY       (fallback)
// ════════════════════════════════════════════════════════════════

function loadCampaignMapping() {
  const raw = process.env.CHECKOUT_CHAMP_CAMPAIGN_MAPPING;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error('[checkout-champ] Invalid CHECKOUT_CHAMP_CAMPAIGN_MAPPING JSON:', e.message);
    return {};
  }
}
const CAMPAIGN_MAP = loadCampaignMapping();

// ── Server-side Meta CAPI Purchase: DISABLED by default ──
// The merchant checkout platform (Checkout Champ / Shopify) owns the single Meta
// Purchase via its own pixel. BB Tracker must NOT forward a second Purchase from
// here — its event_id (cc_purchase_<orderId>) can't dedup against the platform's,
// so Meta would double-count. Deny by default.
// Flip CHECKOUT_CHAMP_META_PURCHASE=on ONLY to make THIS endpoint the sole Meta
// Purchase sender (i.e. when NO platform-native Meta pixel exists for the order).
// TikTok CAPI and the PostHog dashboard mirror below are UNAFFECTED by this flag.
const META_PURCHASE_ENABLED = /^(1|true|on|yes)$/i.test(process.env.CHECKOUT_CHAMP_META_PURCHASE || '');

// Map incoming CC event type → platform event names + action source.
// Returning null = acknowledge but don't forward (e.g. declines/refunds).
const EVENT_TYPES = {
  purchase:  { meta: 'Purchase', tiktok: 'CompletePayment', action_source: 'website' },
  sale:      { meta: 'Purchase', tiktok: 'CompletePayment', action_source: 'website' },
  upsell:    { meta: 'Purchase', tiktok: 'CompletePayment', action_source: 'website' },
  rebill:    { meta: 'Purchase', tiktok: 'CompletePayment', action_source: 'system_generated' },
  recurring: { meta: 'Purchase', tiktok: 'CompletePayment', action_source: 'system_generated' },
  decline:   null,
  declined:  null,
  refund:    null,
};

// ── New-sale classification (fallback when Checkout Champ can't send orderType) ──
// CC's export mapping has no OrderType field, so we can't always rely on
// orderType === 'NEW_SALE'. When orderType is missing we classify by the event:
//   - NEW_SALE_EVENTS : genuine first purchases → eligible to record.
//   - NON_NEW_SALE_EVENTS : anything that is NOT a new sale (upsell, rebill,
//     recurring, refund, decline, cancel, void, chargeback, partial) → blocked.
// Anything not in either set is treated as NOT a new sale (deny by default),
// so an unknown/mislabeled event can never leak through as a purchase.
const NEW_SALE_EVENTS = new Set(['purchase', 'sale', 'new_sale', 'newsale']);
const NON_NEW_SALE_EVENTS = new Set([
  'upsell', 'upsale', 'rebill', 'recurring', 'subscription',
  'refund', 'decline', 'declined', 'void', 'chargeback',
  'cancel', 'cancelled', 'canceled', 'cancellation', 'partial',
]);

function getParams(req) {
  const q = req.query || {};
  let body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  // Body wins over query when both present.
  return Object.assign({}, q, body);
}

function resolveKey(p) {
  if (p.pixel_key) return String(p.pixel_key);
  if (p.campaign_id && CAMPAIGN_MAP[p.campaign_id]) return CAMPAIGN_MAP[p.campaign_id];
  if (p.page_id && CAMPAIGN_MAP[p.page_id]) return CAMPAIGN_MAP[p.page_id];
  return process.env.CHECKOUT_CHAMP_DEFAULT_KEY || null;
}

function tokenOk(req, p) {
  const secret = process.env.CHECKOUT_CHAMP_WEBHOOK_SECRET;
  if (!secret) return { misconfigured: true, ok: false };
  const provided = p.token || req.headers['x-cc-token'] || '';
  const a = Buffer.from(String(provided));
  const b = Buffer.from(secret);
  if (a.length !== b.length) return { ok: false };
  return { ok: crypto.timingSafeEqual(a, b) };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const p = getParams(req);

    // ── Auth (fail-closed) ──
    const auth = tokenOk(req, p);
    if (auth.misconfigured) {
      console.error('[checkout-champ] CHECKOUT_CHAMP_WEBHOOK_SECRET not set');
      return res.status(500).json({ error: 'Server misconfigured' });
    }
    if (!auth.ok) return res.status(401).json({ error: 'Invalid token' });

    // ── Event type ──
    const rawType = String(p.event || p.event_type || p.eventType || p.type || 'purchase').toLowerCase();
    // Accept already-capitalized Meta names too (e.g. ?event=Purchase).
    const typeKey = rawType in EVENT_TYPES ? rawType : 'purchase';
    const mapped = EVENT_TYPES[typeKey];
    if (!mapped) {
      // Declines / refunds: ack so CC doesn't retry, but forward nothing.
      return res.status(200).json({ ok: true, ignored: true, type: rawType });
    }

    // ── Routing ──
    const key = resolveKey(p);
    if (!key) {
      return res.status(400).json({ error: 'No pixel key resolved (set pixel_key, campaign mapping, or CHECKOUT_CHAMP_DEFAULT_KEY)' });
    }
    const pixel = pixelByKey(key);
    const metaPixel = metaPixelByKey(key);
    if (!pixel && !metaPixel) {
      return res.status(400).json({ error: `No pixel configured for key=${key}` });
    }

    // ── Normalize order fields ──
    const orderId = p.order_id || p.orderId || p.transaction_id || p.transactionId;
    if (!orderId) return res.status(400).json({ error: 'Missing order_id' });

    const currency = p.currency || p.currencyCode || 'USD';
    const value = Number(p.total || p.totalAmount || p.value || 0) || 0;
    const quantity = parseInt(p.quantity, 10) || 1;
    const brandInfo = pixel || metaPixel;

    // ── Ingestion gate: only a COMPLETE, genuine NEW SALE becomes a purchase ──
    // Checkout Champ reports lifecycle via orderStatus (PARTIAL → COMPLETE → …).
    // Its export mapping has NO orderType field, so orderType is OPTIONAL here:
    //   • order_status MUST equal COMPLETE.
    //   • If orderType is present, it is authoritative (must be NEW_SALE).
    //   • If orderType is missing (the norm for this account), we fall back to
    //     the EVENT: accept only a new-sale event (Purchase/sale), and reject
    //     any refund / rebill / upsell / recurring / cancellation / void, etc.
    // Deny-by-default: anything not positively identified as a new sale is
    // blocked BEFORE it reaches PostHog or Meta CAPI.
    const orderStatus = String(p.orderStatus || p.order_status || '').toUpperCase();
    const orderTypeRaw = String(p.orderType || p.order_type || '').toUpperCase();
    const orderType = orderTypeRaw || null; // optional — CC can't export it

    // Was an event type actually supplied? (rawType defaults to 'purchase' for
    // the meta/tiktok event-name mapping, so we can't use it to detect "missing".)
    const eventProvided = !!(p.event || p.event_type || p.eventType || p.type);
    const isComplete = orderStatus === 'COMPLETE';
    const eventIsExcluded = NON_NEW_SALE_EVENTS.has(rawType);
    const eventIsNewSale = NEW_SALE_EVENTS.has(rawType);

    let isNewSalePurchase;
    let blockReason = null;
    if (!isComplete) {
      isNewSalePurchase = false;
      blockReason = 'order_not_complete';        // e.g. PARTIAL — may complete later
    } else if (eventProvided && eventIsExcluded) {
      isNewSalePurchase = false;
      blockReason = 'non_new_sale_event';        // refund / rebill / upsell / cancel / …
    } else if (orderType) {
      isNewSalePurchase = orderType === 'NEW_SALE';
      if (!isNewSalePurchase) blockReason = 'non_new_sale_type';
    } else {
      // Fallback (CC can't export orderType): require an EXPLICIT new-sale
      // event. Deny by default — a missing or non-new-sale event is blocked, so
      // upsell/rebill/refund/unknown postbacks can never leak through as sales.
      isNewSalePurchase = eventProvided && eventIsNewSale;
      if (!isNewSalePurchase) blockReason = eventProvided ? 'event_not_new_sale' : 'event_missing';
    }

    // recordOrder() (Neon Postgres), atomically:
    //   1. marks the order "seen" at its current status — a PARTIAL is
    //      remembered, never permanently ignored; its next postback is
    //      re-evaluated, so PARTIAL→COMPLETE records the purchase exactly once.
    //   2. if this is a completed new sale, claims the one-time purchase record
    //      keyed by orderId, so CC retries cannot create duplicates.
    let decision;
    try {
      decision = await recordOrder({
        orderId: String(orderId),
        status: orderStatus || null,
        orderType,
        value,
        currency,
        isCompletedNewSale: isNewSalePurchase,
      });
    } catch (err) {
      // Fail-closed: without the dedup store we cannot guarantee exactly-once,
      // so ask Checkout Champ to retry rather than risk phantom/duplicate
      // purchases. Once the store recovers, the retry records the order once.
      console.error('[checkout-champ] orders store error:', err.message);
      return res.status(500).json({ error: 'orders store unavailable, retry later' });
    }

    if (!decision.shouldForward) {
      // Not a completed new sale, or a duplicate retry of an already-recorded
      // order. Ack with 200 so CC stops retrying, but forward nothing.
      return res.status(200).json({
        ok: true,
        ignored: true,
        order_id: String(orderId),
        order_status: orderStatus || null,
        order_type: orderType,
        event: rawType,
        reason: decision.reason === 'duplicate' ? 'duplicate' : blockReason,
      });
    }

    const eventTimeSec = p.timestamp
      ? Math.floor(new Date(p.timestamp).getTime() / 1000)
      : Math.floor(Date.now() / 1000);

    const productId = String(p.product_id || p.productId || brandInfo.content_prefix);
    const productName = p.product_name || p.productName || brandInfo.brand;
    const contents = [{
      content_id: productId,
      content_name: productName,
      content_type: 'product',
      content_category: brandInfo.content_category,
      quantity,
      price: value && quantity ? value / quantity : value,
    }];

    // Deterministic, platform-specific event ids → dedup vs any browser pixel.
    const ttEventId = `tt_cc_purchase_${orderId}`;
    const metaEventId = `cc_purchase_${orderId}`;

    // fbc: CC forwards raw fbclid; Meta wants fb.1.<click_time_ms>.<fbclid>.
    const fbclid = p.fbclid || p._fbclid;
    const fbc = p.fbc || (fbclid ? `fb.1.${eventTimeSec * 1000}.${fbclid}` : undefined);
    const fbp = p.fbp || p._fbp;

    // ── TikTok CAPI ──
    const ttUser = {
      external_id: sha256(p.bb_user_id || p.email),
      email: sha256(p.email),
      phone_number: sha256(p.phone),
      ttclid: p.ttclid || undefined,
      ttp: p.ttp || undefined,
      ip: clientIp(req),
      country: sha256(p.country),
      city: sha256(p.city),
      state: sha256(p.state),
      zip_code: sha256(p.zip || p.postalCode),
    };
    Object.keys(ttUser).forEach(k => ttUser[k] === undefined && delete ttUser[k]);

    const ttProperties = {
      currency,
      value,
      contents,
      content_id: contents[0].content_id,
      content_name: contents[0].content_name,
      content_type: 'product',
      content_category: brandInfo.content_category,
      order_id: String(orderId),
    };
    const page = { url: p.page_url || p.landing_url, referrer: p.referrer };

    const tiktokPromise = pixel ? sendCapiEvent({
      pixel,
      eventName: mapped.tiktok,
      eventId: ttEventId,
      eventTime: eventTimeSec,
      user: ttUser,
      properties: ttProperties,
      page,
    }).catch(err => ({ status: 500, body: { error: err.message } })) : Promise.resolve(null);

    // ── Meta CAPI ──
    // Gated OFF by default (see META_PURCHASE_ENABLED): the checkout platform's
    // native pixel owns the Meta Purchase. Forwarding here too would double-report.
    const metaPromise = (metaPixel && META_PURCHASE_ENABLED) ? (async () => {
      const userData = buildMetaUserData({
        email: p.email,
        phone: p.phone,
        external_id: p.bb_user_id || p.email,
        first_name: p.first_name || p.firstName,
        last_name: p.last_name || p.lastName,
        city: p.city,
        state: p.state,
        zip: p.zip || p.postalCode,
        country: p.country,
        fbc,
        fbp,
        ip: clientIp(req),
        user_agent: p.user_agent || req.headers['user-agent'],
      });
      const customData = {
        currency,
        value,
        content_ids: contents.map(c => c.content_id),
        content_name: contents[0].content_name,
        content_type: 'product',
        contents: contents.map(c => ({ id: c.content_id, quantity: c.quantity, item_price: c.price })),
        num_items: quantity,
        order_id: String(orderId),
      };
      return sendMetaCapiEvent({
        pixel: metaPixel,
        eventName: mapped.meta,
        eventId: metaEventId,
        eventTime: eventTimeSec,
        userData,
        customData,
        eventSourceUrl: p.page_url || p.landing_url,
        actionSource: mapped.action_source,
      }).catch(err => ({ status: 500, body: { error: err.message } }));
    })() : Promise.resolve(null);

    // ── PostHog mirror (dashboard) ──
    // session_id falls back to order_id so each purchase counts once in the
    // dashboard funnel's Purchase stage even when the funnel session is unknown.
    const phPromise = phCapture({
      event: 'purchase',
      distinctId: p.bb_user_id || (p.email ? sha256(p.email) : String(orderId)),
      timestamp: new Date(eventTimeSec * 1000).toISOString(),
      properties: {
        page_id: p.page_id || key,
        page_type: 'checkout',
        device_type: 'server',
        session_id: p.session_id || p.bb_session_id || String(orderId),
        user_id: p.bb_user_id || undefined,
        source: 'checkout_champ',
        cc_event_type: typeKey,
        value,
        currency,
        order_id: String(orderId),
        product_id: productId,
        product_name: productName,
        utm_source: p.utm_source,
        utm_medium: p.utm_medium,
        utm_campaign: p.utm_campaign,
      },
    }).catch(err => ({ error: err.message }));

    const [ttResult, metaResult, phResult] = await Promise.all([tiktokPromise, metaPromise, phPromise]);

    const metaSent = !!(metaPixel && META_PURCHASE_ENABLED);
    return res.status(200).json({
      ok: (!pixel || (ttResult?.status === 200 && ttResult?.body?.code === 0))
        && (!metaSent || (metaResult?.status === 200 && !metaResult?.body?.error)),
      key,
      type: typeKey,
      tiktok_status: ttResult?.status,
      tiktok_response: ttResult?.body,
      // Meta Purchase is off by default — CC's native integration sends it.
      // meta_purchase_enabled=false means we deliberately skipped the Meta send.
      meta_purchase_enabled: META_PURCHASE_ENABLED,
      meta_status: metaResult?.status,
      meta_response: metaResult?.body,
      posthog: phResult,
      order_id: String(orderId),
      meta_event_id: metaSent ? metaEventId : null,
      tiktok_event_id: ttEventId,
    });
  } catch (err) {
    console.error('[checkout-champ] unhandled error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
};
