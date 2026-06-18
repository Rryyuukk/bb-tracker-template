const { requireAuth, phQuery, posthogConfigured, safeDays } = require('./_lib.js');
const { metaAdsConfigured, metaAdsConfig, fetchCampaignInsights, normalizeRow } = require('./_meta.js');

// GET /api/dashboard/campaign-roas?days=7
// READ-ONLY. Joins Meta ad spend (per campaign) with PostHog purchase revenue
// (grouped by utm_campaign) to produce CPA / ROAS per campaign.
//
// Matching is by NORMALIZED campaign name (trim + collapse whitespace +
// lowercase): Meta `campaign_name` <-> PostHog `properties.utm_campaign`.
// campaign_id is not yet persisted on purchase events, so the name is the only
// join key for now. Purchases whose utm_campaign is empty are folded into a
// single "(no campaign)" row under unmatchedRevenue so totals always reconcile.
//
// The response is split into three buckets so the dashboard can show spend and
// revenue honestly even when they don't line up:
//   matched[]          campaigns present on BOTH sides (have spend + revenue)
//   unmatchedSpend[]   Meta campaigns with spend but no name-matching purchases
//   unmatchedRevenue[] purchase revenue with no matching campaign (incl. (no campaign))
// roas / cpa are null (never 0 or Infinity) when their denominator is 0.
//
// Auth: same signed-cookie dashboard session as the other dashboard routes.
// The Meta access token and PostHog keys are read server-side and never returned.

const NO_CAMPAIGN_LABEL = '(no campaign)';

// Format a Date as YYYY-MM-DD in UTC (matches what meta-spend asks Meta for).
function ymd(d) {
  return d.toISOString().slice(0, 10);
}

