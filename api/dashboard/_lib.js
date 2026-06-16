// Shared helpers for the BB Tracker dashboard:
//   1. Stateless signed-cookie sessions (password login, no DB needed)
//   2. A thin PostHog HogQL query client (read-only analytics source)
//
// Env vars used:
//   DASHBOARD_PASSWORD   shared password for the dashboard login
//   SESSION_SECRET       random string used to sign session cookies (HMAC)
//   POSTHOG_API_KEY      PostHog *personal* API key (Bearer) with query access
//   POSTHOG_PROJECT_ID   PostHog project id (numeric)
//   POSTHOG_API_HOST     query host, e.g. https://us.posthog.com or https://eu.posthog.com
//                        (NOTE: the API host, not the i.posthog.com ingestion host)

const crypto = require('crypto');

const COOKIE_NAME = 'bb_dash';
const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12h

function sessionSecret() {
  // Fall back to the password so the dashboard still works if SESSION_SECRET
  // wasn't set — but warn, since rotating the password then invalidates sessions.
  const s = process.env.SESSION_SECRET || process.env.DASHBOARD_PASSWORD;
  if (!s) return null;
  return s;
}

// ─── Sessions ─────────────────────────────────────────────────────
function signSession(expMs) {
  const secret = sessionSecret();
  const payload = String(expMs);
  const hmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${hmac}`;
}

function issueCookie() {
  const exp = Date.now() + SESSION_TTL_MS;
  const token = signSession(exp);
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function clearCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  const m = header.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

function isAuthed(req) {
  const secret = sessionSecret();
  if (!secret) return false;
  const token = readCookie(req, COOKIE_NAME);
  if (!token) return false;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  // timingSafeEqual throws if lengths differ — guard first.
  if (sig.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  const expMs = Number(payload);
  if (!Number.isFinite(expMs) || expMs < Date.now()) return false;
  return true;
}

// Verifies the supplied password against DASHBOARD_PASSWORD in constant time.
function checkPassword(input) {
  const expected = process.env.DASHBOARD_PASSWORD;
  if (!expected) return false;
  const a = Buffer.from(String(input || ''));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Guard for dashboard data routes. Returns true if the response was already
// ended with a 401 (caller should return immediately).
function requireAuth(req, res) {
  if (isAuthed(req)) return false;
  res.status(401).json({ error: 'unauthorized' });
  return true;
}

// ─── PostHog query client ─────────────────────────────────────────
function posthogConfigured() {
  return !!(process.env.POSTHOG_API_KEY && process.env.POSTHOG_PROJECT_ID);
}

async function phQuery(hogql) {
  if (!posthogConfigured()) {
    const err = new Error('PostHog not configured');
    err.code = 'PH_NOT_CONFIGURED';
    throw err;
  }
  const host = (process.env.POSTHOG_API_HOST || 'https://us.posthog.com').replace(/\/$/, '');
  const projectId = process.env.POSTHOG_PROJECT_ID;
  const apiKey = process.env.POSTHOG_API_KEY;

  const res = await fetch(`${host}/api/projects/${projectId}/query/`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query: hogql } }),
  });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`PostHog query failed (${res.status})`);
    err.code = 'PH_QUERY_FAILED';
    err.status = res.status;
    err.body = json;
    throw err;
  }
  // HogQL responses: { results: [[...row], ...], columns: [...] }
  return json;
}

// Clamp an incoming ?days= value to a safe integer for inlining into HogQL.
function safeDays(input, def = 7, max = 90) {
  const n = parseInt(input, 10);
  if (!Number.isFinite(n) || n < 1) return def;
  return Math.min(n, max);
}

module.exports = {
  COOKIE_NAME,
  issueCookie,
  clearCookie,
  isAuthed,
  checkPassword,
  requireAuth,
  posthogConfigured,
  phQuery,
  safeDays,
};
