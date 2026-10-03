'use strict';

// Live terminal demo: three race conditions, each fired from 5 separate server
// processes at once against one temporary database. Exactly one request wins
// every race; the other four get a clean 409. Your real skyline.db is never
// touched. Run: npm run proof:concurrency

const { tempDbPath, removeDb, startServer, stopServer } = require('./verify-helpers');

const DB_FILE = tempDbPath('proof-concurrency');
process.env.DB_PATH = DB_FILE; // must be set before ./db is required

const PROCESSES = 5;
const HOLD_MS = 150; // test-only pause between "check" and "write", so all 5 requests overlap
const SERVER_ENV = { TEST_PURCHASE_HOLD_MS: String(HOLD_MS) };

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (text) => (color ? `\x1b[${code}m${text}\x1b[0m` : String(text));
const bold = paint('1');
const dim = paint('2');
const green = paint('32');
const red = paint('31');
const yellow = paint('33');
const cyan = paint('36');
const magenta = paint('35');

let failures = 0;
const servers = [];
let db = null;

function verdict(ok, text) {
  if (!ok) failures++;
  console.log(`  ${ok ? green('✔ PASS') : red('✘ FAIL')}  ${text}`);
}

function statusLabel(status) {
  if (status === 200) return green('200 OK');
  if (status === 201) return green('201 Created');
  if (status === 409) return yellow('409 Conflict');
  return red(String(status));
}

// Fires one request per server at the same moment and prints a timing line each.
async function race(makeRequest) {
  const started = Date.now();
  const results = await Promise.all(servers.map(async (server, i) => {
    const t0 = Date.now();
    const res = await makeRequest(server, i);
    return { pid: server.child.pid, status: res.status, error: res.body?.error, startMs: t0 - started, ms: Date.now() - t0 };
  }));
  console.log(dim(`  ${'process'.padEnd(10)}${'sent at'.padEnd(10)}${'took'.padEnd(10)}result`));
  for (const r of results) {
    const reason = r.error ? dim(` (${r.error})`) : '';
    console.log(`  ${cyan(`pid ${r.pid}`.padEnd(10))}${`+${r.startMs}ms`.padEnd(10)}${`${r.ms}ms`.padEnd(10)}${statusLabel(r.status)}${reason}`);
  }
  return results;
}

