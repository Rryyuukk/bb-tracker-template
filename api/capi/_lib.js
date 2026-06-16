// Shared TikTok + Meta CAPI helpers
const crypto = require('crypto');

const TIKTOK_API = 'https://business-api.tiktok.com/open_api/v1.3/event/track/';
const META_API_VERSION = 'v21.0';

// ─── Pixel configs (loaded dynamically from env vars) ─────────────
//
// Add a new product/market by setting env vars in Vercel:
//
//   TIKTOK_<KEY>_PIXEL_ID       (required)
//   TIKTOK_<KEY>_ACCESS_TOKEN   (required)
//   META_<KEY>_PIXEL_ID         (optional, only if running Meta CAPI)
//   META_<KEY>_ACCESS_TOKEN     (optional)
//   META_<KEY>_TEST_CODE        (optional, for test events)
//   BRAND_<KEY>                 (optional, defaults to <KEY>)
//   CONTENT_PREFIX_<KEY>        (optional, defaults to <KEY>)
//   CONTENT_CATEGORY_<KEY>      (optional, defaults to 'product')
//
// <KEY> = anything you want (ex: PRODUCT_1_US, MAIN_FUNNEL, BRAND_US).
// Keys are case-insensitive internally (lowercased).
//
// To map a Shopify domain or page_id to a KEY, see:
//   - SHOPIFY_DOMAIN_MAPPING env var (JSON) in shopify-purchase.js
//   - PAGE_ID_MAPPING env var (JSON) below
// ──────────────────────────────────────────────────────────────────

function loadPixelConfigs() {
  const tiktok = {};
  const meta = {};

  for (const [envKey, value] of Object.entries(process.env)) {
    if (!value) continue;

    // TikTok pixel
    let m = envKey.match(/^TIKTOK_(.+)_PIXEL_ID$/);
    if (m) {
      const key = m[1].toLowerCase();
      const token = process.env[`TIKTOK_${m[1]}_ACCESS_TOKEN`];
      if (token) {
        tiktok[key] = {
          pixel_id: value,
          access_token: token,
          brand: process.env[`BRAND_${m[1]}`] || key,
          content_prefix: (process.env[`CONTENT_PREFIX_${m[1]}`] || key).toLowerCase(),
          content_category: process.env[`CONTENT_CATEGORY_${m[1]}`] || 'product',
        };
      }
      continue;
    }

    // Meta pixel
    m = envKey.match(/^META_(.+)_PIXEL_ID$/);
    if (m) {
      const key = m[1].toLowerCase();
      const token = process.env[`META_${m[1]}_ACCESS_TOKEN`];
      if (token) {
        meta[key] = {
          pixel_id: value,
          access_token: token,
          test_event_code: process.env[`META_${m[1]}_TEST_CODE`],
          brand: process.env[`BRAND_${m[1]}`] || key,
          content_prefix: (process.env[`CONTENT_PREFIX_${m[1]}`] || key).toLowerCase(),
          content_category: process.env[`CONTENT_CATEGORY_${m[1]}`] || 'product',
        };
      }
    }
  }

  return { tiktok, meta };
}

const { tiktok: PIXEL_BY_KEY, meta: META_PIXEL_BY_KEY } = loadPixelConfigs();

// Page ID → KEY mapping (optional, configured via env var PAGE_ID_MAPPING).
// Example: PAGE_ID_MAPPING={"quiz-us":"product_1_us","quiz-uk":"product_1_uk"}
// If unset, page_id must exactly match a KEY (case-insensitive).
function loadPageIdMapping() {
  const raw = process.env.PAGE_ID_MAPPING;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error('Invalid PAGE_ID_MAPPING JSON:', e.message);
    return {};
  }
}

const PAGE_ID_MAPPING = loadPageIdMapping();

function pixelByKey(key) {
  const conf = PIXEL_BY_KEY[key?.toLowerCase?.()];
  if (!conf || !conf.pixel_id || !conf.access_token) return null;
  return conf;
}

function metaPixelByKey(key) {
  const conf = META_PIXEL_BY_KEY[key?.toLowerCase?.()];
  if (!conf || !conf.pixel_id || !conf.access_token) return null;
  return conf;
}

// Resolve page_id → pixel config. Looks up PAGE_ID_MAPPING first,
// then tries direct match against KEY.
function pixelForPageId(pageId) {
  if (!pageId) return null;
  const key = PAGE_ID_MAPPING[pageId] || pageId;
  return pixelByKey(key);
}

function metaPixelForPageId(pageId) {
  if (!pageId) return null;
  const key = PAGE_ID_MAPPING[pageId] || pageId;
  return metaPixelByKey(key);
}

function sha256(value) {
  if (value === null || value === undefined || value === '') return undefined;
  return crypto.createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex');
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket?.remoteAddress;
}

// Map bb-tracker event → TikTok CAPI standard event
function mapEventName(bbEvent, pageType) {
  const map = {
    page_init: 'ViewContent',
    vsl_play: 'ViewContent',
    cta_visible: 'ClickButton',
    cta_clicked: 'InitiateCheckout',
    quiz_complete: 'CompleteRegistration',
    quiz_completed: 'CompleteRegistration',
    plan_selected: 'AddToCart',
    answer_selected: null,
    step_view: null,
    scroll_depth: null,
    time_on_page: null,
  };
  return map[bbEvent] !== undefined ? map[bbEvent] : null;
}

