import { pool } from '../lib/db.js';

export async function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (!token) return res.status(401).json({ error: 'Not logged in', loginUrl: '/login' });

  const { rows } = await pool.query(
    `SELECT sess FROM sessions WHERE sid = $1 AND expire > NOW()`, [token]
  );
  if (!rows[0]) return res.status(401).json({ error: 'Not logged in', loginUrl: '/login' });

  const { rows: qboRows } = await pool.query('SELECT * FROM qbo_tokens WHERE id = 1');
  if (!qboRows[0]?.access_token)
    return res.status(503).json({ error: 'QuickBooks not connected', connectUrl: '/auth/connect' });

  req.user = JSON.parse(rows[0].sess);
  next();
}
