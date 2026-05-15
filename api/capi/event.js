const {
  pixelForPageId, sha256, clientIp, mapEventName, buildContents, sendCapiEvent,
  metaPixelForPageId, mapMetaEventName, buildMetaUserData, sendMetaCapiEvent,
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

    // Skip silently if neither platform has a mapped event/pixel for this hit
    if ((!tiktokEvent || !pixel) && (!metaEvent || !metaPixel)) {
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

    const [ttResult, metaResult] = await Promise.all([tiktokPromise, metaPromise]);

    return res.status(200).json({
      ok: (!tiktokEvent || !pixel || (ttResult?.status === 200 && ttResult?.body?.code === 0))
        && (!metaEvent || !metaPixel || (metaResult?.status === 200 && !metaResult?.body?.error)),
      tiktok_status: ttResult?.status,
      tiktok_response: ttResult?.body,
      tiktok_event: tiktokEvent,
      meta_status: metaResult?.status,
      meta_response: metaResult?.body,
      meta_event: metaEvent,
      event_id,
    });
  } catch (err) {
    // Endpoint is public + CORS *. Don't leak err.message/stack which can
    // expose paths, env var names, or library versions to attackers.
    console.error('[capi/event] unhandled error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
};
