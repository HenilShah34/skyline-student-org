'use strict';

const express = require('express');
const { db, driver, withTransaction, TABLES } = require('./db');
const { hashPassword, verifyPassword, getDummyHash } = require('./lib/password');
const { sign } = require('./lib/token');
const { toPublicUser, membershipSnapshot } = require('./lib/users');
const { requireAuth } = require('./middleware/requireAuth');
const { seedIfEmpty, DEMO_ACCOUNTS, DEMO_PASSWORD } = require('./seed');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const app = express();
app.disable('x-powered-by');
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

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body' });
  if (err.status >= 400 && err.status < 500) return res.status(err.status).json({ error: err.message });
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
