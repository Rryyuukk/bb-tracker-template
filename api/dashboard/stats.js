const { requireAuth, phQuery, posthogConfigured, safeDays } = require('./_lib.js');

// GET /api/dashboard/stats?days=7
// Aggregates bb-tracker events stored in PostHog into the numbers the
// dashboard renders: totals, a funnel, event/device/page breakdowns, and a
// daily timeseries. All data is read live from PostHog via HogQL.
//
// Funnel stages are derived from the universal bb-tracker events:
//   Visits      -> page_init
//   Engaged     -> scroll_depth (any milestone)
//   Started     -> vsl_play OR quiz_started
//   CTA click   -> cta_clicked
//   Checkout    -> plan_selected OR quiz_completed
//   Purchase    -> purchase  (server-side, mirrored from Shopify / Checkout Champ)
// Each stage counts DISTINCT sessions so the funnel is monotonic-ish and
// comparable across page types.

function rows(result) {
  return (result && result.results) || [];
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (requireAuth(req, res)) return;

  if (!posthogConfigured()) {
    return res.status(503).json({
      error: 'PostHog not configured',
      hint: 'Set POSTHOG_API_KEY, POSTHOG_PROJECT_ID and POSTHOG_API_HOST in Vercel.',
    });
  }

  const days = safeDays(req.query && req.query.days, 7);
  const since = `now() - INTERVAL ${days} DAY`;

  try {
    const [totals, funnel, byEvent, byDevice, byPage, timeseries] = await Promise.all([
      phQuery(`
        SELECT count() AS events,
               uniq(properties.session_id) AS sessions,
               uniq(properties.user_id) AS users
        FROM events
        WHERE timestamp > ${since}`),
      phQuery(`
        SELECT
          uniqIf(properties.session_id, event = 'page_init') AS visits,
          uniqIf(properties.session_id, event = 'scroll_depth') AS engaged,
          uniqIf(properties.session_id, event IN ('vsl_play','quiz_started')) AS started,
          uniqIf(properties.session_id, event = 'cta_clicked') AS cta_clicks,
          uniqIf(properties.session_id, event IN ('plan_selected','quiz_completed')) AS checkouts,
          uniqIf(properties.session_id, event = 'purchase') AS purchases
        FROM events
        WHERE timestamp > ${since}`),
      phQuery(`
        SELECT event, count() AS c
        FROM events
        WHERE timestamp > ${since}
        GROUP BY event
        ORDER BY c DESC
        LIMIT 30`),
      phQuery(`
        SELECT ifNull(properties.device_type, 'unknown') AS device, count() AS c
        FROM events
        WHERE timestamp > ${since}
        GROUP BY device
        ORDER BY c DESC`),
      phQuery(`
        SELECT ifNull(properties.page_id, 'unknown') AS page_id, count() AS c
        FROM events
        WHERE timestamp > ${since}
        GROUP BY page_id
        ORDER BY c DESC
        LIMIT 20`),
      phQuery(`
        SELECT toDate(timestamp) AS day, count() AS c
        FROM events
        WHERE timestamp > ${since}
        GROUP BY day
        ORDER BY day`),
    ]);

    const t = rows(totals)[0] || [0, 0, 0];
    const f = rows(funnel)[0] || [0, 0, 0, 0, 0, 0];

    const funnelStages = [
      { key: 'visits', label: 'Visits', count: Number(f[0]) || 0 },
      { key: 'engaged', label: 'Engaged', count: Number(f[1]) || 0 },
      { key: 'started', label: 'Started (VSL/Quiz)', count: Number(f[2]) || 0 },
      { key: 'cta_clicks', label: 'CTA Clicked', count: Number(f[3]) || 0 },
      { key: 'checkouts', label: 'Checkout', count: Number(f[4]) || 0 },
      { key: 'purchases', label: 'Purchase', count: Number(f[5]) || 0 },
    ];
    const top = funnelStages[0].count || 0;
    funnelStages.forEach((s, i) => {
      s.pctOfTop = top ? Math.round((s.count / top) * 1000) / 10 : 0;
      const prev = i === 0 ? s.count : funnelStages[i - 1].count;
      s.pctOfPrev = prev ? Math.round((s.count / prev) * 1000) / 10 : 0;
    });

    return res.status(200).json({
      days,
      totals: {
        events: Number(t[0]) || 0,
        sessions: Number(t[1]) || 0,
        users: Number(t[2]) || 0,
      },
      funnel: funnelStages,
      byEvent: rows(byEvent).map(r => ({ event: r[0], count: Number(r[1]) || 0 })),
      byDevice: rows(byDevice).map(r => ({ device: r[0], count: Number(r[1]) || 0 })),
      byPage: rows(byPage).map(r => ({ page_id: r[0], count: Number(r[1]) || 0 })),
      timeseries: rows(timeseries).map(r => ({ day: r[0], count: Number(r[1]) || 0 })),
    });
  } catch (err) {
    console.error('[dashboard/stats] error:', err.code || '', err.message);
    return res.status(502).json({
      error: 'Failed to query PostHog',
      detail: err.body || err.message,
    });
  }
};