async function run() {
  console.log(bold(magenta('\nSkyline ERP · multi-process concurrency proof')));
  console.log(dim(`Temporary database: ${DB_FILE}`));

  servers.push(await startServer(DB_FILE, SERVER_ENV));
  ({ db } = require('./db'));
  servers.push(...await Promise.all(Array.from({ length: PROCESSES - 1 }, () => startServer(DB_FILE, SERVER_ENV))));
  console.log(dim(`${PROCESSES} independent Node.js server processes, one SQLite file: pids ${servers.map((s) => s.child.pid).join(', ')}`));
  console.log(dim(`Each request pauses ${HOLD_MS}ms inside its transaction, so all five are guaranteed to overlap.`));

  const { api } = servers[0];
  const login = async (email) => (await api('POST', '/api/auth/login', { body: { email, password: 'skyline123' } })).body.token;
  const treasurer = await login('meera@skyline.edu');
  const volunteer = await login('neha@skyline.edu');
  const buyers = [];
  for (let i = 1; i <= PROCESSES; i++) {
    const reg = await api('POST', '/api/auth/register', {
      body: { name: `Proof Buyer ${i}`, email: `proof-buyer${i}@demo.skyline.edu`, password: 'concurrency' },
    });
    buyers.push(reg.body.token);
  }

  // Race 1 ---------------------------------------------------------------
  console.log(bold('\nRace 1 · Scene 2 · five buyers, the last Spring Gala seat'));
  const gala = db.prepare("SELECT id FROM events WHERE title = 'Spring Annual Gala 2026'").get();
  db.prepare('UPDATE events SET seats_left = 1 WHERE id = ?').run(gala.id); // fixture: one seat left
  const sales0 = db.prepare("SELECT COUNT(*) AS n FROM ledger_transactions WHERE category = 'TICKET_SALE'").get().n;
  const r1 = await race((server, i) => server.api('POST', `/api/events/${gala.id}/tickets`, { token: buyers[i] }));
  const seatsLeft = db.prepare('SELECT seats_left FROM events WHERE id = ?').get(gala.id).seats_left;
  const sales1 = db.prepare("SELECT COUNT(*) AS n FROM ledger_transactions WHERE category = 'TICKET_SALE'").get().n;
  verdict(r1.filter((r) => r.status === 201).length === 1 && r1.filter((r) => r.status === 409).length === 4,
    `exactly 1 × 201 Created, 4 × 409 "Event is sold out"`);
  verdict(seatsLeft === 0 && sales1 - sales0 === 1, `seats_left = ${seatsLeft} (never negative), ${sales1 - sales0} ticket-sale ledger row added`);

  // Race 2 ---------------------------------------------------------------
  console.log(bold('\nRace 2 · Scene 4 · five orders, the last size XL hoodie'));
  const xl = db.prepare(`
    SELECT v.id FROM merch_variants v JOIN merch_items i ON i.id = v.item_id
    WHERE i.name = 'Skyline Signature Hoodie' AND v.size = 'XL'`).get();
  db.prepare('UPDATE merch_variants SET stock_count = 1 WHERE id = ?').run(xl.id); // fixture: one unit left
  const orders0 = db.prepare('SELECT COUNT(*) AS n FROM merch_orders WHERE variant_id = ?').get(xl.id).n;
  const r2 = await race((server, i) => server.api('POST', '/api/merch/orders', { token: buyers[i], body: { variant_id: xl.id, quantity: 1 } }));
  const stock = db.prepare('SELECT stock_count FROM merch_variants WHERE id = ?').get(xl.id).stock_count;
  const orders1 = db.prepare('SELECT COUNT(*) AS n FROM merch_orders WHERE variant_id = ?').get(xl.id).n;
  verdict(r2.filter((r) => r.status === 201).length === 1 && r2.filter((r) => r.status === 409).length === 4,
    `exactly 1 × 201 Created, 4 × 409 "Size XL is out of stock"`);
  verdict(stock === 0 && orders1 - orders0 === 1, `stock_count = ${stock} (never negative), ${orders1 - orders0} order row added`);

  // Race 3 ---------------------------------------------------------------
  console.log(bold('\nRace 3 · Scene 6 · five treasurer approvals of one ₹650 receipt'));
  const claim = await api('POST', '/api/finance/reimbursements', {
    token: volunteer,
    body: { title: 'Bake Sale Cocoa & Sugar', category: 'FUNDRAISER_SUPPLIES', amount: 650, receipt_reference: 'RCP-PROOF-650' },
  });
  const claimId = claim.body.reimbursement.id;
  const out0 = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM ledger_transactions WHERE type = 'OUT'").get();
  const r3 = await race((server) => server.api('PATCH', `/api/finance/reimbursements/${claimId}/review`, { token: treasurer, body: { decision: 'APPROVED_PAID' } }));
  const out1 = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM ledger_transactions WHERE type = 'OUT'").get();
  verdict(r3.filter((r) => r.status === 200).length === 1 && r3.filter((r) => r.status === 409).length === 4,
    `exactly 1 × 200 OK, 4 × 409 "Reimbursement already APPROVED_PAID"`);
  verdict(out1.n - out0.n === 1 && out1.total - out0.total === 650, `exactly one −₹${out1.total - out0.total} OUT row in the ledger`);
}

async function main() {
  try {
    await run();
  } catch (err) {
    failures++;
    console.error(red(`\nProof aborted: ${err.stack}`));
  } finally {
    await Promise.all(servers.map((s) => stopServer(s.child)));
    if (db) db.close();
    removeDb(DB_FILE);
  }
  console.log(failures
    ? red(bold(`\n${failures} check(s) failed.`))
    : green(bold('\nAll 3 races: one winner each, no oversell, no double payout. BEGIN IMMEDIATE held.')));
  console.log(dim('Servers stopped and the temporary database removed.\n'));
  process.exitCode = failures ? 1 : 0;
}

main();
