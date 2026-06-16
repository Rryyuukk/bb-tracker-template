const crypto = require('crypto');
const {
  pixelByKey, sha256, clientIp, sendCapiEvent,
  metaPixelByKey, buildMetaUserData, sendMetaCapiEvent,
} = require('./_lib.js');

// Map Shopify domain → pixel key (product+market). Loaded from env var
// SHOPIFY_DOMAIN_MAPPING (JSON string). Example:
//   SHOPIFY_DOMAIN_MAPPING={"my-store.myshopify.com":"product_1_us"}
// Webhook secret env follows pattern SHOPIFY_<KEY>_WEBHOOK_SECRET.
function loadShopifyDomainMap() {
  const raw = process.env.SHOPIFY_DOMAIN_MAPPING;
  if (!raw) {
    console.warn('[shopify-purchase] SHOPIFY_DOMAIN_MAPPING env var not set — all webhooks will return 400');
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error('[shopify-purchase] Invalid SHOPIFY_DOMAIN_MAPPING JSON:', e.message);
    return {};
  }
}

const SHOPIFY_DOMAIN_TO_KEY = loadShopifyDomainMap();

function verifyShopifyHmac(rawBody, hmacHeader, secret) {
  if (!secret || !hmacHeader) return false;
  const computed = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(hmacHeader));
}

// Vercel: disable body parsing so we can verify HMAC against raw body
module.exports.config = { api: { bodyParser: false } };

