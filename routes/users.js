/**
 * routes/users.js — login / logout / session status
 */

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { getUserByUsername } from '../lib/db.js';

export const usersRouter = Router();

const EIGHT_HOURS   = 8  * 60 * 60 * 1000;
const THIRTY_DAYS   = 30 * 24 * 60 * 60 * 1000;

// POST /users/login  { username, password, rememberMe? }
usersRouter.post('/login', async (req, res) => {
  const { username, password, rememberMe } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const user = getUserByUsername(username.trim().toLowerCase());
  if (!user) {
    // Timing-safe: still run bcrypt even on unknown user
    await bcrypt.compare(password, '$2b$10$invalidhashpadding000000000000000000000000000000000000');
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  // Set cookie lifetime based on Remember Me
  req.session.cookie.maxAge = rememberMe ? THIRTY_DAYS : EIGHT_HOURS;

  // Store minimal user info in session
  req.session.userId   = user.id;
  req.session.username = user.username;
  req.session.role     = user.role;

  res.json({ ok: true, username: user.username, role: user.role });
});

// POST /users/logout
usersRouter.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// GET /users/me — dashboard calls this on load to check session
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

// ✅ TEMP: create CEO user (delete after use)
usersRouter.get('/setup-ceo', async (req, res) => {
  const hash = await bcrypt.hash('password123', 10);

  try {
    const stmt = `
      INSERT INTO users (username, password, role)
      VALUES ('CEO', '$2b$10$3euPcmQFCiblsZeEu5s7p.e0qL9h1EKwOTRchE6mC6oq5tOq6r8pG', 'CEO')
    `;
    req.app.locals.db.prepare(stmt).run();

    res.send('✅ CEO user created');
  } catch (err) {
    console.error(err);
    res.send('User may already exist');
  }
});