// Inclusive date range ending today (UTC): `days` total days back.
function rangeForDays(days) {
  const until = new Date();
  const since = new Date(until.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
  return { since: ymd(since), until: ymd(until) };
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// Normalize a campaign name for matching across the two sources.
function normName(s) {
  return String(s == null ? '' : s).trim().replace(/\s+/g, ' ').toLowerCase();
}

function phRows(result) {
  return (result && result.results) || [];
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (requireAuth(req, res)) return;

  // The Campaigns view is fundamentally about spend, so a missing Meta config
  // is a hard 503 (same contract as /meta-spend). A missing PostHog config is
  // soft: we still render spend, just without revenue/ROAS (see below).
  if (!metaAdsConfigured()) {
    return res.status(503).json({
      error: 'Meta Ads not configured',
      hint: 'Set META_ADS_ACCESS_TOKEN and META_AD_ACCOUNT_ID (optionally META_ADS_API_VERSION) in Vercel. The token needs the ads_read permission.',
    });
  }

  const days = safeDays(req.query && req.query.days, 7);
  const { since, until } = rangeForDays(days);
  const warnings = [];

  // ── Revenue side (PostHog) — degrade gracefully so spend still renders ──
  let revenueRows = [];
  try {
    if (!posthogConfigured()) {
      warnings.push('PostHog not configured — revenue, CPA and ROAS are unavailable.');
    } else {
      const rev = await phQuery(`
        SELECT
          ifNull(properties.utm_campaign, '') AS campaign,
          sum(toFloat(ifNull(properties.value, 0))) AS revenue,
          count() AS purchases,
          any(properties.currency) AS currency
        FROM events
        WHERE event = 'purchase' AND timestamp > now() - INTERVAL ${days} DAY
        GROUP BY campaign`);
      revenueRows = phRows(rev).map((r) => ({
        campaign: r[0] || '',
        revenue: round2(r[1]),
        purchases: Number(r[2]) || 0,
        currency: r[3] || null,
      }));
    }
  } catch (err) {
    console.error('[dashboard/campaign-roas] posthog error:', err.code || '', err.message);
    warnings.push('Failed to query PostHog revenue — showing spend only.');
  }

  // ── Spend side (Meta) ──
  let campaigns;
  try {
    const rawRows = await fetchCampaignInsights({ since, until });
    campaigns = rawRows.map(normalizeRow);
  } catch (err) {
    console.error('[dashboard/campaign-roas] meta error:', err.code || '', err.metaCode || '', err.message);
    return res.status(502).json({
      error: 'Failed to query Meta Ads Insights',
      hint: err.hint,
      detail: err.message,
    });
  }

  // ── Merge by normalized campaign name ──
  // Build a revenue lookup keyed by normalized name. The empty-name bucket is
  // tracked separately and never matched to a spend campaign.
  const revByName = new Map();
  let noCampaign = null;
  revenueRows.forEach((rr) => {
    const key = normName(rr.campaign);
    if (key === '') {
      // Fold all empty-utm_campaign purchases into one "(no campaign)" bucket.
      if (!noCampaign) noCampaign = { campaign: NO_CAMPAIGN_LABEL, revenue: 0, purchases: 0, currency: rr.currency };
      noCampaign.revenue = round2(noCampaign.revenue + rr.revenue);
      noCampaign.purchases += rr.purchases;
      return;
    }
    if (revByName.has(key)) {
      // Two utm_campaign spellings that normalize to the same name — merge them.
      const ex = revByName.get(key);
      ex.revenue = round2(ex.revenue + rr.revenue);
      ex.purchases += rr.purchases;
    } else {
      revByName.set(key, { campaign: rr.campaign, revenue: rr.revenue, purchases: rr.purchases, currency: rr.currency, matched: false });
    }
  });

  const matched = [];
  const unmatchedSpend = [];

  campaigns.forEach((c) => {
    const rev = revByName.get(normName(c.campaign_name));
    if (rev) {
      rev.matched = true;
      matched.push({
        campaign_id: c.campaign_id,
        campaign_name: c.campaign_name,
        spend: round2(c.spend),
        impressions: c.impressions,
        clicks: c.clicks,
        link_clicks: c.link_clicks,
        revenue: round2(rev.revenue),
        purchases: rev.purchases,
        roas: c.spend > 0 ? round2(rev.revenue / c.spend) : null,
        cpa: rev.purchases > 0 ? round2(c.spend / rev.purchases) : null,
        currency: c.currency || rev.currency || null,
      });
    } else {
      unmatchedSpend.push({
        campaign_id: c.campaign_id,
        campaign_name: c.campaign_name,
        spend: round2(c.spend),
        impressions: c.impressions,
        clicks: c.clicks,
        link_clicks: c.link_clicks,
        revenue: 0,
        purchases: 0,
        roas: null,
        cpa: null,
        currency: c.currency || null,
      });
    }
  });

  // Revenue rows that never matched a spend campaign, plus the (no campaign) bucket.
  const unmatchedRevenue = [];
  revByName.forEach((rev) => {
    if (!rev.matched) {
      unmatchedRevenue.push({ campaign: rev.campaign, revenue: round2(rev.revenue), purchases: rev.purchases, currency: rev.currency || null });
    }
  });
  if (noCampaign) unmatchedRevenue.push(noCampaign);

  matched.sort((a, b) => b.spend - a.spend);
  unmatchedSpend.sort((a, b) => b.spend - a.spend);
  unmatchedRevenue.sort((a, b) => b.revenue - a.revenue);

  // ── Totals (always reconcile: matchedRevenue + unmatchedRevenue = totalRevenue) ──
  const spend = round2(campaigns.reduce((s, c) => s + c.spend, 0));
  const matchedRevenue = round2(matched.reduce((s, m) => s + m.revenue, 0));
  const unmatchedRevenueTotal = round2(unmatchedRevenue.reduce((s, u) => s + u.revenue, 0));
  const totalRevenue = round2(matchedRevenue + unmatchedRevenueTotal);
  const totalPurchases =
    matched.reduce((s, m) => s + m.purchases, 0) +
    unmatchedRevenue.reduce((s, u) => s + u.purchases, 0);

  // Currency: prefer Meta account currency. Flag if PostHog reports a different one.
  const metaCurrency = (campaigns.find((c) => c.currency) || {}).currency || null;
  const phCurrencyList = Array.from(new Set(revenueRows.map((r) => r.currency).filter(Boolean)));
  const currencyMismatch = !!(metaCurrency && phCurrencyList.length && phCurrencyList.some((c) => c !== metaCurrency));
  if (currencyMismatch) {
    warnings.push('Currency mismatch: Meta reports ' + metaCurrency + ' but PostHog purchases include ' + phCurrencyList.join(', ') + '. Revenue is summed as-is.');
  }

  const { accountId } = metaAdsConfig();

  return res.status(200).json({
    days,
    since,
    until,
    account_id: accountId, // numeric id only; behind auth. Token never returned.
    currency: metaCurrency,
    currencyMismatch,
    totals: {
      spend,
      matchedRevenue,
      unmatchedRevenue: unmatchedRevenueTotal,
      totalRevenue,
      purchases: totalPurchases,
      blendedRoas: spend > 0 ? round2(totalRevenue / spend) : null,
    },
    matched,
    unmatchedSpend,
    unmatchedRevenue,
    warnings,
  });
};
