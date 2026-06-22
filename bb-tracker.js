// ═══════════════════════════════════════════════════════════════
// BB SCALING — UNIVERSAL TRACKER v1.0
// Funciona em: Quizzes, VSLs, Advertoriais, Landing Pages
// Envia dados via GTM dataLayer → GA4 (fonte de verdade)
// ═══════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // ── Early <video> capture ──
  // Patch document.createElement BEFORE anything else, so we intercept <video>
  // elements VTURB injects into closed shadow DOM (which document.querySelector
  // can't reach). Listeners on the element itself still fire regardless of where
  // the element lives. Queue them for initVSLPlugin to consume later.
  (function patchCreateElement() {
    try {
      if (document.createElement.__bbPatched) return;
      var orig = document.createElement;
      window.__bbEarlyVideos = window.__bbEarlyVideos || [];
      document.createElement = function (tagName) {
        var el = orig.apply(this, arguments);
        try {
          if (tagName && String(tagName).toLowerCase() === 'video') {
            window.__bbEarlyVideos.push(el);
            if (typeof window.__bbOnVideoCreated === 'function') {
              try { window.__bbOnVideoCreated(el); } catch (e) {}
            }
          }
        } catch (e) {}
        return el;
      };
      document.createElement.__bbPatched = true;
    } catch (e) {}
  })();

  // ── Config (setado por cada página antes de carregar este script) ──
  var cfg = window.BB_TRACKER_CONFIG || {};
  var PAGE_TYPE = cfg.pageType || 'unknown';   // 'quiz', 'vsl', 'advertorial', 'landing'
  var PAGE_ID = cfg.pageId || 'unknown';        // 'usa', 'ge-rev3rx', 'vsl-kegel-us', etc.
  var GTM_ID = cfg.gtmId || 'GTM-XXXXXXX';
  var GA4_MEASUREMENT_ID = cfg.ga4MeasurementId || 'G-XXXXXXXXXX';
  var PROXY_BASE = cfg.proxyBase || '';

  // ── DataLayer init ──
  window.dataLayer = window.dataLayer || [];

  // ── Install GTM (skip if already loaded inline) ──
  window.dataLayer = window.dataLayer || [];
  var gtmAlreadyLoaded = false;
  for (var i = 0; i < window.dataLayer.length; i++) {
    if (window.dataLayer[i]['gtm.start']) { gtmAlreadyLoaded = true; break; }
  }
  if (!gtmAlreadyLoaded) {
    (function (w, d, s, l, id) {
      w[l].push({ 'gtm.start': new Date().getTime(), event: 'gtm.js' });
      var f = d.getElementsByTagName(s)[0],
        j = d.createElement(s), dl = l !== 'dataLayer' ? '&l=' + l : '';
      j.async = true;
      // Try first-party proxy, fallback to direct GTM
      j.src = PROXY_BASE + '/api/proxy-gtm?id=' + id + dl;
      j.onerror = function () {
        var k = d.createElement(s);
        k.async = true;
        k.src = 'https://www.googletagmanager.com/gtm.js?id=' + id + dl;
        f.parentNode.insertBefore(k, f);
      };
      f.parentNode.insertBefore(j, f);
    })(window, document, 'script', 'dataLayer', GTM_ID);
  }

  // ── User ID (persistent across sessions, 2 years) ──
  var USER_KEY = 'bb_user_id';
  var userId = null;
  try { userId = localStorage.getItem(USER_KEY); } catch (e) {}
  if (!userId) {
    userId = 'u_' + Math.random().toString(36).substring(2, 10) + '_' + Date.now().toString(36);
    try { localStorage.setItem(USER_KEY, userId); } catch (e) {}
  }
  // Also set as cookie for server-side reading
  try {
    document.cookie = 'bb_uid=' + userId + '; max-age=63072000; path=/; SameSite=Lax';
  } catch (e) {}

  // ── Session ID (persiste por tab) ──
  var SESSION_KEY = 'bb_session_id';
  var sessionId = sessionStorage.getItem(SESSION_KEY);
  if (!sessionId) {
    sessionId = Math.random().toString(36).substring(2) + Date.now().toString(36);
    sessionStorage.setItem(SESSION_KEY, sessionId);
  }

  // ── Device detection ──
  var device = /Mobi|Android/i.test(navigator.userAgent) ? 'mobile' : 'desktop';

  // ── UTM capture ──
  var params = new URLSearchParams(window.location.search);
  var utms = {};
  ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id'].forEach(function (key) {
    var val = params.get(key);
    if (val) utms[key] = val;
  });

  // Cloaker fallback: Cloakup repassa params do TikTok com nomes próprios
  // (cname, search, adname, wr). Sem esse map, atribuição granular por campanha
  // some quando o tráfego passa por cloaker.
  var CLOAKER_FALLBACK = {
    utm_campaign: 'cname',
    utm_content: 'search',
    utm_term: 'adname',
    utm_id: 'wr'
  };
  Object.keys(CLOAKER_FALLBACK).forEach(function (utmKey) {
    if (utms[utmKey]) return;
    var val = params.get(CLOAKER_FALLBACK[utmKey]);
    if (val) utms[utmKey] = val;
  });

  // Salva UTMs no sessionStorage (persiste entre páginas do mesmo funil)
  if (Object.keys(utms).length > 0) {
    sessionStorage.setItem('bb_utms', JSON.stringify(utms));
  } else {
    try { utms = JSON.parse(sessionStorage.getItem('bb_utms')) || {}; } catch (e) { utms = {}; }
  }

  // ── TikTok Click ID (persisted per session for attribution) ──
  var ttclid = params.get('ttclid');
  if (ttclid) sessionStorage.setItem('bb_ttclid', ttclid);
  else ttclid = sessionStorage.getItem('bb_ttclid') || '';

  // ── TikTok _ttp cookie (set by the pixel; needed for CAPI dedup) ──
  function readCookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }
  function getTtp() { return readCookie('_ttp'); }

  // ── Returning visitor detection ──
  var isReturning = !!localStorage.getItem('bb_visited');
  localStorage.setItem('bb_visited', '1');

  // ── UUID-ish event id generator (deterministic-friendly for dedup) ──
  function genEventId(prefix) {
    var rnd = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    return (prefix || 'ev') + '_' + rnd;
  }

  // ── Base properties (enviadas com todo evento) ──
  var baseProps = {
    page_type: PAGE_TYPE,
    page_id: PAGE_ID,
    user_id: userId,
    session_id: sessionId,
    device_type: device,
    is_returning: isReturning
  };
  // Merge UTMs
  Object.keys(utms).forEach(function (k) { baseProps[k] = utms[k]; });
  // TikTok click ID
  if (ttclid) baseProps.ttclid = ttclid;

  // ═══════════════════════════════════════
  // PostHog Bridge — espelha eventos pro PostHog (queue se posthog ainda não carregou)
  // ═══════════════════════════════════════
  var phQueue = [];
  var phWatcherStarted = false;
  var phSuperPropsRegistered = false;

  function registerPHSuperProps() {
    if (phSuperPropsRegistered) return;
    if (window.posthog && typeof window.posthog.register === 'function') {
      try { window.posthog.register(baseProps); phSuperPropsRegistered = true; } catch (e) {}
    }
  }

  // Events that immediately trigger navigation (CTA → Shopify, plan select, quiz
  // submit). Without sendBeacon transport, the pending PostHog XHR is aborted by
  // the browser when the page unloads, dropping ~10-30% of these events. Using
  // sendBeacon registers the request with the browser to outlive the navigation.
  // Discrepancy diagnosed 2026-05-10 (DE advertorial: 88 PostHog clicks vs
  // 100 Shopify ICs = 12% loss; older funnels showed up to 37% loss).
  var NAVIGATING_EVENTS = { cta_clicked: 1, plan_selected: 1, quiz_completed: 1 };

  function phCapture(event, phPayload) {
    var opts = NAVIGATING_EVENTS[event] ? { transport: 'sendBeacon' } : undefined;
    try { window.posthog.capture(event, phPayload, opts); } catch (e) {}
  }

  function bridgeToPostHog(event, payload) {
    // PostHog usa o nome do evento como chave; remove o campo "event" do payload
    var phPayload = {};
    for (var k in payload) {
      if (k !== 'event' && payload.hasOwnProperty(k)) phPayload[k] = payload[k];
    }
    if (window.posthog && typeof window.posthog.capture === 'function') {
      registerPHSuperProps();
      while (phQueue.length > 0) {
        var q = phQueue.shift();
        phCapture(q.event, q.payload);
      }
      phCapture(event, phPayload);
      return;
    }
    phQueue.push({ event: event, payload: phPayload });
    if (phWatcherStarted) return;
    phWatcherStarted = true;
    var attempts = 0;
    var phInterval = setInterval(function () {
      if (window.posthog && typeof window.posthog.capture === 'function') {
        registerPHSuperProps();
        while (phQueue.length > 0) {
          var qq = phQueue.shift();
          phCapture(qq.event, qq.payload);
        }
        clearInterval(phInterval);
      } else if (++attempts > 20) { // 10s max
        clearInterval(phInterval);
      }
    }, 500);
  }

  // ── Push initial UTM event ──
  if (Object.keys(utms).length > 0) {
    var utmPayload = Object.assign({ event: 'utm_captured' }, baseProps);
    window.dataLayer.push(utmPayload);
    bridgeToPostHog('utm_captured', utmPayload);
  }

  // ── Push device info ──
  var deviceInfoPayload = Object.assign({ event: 'device_info' }, baseProps, {
    screen_width: screen.width,
    screen_height: screen.height,
    viewport_width: window.innerWidth,
    viewport_height: window.innerHeight
  });
  window.dataLayer.push(deviceInfoPayload);
  bridgeToPostHog('device_info', deviceInfoPayload);

  // ── Returning visitor event ──
  if (isReturning) {
    var returningPayload = Object.assign({ event: 'returning_visitor' }, baseProps);
    window.dataLayer.push(returningPayload);
    bridgeToPostHog('returning_visitor', returningPayload);
  }

  // ═══════════════════════════════════════
  // TikTok CAPI Bridge — sends mapped events server-side for dedup w/ pixel
  // Endpoint: set via cfg.capiEndpoint (your bb-tracker Vercel deploy)
  // ═══════════════════════════════════════
  var CAPI_ENDPOINT = (cfg.capiEndpoint || '');
  // Events forwarded to the server endpoint. The endpoint forwards mapped events
  // to Meta/TikTok CAPI AND mirrors every event into PostHog for the dashboard.
  // scroll_depth + read_time_estimate don't map to any ad-platform conversion
  // (the endpoint sends them to PostHog only) but the dashboard's Advertorial
  // view needs them — without this they'd only reach the browser PostHog SDK,
  // which isn't present on server-rendered funnel pages (Checkout Champ).
  var CAPI_EVENTS = { page_init: 1, vsl_play: 1, cta_visible: 1, cta_clicked: 1, quiz_complete: 1, quiz_completed: 1, plan_selected: 1, scroll_depth: 1, read_time_estimate: 1 };

  function bridgeToCapi(event, data, eventId) {
    if (!CAPI_EVENTS[event]) return;
    if (cfg.disableCapi) return;
    try {
      var body = Object.assign({}, baseProps, data || {}, {
        event: event,
        event_id: eventId,
        ttp: getTtp(),
        page_url: window.location.href,
        page_referrer: document.referrer,
      });
      // Fire-and-forget; use sendBeacon when leaving page would lose the request
      var blob = new Blob([JSON.stringify(body)], { type: 'application/json' });
      if (navigator.sendBeacon && (event === 'cta_clicked' || event === 'quiz_completed')) {
        navigator.sendBeacon(CAPI_ENDPOINT, blob);
      } else {
        fetch(CAPI_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true }).catch(function () {});
      }
    } catch (e) {}
  }

  // ═══════════════════════════════════════
  // PUBLIC API: window.bbTrack(event, data)
  // ═══════════════════════════════════════
  window.bbTrack = function (event, data) {
    var eventId = genEventId(event);
    var payload = Object.assign({
      event: event,
      event_id: eventId,
      event_timestamp: new Date().toISOString()
    }, baseProps, data || {});

    window.dataLayer.push(payload);
    bridgeToPostHog(event, payload);
    bridgeToCapi(event, data, eventId);
    maybeFireInitiateCheckout(event, data, eventId);

    // Console log em dev
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
      console.log('[BB-TRACK]', event, payload);
    }
  };

  // Auto-fire TikTok InitiateCheckout + GA4 begin_checkout when the user clicks
  // a buy button. Centralized here so every page (quiz, vsl, advertorial, landing)
  // gets it for free without per-page code. Triggered by:
  //   - plan_selected (quiz protocol page)
  //   - cta_clicked when data.destination points to a Shopify cart
  // The flag prevents duplicates: quiz onClick fires plan_selected + cta_clicked
  // back-to-back, and double-clicks would otherwise send IC twice.
  var IC_TRIGGER_EVENTS = { plan_selected: true, cta_clicked: true };
  var icAlreadyFired = false;
  function maybeFireInitiateCheckout(event, data, eventId) {
    if (icAlreadyFired) return;
    if (!IC_TRIGGER_EVENTS[event]) return;
    // plan_selected is only emitted from real buy-button onClicks, so it
    // always counts as IC. cta_clicked fires for every CTA on the page
    // (Continue, FAQ, etc), so it requires destination/cta_href pointing
    // to a Shopify cart.
    if (event === 'cta_clicked') {
      var dest = data && (data.destination || data.cta_href);
      if (!dest || !/myshopify\.com|\/cart\//.test(dest)) return;
    }
    var value = data && (data.total_usd || data.total_gbp || data.total_eur || data.total || data.value);
    var currency = cfg.currency || (data && (data.total_gbp ? 'GBP' : data.total_eur ? 'EUR' : 'USD'));
    var contentId = (data && (data.plan || data.pack || data.cta_pack)) || PAGE_ID;
    var icEventId = 'tt_ic_' + eventId;
    if (window.ttq && typeof window.ttq.track === 'function') {
      try {
        window.ttq.track('InitiateCheckout', {
          value: Number(value) || 0,
          currency: currency,
          content_id: contentId,
          content_type: 'product',
          event_id: icEventId
        });
        icAlreadyFired = true;
      } catch (e) {}
    }
    if (typeof window.gtag === 'function') {
      try {
        window.gtag('event', 'begin_checkout', {
          value: Number(value) || 0,
          currency: currency,
          items: [{ item_id: contentId, item_name: contentId, quantity: 1, price: Number(value) || 0 }]
        });
      } catch (e) {}
    }
  }

  // ═══════════════════════════════════════
  // IMMEDIATE page_init — fire NOW before init() runs, so even if any plugin
  // throws we still record the hit. init() later will fire page_init_detected
  // with the auto-detected page_type for refinement.
  // ═══════════════════════════════════════
  try {
    window.bbTrack('page_init', {
      detected_page_type: PAGE_TYPE,
      ready_state: document.readyState,
      early: true
    });
  } catch (e) {}

  // ═══════════════════════════════════════
  // AUTO-TRACKING: Scroll Depth
  // ═══════════════════════════════════════
  var scrollMilestones = [25, 50, 75, 100];
  var scrollFired = {};
  var MIN_SCROLLABLE_HEIGHT = 500; // Minimum scrollable area (px) to count scroll

  function getScrollPercent() {
    var h = document.documentElement;
    var b = document.body;
    var st = window.pageYOffset || h.scrollTop || b.scrollTop || 0;
    var sh = Math.max(h.scrollHeight, b.scrollHeight) - window.innerHeight;
    if (sh < MIN_SCROLLABLE_HEIGHT) return -1;
    return Math.round((st / sh) * 100);
  }

  // Delay scroll tracking briefly to let page settle (500ms)
  var scrollTrackingReady = false;
  setTimeout(function() { scrollTrackingReady = true; }, 500);

  window.addEventListener('scroll', function () {
    if (!scrollTrackingReady) return; // Wait for page to fully load
    var pct = getScrollPercent();
    if (pct < 0) return; // Page too short, skip tracking
    scrollMilestones.forEach(function (m) {
      // Accept 95% as reaching 100% — sticky CTAs, footer padding, mobile overscroll
      // often prevent hitting exact 100%. This is a common reality across landing pages.
      var threshold = m === 100 ? 95 : m;
      if (pct >= threshold && !scrollFired[m]) {
        scrollFired[m] = true;
        window.bbTrack('scroll_depth', { scroll_percent: m });
      }
    });
  }, { passive: true });

  // On pageleave / beforeunload, fire scroll_100 if user reached >= 90% —
  // captures "read almost all" cases where they scrolled but never stopped at the bottom.
  function maybeFireScroll100OnExit() {
    if (scrollFired[100]) return;
    var pct = getScrollPercent();
    if (pct >= 90) {
      scrollFired[100] = true;
      window.bbTrack('scroll_depth', { scroll_percent: 100 });
    }
  }
  window.addEventListener('pagehide', maybeFireScroll100OnExit);
  window.addEventListener('beforeunload', maybeFireScroll100OnExit);

  // ═══════════════════════════════════════
  // AUTO-TRACKING: Time on Page
  // ═══════════════════════════════════════
  var timeMilestones = [30, 60, 120, 300];
  var pageStartTime = Date.now();

  timeMilestones.forEach(function (seconds) {
    setTimeout(function () {
      window.bbTrack('time_on_page', { seconds_on_page: seconds });
    }, seconds * 1000);
  });

  // ═══════════════════════════════════════
  // AUTO-TRACKING: Exit Intent
  // ═══════════════════════════════════════
  var exitFired = false;

  // Desktop: mouse sai pelo topo
  document.addEventListener('mouseout', function (e) {
    if (exitFired) return;
    if (e.clientY <= 0 && e.relatedTarget === null) {
      exitFired = true;
      window.bbTrack('exit_intent', {
        method: 'mouse_leave',
        time_on_page_seconds: Math.round((Date.now() - pageStartTime) / 1000),
        scroll_percent: getScrollPercent()
      });
    }
  });

  // Mobile: back button / visibilidade
  document.addEventListener('visibilitychange', function () {
    if (exitFired) return;
    if (document.visibilityState === 'hidden') {
      exitFired = true;
      window.bbTrack('exit_intent', {
        method: 'visibility_hidden',
        time_on_page_seconds: Math.round((Date.now() - pageStartTime) / 1000),
        scroll_percent: getScrollPercent()
      });
    }
  });

  // ═══════════════════════════════════════
  // PAGE TYPE AUTO-DETECT
  // ═══════════════════════════════════════
  function detectPageType() {
    if (cfg.pageType && cfg.pageType !== 'unknown') return cfg.pageType;
    if (document.querySelector('vturb-smartplayer')) return 'vsl';
    if (document.querySelector('video')) return 'vsl';
    if (document.querySelector('[data-bb-slide], .slide, .phase')) return 'quiz';
    return 'landing';
  }

  // ═══════════════════════════════════════
  // UNIVERSAL CTA DETECTION (all page types)
  // Auto-detect via href/text matching + IntersectionObserver + click delegation
  // ═══════════════════════════════════════
  var CTA_HREF_REGEX = /checkout|cart|buy|order|kaufen|comprar|purchase|click|/i;
  var CTA_TEXT_REGEX = /buy now|order now|comprar|kaufen|checkout|get started|claim|unlock|continue/i;
  var CTA_CLASS_SELECTOR = '[data-bb-cta],[data-bb-cta-buy],.cta-button,.buy-button,.checkout-btn,button.cta,a.btn-cta,.btn-unlock,.dtc-cta,.dtc-btn,[buylink],[data-bb-pack]';

  function isCTAElement(el) {
    if (!el || el.nodeType !== 1) return false;
    // Anchor-only links (href starts with "#") scroll within the page —
    // they are not CTAs even when their text matches the CTA regex.
    // Explicit opt-in via data-bb-cta still counts as CTA.
    if (el.tagName === 'A') {
      var hrefAttr = (el.getAttribute('href') || '').trim();
      if (hrefAttr.startsWith('#') && !el.hasAttribute('data-bb-cta')) return false;
    }
    if (el.matches(CTA_CLASS_SELECTOR)) return true;
    if (el.hasAttribute && (el.hasAttribute('buylink') || el.hasAttribute('data-bb-pack'))) return true;
    if (el.className && /\bbottle\d+\b|\bcard-\d+(?:bot|pot|pack)\b|\bpack-\d+\b/i.test(el.className)) return true;
    var href = (el.getAttribute && el.getAttribute('href') || '').toLowerCase();
    if (href && /checkout|cart|buy|order|kaufen|comprar|purchase|\/click/i.test(href)) return true;
    var text = (el.textContent || '').trim();
    if (text && text.length < 80 && CTA_TEXT_REGEX.test(text)) return true;
    return false;
  }

  // ═══════════════════════════════════════
  // PACK / OFFER DETECTION (2/4/6 bottles, plans, packs)
  // 4 levels: data-bb-pack → buylink attr → class bottleN → text heuristic → parent card text
  // ═══════════════════════════════════════
  var PACK_TEXT_REGEX = /(\d+)\s*[xX×]?\s*(?:bottle|bottles|pot|potes|pack|month|months|monate?|mes|meses|mo\b|unit|qty|jar|capsule)/i;

  function extractPackInfo(el) {
    if (!el) return null;
    // 1. data-bb-pack on element or any ancestor
    var packEl = el.closest && el.closest('[data-bb-pack]');
    if (packEl) return { value: packEl.getAttribute('data-bb-pack'), source: 'data-bb-pack' };
    // 2. buylink="buyN_link" attribute on element or ancestor
    var buylinkEl = el.closest && el.closest('[buylink]');
    if (buylinkEl) {
      var b = (buylinkEl.getAttribute('buylink') || '').match(/buy(\d+)/i);
      if (b) return { value: b[1], source: 'buylink' };
    }
    // 3. Class "bottleN" / "card-Nbot" / "pack-N" on element or ancestor
    var node = el;
    while (node && node.nodeType === 1) {
      var c = node.className || '';
      var cm = (typeof c === 'string' ? c : c.baseVal || '').match(/\b(?:bottle|pack|qty)(\d+)\b|\bcard-(\d+)(?:bot|pot|pack)\b/i);
      if (cm) return { value: cm[1] || cm[2], source: 'class' };
      node = node.parentElement;
    }
    // 4. Text on the button itself
    var t = (el.textContent || '').trim();
    var tm = t.match(PACK_TEXT_REGEX);
    if (tm) return { value: tm[1], source: 'text' };
    // 5. Walk up to a card-like container and read its full text
    var container = el.closest && el.closest('[class*="card"],[class*="plan"],[class*="pack"],[class*="bottle"],[class*="pricing"],[class*="offer"]');
    if (container && container !== el) {
      var ct = (container.textContent || '').trim();
      var ctm = ct.match(PACK_TEXT_REGEX);
      if (ctm) return { value: ctm[1], source: 'parent-card-text' };
    }
    return null;
  }

  function scanPackCards() {
    var seenPacks = {};
    var cards = [];
    function add(el, pack, source) {
      if (!pack) return;
      var key = pack + '|' + source + '|' + (el.id || el.className || '').substring(0, 30);
      if (seenPacks[key]) return;
      seenPacks[key] = true;
      cards.push({
        pack: pack,
        source: source,
        href: (el.getAttribute('href') || '').substring(0, 200),
        text: (el.textContent || '').trim().substring(0, 60)
      });
    }
    // data-bb-pack
    document.querySelectorAll('[data-bb-pack]').forEach(function (el) {
      add(el, el.getAttribute('data-bb-pack'), 'data-bb-pack');
    });
    // buylink="buyN_link"
    document.querySelectorAll('[buylink]').forEach(function (el) {
      var m = (el.getAttribute('buylink') || '').match(/buy(\d+)/i);
      if (m) add(el, m[1], 'buylink');
    });
    // class "bottleN" / "card-Nbot" / "packN"
    document.querySelectorAll('[class*="bottle"],[class*="pack"],[class*="card-"]').forEach(function (el) {
      var c = el.className || '';
      var m = (typeof c === 'string' ? c : c.baseVal || '').match(/\bbottle(\d+)\b|\bcard-(\d+)(?:bot|pot|pack)\b|\bpack(\d+)\b/i);
      if (m) add(el, m[1] || m[2] || m[3], 'class');
    });
    return cards;
  }

  function watchCTAVisibility() {
    var seen = new WeakSet();
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        if (seen.has(entry.target)) return;
        seen.add(entry.target);
        var packInfo = extractPackInfo(entry.target);
        window.bbTrack('cta_visible', {
          cta_text: (entry.target.textContent || '').trim().substring(0, 80),
          cta_href: (entry.target.getAttribute('href') || '').substring(0, 200),
          cta_pack: packInfo ? packInfo.value : null,
          cta_pack_source: packInfo ? packInfo.source : null
        });
        io.unobserve(entry.target);
      });
    }, { threshold: 0.5 });

    function scan() {
      var candidates = document.querySelectorAll('a, button, ' + CTA_CLASS_SELECTOR);
      for (var i = 0; i < candidates.length; i++) {
        if (!seen.has(candidates[i]) && isCTAElement(candidates[i])) io.observe(candidates[i]);
      }
    }
    scan();
    var domObserver = new MutationObserver(function () { scan(); });
    domObserver.observe(document.body, { childList: true, subtree: true });
  }

  // Click delegation — captures CTAs even if injected dynamically
  document.addEventListener('click', function (e) {
    var el = e.target.closest && e.target.closest('a, button, ' + CTA_CLASS_SELECTOR);
    if (!el || !isCTAElement(el)) return;
    var packInfo = extractPackInfo(el);
    window.bbTrack('cta_clicked', {
      cta_text: (el.textContent || '').trim().substring(0, 80),
      cta_href: (el.getAttribute('href') || '').substring(0, 200),
      cta_pack: packInfo ? packInfo.value : null,
      cta_pack_source: packInfo ? packInfo.source : null,
      cta_seconds_since_play: window.__bbVslPlayAt ? Math.round((Date.now() - window.__bbVslPlayAt) / 1000) : null,
      cta_seconds_since_pageload: Math.round((Date.now() - pageStartTime) / 1000)
    });
  }, true);

  // ═══════════════════════════════════════
  // PLUGIN: VSL (VTURB or native <video>)
  // ═══════════════════════════════════════
  function initVSLPlugin() {
    var vturbPlayer = document.querySelector('vturb-smartplayer');
    var nativeVideo = document.querySelector('video');
    if (!vturbPlayer && !nativeVideo) return;

    window.bbTrack('vsl_loaded', {
      vsl_player_type: vturbPlayer ? 'vturb' : 'native',
      vsl_player_id: vturbPlayer ? (vturbPlayer.id || '') : ''
    });

    var playFired = false;
    var milestonesFired = { 25: false, 50: false, 75: false, 100: false };
    var durationDetected = null;
    var boundVideo = null;

    function firePlay() {
      if (playFired) return;
      playFired = true;
      window.__bbVslPlayAt = Date.now();
      window.bbTrack('vsl_play', { vsl_player_type: vturbPlayer ? 'vturb' : 'native' });
    }

    function fireProgress(pct, seconds) {
      if (milestonesFired[pct]) return;
      milestonesFired[pct] = true;
      window.bbTrack('vsl_progress', {
        vsl_percent: pct,
        vsl_seconds: Math.round(seconds || 0),
        vsl_duration: durationDetected ? Math.round(durationDetected) : null
      });
      if (pct === 100) window.bbTrack('vsl_complete', { vsl_seconds: Math.round(seconds || 0) });
    }

    // VTURB uses closed shadow DOM — document.querySelector can't reach the real <video>.
    // Returns a 1×1 "probe" <video> (cdn.converteai.net/1.mp4) VTURB appends to body.
    // We must filter it out to avoid false-positive plays.
    function isProbeVideo(v) {
      try {
        var src = String(v.src || v.currentSrc || '');
        if (src.indexOf('/1.mp4') >= 0) return true;
        if (v.getAttribute && v.getAttribute('aria-hidden') === 'true') return true;
        var st = v.style;
        if (st && (st.width === '1px' || st.height === '1px' || st.opacity === '0')) return true;
      } catch (e) {}
      return false;
    }

    function bindRealVideo(v) {
      if (boundVideo === v) return;
      boundVideo = v;
      if (v.duration > 0 && isFinite(v.duration) && !durationDetected) {
        durationDetected = v.duration;
        window.bbTrack('vsl_duration_detected', { vsl_duration: Math.round(v.duration) });
      }
      try {
        v.addEventListener('loadedmetadata', function () {
          if (!durationDetected && v.duration > 0 && isFinite(v.duration)) {
            durationDetected = v.duration;
            window.bbTrack('vsl_duration_detected', { vsl_duration: Math.round(v.duration) });
          }
        });
        v.addEventListener('timeupdate', function () {
          if (!durationDetected && v.duration > 0 && isFinite(v.duration)) {
            durationDetected = v.duration;
            window.bbTrack('vsl_duration_detected', { vsl_duration: Math.round(v.duration) });
          }
          if (durationDetected && v.currentTime > 0) {
            var pct = (v.currentTime / durationDetected) * 100;
            [25, 50, 75, 100].forEach(function (m) {
              if (pct >= m && !milestonesFired[m]) fireProgress(m, v.currentTime);
            });
          }
        });
        v.addEventListener('ended', function () { fireProgress(100, v.duration || 0); });
      } catch (e) {}
    }

    // Monkey-patch HTMLMediaElement.prototype.play — intercepts .play() calls from
    // ANY <video>, including VTURB's closed shadow DOM. Prototype is shared globally,
    // so cross-shadow-root calls still reach this hook.
    (function patchPlay() {
      var proto = HTMLMediaElement && HTMLMediaElement.prototype;
      if (!proto || proto.play.__bbPatched) return;
      var orig = proto.play;
      proto.play = function () {
        var result;
        try { result = orig.apply(this, arguments); } catch (e) { result = Promise.reject(e); }
        try {
          if (!isProbeVideo(this)) {
            bindRealVideo(this);
            firePlay();
          }
        } catch (e) {}
        return result;
      };
      proto.play.__bbPatched = true;
    })();

    // Consume any <video> elements captured by the early createElement hook.
    // VTURB creates its <video> before initVSLPlugin runs — those are queued
    // on window.__bbEarlyVideos so we can bind listeners to them here.
    (function consumeEarlyVideos() {
      var list = window.__bbEarlyVideos || [];
      function attach(v) {
        if (!v || v.__bbBound) return;
        if (isProbeVideo(v)) return;
        v.__bbBound = true;
        bindRealVideo(v);
        var onPlay = function () { if (!isProbeVideo(v)) firePlay(); };
        try {
          v.addEventListener('play', onPlay);
          v.addEventListener('playing', onPlay);
          v.addEventListener('timeupdate', function () {
            if (v.currentTime > 0.3 && !isProbeVideo(v)) firePlay();
          });
        } catch (e) {}
        // If it's already playing by the time we get here, fire immediately.
        try {
          if (v.currentTime > 0.3 && !v.paused && !isProbeVideo(v)) firePlay();
        } catch (e) {}
      }
      for (var i = 0; i < list.length; i++) attach(list[i]);
      // Keep watching: if VTURB creates more <video>s later, hook them too.
      window.__bbOnVideoCreated = attach;
    })();

    // Backup poll: scan document.querySelectorAll('video') for 30s.
    // Catches <video> elements living OUTSIDE shadow DOM where createElement
    // hook may have missed them (pre-existing in HTML, or created before our IIFE).
    (function pollVideos() {
      var attempts = 0;
      var iv = setInterval(function () {
        try {
          var videos = document.querySelectorAll('video');
          for (var i = 0; i < videos.length; i++) {
            var v = videos[i];
            if (isProbeVideo(v)) continue;
            if (!v.__bbBound) {
              v.__bbBound = true;
              bindRealVideo(v);
              try {
                v.addEventListener('play', function () { firePlay(); });
                v.addEventListener('playing', function () { firePlay(); });
              } catch (e) {}
            }
            if (v.currentTime > 0.3 && !v.paused) firePlay();
          }
        } catch (e) {}
        if (++attempts > 60 || playFired) clearInterval(iv);
      }, 500);
    })();

    // Player-level ready event (host element dispatches this)
    if (vturbPlayer) {
      try {
        vturbPlayer.addEventListener('player:ready', function () {
          window.bbTrack('vsl_ready', {});
        });
      } catch (e) {}
    }

    // Native-video fallback (non-VTURB pages)
    if (nativeVideo && !isProbeVideo(nativeVideo)) {
      bindRealVideo(nativeVideo);
      try {
        nativeVideo.addEventListener('play', firePlay);
        nativeVideo.addEventListener('playing', firePlay);
      } catch (e) {}
    }

    // ── Pitch Reveal Detection ──
    // VTURB calls player.displayHiddenElements(seconds, ['.esconder']) which removes display:none.
    // We intercept BOTH ways: monkey-patch the method AND MutationObserver on .esconder elements.
    function watchPitchReveal() {
      var pitchScheduled = null;
      // Method 1: Monkey-patch displayHiddenElements when player exposes it
      function tryPatch() {
        if (!vturbPlayer) return false;
        if (typeof vturbPlayer.displayHiddenElements !== 'function') return false;
        if (vturbPlayer.__bbPatched) return true;
        vturbPlayer.__bbPatched = true;
        var orig = vturbPlayer.displayHiddenElements.bind(vturbPlayer);
        vturbPlayer.displayHiddenElements = function (seconds, selectors, opts) {
          pitchScheduled = seconds;
          window.bbTrack('pitch_scheduled', {
            pitch_at_video_seconds: seconds,
            pitch_selectors: Array.isArray(selectors) ? selectors.join(',') : String(selectors || '')
          });
          return orig(seconds, selectors, opts);
        };
        return true;
      }
      var patched = tryPatch();
      if (!patched) {
        var patchAttempts = 0;
        var patchInterval = setInterval(function () {
          if (tryPatch() || ++patchAttempts > 30) clearInterval(patchInterval);
        }, 500);
      }

      // Method 2: MutationObserver on .esconder elements (catches the actual reveal)
      var seenReveal = new WeakSet();
      function checkRevealedElements() {
        var hidden = document.querySelectorAll('.esconder, [data-bb-hidden-until-pitch]');
        hidden.forEach(function (el) {
          if (seenReveal.has(el)) return;
          var cs = window.getComputedStyle(el);
          if (cs.display !== 'none' && cs.visibility !== 'hidden' && el.offsetHeight > 0) {
            seenReveal.add(el);
            var sincePlay = window.__bbVslPlayAt ? Math.round((Date.now() - window.__bbVslPlayAt) / 1000) : null;
            window.bbTrack('pitch_revealed', {
              pitch_seconds_since_play: sincePlay,
              pitch_seconds_since_pageload: Math.round((Date.now() - pageStartTime) / 1000),
              pitch_scheduled_at: pitchScheduled,
              pitch_element_class: (el.className || '').replace(/\besconder\b/, '').trim().substring(0, 80)
            });
          }
        });
      }
      // Run periodically (covers both immediate and delayed reveals)
      checkRevealedElements();
      var revealInterval = setInterval(checkRevealedElements, 1000);
      setTimeout(function () { clearInterval(revealInterval); }, 60 * 60 * 1000); // stop after 1h
    }
    watchPitchReveal();
  }

  // ═══════════════════════════════════════
  // PLUGIN: QUIZ (auto-detect via .slide.active toggle)
  // Works with: [data-bb-slide], .slide.active, .phase.active
  // ═══════════════════════════════════════
  var quizCompleted = false;
  var quizSlideStart = {};
  var quizSlidesViewed = 0;
  var quizLastSlideId = null;

  window.bbMarkQuizComplete = function () { quizCompleted = true; };

  function getSlideId(el) {
    return el.getAttribute('data-bb-slide') || el.id || el.getAttribute('data-slide') || ('slide-idx-' + Array.prototype.indexOf.call(document.querySelectorAll('.slide,[data-bb-slide]'), el));
  }

  function fireSlideViewed(el) {
    var id = getSlideId(el);
    if (quizSlideStart[id]) return; // already counted
    quizSlideStart[id] = Date.now();
    quizSlidesViewed++;
    quizLastSlideId = id;
    window.bbLastSlide = id;
    var allSlides = document.querySelectorAll('.slide, [data-bb-slide]');
    var idx = Array.prototype.indexOf.call(allSlides, el);
    window.bbTrack('slide_viewed', {
      slide_id: id,
      slide_index: idx,
      slide_total: allSlides.length,
      slide_position_pct: allSlides.length > 0 ? Math.round((idx / Math.max(allSlides.length - 1, 1)) * 100) : 0
    });
    if (idx === 0) window.bbTrack('quiz_started', { total_slides: allSlides.length });
    if (el.matches('[data-bb-quiz-end]')) {
      quizCompleted = true;
      window.bbTrack('quiz_completed', { total_slides: allSlides.length, slides_viewed: quizSlidesViewed });
    }
  }

  function initQuizPlugin() {
    var slides = document.querySelectorAll('.slide, [data-bb-slide]');
    if (slides.length === 0) return;

    // Initial active slide
    slides.forEach(function (s) {
      if (s.classList.contains('active')) fireSlideViewed(s);
    });

    // Watch for class changes (slide navigation)
    var slideObserver = new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        if (m.attributeName !== 'class') return;
        var el = m.target;
        if (el.classList.contains('active')) fireSlideViewed(el);
      });
    });
    slides.forEach(function (s) {
      slideObserver.observe(s, { attributes: true, attributeFilter: ['class'] });
    });

    // Click delegation for answer tracking inside slides
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('button, .s-option, .yn-option, .cover-opt, [data-bb-answer]');
      if (!btn) return;
      var slide = btn.closest('.slide.active, [data-bb-slide].active, .slide, [data-bb-slide]');
      if (!slide || !slide.classList.contains('active')) return;
      var slideId = getSlideId(slide);
      var startTime = quizSlideStart[slideId];
      window.bbTrack('slide_answered', {
        slide_id: slideId,
        answer_text: (btn.textContent || '').trim().substring(0, 120),
        answer_value: btn.getAttribute('data-bb-answer') || btn.getAttribute('data-value') || '',
        time_on_slide_seconds: startTime ? Math.round((Date.now() - startTime) / 1000) : null
      });
    });

    // Drop-off on unload (quiz didn't complete)
    window.addEventListener('beforeunload', function () {
      if (quizCompleted) return;
      var dropData = {
        last_slide: quizLastSlideId || 'unknown',
        slides_viewed: quizSlidesViewed,
        slides_total: slides.length,
        time_on_page_seconds: Math.round((Date.now() - pageStartTime) / 1000)
      };
      var payload = Object.assign({ event: 'quiz_abandoned' }, baseProps, dropData);
      window.dataLayer.push(payload);
      bridgeToPostHog('quiz_abandoned', payload);
      try {
        navigator.sendBeacon(
          'https://www.google-analytics.com/g/collect?v=2&tid=' + GA4_MEASUREMENT_ID,
          'en=quiz_abandoned&ep.page_id=' + PAGE_ID +
          '&ep.last_slide=' + encodeURIComponent(dropData.last_slide) +
          '&ep.session_id=' + sessionId
        );
      } catch (e) {}
    });
  }

  // ═══════════════════════════════════════
  // PLUGIN: ADVERTORIAL
  // Read-quality scroll + first CTA visible timing
  // ═══════════════════════════════════════
  function initAdvertorialPlugin() {
    var lastScrollAt = Date.now();
    var lastScrollY = window.pageYOffset;
    var totalReadTimeMs = 0;
    var readingThresholdPxPerSec = 1500; // faster than this = scrolling, not reading

    window.addEventListener('scroll', function () {
      var now = Date.now();
      var dt = now - lastScrollAt;
      var dy = Math.abs(window.pageYOffset - lastScrollY);
      if (dt > 0 && (dy / dt) * 1000 < readingThresholdPxPerSec) {
        totalReadTimeMs += Math.min(dt, 5000); // cap per-segment
      }
      lastScrollAt = now;
      lastScrollY = window.pageYOffset;
    }, { passive: true });

    [60, 180, 300].forEach(function (s) {
      setTimeout(function () {
        window.bbTrack('read_time_estimate', {
          estimated_read_seconds: Math.round(totalReadTimeMs / 1000),
          time_on_page_seconds: s,
          scroll_percent: getScrollPercent()
        });
      }, s * 1000);
    });
  }

  // ═══════════════════════════════════════
  // INIT — auto-detect type and load plugins
  // ═══════════════════════════════════════
  function init() {
    try {
      PAGE_TYPE = detectPageType();
      baseProps.page_type = PAGE_TYPE;
      // Refinement of the early page_init: now we know the DOM-detected type.
      window.bbTrack('page_init_detected', { detected_page_type: PAGE_TYPE });
    } catch (e) {}

    var disabled = Array.isArray(cfg.disablePlugins) ? cfg.disablePlugins : [];
    function isDisabled(name) { return disabled.indexOf(name) !== -1; }

    try { if (!isDisabled('cta')) watchCTAVisibility(); } catch (e) {}
    try { if (PAGE_TYPE === 'vsl' && !isDisabled('vsl')) initVSLPlugin(); } catch (e) {}
    try { if (PAGE_TYPE === 'quiz' && !isDisabled('quiz')) initQuizPlugin(); } catch (e) {}
    try { if (PAGE_TYPE === 'advertorial' && !isDisabled('advertorial')) initAdvertorialPlugin(); } catch (e) {}

    // Scan for pack/offer cards and report inventory
    setTimeout(function () {
      try {
        var cards = scanPackCards();
        if (cards.length > 0) {
          window.bbTrack('pack_cards_detected', {
            cards_count: cards.length,
            packs_available: cards.map(function (c) { return c.pack; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).join(','),
            packs_detail: JSON.stringify(cards.slice(0, 12))
          });
        }
      } catch (e) {}
    }, 1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
