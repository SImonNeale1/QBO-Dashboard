/**
 * db.js — lightweight SQLite database
 *
 * Stores:
 *   - users        (username, hashed password, role)
 *   - qbo_tokens   (single row: the shared QBO access/refresh tokens)
 *
 * SQLite means zero external database service needed.
 * The file lives at ./data/dashboard.db — Render persists this via a disk mount.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = join(__dirname, '..', 'data');
const DB_PATH   = process.env.DB_PATH || join(DATA_DIR, 'dashboard.db');

mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');

// ── Schema ─────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT    NOT NULL UNIQUE,
    password    TEXT    NOT NULL,
    role        TEXT    NOT NULL DEFAULT 'finance',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS qbo_tokens (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    access_token  TEXT,
    refresh_token TEXT,
    realm_id      TEXT,
    expires_at    INTEGER
  );
`);

// ── User helpers ───────────────────────────────────────────────────────────

export function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

export function createUser(username, hashedPassword, role = 'finance') {
  return db.prepare(
    'INSERT INTO users (username, password, role) VALUES (?, ?, ?)'
  ).run(username, hashedPassword, role);
}

export function listUsers() {
  return db.prepare('SELECT id, username, role, created_at FROM users').all();
}

export function deleteUser(username) {
  return db.prepare('DELETE FROM users WHERE username = ?').run(username);
}

// ── QBO token helpers ──────────────────────────────────────────────────────

export function getQboTokens() {
  return db.prepare('SELECT * FROM qbo_tokens WHERE id = 1').get();
}

export function saveQboTokens({ accessToken, refreshToken, realmId, expiresAt }) {
  db.prepare(`
    INSERT INTO qbo_tokens (id, access_token, refresh_token, realm_id, expires_at)
    VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      access_token  = excluded.access_token,
      refresh_token = excluded.refresh_token,
      realm_id      = excluded.realm_id,
      expires_at    = excluded.expires_at
  `).run(accessToken, refreshToken, realmId, expiresAt);
}

export function isQboTokenExpiredSoon() {
  const row = getQboTokens();
  if (!row?.expires_at) return true;
  return Date.now() >= row.expires_at;
}

export default db;
