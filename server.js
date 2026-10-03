'use strict';

const path = require('node:path');
const express = require('express');
const { db, driver, withTransaction, TABLES } = require('./db');
const { hashPassword, verifyPassword, getDummyHash } = require('./lib/password');
const { sign } = require('./lib/token');
const { toPublicUser, membershipSnapshot } = require('./lib/users');
const { requireAuth, requireRole } = require('./middleware/requireAuth');
const { seedIfEmpty, DEMO_ACCOUNTS, DEMO_PASSWORD } = require('./seed');
const membershipsRouter = require('./routes/memberships');
const eventsRouter = require('./routes/events');
const announcementsRouter = require('./routes/announcements');
const merchRouter = require('./routes/merch');
const tasksRouter = require('./routes/tasks');
const financeRouter = require('./routes/finance');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const app = express();
app.disable('x-powered-by');
// Only public/ is web-reachable; server code, the database and dotfiles are not.
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '100kb' }));

function issueToken(user) {
  return sign({ sub: user.id, role: user.role, email: user.email });
}

function validationError(res, details) {
  return res.status(400).json({ error: 'Validation failed', details });
}

app.get('/api/health', (req, res) => {
  try {
    const { version } = db.prepare('SELECT sqlite_version() AS version').get();
    const { foreign_keys } = db.prepare('PRAGMA foreign_keys').get();
    const { journal_mode } = db.prepare('PRAGMA journal_mode').get();
    const tables = {};
    for (const table of TABLES) tables[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

    res.json({
      status: 'ok',
      database: { status: 'connected', driver, sqlite_version: version, foreign_keys, journal_mode },
      tables,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(503).json({ status: 'error', database: { status: 'unavailable', error: err.message } });
  }
});

app.post('/api/auth/register', (req, res) => {
  const { name, email, password } = req.body || {};
  const cleanName = typeof name === 'string' ? name.trim() : '';
  const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';

  const details = {};
  if (cleanName.length < 2 || cleanName.length > 80) details.name = 'Name must be 2-80 characters';
  if (cleanEmail.length > 254 || !EMAIL_RE.test(cleanEmail)) details.email = 'A valid email address is required';
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    details.password = 'Password must be 8-128 characters';
  }
  if (Object.keys(details).length) return validationError(res, details);

  // scrypt is deliberately slow; hash before taking the write lock.
  const passwordHash = hashPassword(password);

  const user = withTransaction(() => {
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(cleanEmail)) return null;
    const { lastInsertRowid } = db
      .prepare(`INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?, ?, ?, 'STUDENT', ?)`)
      .run(cleanName, cleanEmail, passwordHash, new Date().toISOString());
    return db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid);
  });
  if (!user) return res.status(409).json({ error: 'An account with this email already exists' });

  res.status(201).json({ token: issueToken(user), user: toPublicUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const details = {};
  if (typeof email !== 'string' || !email.trim()) details.email = 'Email is required';
  if (typeof password !== 'string' || !password) details.password = 'Password is required';
  if (Object.keys(details).length) return validationError(res, details);

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase());
  // Always run scrypt so response time doesn't reveal whether the email exists.
  const passwordOk = verifyPassword(password, user ? user.password_hash : getDummyHash());
  if (!user || !passwordOk) return res.status(401).json({ error: 'Invalid email or password' });

  res.json({ token: issueToken(user), user: toPublicUser(user) });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(401).json({ error: 'Unauthorized', reason: 'user no longer exists' });
  res.json({ user: toPublicUser(user) });
});

// ---------------------------------------------------------------- account recovery + profile

const MIN_RESET_PASSWORD = 6;
const MAX_PASSWORD = 128;

function maskEmail(email) {
  const [local, domain] = email.split('@');
  return `${local.slice(0, 2)}${'•'.repeat(Math.max(local.length - 2, 1))}@${domain}`;
}

// "Forgot email": find an account by its membership code (e.g. SKY-2026-004)
// or its full name, both case-insensitive. A code match wins over a name match.
app.post('/api/auth/forgot-email', (req, res) => {
  const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
  if (!query || query.length > 100) return validationError(res, { query: 'Enter your full name or membership code (SKY-2026-XXX)' });

  const user = db
    .prepare(`
      SELECT * FROM users
      WHERE UPPER(membership_code) = UPPER(?) OR LOWER(name) = LOWER(?)
      ORDER BY CASE WHEN UPPER(membership_code) = UPPER(?) THEN 0 ELSE 1 END, id
      LIMIT 1`)
    .get(query, query, query);
  if (!user) return res.status(404).json({ error: 'No account matches that name or membership code' });

  res.json({
    account: {
      name: user.name,
      email: user.email,
      masked_email: maskEmail(user.email),
      role: user.role,
      membership_code: user.membership_code,
    },
  });
});

// "Forgot password": prove who you are with your membership code or full name,
// then set a new password. Unknown email and wrong verification give the same
// 401, so the endpoint can't be used to discover which emails are registered.
app.post('/api/auth/forgot-password', (req, res) => {
  const { email, verification, new_password: newPassword } = req.body || {};
  const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const proof = typeof verification === 'string' ? verification.trim() : '';

  const details = {};
  if (!EMAIL_RE.test(cleanEmail)) details.email = 'A valid email address is required';
  if (!proof) details.verification = 'Enter your membership code (SKY-2026-XXX) or your full name';
  if (typeof newPassword !== 'string' || newPassword.length < MIN_RESET_PASSWORD || newPassword.length > MAX_PASSWORD) {
    details.new_password = `New password must be ${MIN_RESET_PASSWORD}-${MAX_PASSWORD} characters`;
  }
  if (Object.keys(details).length) return validationError(res, details);

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(cleanEmail);
  const verified = user && (
    (user.membership_code && user.membership_code.toUpperCase() === proof.toUpperCase()) ||
    user.name.toLowerCase() === proof.toLowerCase()
  );
  if (!verified) return res.status(401).json({ error: 'Those details do not match any account' });

  const passwordHash = hashPassword(newPassword); // slow KDF, kept outside the write lock
  const updated = withTransaction(() => {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, user.id);
    return db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  });
  res.json({ token: issueToken(updated), user: toPublicUser(updated) });
});

