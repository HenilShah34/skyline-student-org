'use strict';

// Phase 1 self-verification. Boots the real server (`node server.js`) against a
// throwaway database on an ephemeral port, exercises the auth API, then checks
// pragmas, constraints, transactions and index usage directly. The server is
// always stopped and the temp database removed, pass or fail.

const { once } = require('node:events');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { check, section, summarize, tempDbPath, removeDb, startServer, stopServer } = require('./verify-helpers');

const DB_FILE = tempDbPath('verify1');
process.env.DB_PATH = DB_FILE; // must be set before ./db is required

function forgeRole(token, role) {
  const [encoded, signature] = token.split('.');
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  payload.role = role;
  return `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${signature}`;
}

async function verifyApi(api) {
  section('HTTP API (real server process)');

  const health = await api('GET', '/api/health');
  check('GET /api/health -> 200, foreign_keys = 1, WAL, auto-seeded',
    health.status === 200 && health.body.database.foreign_keys === 1 &&
      health.body.database.journal_mode === 'wal' && health.body.tables.users === 4,
    `driver=${health.body?.database?.driver} rows=${JSON.stringify(health.body?.tables)}`);

  const login = await api('POST', '/api/auth/login', { body: { email: 'vikram@skyline.edu', password: 'skyline123' } });
  check('POST /api/auth/login (valid) -> 200 + token, no password_hash leaked',
    login.status === 200 && typeof login.body.token === 'string' && login.body.user.role === 'ADMIN' &&
      !('password_hash' in login.body.user),
    `status=${login.status} role=${login.body?.user?.role}`);

  const wrongPw = await api('POST', '/api/auth/login', { body: { email: 'vikram@skyline.edu', password: 'wrong-password' } });
  check('POST /api/auth/login (wrong password) -> 401', wrongPw.status === 401, `body=${JSON.stringify(wrongPw.body)}`);

  const unknown = await api('POST', '/api/auth/login', { body: { email: 'nobody@skyline.edu', password: 'skyline123' } });
  check('POST /api/auth/login (unknown email) -> same generic 401',
    unknown.status === 401 && unknown.body.error === wrongPw.body.error);

  const missing = await api('POST', '/api/auth/login', { body: { email: 'vikram@skyline.edu' } });
  check('POST /api/auth/login (missing password) -> 400', missing.status === 400, `body=${JSON.stringify(missing.body)}`);

  const badJson = await api('POST', '/api/auth/login', { rawBody: '{"email":' });
  check('POST /api/auth/login (malformed JSON) -> 400', badJson.status === 400);

  const me = await api('GET', '/api/auth/me', { token: login.body.token });
  check('GET /api/auth/me (valid token) -> 200', me.status === 200 && me.body.user.email === 'vikram@skyline.edu');

  const rohan = await api('POST', '/api/auth/login', { body: { email: 'rohan@skyline.edu', password: 'skyline123' } });
  const rohanMe = await api('GET', '/api/auth/me', { token: rohan.body.token });
  const m = rohanMe.body?.user?.membership;
  check('GET /api/auth/me (rohan) -> ACTIVE, 10 days left, renewal_due',
    m?.status === 'ACTIVE' && m.days_remaining === 10 && m.renewal_due === true, `membership=${JSON.stringify(m)}`);

  const noToken = await api('GET', '/api/auth/me');
  check('GET /api/auth/me (no token) -> 401', noToken.status === 401, `reason=${noToken.body?.reason}`);

  const kabir = await api('POST', '/api/auth/login', { body: { email: 'kabir@skyline.edu', password: 'skyline123' } });
  const forged = await api('GET', '/api/auth/me', { token: forgeRole(kabir.body.token, 'ADMIN') });
  check('GET /api/auth/me (payload tampered STUDENT->ADMIN) -> 401 signature mismatch',
    forged.status === 401 && forged.body.reason === 'signature mismatch', `body=${JSON.stringify(forged.body)}`);

  const t = kabir.body.token;
  const flipped = t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A');
  const badSig = await api('GET', '/api/auth/me', { token: flipped });
  check('GET /api/auth/me (signature tampered) -> 401 signature mismatch',
    badSig.status === 401 && badSig.body.reason === 'signature mismatch');

  const reg = await api('POST', '/api/auth/register', { body: { name: 'Meera Joshi', email: 'Meera@Skyline.edu', password: 'hackathon26' } });
  check('POST /api/auth/register -> 201 STUDENT, membership NONE',
    reg.status === 201 && reg.body.user.role === 'STUDENT' && reg.body.user.membership.status === 'NONE' &&
      reg.body.user.email === 'meera@skyline.edu' && typeof reg.body.token === 'string',
    `status=${reg.status} user=${JSON.stringify(reg.body?.user)}`);

  const dup = await api('POST', '/api/auth/register', { body: { name: 'Meera Again', email: 'meera@SKYLINE.edu', password: 'hackathon26' } });
  check('POST /api/auth/register (duplicate email, any case) -> 409', dup.status === 409);

  const badReg = await api('POST', '/api/auth/register', { body: { name: 'X', email: 'not-an-email', password: 'short' } });
  check('POST /api/auth/register (invalid input) -> 400 with field details',
    badReg.status === 400 && ['name', 'email', 'password'].every((f) => f in badReg.body.details),
    `details=${JSON.stringify(badReg.body?.details)}`);

  const demo = await api('GET', '/api/auth/demo-accounts');
  check('GET /api/auth/demo-accounts -> 4 seeded accounts',
    demo.status === 200 && demo.body.accounts.length === 4,
    demo.body?.accounts?.map((a) => `${a.email} (${a.role})`).join(', '));
}

