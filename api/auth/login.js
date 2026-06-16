const { checkPassword, issueCookie } = require('../dashboard/_lib.js');

// POST /api/auth/login  { password }
// On success sets an HttpOnly signed session cookie. No DB / user store —
// a single shared password (DASHBOARD_PASSWORD), like the reference dashboard.
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.DASHBOARD_PASSWORD) {
    return res.status(500).json({ error: 'DASHBOARD_PASSWORD not configured' });
  }

  try {
    let body = req.body;
    // Vercel parses JSON automatically, but be defensive about string bodies.
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    const password = body && body.password;

    // Small delay-free constant-time check happens inside checkPassword.
    if (!checkPassword(password)) {
      return res.status(401).json({ ok: false, error: 'Invalid password' });
    }

    res.setHeader('Set-Cookie', issueCookie());
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[auth/login] error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
};
