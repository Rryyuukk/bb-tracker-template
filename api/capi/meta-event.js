const { metaPixelForPageId, metaPixelByKey, clientIp, buildMetaUserData, sendMetaCapiEvent } = require('./_lib.js');

// Public endpoint called by Shopify Custom Pixel (and bb-tracker fallback).
// Receives a pre-mapped Meta event name (PageView, ViewContent, AddToCart,
// InitiateCheckout, AddPaymentInfo, Purchase) and forwards to Meta CAPI.
//
// Why a separate endpoint (not /api/capi/event): Shopify Custom Pixel sandbox
// already speaks Shopify analytics events; we map to Meta names client-side
// and just relay. Keeps responsibilities clear vs bb-tracker generic events.

const ALLOWED_META_EVENTS = new Set([
  'PageView',
  'ViewContent',
  'AddToCart',
  'InitiateCheckout',
  'AddPaymentInfo',
  'Purchase',
  'CompleteRegistration',
  'Lead',
  'Subscribe',
]);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const payload = req.body || {};
    const {
      event,            // Meta standard event name (already mapped by caller)
      event_id,
      pixel_key,        // optional — explicit key (e.g. "product_1_us")
      page_id,          // alternative — resolved via PAGE_ID_MAPPING env
      page_url,
      action_source,    // 'website' | 'app' | 'phone_call' | 'chat' | 'email' | 'physical_store' | 'system_generated' | 'other'

      // user_data
      email, phone, external_id, first_name, last_name,
      city, state, zip, country,
      fbc, fbp,

      // custom_data
      currency, value, content_ids, content_name, content_type,
      contents, num_items, order_id, search_string, predicted_ltv,
    } = payload;

    if (!event || !ALLOWED_META_EVENTS.has(event)) {
      return res.status(400).json({ error: `Invalid event: ${event}` });
    }

    const pixel = pixel_key ? metaPixelByKey(pixel_key) : metaPixelForPageId(page_id);
    if (!pixel) {
      return res.status(400).json({ error: `No Meta pixel for pixel_key=${pixel_key} page_id=${page_id}` });
    }

    const userData = buildMetaUserData({
      email,
      phone,
      external_id,
      first_name,
      last_name,
      city,
      state,
      zip,
      country,
      fbc,
      fbp,
      ip: clientIp(req),
      user_agent: req.headers['user-agent'],
      locale: req.headers['accept-language']?.split(',')[0],
    });

    const customData = {
      currency: currency || undefined,
      value: value !== undefined ? Number(value) : undefined,
      content_ids: Array.isArray(content_ids) && content_ids.length ? content_ids.map(String) : undefined,
      content_name: content_name || undefined,
      content_type: content_type || (Array.isArray(content_ids) && content_ids.length ? 'product' : undefined),
      contents: Array.isArray(contents) && contents.length ? contents : undefined,
      num_items: num_items !== undefined ? Number(num_items) : undefined,
      order_id: order_id ? String(order_id) : undefined,
      search_string: search_string || undefined,
      predicted_ltv: predicted_ltv !== undefined ? Number(predicted_ltv) : undefined,
    };
    Object.keys(customData).forEach(k => customData[k] === undefined && delete customData[k]);

    const result = await sendMetaCapiEvent({
      pixel,
      eventName: event,
      eventId: event_id,
      userData,
      customData,
      eventSourceUrl: page_url,
      actionSource: action_source || 'website',
    });

    return res.status(200).json({
      ok: result.status === 200 && !result.body?.error,
      meta_status: result.status,
      meta_response: result.body,
      event,
      event_id,
    });
  } catch (err) {
    console.error('[capi/meta-event] unhandled error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
};
