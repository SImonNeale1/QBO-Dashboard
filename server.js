
import express from 'express';
import cors from 'cors';
import session from 'express-session';
import connectSqlite3 from 'better-sqlite3-session-store';
import dotenv from 'dotenv';

import db from './lib/db.js';
import { authRouter } from './routes/auth.js';
import { apiRouter } from './routes/api.js';
import { salesRouter } from './routes/sales.js';
import { budgetRouter } from './routes/budget.js';
import { usersRouter } from './routes/users.js';
import { requireAuth } from './middleware/requireAuth.js';
import { tokenRefresher } from './middleware/tokenRefresher.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ FIXED SQLite session store
const SQLiteStore = connectSqlite3(session);

app.use(cors({
  origin: process.env.DASHBOARD_ORIGIN || 'http://localhost:5173',
  credentials: true,
}));

app.use(express.json());

app.use(session({
  store: new SQLiteStore({
    client: db,
  }),
  secret: process.env.SESSION_SECRET || 'change-me-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 8 * 60 * 60 * 1000,
  },
}));

// ✅ SIMPLE TEST ROUTE (fixes Render "loading" issue)
app.get('/', (_req, res) => {
  res.send('✅ QBO Dashboard backend is running');
});

// ✅ Health check
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

// ✅ IMPORTANT: must use process.env.PORT
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