function verifyAuthUnits() {
  section('Auth units');
  const { sign, verify } = require('./lib/token');
  const { hashPassword, verifyPassword } = require('./lib/password');
  const { requireRole } = require('./middleware/requireAuth');

  const expired = verify(sign({ sub: 1, role: 'ADMIN', email: 'a@b.c', exp: Math.floor(Date.now() / 1000) - 1 }));
  check('token.verify rejects expired token', !expired.valid && expired.reason === 'token expired');

  const stored = hashPassword('skyline123');
  check('password hash format is saltHex(16 bytes):hashHex', /^[0-9a-f]{32}:[0-9a-f]{128}$/.test(stored));
  check('password verify: correct -> true, wrong -> false, malformed -> false',
    verifyPassword('skyline123', stored) && !verifyPassword('skyline124', stored) && !verifyPassword('x', 'garbage'));

  const run = (mw, user) => {
    const out = { status: 200, next: false };
    const res = { status(code) { out.status = code; return this; }, json() { return this; }, set() { return this; } };
    mw({ user }, res, () => { out.next = true; });
    return out;
  };
  const adminOnly = requireRole('ADMIN');
  const student = run(adminOnly, { id: 4, role: 'STUDENT' });
  const admin = run(adminOnly, { id: 1, role: 'ADMIN' });
  check("requireRole('ADMIN'): STUDENT -> 403, ADMIN -> next()",
    student.status === 403 && !student.next && admin.next);
}