// Generic content builder. Uses pixel config's content_prefix/content_category.
function buildContents({ cta_pack, plan_price, plan, currency, pixelConfig }) {
  if (!cta_pack && !plan) return undefined;
  const pack = cta_pack || plan;
  const prefix = pixelConfig?.content_prefix || 'item';
  const brand = pixelConfig?.brand || 'product';
  const category = pixelConfig?.content_category || 'product';
  return [{
    content_id: `${prefix}-${pack}`,
    content_name: `${brand} ${pack}`,
    content_type: 'product',
    content_category: category,
    quantity: parseInt(pack, 10) || 1,
    price: plan_price ? Number(plan_price) : undefined,
  }];
}

// Map bb-tracker event → Meta CAPI standard event
function mapMetaEventName(bbEvent, pageType) {
  const map = {
    page_init: 'PageView',
    vsl_play: 'ViewContent',
    cta_visible: null,
    cta_clicked: 'InitiateCheckout',
    quiz_complete: 'CompleteRegistration',
    quiz_completed: 'CompleteRegistration',
    plan_selected: 'AddToCart',
    answer_selected: null,
    step_view: null,
    scroll_depth: null,
    time_on_page: null,
  };
  return map[bbEvent] !== undefined ? map[bbEvent] : null;
}

function metaHashArr(value) {
  const h = sha256(value);
  return h ? [h] : undefined;
}

function buildMetaUserData({
  email, phone, external_id, first_name, last_name, city, state, zip, country,
  fbc, fbp, ip, user_agent, locale,
}) {
  const u = {
    em: metaHashArr(email),
    ph: metaHashArr(phone),
    external_id: metaHashArr(external_id),
    fn: metaHashArr(first_name),
    ln: metaHashArr(last_name),
    ct: metaHashArr(city),
    st: metaHashArr(state),
    zp: metaHashArr(zip),
    country: metaHashArr(country),
    fbc: fbc || undefined,
    fbp: fbp || undefined,
    client_ip_address: ip || undefined,
    client_user_agent: user_agent || undefined,
    locale: locale || undefined,
  };
  Object.keys(u).forEach(k => u[k] === undefined && delete u[k]);
  return u;
}

async function sendMetaCapiEvent({ pixel, eventName, eventId, eventTime, userData, customData, eventSourceUrl, actionSource = 'website' }) {
  const payload = {
    data: [{
      event_name: eventName,
      event_time: eventTime || Math.floor(Date.now() / 1000),
      event_id: eventId,
      action_source: actionSource,
      event_source_url: eventSourceUrl || undefined,
      user_data: userData,
      custom_data: customData,
    }],
  };
  if (pixel.test_event_code) payload.test_event_code = pixel.test_event_code;

  const url = `https://graph.facebook.com/${META_API_VERSION}/${pixel.pixel_id}/events?access_token=${encodeURIComponent(pixel.access_token)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

async function sendCapiEvent({ pixel, eventName, eventId, eventTime, user, properties, page, testCode }) {
  const body = {
    event_source: 'web',
    event_source_id: pixel.pixel_id,
    data: [{
      event: eventName,
      event_time: eventTime || Math.floor(Date.now() / 1000),
      event_id: eventId,
      user,
      properties,
      page,
      limited_data_use: false,
    }],
  };
  if (testCode) body.test_event_code = testCode;

  const res = await fetch(TIKTOK_API, {
    method: 'POST',
    headers: {
      'Access-Token': pixel.access_token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

// ─── PostHog server-side ingest ───────────────────────────────────
// Mirror a server event into PostHog so the dashboard (which reads from
// PostHog) sees events that never touch the browser — e.g. Shopify /
// Checkout Champ purchases. Uses the *project* write key (phc_...), which is
// different from the *personal* query key the dashboard uses to read.
//   POSTHOG_PROJECT_API_KEY   project write key (phc_...)
//   POSTHOG_INGEST_HOST       ingestion host, e.g. https://us.i.posthog.com
// No-op (resolves { skipped: true }) when the write key isn't configured, so
// callers can fire-and-forget without guarding.
async function phCapture({ event, distinctId, properties, timestamp }) {
  const apiKey = process.env.POSTHOG_PROJECT_API_KEY;
  if (!apiKey) return { skipped: true };
  const host = (process.env.POSTHOG_INGEST_HOST || 'https://us.i.posthog.com').replace(/\/$/, '');
  try {
    const res = await fetch(`${host}/capture/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        event,
        distinct_id: distinctId || 'server',
        properties: properties || {},
        timestamp: timestamp || new Date().toISOString(),
      }),
    });
    return { status: res.status };
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = {
  pixelByKey,
  pixelForPageId,
  metaPixelByKey,
  metaPixelForPageId,
  sha256,
  clientIp,
  mapEventName,
  mapMetaEventName,
  buildContents,
  buildMetaUserData,
  sendCapiEvent,
  sendMetaCapiEvent,
  phCapture,
};
