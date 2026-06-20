import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { getUserByUsername, pool } from '../lib/db.js';

export const usersRouter = Router();

// Simple in-memory token store (survives restarts via DB)
async function createToken(userId, username, role, rememberMe) {
  const token   = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + (rememberMe ? 30 * 24 * 60 * 60 * 1000 : 8 * 60 * 60 * 1000);
  await pool.query(
    `INSERT INTO sessions (sid, sess, expire) VALUES ($1, $2, $3)`,
    [token, JSON.stringify({ userId, username, role }), new Date(expires)]
  );
  return token;
}

async function getTokenData(token) {
  if (!token) return null;
  const { rows } = await pool.query(
    `SELECT sess FROM sessions WHERE sid = $1 AND expire > NOW()`, [token]
  );
  return rows[0] ? JSON.parse(rows[0].sess) : null;
}

usersRouter.post('/login', async (req, res) => {
  try {
    const { username, password, rememberMe } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: 'Username and password required' });

    const user = await getUserByUsername(username.trim().toLowerCase());
    if (!user) {
      await bcrypt.compare(password, '$2b$10$invalidhashpadding000000000000000000000000000000000000');
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid username or password' });

    const token = await createToken(user.id, user.username, user.role, rememberMe);
    res.json({ ok: true, token, username: user.username, role: user.role });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

usersRouter.post('/logout', async (req, res) => {
  const token = req.headers['x-auth-token'];
  if (token) await pool.query('DELETE FROM sessions WHERE sid = $1', [token]);
  res.json({ ok: true });
});

usersRouter.get('/me', async (req, res) => {
  const token = req.headers['x-auth-token'];
  const data  = await getTokenData(token);
  if (!data) return res.status(401).json({ authenticated: false });
  res.json({ authenticated: true, username: data.username, role: data.role });
});

// Middleware to validate token on API calls
export async function validateToken(req, res, next) {
  const token = req.headers['x-auth-token'];
  const data  = await getTokenData(token);
  if (!data) return res.status(401).json({ error: 'Not logged in' });
  req.user = data;
  next();
}