// Update your own name and/or password. Changing the password needs the
// current one, so a borrowed, unlocked session can't lock the owner out.
app.patch('/api/auth/profile', requireAuth, (req, res) => {
  const body = req.body || {};
  const changeName = body.name !== undefined;
  const changePassword = body.new_password !== undefined;
  const name = typeof body.name === 'string' ? body.name.trim() : '';

  const details = {};
  if (!changeName && !changePassword) details.profile = 'Send a new name and/or a new password';
  if (changeName && (name.length < 2 || name.length > 80)) details.name = 'Name must be 2-80 characters';
  if (changePassword) {
    if (typeof body.current_password !== 'string' || !body.current_password) details.current_password = 'Current password is required';
    if (typeof body.new_password !== 'string' || body.new_password.length < MIN_RESET_PASSWORD || body.new_password.length > MAX_PASSWORD) {
      details.new_password = `New password must be ${MIN_RESET_PASSWORD}-${MAX_PASSWORD} characters`;
    }
  }
  if (Object.keys(details).length) return validationError(res, details);

  const current = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!current) return res.status(401).json({ error: 'Unauthorized', reason: 'user no longer exists' });
  if (changePassword && !verifyPassword(body.current_password, current.password_hash)) {
    return res.status(403).json({ error: 'Current password is incorrect' });
  }

  const passwordHash = changePassword ? hashPassword(body.new_password) : null;
  const user = withTransaction(() => {
    if (changeName) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, current.id);
    if (passwordHash) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, current.id);
    return db.prepare('SELECT * FROM users WHERE id = ?').get(current.id);
  });
  res.json({ user: toPublicUser(user), updated: { name: changeName, password: changePassword } });
});

// Powers the 1-click demo login buttons. Set DEMO_ACCOUNTS=off to hide it.
app.get('/api/auth/demo-accounts', (req, res) => {
  if (process.env.DEMO_ACCOUNTS === 'off') return res.status(404).json({ error: 'Not found' });

  const emails = DEMO_ACCOUNTS.map((a) => a.email);
  const rows = db
    .prepare(`SELECT * FROM users WHERE email IN (${emails.map(() => '?').join(', ')})`)
    .all(...emails);
  const byEmail = new Map(rows.map((row) => [row.email, row]));

  const accounts = DEMO_ACCOUNTS.filter((a) => byEmail.has(a.email)).map((a) => {
    const row = byEmail.get(a.email);
    return { name: row.name, email: row.email, role: row.role, persona: a.persona, membership: membershipSnapshot(row) };
  });
  res.json({ password: DEMO_PASSWORD, accounts });
});

