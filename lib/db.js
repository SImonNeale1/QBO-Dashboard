Here are both files:
db.js
javascriptimport pg from 'pg';
const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is not set');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id         SERIAL PRIMARY KEY,
      username   TEXT NOT NULL UNIQUE,
      password   TEXT NOT NULL,
      role       TEXT NOT NULL DEFAULT 'finance',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS qbo_tokens (
      id            INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      access_token  TEXT,
      refresh_token TEXT,
      realm_id      TEXT,
      expires_at    BIGINT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      sid    TEXT PRIMARY KEY,
      sess   JSONB NOT NULL,
      expire TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expire_idx ON sessions (expire);
  `);
  console.log('Database schema ready');
}

export async function getUserByUsername(username) {
  const { rows } = await pool.query(
    'SELECT * FROM users WHERE username = $1', [username]
  );
  return rows[0] || null;
}

export async function createUser(username, hashedPassword, role = 'finance') {
  await pool.query(
    'INSERT INTO users (username, password, role) VALUES ($1, $2, $3)',
    [username, hashedPassword, role]
  );
}

export async function listUsers() {
  const { rows } = await pool.query(
    'SELECT id, username, role, created_at FROM users ORDER BY created_at'
  );
  return rows;
}

export async function deleteUser(username) {
  const { rowCount } = await pool.query(
    'DELETE FROM users WHERE username = $1', [username]
  );
  return rowCount;
}

export async function getQboTokens() {
  const { rows } = await pool.query('SELECT * FROM qbo_tokens WHERE id = 1');
  return rows[0] || null;
}

export async function saveQboTokens({ accessToken, refreshToken, realmId, expiresAt }) {
  await pool.query(`
    INSERT INTO qbo_tokens (id, access_token, refresh_token, realm_id, expires_at)
    VALUES (1, $1, $2, $3, $4)
    ON CONFLICT (id) DO UPDATE SET
      access_token  = EXCLUDED.access_token,
      refresh_token = EXCLUDED.refresh_token,
      realm_id      = EXCLUDED.realm_id,
      expires_at    = EXCLUDED.expires_at
  `, [accessToken, refreshToken, realmId, expiresAt]);
}

export async function isQboTokenExpiredSoon() {
  const tokens = await getQboTokens();
  if (!tokens?.expires_at) return true;
  return Date.now() >= parseInt(tokens.expires_at);
}
