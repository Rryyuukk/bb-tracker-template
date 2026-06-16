const { requireAuth, phQuery, posthogConfigured } = require('./_lib.js');

// GET /api/dashboard/events?limit=100
// Live feed of the most recent bb-tracker events from PostHog.
module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (requireAuth(req, res)) return;

  if (!posthogConfigured()) {
    return res.status(503).json({ error: 'PostHog not configured' });
  }

  let limit = parseInt(req.query && req.query.limit, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 100;
  limit = Math.min(limit, 500);

  try {
    const result = await phQuery(`
      SELECT
        timestamp,
        event,
        ifNull(properties.page_id, '') AS page_id,
        ifNull(properties.page_type, '') AS page_type,
        ifNull(properties.device_type, '') AS device,
        ifNull(toString(properties.session_id), '') AS session_id
      FROM events
      ORDER BY timestamp DESC
      LIMIT ${limit}`);

    const events = ((result && result.results) || []).map(r => ({
      timestamp: r[0],
      event: r[1],
      page_id: r[2],
      page_type: r[3],
      device: r[4],
      session_id: r[5],
    }));

    return res.status(200).json({ events });
  } catch (err) {
    console.error('[dashboard/events] error:', err.code || '', err.message);
    return res.status(502).json({ error: 'Failed to query PostHog', detail: err.body || err.message });
  }
};
