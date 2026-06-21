javascriptimport { Router } from 'express';
import crypto from 'crypto';
import { buildAuthUrl, exchangeCodeForTokens } from '../lib/qbo.js';
import { saveQboTokens, getQboTokens, pool } from '../lib/db.js';

export const authRouter = Router();

authRouter.get('/connect', async (req, res) => {
  const token = req.headers['x-auth-token'] || req.query.token;

  if (!token) {
    return res.send(`
      <html><body style="font-family:sans-serif;padding:2rem;background:#0f1117;color:#e8eaf0">
        <h2>Connect QuickBooks</h2>
        <p style="margin:.75rem 0">Paste your auth token to connect:</p>
        <input id="t" style="width:420px;padding:8px;background:#22263a;border:1px solid #2e3349;color:#e8eaf0;border-radius:6px" placeholder="Paste token here">
        <button onclick="location.href='/auth/connect?token='+document.getElementById('t').value"
          style="margin-left:8px;padding:8px 16px;background:#4a8fe8;color:#fff;border:none;border-radius:6px;cursor:pointer">
          Connect
        </button>
      </body></html>
    `);
  }

  try {
    const { rows } = await pool.query(
      `SELECT sess FROM sessions WHERE sid = $1 AND expire > NOW()`, [token]
    );
    if (!rows[0]) return res.status(401).send('Invalid or expired token — please log in again.');

    const sess = typeof rows[0].sess === 'string' ? JSON.parse(rows[0].sess) : rows[0].sess;
    if (sess.role !== 'ceo') return res.status(403).send('Only the CEO account can connect QuickBooks.');

    const state = crypto.randomBytes(16).toString('hex');
    await pool.query(
      `INSERT INTO sessions (sid, sess, expire) VALUES ($1, $2::jsonb, $3)`,
      ['oauth_'+state, JSON.stringify({ state }), new Date(Date.now() + 10 * 60 * 1000)]
    );

    res.redirect(buildAuthUrl(state));
  } catch (err) {
    console.error('Connect error:', err);
    res.status(500).send('Error: ' + err.message);
  }
});

authRouter.get('/callback', async (req, res) => {
  const { code, realmId, state, error } = req.query;
  if (error) return res.status(400).send(`OAuth error: ${error}`);

  try {
    const { rows } = await pool.query(
      `SELECT sess FROM sessions WHERE sid = $1`, ['oauth_'+state]
    );
    if (!rows[0]) return res.status(400).send('Invalid state — please try connecting again.');
    await pool.query(`DELETE FROM sessions WHERE sid = $1`, ['oauth_'+state]);

    const tokens    = await exchangeCodeForTokens(code);
    const expiresAt = Date.now() + (tokens.expires_in - 300) * 1000;
    await saveQboTokens({
      accessToken:  tokens.access_token,
      refreshToken: tokens.refresh_token,
      realmId,
      expiresAt,
    });
    res.redirect('/finance');
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.status(500).send('Authentication failed: ' + err.message);
  }
});

authRouter.get('/status', async (req, res) => {
  const tokens = await getQboTokens();
  res.json({ connected: !!tokens?.access_token, realmId: tokens?.realm_id || null });
});
