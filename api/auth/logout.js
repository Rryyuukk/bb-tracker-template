const { clearCookie } = require('../dashboard/_lib.js');

// POST /api/auth/logout — clears the session cookie.
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Set-Cookie', clearCookie());
  return res.status(200).json({ ok: true });
};
