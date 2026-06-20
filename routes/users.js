/**
 * routes/users.js — login / logout / session status
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { getUserByUsername } from '../lib/db.js';

export const usersRouter = Router();

const EIGHT_HOURS = 8 * 60 * 60 * 1000;
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

// ✅ POST /users/login
usersRouter.post('/login', async (req, res) => {
  try {
    const { username, password, rememberMe } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const user = await getUserByUsername(username.trim().toLowerCase());
    if (!user) {
      await bcrypt.compare(
        password,
        '$2b$10$invalidhashpadding000000000000000000000000000000000000'
      );
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // ✅ Set session data
    req.session.userId   = user.id;
    req.session.username = user.username;
    req.session.role     = user.role;
    req.session.cookie.maxAge = rememberMe ? THIRTY_DAYS : EIGHT_HOURS;

    // ✅ Force save before responding
    req.session.save(err => {
      if (err) {
        console.error('❌ Session save error:', err);
        return res.status(500).json({ error: 'Session could not be saved' });
      }
      res.json({ ok: true, username: user.username, role: user.role });
    });

  } catch (err) {
    console.error('❌ Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ✅ POST /users/logout
usersRouter.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ✅ GET /users/me
usersRouter.get('/me', (req, res) => {
  if (!req.session?.userId) {
    return res.status(401).json({ authenticated: false });
  }
  res.json({
    authenticated: true,
    username: req.session.username,
    role:     req.session.role,
  });
});