async function readRaw(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const raw = await readRaw(req);
    const shopDomain = req.headers['x-shopify-shop-domain'];
    const hmacHeader = req.headers['x-shopify-hmac-sha256'];
    const key = SHOPIFY_DOMAIN_TO_KEY[shopDomain];

    if (!key) {
      return res.status(400).json({ error: `Unknown Shopify domain: ${shopDomain}` });
    }

    const sharedSecret = process.env[`SHOPIFY_${key.toUpperCase()}_WEBHOOK_SECRET`];
    if (!sharedSecret) {
      // Fail-closed: missing secret means we cannot prove the request is real.
      // Don't accept and forward to TikTok blindly — that would let anyone
      // POST a forged Purchase to inflate metrics.
      console.error(`[shopify-purchase] missing SHOPIFY_${key.toUpperCase()}_WEBHOOK_SECRET env var`);
      return res.status(500).json({ error: 'Server misconfigured' });
    }
    if (!verifyShopifyHmac(raw, hmacHeader, sharedSecret)) {
      return res.status(401).json({ error: 'Invalid HMAC' });
    }

    const order = JSON.parse(raw);
    const pixel = pixelByKey(key);
    const metaPixel = metaPixelByKey(key);
    if (!pixel && !metaPixel) return res.status(400).json({ error: `No pixel for key=${key}` });

    // event_id deterministic from order id — MUST match the Shopify Custom Pixel
    // so each platform dedups CAPI server event ↔ pixel browser event
    const eventId = `tt_purchase_${order.id}`;
    const metaEventId = `fb_purchase_${order.id}`;

    // Brand metadata may live on either pixel config — pick whichever is set
    const brandInfo = pixel || metaPixel;
    const lineItems = (order.line_items || []).map(li => ({
      content_id: String(li.product_id || li.variant_id || li.id),
      content_name: li.title || li.name || brandInfo.brand,
      content_type: 'product',
      content_category: brandInfo.content_category,
      quantity: li.quantity || 1,
      price: Number(li.price) || 0,
    }));
    if (lineItems.length === 0) {
      lineItems.push({
        content_id: brandInfo.content_prefix,
        content_name: brandInfo.brand,
        content_type: 'product',
        content_category: brandInfo.content_category,
        quantity: 1,
        price: Number(order.total_price) || 0,
      });
    }

    // Extract UTM/click ids from note_attributes or referring_site
    const noteAttrs = (order.note_attributes || []).reduce((m, a) => { m[a.name] = a.value; return m; }, {});
    const ttclid = noteAttrs.ttclid || noteAttrs._ttclid;
    const ttp = noteAttrs.ttp || noteAttrs._ttp;

    const user = {
      external_id: sha256(noteAttrs.bb_user_id || order.customer?.id),
      email: sha256(order.email || order.customer?.email),
      phone_number: sha256(order.phone || order.shipping_address?.phone),
      ttclid: ttclid || undefined,
      ttp: ttp || undefined,
      ip: clientIp(req),
      country: sha256(order.shipping_address?.country_code),
      city: sha256(order.shipping_address?.city),
      state: sha256(order.shipping_address?.province_code),
      zip_code: sha256(order.shipping_address?.zip),
    };
    Object.keys(user).forEach(k => user[k] === undefined && delete user[k]);

    const properties = {
      currency: order.currency || 'USD',
      value: Number(order.total_price) || 0,
      contents: lineItems,
      content_id: lineItems[0].content_id,
      content_name: lineItems[0].content_name,
      content_type: 'product',
      content_category: brandInfo.content_category,
      order_id: String(order.id),
      description: order.order_number ? `Order #${order.order_number}` : undefined,
    };

    const page = {
      url: order.referring_site || order.landing_site,
      referrer: order.referring_site,
    };

    const eventTime = Math.floor(new Date(order.created_at || Date.now()).getTime() / 1000);

    // Meta CAPI payload — uses customer/billing fields directly (Meta hashes them via _lib helper)
    const billing = order.billing_address || order.shipping_address || {};
    const noteFbc = noteAttrs.fbc || noteAttrs._fbc;
    const noteFbp = noteAttrs.fbp || noteAttrs._fbp;
    // Checkout Champ forwards the RAW click id (fbclid), but Meta CAPI expects the
    // formatted fbc cookie: fb.1.<click_time_ms>.<fbclid>. Reconstruct it when a
    // preformatted fbc isn't present. eventTime is in seconds → *1000 for ms.
    const fbclid = noteAttrs.fbclid || noteAttrs._fbclid;
    const fbc = noteFbc || (fbclid ? `fb.1.${eventTime * 1000}.${fbclid}` : undefined);
    const metaUserData = metaPixel ? buildMetaUserData({
      email: order.email || order.customer?.email,
      phone: order.phone || order.shipping_address?.phone,
      external_id: noteAttrs.bb_user_id || order.customer?.id,
      first_name: billing.first_name || order.customer?.first_name,
      last_name: billing.last_name || order.customer?.last_name,
      city: billing.city,
      state: billing.province_code,
      zip: billing.zip,
      country: billing.country_code,
      fbc: fbc || undefined,
      fbp: noteFbp || undefined,
      ip: clientIp(req),
      user_agent: req.headers['user-agent'],
    }) : null;

    const metaCustomData = {
      currency: order.currency || 'USD',
      value: Number(order.total_price) || 0,
      content_ids: lineItems.map(li => li.content_id),
      content_name: lineItems[0].content_name,
      content_type: 'product',
      contents: lineItems.map(li => ({
        id: li.content_id,
        quantity: li.quantity,
        item_price: li.price,
      })),
      num_items: lineItems.reduce((s, li) => s + (li.quantity || 1), 0),
      order_id: String(order.id),
    };

    const tiktokPromise = pixel ? sendCapiEvent({
      pixel,
      eventName: 'CompletePayment',
      eventId,
      eventTime,
      user,
      properties,
      page,
    }).catch(err => ({ status: 500, body: { error: err.message } })) : Promise.resolve(null);

    const metaPromise = metaPixel ? sendMetaCapiEvent({
      pixel: metaPixel,
      eventName: 'Purchase',
      eventId: metaEventId,
      eventTime,
      userData: metaUserData,
      customData: metaCustomData,
      eventSourceUrl: order.referring_site || order.landing_site,
    }).catch(err => ({ status: 500, body: { error: err.message } })) : Promise.resolve(null);

    const [ttResult, metaResult] = await Promise.all([tiktokPromise, metaPromise]);

    return res.status(200).json({
      ok: (!pixel || (ttResult?.status === 200 && ttResult?.body?.code === 0))
        && (!metaPixel || (metaResult?.status === 200 && !metaResult?.body?.error)),
      tiktok_status: ttResult?.status,
      tiktok_response: ttResult?.body,
      meta_status: metaResult?.status,
      meta_response: metaResult?.body,
      order_id: order.id,
      event_id: eventId,
      meta_event_id: metaEventId,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
