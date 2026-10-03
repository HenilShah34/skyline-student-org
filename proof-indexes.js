'use strict';

// Live terminal demo: B-tree index SEARCH vs full-table SCAN on the app's key
// lookups. Builds a throwaway database with 25,000 synthetic rows per table,
// then times each lookup both ways with process.hrtime.bigint(). The SCAN side
// uses SQLite's NOT INDEXED clause, which forbids the index for that query.
// Your real skyline.db is never touched. Run: npm run proof:indexes

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const DB_FILE = path.join(os.tmpdir(), `skyline-proof-indexes-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE; // must be set before ./db is required
const { db, driver, withTransaction } = require('./db');

const ROWS = 25000;
const RUNS = 300; // lookups per measurement; random keys each time
const USERS = 500;
const EVENTS = 50; // 500 users × 50 events = 25,000 distinct (event, user) tickets
const CATEGORIES = ['MEMBERSHIP_DUES', 'TICKET_SALE', 'MERCH_SALE', 'FUNDRAISER_INCOME', 'EXPENSE_REIMBURSEMENT'];
const SIZES = ['S', 'M', 'L', 'XL'];
const STATUSES = ['TODO', 'IN_PROGRESS', 'DONE'];
const DAY_MS = 24 * 60 * 60 * 1000;

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (text) => (color ? `\x1b[${code}m${text}\x1b[0m` : String(text));
const bold = paint('1');
const dim = paint('2');
const green = paint('32');
const red = paint('31');
const cyan = paint('36');
const magenta = paint('35');

const rand = (n) => Math.floor(Math.random() * n);

function seedSyntheticData() {
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  withTransaction(() => {
    const user = db.prepare("INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?, ?, 'x:y', 'STUDENT', ?)");
    for (let i = 1; i <= USERS; i++) user.run(`Student ${i}`, `student${i}@bench.skyline.edu`, iso(now));

    const event = db.prepare(`
      INSERT INTO events (title, event_date, location, total_seats, seats_left, member_price, guest_price, created_at)
      VALUES (?, ?, 'Hall', 1000, 1000, 100, 200, ?)`);
    for (let i = 1; i <= EVENTS; i++) event.run(`Event ${i}`, iso(now + i * DAY_MS), iso(now));

    const ticket = db.prepare('INSERT INTO tickets (ticket_code, event_id, user_id, price_paid, created_at) VALUES (?, ?, ?, 100, ?)');
    let n = 0;
    for (let e = 1; e <= EVENTS; e++) {
      for (let u = 1; u <= USERS; u++) ticket.run(`TKT-B${String(++n).padStart(6, '0')}`, e, u, iso(now));
    }

    const item = db.prepare("INSERT INTO merch_items (name, category, member_price, regular_price, created_at) VALUES (?, 'APPAREL', 300, 400, ?)");
    const variant = db.prepare('INSERT INTO merch_variants (item_id, size, stock_count) VALUES (?, ?, ?)');
    for (let i = 1; i <= ROWS / SIZES.length; i++) {
      item.run(`Item ${i}`, iso(now));
      for (const size of SIZES) variant.run(i, size, rand(50));
    }

    const task = db.prepare('INSERT INTO fundraiser_tasks (campaign_name, title, status, created_at) VALUES (?, ?, ?, ?)');
    for (let i = 0; i < ROWS; i++) task.run(`Campaign ${i % 500}`, `Task ${i}`, STATUSES[i % 3], iso(now));

    const ledger = db.prepare(`
      INSERT INTO ledger_transactions (type, category, amount, description, created_at)
      VALUES (?, ?, ?, 'synthetic', ?)`);
    for (let i = 0; i < ROWS; i++) {
      const category = CATEGORIES[i % CATEGORIES.length];
      ledger.run(category === 'EXPENSE_REIMBURSEMENT' ? 'OUT' : 'IN', category, 1 + rand(5000), iso(now - rand(365) * DAY_MS));
    }
  });
}

// Each lookup: the query as the app writes it, the same query with the index
// forbidden, and a generator of random keys.
const LOOKUPS = [
  {
    name: 'tickets by (event_id, user_id)',
    table: 'tickets',
    where: 'event_id = ? AND user_id = ?',
    select: 'ticket_code',
    params: () => [1 + rand(EVENTS), 1 + rand(USERS)],
  },
  {
    name: 'tickets by ticket_code',
    table: 'tickets',
    where: 'ticket_code = ?',
    select: 'id, checked_in',
    params: () => [`TKT-B${String(1 + rand(ROWS)).padStart(6, '0')}`],
  },
  {
    name: 'merch_variants by (item_id, size)',
    table: 'merch_variants',
    where: 'item_id = ? AND size = ?',
    select: 'id, stock_count',
    params: () => [1 + rand(ROWS / SIZES.length), SIZES[rand(SIZES.length)]],
  },
  {
    name: 'fundraiser_tasks by (campaign_name, status)',
    table: 'fundraiser_tasks',
    where: 'campaign_name = ? AND status = ?',
    select: 'id, title',
    params: () => [`Campaign ${rand(500)}`, STATUSES[rand(3)]],
  },
  {
    name: 'ledger by (type, category, created_at)',
    table: 'ledger_transactions',
    where: 'type = ? AND category = ? AND created_at >= ?',
    select: 'id, amount',
    params: () => {
      const category = CATEGORIES[rand(CATEGORIES.length)];
      return [category === 'EXPENSE_REIMBURSEMENT' ? 'OUT' : 'IN', category, new Date(Date.now() - 3 * DAY_MS).toISOString()];
    },
  },
];

function plan(sql, params) {
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((r) => r.detail).join(' | ');
}

// Average microseconds per lookup over RUNS random keys.
function time(sql, makeParams) {
  const stmt = db.prepare(sql);
  const keys = Array.from({ length: RUNS }, makeParams);
  for (const k of keys.slice(0, 20)) stmt.all(...k); // warm-up
  const start = process.hrtime.bigint();
  for (const k of keys) stmt.all(...k);
  return Number(process.hrtime.bigint() - start) / 1000 / RUNS;
}

function fmtUs(us) {
  return us >= 1000 ? `${(us / 1000).toFixed(2)} ms` : `${us.toFixed(1)} µs`;
}

function main() {
  console.log(bold(magenta('\nSkyline ERP · B-tree index proof')));
  console.log(dim(`Temporary database (${driver}): ${DB_FILE}`));
  const seedStart = process.hrtime.bigint();
  seedSyntheticData();
  const seedMs = Number(process.hrtime.bigint() - seedStart) / 1e6;
  console.log(dim(`Seeded ${ROWS.toLocaleString('en-IN')} rows each into tickets, merch_variants, fundraiser_tasks and ledger_transactions in ${seedMs.toFixed(0)} ms.`));
  console.log(dim(`Each figure is the average of ${RUNS} lookups with random keys.\n`));

  let allIndexed = true;
  const rows = [];
  for (const l of LOOKUPS) {
    const indexedSql = `SELECT ${l.select} FROM ${l.table} WHERE ${l.where}`;
    const scanSql = `SELECT ${l.select} FROM ${l.table} NOT INDEXED WHERE ${l.where}`;
    const sample = l.params();
    const indexedPlan = plan(indexedSql, sample);
    const scanPlan = plan(scanSql, sample);
    const usesIndex = /SEARCH .* USING (COVERING )?INDEX/.test(indexedPlan);
    if (!usesIndex) allIndexed = false;
    const indexedUs = time(indexedSql, l.params);
    const scanUs = time(scanSql, l.params);
    rows.push({ l, indexedPlan, scanPlan, usesIndex, indexedUs, scanUs });

    console.log(bold(l.name));
    console.log(`  ${usesIndex ? green('index') : red('index')} ${dim('→')} ${indexedPlan}`);
    console.log(`  ${red('scan ')} ${dim('→')} ${scanPlan}\n`);
  }

  const w = [46, 12, 12, 10];
  const line = (cells) => cells.map((c, i) => String(c).padEnd(w[i])).join('  ');
  console.log(bold(line(['Lookup', 'B-tree', 'Full scan', 'Speed-up'])));
  console.log(dim('─'.repeat(w.reduce((a, b) => a + b + 2, 0))));
  for (const r of rows) {
    const speedup = r.scanUs / r.indexedUs;
    console.log(line([r.l.name, fmtUs(r.indexedUs), fmtUs(r.scanUs), ''])
      .replace(/\s+$/, '') + '  ' + (speedup >= 2 ? green(`${speedup.toFixed(0)}×`) : cyan(`${speedup.toFixed(1)}×`)));
  }

  console.log(allIndexed
    ? green(bold('\nEvery lookup is a B-tree SEARCH; without the index SQLite must SCAN all 25,000 rows.'))
    : red(bold('\nAt least one lookup did not use an index.')));
  process.exitCode = allIndexed ? 0 : 1;
}

try {
  main();
} finally {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB_FILE + suffix, { force: true });
  console.log(dim('Temporary database removed.\n'));
}