// The indexed lookups the app depends on, with sample parameters. Single-table
// queries without ORDER BY, so each plan line shows exactly how SQLite finds rows.
const PROOF_QUERIES = [
  { name: 'tickets by (event_id, user_id)', index: 'idx_tickets_event_user', sql: 'SELECT ticket_code FROM tickets WHERE event_id = ? AND user_id = ?', params: [1, 1] },
  { name: 'tickets by ticket_code', index: 'UNIQUE(ticket_code) autoindex', sql: 'SELECT id, checked_in FROM tickets WHERE ticket_code = ?', params: ['TKT-E1-ABC234'] },
  { name: 'merch_variants by (item_id, size)', index: 'UNIQUE(item_id, size) autoindex', sql: 'SELECT id, stock_count FROM merch_variants WHERE item_id = ? AND size = ?', params: [1, 'M'] },
  { name: 'fundraiser_tasks by (campaign_name, status)', index: 'idx_tasks_campaign_status', sql: 'SELECT id, title FROM fundraiser_tasks WHERE campaign_name = ? AND status = ?', params: ['Spring Bake Sale', 'TODO'] },
  { name: 'ledger_transactions by (type, category, created_at)', index: 'idx_ledger_type_category', sql: 'SELECT id, amount FROM ledger_transactions WHERE type = ? AND category = ? AND created_at >= ?', params: ['IN', 'TICKET_SALE', '2026-01-01'] },
];

// Live architecture proof for demos: pragmas, row counts, query plans and the
// ledger balance check, all read from the running database.
app.get('/api/system/proof', requireAuth, requireRole('VOLUNTEER', 'TREASURER', 'ADMIN'), (req, res) => {
  const tableCounts = {};
  for (const table of TABLES) tableCounts[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

  const queryPlans = PROOF_QUERIES.map((q) => {
    const detail = db.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...q.params).map((r) => r.detail).join(' | ');
    return {
      name: q.name,
      expected_index: q.index,
      sql: q.sql,
      plan: detail,
      uses_index: /USING (COVERING )?INDEX/.test(detail),
      full_scan: /\bSCAN\b/.test(detail),
    };
  });

  const ledger = db
    .prepare(`
      SELECT COALESCE(SUM(CASE WHEN type = 'IN' THEN amount ELSE 0 END), 0) AS total_in,
             COALESCE(SUM(CASE WHEN type = 'OUT' THEN amount ELSE 0 END), 0) AS total_out,
             COALESCE(SUM(CASE WHEN type = 'IN' THEN amount ELSE -amount END), 0) AS net_balance,
             COUNT(*) AS transaction_count
      FROM ledger_transactions`)
    .get();

  res.json({
    generated_at: new Date().toISOString(),
    driver,
    sqlite_version: db.prepare('SELECT sqlite_version() AS v').get().v,
    pragmas: {
      foreign_keys: db.prepare('PRAGMA foreign_keys').get().foreign_keys,
      journal_mode: db.prepare('PRAGMA journal_mode').get().journal_mode,
    },
    table_counts: tableCounts,
    query_plans: queryPlans,
    all_queries_use_index: queryPlans.every((p) => p.uses_index && !p.full_scan),
    ledger_integrity: { ...ledger, balanced: ledger.total_in - ledger.total_out === ledger.net_balance },
  });
});

app.use('/api', membershipsRouter);
app.use('/api', eventsRouter);
app.use('/api/announcements', announcementsRouter);
app.use('/api/merch', merchRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/finance', financeRouter);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body' });
  if (err.status >= 400 && err.status < 500) return res.status(err.status).json({ error: err.message, ...err.extra });
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

function start(port = Number(process.env.PORT ?? 3000)) {
  const seed = seedIfEmpty();
  if (seed.seeded) console.log('[seed] Empty database detected; loaded demo data:', seed.counts);

  const server = app.listen(port, (err) => {
    if (err) {
      console.error(`Failed to start server: ${err.message}`);
      process.exit(1);
    }
    console.log(`Skyline ERP API listening on http://localhost:${server.address().port} (sqlite driver: ${driver})`);
    console.log(`Demo login: ${DEMO_ACCOUNTS[0].email} / ${DEMO_PASSWORD}`);
  });
  return server;
}

if (require.main === module) start();

module.exports = { app, start };
