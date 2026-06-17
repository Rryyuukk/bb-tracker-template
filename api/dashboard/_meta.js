// Meta (Facebook) Ads Insights helper for the dashboard.
//
// READ-ONLY. This file only *reads* ad spend from the Meta Marketing API.
// It is deliberately separate from api/capi/_lib.js so that ad-spend reporting
// is fully decoupled from Meta CAPI purchase sending — they use different
// tokens (CAPI uses pixel tokens; spend needs an `ads_read` token) and must
// never share failure modes.
//
// Env vars (server-side only — never exposed to the frontend):
//   META_ADS_ACCESS_TOKEN   long-lived system-user token with `ads_read` scope
//   META_AD_ACCOUNT_ID      ad account id (with or without the `act_` prefix)
//   META_ADS_API_VERSION    optional, defaults to v21.0 (matches capi/_lib.js)

const DEFAULT_API_VERSION = 'v21.0';
const GRAPH_BASE = 'https://graph.facebook.com';
const MAX_PAGES = 25; // safety cap on pagination

function metaAdsConfigured() {
  return !!(process.env.META_ADS_ACCESS_TOKEN && process.env.META_AD_ACCOUNT_ID);
}

// Normalize the account id to the bare numeric id (no `act_` prefix); the
// prefix is added at call time. Accepts either form in the env var.
function normalizeAccountId(raw) {
  return String(raw || '').trim().replace(/^act_/i, '');
}

function metaAdsConfig() {
  return {
    token: process.env.META_ADS_ACCESS_TOKEN,
    accountId: normalizeAccountId(process.env.META_AD_ACCOUNT_ID),
    version: process.env.META_ADS_API_VERSION || DEFAULT_API_VERSION,
  };
}

// Build a friendly, code-mapped error from a Meta Graph error body so the
// route can surface a useful hint without leaking the token.
function metaError(status, body) {
  const e = (body && body.error) || {};
  const err = new Error(e.message || `Meta API request failed (${status})`);
  err.code = 'META_API_ERROR';
  err.status = status;
  err.metaCode = e.code;
  err.metaSubcode = e.error_subcode;
  // Common cases worth a human-readable hint.
  if (e.code === 190) err.hint = 'Access token is invalid or expired — refresh META_ADS_ACCESS_TOKEN.';
  else if (e.code === 200 || e.code === 10 || e.code === 3) err.hint = 'Token is missing the ads_read permission for this ad account.';
  else if (e.code === 17 || e.code === 80004 || e.code === 4) err.hint = 'Meta API rate limit reached — try again shortly or narrow the date range.';
  else if (e.code === 100) err.hint = 'Bad request to Meta (check META_AD_ACCOUNT_ID and field names).';
  return err;
}

async function graphGet(url) {
  const res = await fetch(url);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok || (json && json.error)) throw metaError(res.status, json);
  return json;
}

// Fetch campaign-level insights for a date range (inclusive, YYYY-MM-DD in the
// ad account's timezone). Returns the raw, normalized rows — no matching, no
// ROAS. Follows pagination up to MAX_PAGES.
async function fetchCampaignInsights({ since, until }) {
  const { token, accountId, version } = metaAdsConfig();

  const fields = [
    'account_currency',
    'campaign_id',
    'campaign_name',
    'spend',
    'impressions',
    'clicks',
    'inline_link_clicks',
    'cpc',
    'ctr',
    'date_start',
    'date_stop',
  ].join(',');

  const params = new URLSearchParams({
    level: 'campaign',
    fields,
    time_range: JSON.stringify({ since, until }),
    limit: '500',
    access_token: token,
  });

  let url = `${GRAPH_BASE}/${version}/act_${accountId}/insights?${params.toString()}`;
  const rows = [];
  let pages = 0;

  while (url && pages < MAX_PAGES) {
    const json = await graphGet(url);
    if (Array.isArray(json.data)) rows.push(...json.data);
    url = json.paging && json.paging.next ? json.paging.next : null;
    pages += 1;
  }

  return rows;
}

// Convert a raw Meta insights row into the dashboard's clean shape.
function normalizeRow(r) {
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    campaign_id: r.campaign_id || null,
    campaign_name: r.campaign_name || '(unnamed campaign)',
    spend: num(r.spend),
    impressions: num(r.impressions),
    clicks: num(r.clicks),
    link_clicks: num(r.inline_link_clicks),
    cpc: num(r.cpc),
    ctr: num(r.ctr),
    currency: r.account_currency || null,
  };
}

module.exports = {
  metaAdsConfigured,
  metaAdsConfig,
  normalizeAccountId,
  fetchCampaignInsights,
  normalizeRow,
  DEFAULT_API_VERSION,
};
