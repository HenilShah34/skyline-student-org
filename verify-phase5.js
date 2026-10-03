'use strict';

// Phase 5 self-verification: the web client is served from public/ with the
// right content types, parses cleanly, works offline (no external URLs), is
// wired to every mutation endpoint, and static serving leaks nothing outside
// public/. Also checks the per-viewer fields the UI relies on. Runs the real
// server against a throwaway database on an ephemeral port.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { check, section, summarize, tempDbPath, removeDb, startServer, stopServer } = require('./verify-helpers');

const DB_FILE = tempDbPath('verify5');
const PUBLIC_DIR = path.join(__dirname, 'public');
// Strings that only appear inside server source, package manifests or the DB
// file (Express's 404 page echoes the requested path, so paths can't be used).
const SOURCE_MARKERS = /withTransaction|require\(|SQLite format 3|"dependencies"/;

async function fetchRaw(port, route) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`);
  return { status: res.status, type: res.headers.get('content-type') || '', body: await res.text() };
}

async function run(server) {
  const { port, api } = server;

  section('Static client');
  const index = await fetchRaw(port, '/');
  check('GET / -> 200 text/html with viewport meta, stylesheet and script',
    index.status === 200 && index.type.startsWith('text/html') && index.body.includes('name="viewport"') &&
      index.body.includes('href="/styles.css"') && index.body.includes('src="/app.js"'),
    `${index.status} ${index.type}`);
  const css = await fetchRaw(port, '/styles.css');
  check('GET /styles.css -> 200 text/css', css.status === 200 && css.type.startsWith('text/css'), `${css.status} ${css.type}`);
  const js = await fetchRaw(port, '/app.js');
  check('GET /app.js -> 200 JavaScript', js.status === 200 && /javascript/.test(js.type), `${js.status} ${js.type}`);

  const syntax = spawnSync(process.execPath, ['--check', path.join(PUBLIC_DIR, 'app.js')], { encoding: 'utf8' });
  check('node --check public/app.js -> no syntax errors', syntax.status === 0, syntax.stderr.trim());

  // Venue Wi-Fi can drop: nothing may load from another origin. The SVG XML
  // namespace is an identifier, not a request.
  const external = [];
  for (const file of fs.readdirSync(PUBLIC_DIR)) {
    const text = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
    for (const url of text.match(/https?:\/\/[^\s'")]+/g) || []) {
      if (!url.startsWith('http://www.w3.org/2000/svg')) external.push(`${file}: ${url}`);
    }
  }
  check('works offline: no CDN, web font or other external URL in public/', external.length === 0, external.join(', '));

  const wired = ['Authorization', '/api/memberships/join-or-renew', '/api/memberships/lookup', '/tickets',
    '/check-in', '/api/announcements', '/api/merch/orders', '/pickup', '/api/tasks', '/status',
    '/api/finance/reimbursements', '/review', '/api/finance/ledger', '/api/finance/fundraiser-income',
    '/api/auth/demo-accounts', '/api/events', '/api/auth/forgot-password', '/api/auth/forgot-email',
    '/api/auth/profile', '/api/finance/ledger/export.csv', '/api/users', '/role', "'DELETE'"];
  const missing = wired.filter((needle) => !js.body.includes(needle));
  check('app.js is wired to every scene endpoint and sends the Bearer token', missing.length === 0, missing.join(', '));

  section('Static serving does not leak server files');
  const probes = ['/db.js', '/server.js', '/skyline.db', '/seed.js', '/package.json', '/.gitignore',
    '/lib/token.js', '/routes/finance.js', '/node_modules/express/package.json', '/..%2fdb.js', '/%2e%2e/server.js'];
  const leaks = [];
  for (const probe of probes) {
    const res = await fetchRaw(port, probe);
    if (res.status === 200 || SOURCE_MARKERS.test(res.body)) leaks.push(`${probe} -> ${res.status}`);
    if (['/db.js', '/server.js', '/skyline.db'].includes(probe) && res.status !== 404) leaks.push(`${probe} -> ${res.status} (expected 404)`);
  }
  check('/db.js, /server.js, /skyline.db -> 404; no source, DB or traversal path is served', leaks.length === 0, leaks.join(', ') || `${probes.length} probes refused`);
  const apiMiss = await api('GET', '/api/does-not-exist');
  check('unknown /api route still answers JSON 404 (static files do not shadow the API)',
    apiMiss.status === 404 && apiMiss.body?.error === 'Not found');

  section('Per-viewer fields the UI renders');
  const login = async (email) => (await api('POST', '/api/auth/login', { body: { email, password: 'skyline123' } })).body.token;
  const rohan = await login('rohan@skyline.edu');
  const kabir = await login('kabir@skyline.edu');
  const neha = await login('neha@skyline.edu');

  const anonEvents = await api('GET', '/api/events');
  const rohanEvents = await api('GET', '/api/events', { token: rohan });
  const kabirEvents = await api('GET', '/api/events', { token: kabir });
  const galaOf = (res) => res.body.events.find((e) => e.title === 'Spring Annual Gala 2026');
  const odooOf = (res) => res.body.events.find((e) => e.title.startsWith('Odoo'));
  check('GET /api/events: visitor gets no tier, price or ticket',
    anonEvents.body.viewer.tier === null && galaOf(anonEvents).your_price === null && galaOf(anonEvents).my_ticket === null);
  check('GET /api/events: Rohan -> MEMBER, Gala ₹250, his Odoo ticket attached',
    rohanEvents.body.viewer.tier === 'MEMBER' && galaOf(rohanEvents).your_price === 250 &&
      galaOf(rohanEvents).my_ticket === null && odooOf(rohanEvents).my_ticket?.ticket_code === 'TKT-ODOO26-0001',
    `odoo my_ticket=${JSON.stringify(odooOf(rohanEvents).my_ticket)}`);
  check('GET /api/events: Kabir -> GUEST, Gala ₹500', kabirEvents.body.viewer.tier === 'GUEST' && galaOf(kabirEvents).your_price === 500);

  const hoodieOf = (res) => res.body.items.find((i) => /Hoodie/.test(i.name));
  const rohanMerch = await api('GET', '/api/merch/items', { token: rohan });
  const kabirMerch = await api('GET', '/api/merch/items', { token: kabir });
  check('GET /api/merch/items: Rohan MEMBER ₹899, Kabir REGULAR ₹1199',
    rohanMerch.body.viewer.tier === 'MEMBER' && hoodieOf(rohanMerch).your_price === 899 &&
      kabirMerch.body.viewer.tier === 'REGULAR' && hoodieOf(kabirMerch).your_price === 1199);

  const assignees = await api('GET', '/api/tasks/assignees', { token: neha });
  const studentAssignees = await api('GET', '/api/tasks/assignees', { token: kabir });
  check('GET /api/tasks/assignees: staff get the picker list; students -> 403',
    assignees.status === 200 && assignees.body.users.length === 5 && assignees.body.users.every((u) => u.id && u.name && u.role) &&
      !('password_hash' in assignees.body.users[0]) && studentAssignees.status === 403);

  const forged = await api('GET', '/api/events', { token: `${kabir.slice(0, -1)}x` });
  check('public endpoints reject a tampered token with 401 instead of serving it as a visitor', forged.status === 401);
}

async function main() {
  console.log(`Phase 5 verification (temp DB: ${DB_FILE})`);
  let server = null;
  try {
    server = await startServer(DB_FILE);
    console.log(`Test server started (pid ${server.child.pid}, port ${server.port})`);
    await run(server);
  } catch (err) {
    check('verification ran to completion', false, err.stack);
  } finally {
    if (server) {
      await stopServer(server.child);
      console.log(`\nTest server stopped (pid ${server.child.pid}); port 3000 was never used.`);
    }
    removeDb(DB_FILE);
  }
  summarize();
}

main();
