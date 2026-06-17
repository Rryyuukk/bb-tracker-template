const { requireAuth, safeDays } = require('./_lib.js');
const { metaAdsConfigured, metaAdsConfig, fetchCampaignInsights, normalizeRow } = require('./_meta.js');

// GET /api/dashboard/meta-spend?days=7
// READ-ONLY. Returns raw Meta ad spend grouped by campaign for the selected
// date range. Phase A only: no matching to PostHog purchases, no ROAS — just
// spend / impressions / clicks straight from the Meta Marketing API.
//
// Auth: same signed-cookie dashboard session as the other dashboard routes.
// The Meta access token is read from env server-side and is NEVER returned to
// the client.

// Format a Date as YYYY-MM-DD in UTC (matches what we ask Meta for).
function ymd(d) {
  return d.toISOString().slice(0, 10);
}

// Inclusive date range ending today (UTC): `days` total days back.
function rangeForDays(days) {
  const until = new Date();
  const since = new Date(until.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
  return { since: ymd(since), until: ymd(until) };
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (requireAuth(req, res)) return;

  if (!metaAdsConfigured()) {
    return res.status(503).json({
      error: 'Meta Ads not configured',
      hint: 'Set META_ADS_ACCESS_TOKEN and META_AD_ACCOUNT_ID (optionally META_ADS_API_VERSION) in Vercel. The token needs the ads_read permission.',
    });
  }

  const days = safeDays(req.query && req.query.days, 7);
  const { since, until } = rangeForDays(days);

  try {
    const rawRows = await fetchCampaignInsights({ since, until });
    const campaigns = rawRows.map(normalizeRow);

    // Sort by spend desc so the biggest spenders surface first.
    campaigns.sort((a, b) => b.spend - a.spend);

    const totals = campaigns.reduce(
      (acc, c) => {
        acc.spend += c.spend;
        acc.impressions += c.impressions;
        acc.clicks += c.clicks;
        acc.link_clicks += c.link_clicks;
        return acc;
      },
      { spend: 0, impressions: 0, clicks: 0, link_clicks: 0 }
    );
    totals.spend = Math.round(totals.spend * 100) / 100;

    // Currency comes back on each row as account_currency; take the first.
    const currency = (campaigns.find((c) => c.currency) || {}).currency || null;
    const { accountId } = metaAdsConfig();

    return res.status(200).json({
      days,
      since,
      until,
      account_id: accountId, // numeric id only; behind auth. Token never returned.
      currency,
      totals,
      campaigns,
    });
  } catch (err) {
    console.error('[dashboard/meta-spend] error:', err.code || '', err.metaCode || '', err.message);
    return res.status(502).json({
      error: 'Failed to query Meta Ads Insights',
      hint: err.hint,
      detail: err.message,
    });
  }
};
