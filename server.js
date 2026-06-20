import express from 'express';
import cors from 'cors';
import session from 'express-session';
import pgSession from 'connect-pg-simple';
import dotenv from 'dotenv';

import { pool, initDb } from './lib/db.js';
import { authRouter }  from './routes/auth.js';
import { apiRouter }   from './routes/api.js';
import { usersRouter } from './routes/users.js';
import { salesRouter } from './routes/sales.js';
import { budgetRouter } from './routes/budget.js';
import { requireAuth }    from './middleware/requireAuth.js';
import { tokenRefresher } from './middleware/tokenRefresher.js';

dotenv.config();

const app     = express();
const PORT    = process.env.PORT || 3000;
const PgStore = pgSession(session);

// ✅ ✅ CORS (FIXED for cookies)
app.use(cors({
  origin: 'https://qbo-dashboard-fdtq.onrender.com',
  credentials: true,
}));

app.use(express.json());

// ✅ ✅ SESSION (FIXED for browser cookies)
app.use(session({
  store: new PgStore({
    pool,
    tableName: 'sessions',
    createTableIfMissing: false,
  }),
  secret: process.env.SESSION_SECRET || 'change-me-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true,          // ✅ required on Render (HTTPS)
    httpOnly: true,
    sameSite: 'none',      // ✅ CRITICAL for session to work
    maxAge: 8 * 60 * 60 * 1000,
  },
}));

// ✅ Basic routes
app.get('/', (_req, res) => {
  res.send('✅ QBO Dashboard backend is running');
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// ✅ Public routes
app.use('/users', usersRouter);
app.use('/auth', authRouter);

// ✅ Protected routes
app.use('/api', requireAuth, tokenRefresher, apiRouter);
app.use('/api/sales', requireAuth, tokenRefresher, salesRouter);
app.use('/api/budget', requireAuth, tokenRefresher, budgetRouter);

// ✅ Start server
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`✅ Server running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('❌ DB init failed:', err);
    process.exit(1);
  });