async function verifyDatabase() {
  section('Database integrity');
  const { db, connect, withTransaction, TABLES } = require('./db');

  const fresh = connect(DB_FILE);
  const fk = fresh.prepare('PRAGMA foreign_keys').get().foreign_keys;
  const jm = fresh.prepare('PRAGMA journal_mode').get().journal_mode;
  fresh.close();
  check('PRAGMA foreign_keys = 1 on a new connection', fk === 1, `foreign_keys=${fk}`);
  check('PRAGMA journal_mode = wal', jm === 'wal', `journal_mode=${jm}`);

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
  check(`all ${TABLES.length} tables exist`, TABLES.every((t) => tables.includes(t)), tables.join(', '));

  const now = new Date().toISOString();
  let fkError = null;
  try {
    db.prepare('INSERT INTO tickets (ticket_code, event_id, user_id, price_paid, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('TKT-FK-PROBE', 999999, 1, 0, now);
  } catch (err) {
    fkError = err.message;
  }
  check('FK enforced: ticket for non-existent event rejected', /FOREIGN KEY constraint failed/.test(fkError || ''), fkError);

  let checkError = null;
  try {
    db.prepare('UPDATE events SET seats_left = -1 WHERE id = 1').run();
  } catch (err) {
    checkError = err.message;
  }
  check('CHECK enforced: seats_left cannot go negative (oversell guard)', /CHECK constraint failed/.test(checkError || ''), checkError);

  const before = db.prepare('SELECT COUNT(*) AS n FROM announcements').get().n;
  try {
    withTransaction(() => {
      db.prepare("INSERT INTO announcements (title, content, category, author_id, created_at) VALUES ('probe', 'probe', 'GENERAL', 1, ?)").run(now);
      throw new Error('simulated failure');
    });
  } catch {
    // expected
  }
  const after = db.prepare('SELECT COUNT(*) AS n FROM announcements').get().n;
  check('withTransaction rolls back on error', before === after, `announcements before=${before} after=${after}`);

  // Another thread holds the write lock for HOLD_MS. The contender connection has
  // busy_timeout = 0, so SQLite itself won't wait: only withTransaction's
  // SQLITE_BUSY retry loop can get it through.
  const HOLD_MS = 150;
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { db } = require(workerData.dbModule);
    db.exec('BEGIN IMMEDIATE');
    parentPort.postMessage('locked');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.holdMs);
    db.exec('COMMIT');
    db.close();
  `, { eval: true, workerData: { dbModule: path.join(__dirname, 'db.js'), holdMs: HOLD_MS } });
  await once(worker, 'message');
  const contender = connect(DB_FILE, { busyTimeoutMs: 0 });
  const started = Date.now();
  let busyError = null;
  try {
    withTransaction((c) => c.prepare('UPDATE events SET seats_left = seats_left WHERE id = 1').run(), contender);
  } catch (err) {
    busyError = err;
  }
  const waited = Date.now() - started;
  await once(worker, 'exit');
  contender.close();
  check('withTransaction retries SQLITE_BUSY until the lock frees',
    !busyError && waited >= HOLD_MS * 0.8,
    busyError ? `failed: ${busyError.message}` : `lock held ${HOLD_MS}ms by another thread; committed after ${waited}ms`);

  section('EXPLAIN QUERY PLAN');
  const plans = [
    ['users by membership_code', 'SELECT id FROM users WHERE membership_code = ?', ['SKY-2026-003']],
    ['tickets by event_id + user_id', 'SELECT id FROM tickets WHERE event_id = ? AND user_id = ?', [1, 1]],
    ['tickets by ticket_code', 'SELECT * FROM tickets WHERE ticket_code = ?', ['TKT-GALA26-0001']],
    ['merch_variants by item_id + size', 'SELECT stock_count FROM merch_variants WHERE item_id = ? AND size = ?', [1, 'M']],
    ['fundraiser_tasks by campaign + status', 'SELECT * FROM fundraiser_tasks WHERE campaign_name = ? AND status = ?', ['Autumn Bake Sale 2026', 'TODO']],
    ['ledger totals by type + category + date', 'SELECT SUM(amount) FROM ledger_transactions WHERE type = ? AND category = ? AND created_at >= ?', ['IN', 'TICKET_SALE', '2026-01-01']],
  ];
  for (const [label, sql, params] of plans) {
    const detail = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((r) => r.detail).join(' | ');
    check(label, /SEARCH \S+ USING (COVERING )?INDEX/.test(detail), detail);
  }

  const explicit = ['idx_tickets_event_user', 'idx_tasks_campaign_status', 'idx_ledger_type_category'];
  const redundant = ['idx_users_membership_code', 'idx_tickets_code', 'idx_merch_variants_item_size'];
  const present = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name);
  check('3 explicit indexes exist; redundant copies of UNIQUE autoindexes are gone',
    explicit.every((n) => present.includes(n)) && !redundant.some((n) => present.includes(n)),
    present.join(', '));

  db.close();
}

async function main() {
  console.log(`Phase 1 verification (temp DB: ${DB_FILE})`);
  let child = null;
  try {
    const server = await startServer(DB_FILE);
    child = server.child;
    console.log(`Test server started (pid ${child.pid}, port ${server.port})`);
    await verifyApi(server.api);
    verifyAuthUnits();
    await verifyDatabase();
  } catch (err) {
    check('verification ran to completion', false, err.stack);
  } finally {
    await stopServer(child);
    if (child) console.log(`\nTest server stopped (pid ${child.pid}); port 3000 was never used.`);
    removeDb(DB_FILE);
  }
  summarize();
}

main();
