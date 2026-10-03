'use strict';

const path = require('node:path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'skyline.db');
const BUSY_TIMEOUT_MS = 1000;
const MAX_BUSY_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 25;

// Dependency order (parents before children). Reversed, it is a safe delete order.
const TABLES = [
  'users',
  'events',
  'tickets',
  'announcements',
  'merch_items',
  'merch_variants',
  'merch_orders',
  'fundraiser_tasks',
  'expense_reimbursements',
  'ledger_transactions',
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  name                  TEXT NOT NULL,
  email                 TEXT UNIQUE NOT NULL,
  password_hash         TEXT NOT NULL,
  role                  TEXT NOT NULL CHECK (role IN ('STUDENT', 'VOLUNTEER', 'ADMIN')),
  membership_code       TEXT UNIQUE,
  membership_status     TEXT NOT NULL DEFAULT 'NONE' CHECK (membership_status IN ('NONE', 'ACTIVE', 'EXPIRED')),
  membership_expires_at TEXT,
  created_at            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  description  TEXT,
  event_date   TEXT NOT NULL,
  location     TEXT NOT NULL,
  total_seats  INTEGER NOT NULL CHECK (total_seats > 0),
  seats_left   INTEGER NOT NULL CHECK (seats_left >= 0),
  member_price INTEGER NOT NULL,
  guest_price  INTEGER NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tickets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_code   TEXT UNIQUE NOT NULL,
  event_id      INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  price_paid    INTEGER NOT NULL,
  checked_in    INTEGER NOT NULL DEFAULT 0 CHECK (checked_in IN (0, 1)),
  checked_in_at TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS announcements (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  title           TEXT NOT NULL,
  content         TEXT NOT NULL,
  category        TEXT NOT NULL CHECK (category IN ('MEETING', 'DEADLINE', 'EVENT', 'GENERAL')),
  target_audience TEXT NOT NULL DEFAULT 'ALL' CHECK (target_audience IN ('ALL', 'MEMBERS_ONLY')),
  author_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS merch_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  description   TEXT,
  category      TEXT NOT NULL,
  member_price  INTEGER NOT NULL,
  regular_price INTEGER NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS merch_variants (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     INTEGER NOT NULL REFERENCES merch_items(id) ON DELETE CASCADE,
  size        TEXT NOT NULL CHECK (size IN ('S', 'M', 'L', 'XL')),
  stock_count INTEGER NOT NULL CHECK (stock_count >= 0),
  UNIQUE (item_id, size)
);

CREATE TABLE IF NOT EXISTS merch_orders (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  order_code         TEXT UNIQUE NOT NULL,
  user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  variant_id         INTEGER NOT NULL REFERENCES merch_variants(id) ON DELETE RESTRICT,
  quantity           INTEGER NOT NULL CHECK (quantity > 0),
  total_paid         INTEGER NOT NULL,
  fulfillment_status TEXT NOT NULL DEFAULT 'PAID_PENDING_PICKUP' CHECK (fulfillment_status IN ('PAID_PENDING_PICKUP', 'PICKED_UP')),
  created_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fundraiser_tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_name TEXT NOT NULL,
  title         TEXT NOT NULL,
  assigned_to   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'TODO' CHECK (status IN ('TODO', 'IN_PROGRESS', 'DONE')),
  due_date      TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS expense_reimbursements (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  volunteer_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  category          TEXT NOT NULL,
  amount            INTEGER NOT NULL CHECK (amount > 0),
  receipt_reference TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED_PAID', 'REJECTED')),
  approved_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger_transactions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  type         TEXT NOT NULL CHECK (type IN ('IN', 'OUT')),
  category     TEXT NOT NULL CHECK (category IN ('MEMBERSHIP_DUES', 'TICKET_SALE', 'MERCH_SALE', 'EXPENSE_REIMBURSEMENT', 'FUNDRAISER_INCOME')),
  amount       INTEGER NOT NULL CHECK (amount > 0),
  description  TEXT NOT NULL,
  reference_id TEXT,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL
);

-- Explicit B-tree indexes, only where no UNIQUE constraint already provides one.
-- users(email), users(membership_code), tickets(ticket_code) and
-- merch_variants(item_id, size) are served by the sqlite_autoindex_* B-trees that
-- SQLite builds for their UNIQUE constraints, so they need no index of their own.
--   idx_tickets_event_user    duplicate-ticket check on purchase; per-event door
--                             roster and attendance stats (event_id prefix)
--   idx_tasks_campaign_status fundraiser board: a campaign's tasks by status
--   idx_ledger_type_category  treasury totals by type + category over a date range
CREATE INDEX IF NOT EXISTS idx_tickets_event_user    ON tickets(event_id, user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_campaign_status ON fundraiser_tasks(campaign_name, status);
CREATE INDEX IF NOT EXISTS idx_ledger_type_category  ON ledger_transactions(type, category, created_at);

-- Phase 1 databases carry redundant copies of the UNIQUE autoindexes; remove them.
DROP INDEX IF EXISTS idx_users_membership_code;
DROP INDEX IF EXISTS idx_tickets_code;
DROP INDEX IF EXISTS idx_merch_variants_item_size;
`;

let driver = null;

// Prefer better-sqlite3; fall back to Node's built-in node:sqlite if the native
// binding is unavailable (or SQLITE_DRIVER=node forces it). Both expose the same
// exec / prepare().get|all|run surface used throughout the app.
function openDriver(file, busyTimeoutMs) {
  if (process.env.SQLITE_DRIVER !== 'node') {
    try {
      const Database = require('better-sqlite3');
      const conn = new Database(file, { timeout: busyTimeoutMs });
      driver = 'better-sqlite3';
      return conn;
    } catch (err) {
      if (driver !== 'node:sqlite') {
        console.warn(`[db] better-sqlite3 unavailable (${String(err.message).split('\n')[0]}); falling back to node:sqlite`);
      }
    }
  }
  const { DatabaseSync } = require('node:sqlite');
  driver = 'node:sqlite';
  return new DatabaseSync(file);
}

// Opens a connection with the mandatory pragmas applied. Every connection in the
// app (server, seed script, verification, workers) must come through here.
function connect(file = DB_PATH, { busyTimeoutMs = BUSY_TIMEOUT_MS } = {}) {
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new TypeError('busyTimeoutMs must be a non-negative integer');
  }
  const conn = openDriver(file, busyTimeoutMs);
  conn.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = ${busyTimeoutMs};
  `);
  // foreign_keys is silently ignored inside a transaction; fail loudly instead.
  if (conn.prepare('PRAGMA foreign_keys').get().foreign_keys !== 1) {
    throw new Error('Failed to enable PRAGMA foreign_keys');
  }
  return conn;
}

function isBusy(err) {
  if (!err) return false;
  // better-sqlite3: err.code = 'SQLITE_BUSY' | 'SQLITE_BUSY_SNAPSHOT' | ...
  if (typeof err.code === 'string' && err.code.startsWith('SQLITE_BUSY')) return true;
  // node:sqlite: err.errcode = extended result code; primary SQLITE_BUSY is 5.
  return typeof err.errcode === 'number' && (err.errcode & 0xff) === 5;
}

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
  Atomics.wait(sleepCell, 0, 0, ms);
}

function backoffDelay(attempt) {
  return RETRY_BASE_DELAY_MS * 2 ** attempt + Math.floor(Math.random() * RETRY_BASE_DELAY_MS);
}

function assertSync(result) {
  if (result && typeof result.then === 'function') {
    throw new TypeError('withTransaction callback must be synchronous; never await inside a transaction');
  }
}

function rollbackQuietly(conn, sql) {
  try {
    conn.exec(sql);
  } catch {
    // SQLite may already have rolled back (e.g. after SQLITE_FULL); nothing to undo.
  }
}

const txDepth = new WeakMap();

// Runs fn(conn) inside BEGIN IMMEDIATE ... COMMIT. The write lock is taken up
// front, so any check-then-write inside fn is atomic across connections and
// processes (no TOCTOU window). On SQLITE_BUSY the whole unit is rolled back and
// retried, so fn must be synchronous and touch only the database. Nested calls
// become SAVEPOINTs inside the outer transaction.
function withTransaction(fn, conn = db) {
  const depth = txDepth.get(conn) || 0;
  if (depth > 0) return runSavepoint(fn, conn, depth);

  for (let attempt = 0; ; attempt++) {
    try {
      conn.exec('BEGIN IMMEDIATE');
    } catch (err) {
      if (isBusy(err) && attempt < MAX_BUSY_RETRIES) {
        sleepSync(backoffDelay(attempt));
        continue;
      }
      throw err;
    }

    txDepth.set(conn, 1);
    try {
      const result = fn(conn);
      assertSync(result);
      conn.exec('COMMIT');
      return result;
    } catch (err) {
      rollbackQuietly(conn, 'ROLLBACK');
      if (isBusy(err) && attempt < MAX_BUSY_RETRIES) {
        sleepSync(backoffDelay(attempt));
        continue;
      }
      throw err;
    } finally {
      txDepth.set(conn, 0);
    }
  }
}

function runSavepoint(fn, conn, depth) {
  const name = `sp_${depth}`;
  conn.exec(`SAVEPOINT ${name}`);
  txDepth.set(conn, depth + 1);
  try {
    const result = fn(conn);
    assertSync(result);
    conn.exec(`RELEASE ${name}`);
    return result;
  } catch (err) {
    rollbackQuietly(conn, `ROLLBACK TO ${name}; RELEASE ${name}`);
    throw err;
  } finally {
    txDepth.set(conn, depth);
  }
}

const db = connect(DB_PATH);
withTransaction(() => db.exec(SCHEMA));

module.exports = {
  db,
  driver,
  connect,
  withTransaction,
  isBusy,
  sleepSync,
  TABLES,
  DB_PATH,
};
