import express from 'express';
import cors from 'cors';
import session from 'express-session';
import pgSession from 'connect-pg-simple';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { pool, initDb } from './lib/db.js';
import { authRouter }  from './routes/auth.js';
import { apiRouter }   from './routes/api.js';
import { usersRouter } from './routes/users.js';
import { salesRouter } from './routes/sales.js';
import { budgetRouter } from './routes/budget.js';
import { requireAuth }    from './middleware/requireAuth.js';
import { tokenRefresher } from './middleware/tokenRefresher.js';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const app       = express();
const PORT      = process.env.PORT || 3000;
const PgStore   = pgSession(session);

app.use(cors({
  origin:      process.env.DASHBOARD_ORIGIN || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());
app.use(session({
  store: new PgStore({
    pool,
    tableName: 'sessions',
    createTableIfMissing: true,
  }),
  secret:            process.env.SESSION_SECRET || 'change-me-in-production',
  resave:            false,
  saveUninitialized: false,
  cookie: {
    secure:   true,
    httpOnly: true,
    sameSite: 'none',
    maxAge:   8 * 60 * 60 * 1000,
  },
}));

// ── Serve dashboards ───────────────────────────────────────────────────────
app.get('/', (_req, res) => res.send('✅ QBO Dashboard backend is running'));
app.get('/finance', (_req, res) => res.sendFile(join(__dirname, 'dashboard-finance.html')));
app.get('/sales',   (_req, res) => res.sendFile(join(__dirname, 'dashboard-sales.html')));
app.get('/health',  (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ── Public routes ──────────────────────────────────────────────────────────
app.use('/users', usersRouter);
app.use('/auth',  authRouter);

// ── Protected routes ───────────────────────────────────────────────────────
app.use('/api',        requireAuth, tokenRefresher, apiRouter);
app.use('/api/sales',  requireAuth, tokenRefresher, salesRouter);
app.use('/api/budget', requireAuth, tokenRefresher, budgetRouter);

// TEMPORARY DEBUG — DELETE AFTER TESTING
app.get('/check-sessions', async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM sessions');
  res.json(rows);
});

// ── Boot ───────────────────────────────────────────────────────────────────
initDb()
  .then(() => app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`)))
  .catch(err => { console.error('❌ DB init failed:', err); process.exit(1); });
