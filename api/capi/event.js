const {
  pixelForPageId, sha256, clientIp, mapEventName, buildContents, sendCapiEvent,
  metaPixelForPageId, mapMetaEventName, buildMetaUserData, sendMetaCapiEvent,
  phCapture,
} = require('./_lib.js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const payload = req.body || {};
    const {
      event,        // bb-tracker event name
      event_id,     // dedup id (UUID generated client-side)
      page_id,
      page_type,
      page_url,
      page_referrer,
      session_id,
      device_type,
      is_returning,
      ttclid,
      ttp,
      user_id,
      email,
      phone,
      cta_pack,
      cta_href,
      plan,
      plan_price,
      currency,
      value,
      utm_source,
      utm_medium,
      utm_campaign,
      test_code,    // for TikTok Events Manager Test Events
      // Meta-specific click ids (browser captures from cookies / fbclid)
      fbc,
      fbp,
    } = payload;

    const tiktokEvent = mapEventName(event, page_type);
    const metaEvent = mapMetaEventName(event, page_type);

    const pixel = pixelForPageId(page_id);
    const metaPixel = metaPixelForPageId(page_id);

    // ── Dashboard mirror (PostHog) ──
    // The BB Tracker dashboard reads exclusively from PostHog. Server-rendered
    // funnel pages (Checkout Champ, custom advertorials) have no PostHog browser
    // SDK, so server-side ingest here is the ONLY way these bb-tracker events
    // reach the dashboard. Record the RAW bb-tracker event name (page_init,
    // scroll_depth, cta_clicked, cta_visible, read_time_estimate…) because the
    // dashboard funnel/feed queries key off those names — not the mapped
    // Meta/TikTok conversion names. Fire for EVERY event, including ones with no
    // pixel mapping (scroll_depth, read_time_estimate) and pages with no pixel
    // configured — and BEFORE the early return below. No-ops when
    // POSTHOG_PROJECT_API_KEY is unset. Never throws into the request path.
    const dashboardPromise = (event && page_id) ? phCapture({
      event,
      distinctId: user_id || session_id || page_id,
      properties: {
        page_id,
        page_type,
        device_type,
        session_id,
        user_id,
        is_returning,
        // event-specific fields surfaced in the dashboard (undefined drops out of JSON)
        scroll_percent: payload.scroll_percent,
        estimated_read_seconds: payload.estimated_read_seconds,
        time_on_page_seconds: payload.time_on_page_seconds,
        seconds_on_page: payload.seconds_on_page,
        cta_text: payload.cta_text,
        cta_href,
        cta_pack,
        utm_source,
        utm_medium,
        utm_campaign,
        source: 'bb_tracker_capi',
      },
    }).catch(err => ({ error: err.message })) : Promise.resolve(null);

    // Skip platform forwarding if neither platform has a mapped event/pixel for
    // this hit — but still record it to the dashboard first.
    if ((!tiktokEvent || !pixel) && (!metaEvent || !metaPixel)) {
      await dashboardPromise;
      return res.status(204).end();
    }

    const user = {
      external_id: sha256(user_id),
      email: sha256(email),
      phone_number: sha256(phone),
      ttclid: ttclid || undefined,
      ttp: ttp || undefined,
      user_agent: req.headers['user-agent'],
      ip: clientIp(req),
      locale: req.headers['accept-language']?.split(',')[0],
    };
    Object.keys(user).forEach(k => user[k] === undefined && delete user[k]);

    // Always set base product info so platform diagnostics don't flag missing fields.
    // Brand-level fallback derived from the resolved pixel — prevents events
    // without a cta_pack from being mis-attributed to another product's brand.
    const brandInfo = pixel || metaPixel;
    const fallbackContents = [{
      content_id: brandInfo.content_prefix,
      content_name: brandInfo.brand,
      content_type: 'product',
      content_category: brandInfo.content_category,
      quantity: 1,
    }];
    const contents = buildContents({ cta_pack, plan_price, plan, currency }) || fallbackContents;
    // Currency fallback: client (bb-tracker.js) reads BB_TRACKER_CONFIG.currency
    // and forwards it, so this branch is mostly defensive. Map page_id suffix
    // to the regional default so that a missing config doesn't quietly send
    // USD for a EUR/GBP funnel.
    const resolvedCurrency = currency
      || (page_id?.endsWith('-uk') ? 'GBP'
      : page_id?.endsWith('-de') || page_id?.endsWith('-fr') || page_id?.endsWith('-it') || page_id?.endsWith('-es') ? 'EUR'
      : 'USD');
    const resolvedValue = value !== undefined ? Number(value) : (plan_price ? Number(plan_price) : 0);

    const properties = {
      currency: resolvedCurrency,
      value: resolvedValue,
      contents,
      content_id: contents[0].content_id,
      content_name: contents[0].content_name,
      content_type: contents[0].content_type,
      content_category: contents[0].content_category,
      query: utm_source ? `utm_source=${utm_source}&utm_medium=${utm_medium||''}&utm_campaign=${utm_campaign||''}` : undefined,
    };
    Object.keys(properties).forEach(k => properties[k] === undefined && delete properties[k]);

    const page = {
      url: page_url,
      referrer: page_referrer,
    };

    const tiktokPromise = (tiktokEvent && pixel) ? sendCapiEvent({
      pixel,
      eventName: tiktokEvent,
      eventId: event_id,
      user,
      properties,
      page,
      testCode: test_code,
    }).catch(err => ({ status: 500, body: { error: err.message } })) : Promise.resolve(null);

    const metaPromise = (metaEvent && metaPixel) ? (async () => {
      const metaUserData = buildMetaUserData({
        email,
        phone,
        external_id: user_id,
        fbc,
        fbp,
        ip: clientIp(req),
        user_agent: req.headers['user-agent'],
        locale: req.headers['accept-language']?.split(',')[0],
      });
      const metaCustomData = {
        currency: resolvedCurrency,
        value: resolvedValue,
        content_ids: contents.map(c => c.content_id),
        content_name: contents[0].content_name,
        content_type: 'product',
        contents: contents.map(c => ({
          id: c.content_id,
          quantity: c.quantity || 1,
          item_price: c.price,
        })),
      };
      Object.keys(metaCustomData).forEach(k => metaCustomData[k] === undefined && delete metaCustomData[k]);
      // Use a different event_id for Meta so it dedups against fbq browser pixel
      // (which uses the same event_id from bb-tracker). bb-tracker sends one
      // event_id per logical event — both server and browser must use it.
      return sendMetaCapiEvent({
        pixel: metaPixel,
        eventName: metaEvent,
        eventId: event_id,
        userData: metaUserData,
        customData: metaCustomData,
        eventSourceUrl: page_url,
      }).catch(err => ({ status: 500, body: { error: err.message } }));
    })() : Promise.resolve(null);

    const [ttResult, metaResult, dashResult] = await Promise.all([tiktokPromise, metaPromise, dashboardPromise]);

    return res.status(200).json({
      ok: (!tiktokEvent || !pixel || (ttResult?.status === 200 && ttResult?.body?.code === 0))
        && (!metaEvent || !metaPixel || (metaResult?.status === 200 && !metaResult?.body?.error)),
      tiktok_status: ttResult?.status,
      tiktok_response: ttResult?.body,
      tiktok_event: tiktokEvent,
      meta_status: metaResult?.status,
      meta_response: metaResult?.body,
      meta_event: metaEvent,
      dashboard: dashResult,
      event_id,
    });
  } catch (err) {
    // Endpoint is public + CORS *. Don't leak err.message/stack which can
    // expose paths, env var names, or library versions to attackers.
    console.error('[capi/event] unhandled error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
};
