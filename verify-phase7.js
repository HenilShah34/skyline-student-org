'use strict';

// Phase 7 self-verification: privacy-safe ledger rows for students, the admin
// merch restock endpoint, payment-voucher data, and the digital passes (the
// Code 128 barcode is decoded back to its text, and the print stylesheet and
// offline guarantee are checked). Runs the real server against a throwaway
// database on an ephemeral port.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { check, section, summarize, tempDbPath, removeDb, startServer, stopServer } = require('./verify-helpers');

const DB_FILE = tempDbPath('verify7');
process.env.DB_PATH = DB_FILE; // must be set before ./db is required
const PUBLIC_DIR = path.join(__dirname, 'public');

let server = null;
let db = null;

// ------------------------------------------------------------------ barcode decoding
// Anchors from the Code 128 specification, written out here independently of
// the generator's table: Start B, Stop, value 0 (space), 16 ("0") and 33 ("A").
const SPEC_ANCHORS = { 104: '211214', 106: '2331112', 0: '212222', 16: '123122', 33: '111323' };

function loadBarcodeModule() {
  const source = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');
  const block = /\/\/ ---- code128:start([\s\S]*?)\/\/ ---- code128:end/.exec(source);
  if (!block) throw new Error('code128 block not found in public/app.js');
  const sandbox = { esc: (v) => String(v) };
  vm.createContext(sandbox);
  vm.runInContext(`${block[1]}\nthis.api = { CODE128_PATTERNS, code128Widths, barcodeSvg };`, sandbox);
  return sandbox.api;
}

// SVG -> module widths (bar, space, bar, …) plus the blank margins either side.
function svgToRuns(svg) {
  const total = Number(/viewBox="0 0 (\d+) /.exec(svg)[1]);
  const group = /<g[^>]*>([\s\S]*?)<\/g>/.exec(svg)[1];
  const bars = [...group.matchAll(/<rect x="(\d+)" width="(\d+)"/g)].map((m) => ({ x: Number(m[1]), w: Number(m[2]) }));
  const runs = [];
  bars.forEach((bar, i) => {
    if (i > 0) runs.push(bar.x - (bars[i - 1].x + bars[i - 1].w));
    runs.push(bar.w);
  });
  const last = bars[bars.length - 1];
  return { runs, left: bars[0].x, right: total - (last.x + last.w) };
}

function decodeCode128(svg, patterns) {
  const { runs, left, right } = svgToRuns(svg);
  if (left < 10 || right < 10) throw new Error(`quiet zones too small (${left}/${right})`);
  if (runs.some((w) => w < 1 || w > 4)) throw new Error('a bar or space is wider than 4 modules');
  const symbols = [];
  for (let i = 0; i + 6 <= runs.length - 7; i += 6) symbols.push(runs.slice(i, i + 6).join(''));
  const stop = runs.slice(-7).join('');
  if (stop !== patterns[106]) throw new Error(`bad stop pattern ${stop}`);
  const values = symbols.map((p) => {
    const v = patterns.indexOf(p);
    if (v < 0 || v > 105) throw new Error(`unknown symbol ${p}`);
    return v;
  });
  if (values[0] !== 104) throw new Error('does not start with Start B');
  const check = values[values.length - 1];
  const data = values.slice(1, -1);
  const expected = (104 + data.reduce((sum, v, i) => sum + v * (i + 1), 0)) % 103;
  if (check !== expected) throw new Error(`checksum ${check} != ${expected}`);
  return data.map((v) => String.fromCharCode(v + 32)).join('');
}

async function run() {
  server = await startServer(DB_FILE);
  console.log(`Test server started (pid ${server.child.pid}, port ${server.port})`);
  ({ db } = require('./db'));
  const { api } = server;
  const login = async (email) => (await api('POST', '/api/auth/login', { body: { email, password: 'skyline123' } })).body.token;
  const admin = await login('vikram@skyline.edu');
  const treasurer = await login('meera@skyline.edu');
  const volunteer = await login('neha@skyline.edu');
  const rohan = await login('rohan@skyline.edu');
  const kabir = await login('kabir@skyline.edu');
  const users = db.prepare('SELECT id, name, email FROM users').all();
  const idOf = (email) => users.find((u) => u.email === email).id;
  const rohanId = idOf('rohan@skyline.edu');
  const othersNames = () => db.prepare('SELECT name FROM users WHERE id != ?').all(rohanId).map((u) => u.name);

  // ------------------------------------------------------------ privacy
  section('Privacy-safe ledger: students see every amount, not other people');
  const asRohan = await api('GET', '/api/finance/ledger', { token: rohan });
  const asMeera = await api('GET', '/api/finance/ledger', { token: treasurer });
  const asVikram = await api('GET', '/api/finance/ledger', { token: admin });
  check('student Rohan gets the full summary, by_category and semester_story (identical to the Treasurer\'s)',
    asRohan.status === 200 &&
      JSON.stringify(asRohan.body.summary) === JSON.stringify(asMeera.body.summary) &&
      JSON.stringify(asRohan.body.by_category) === JSON.stringify(asMeera.body.by_category) &&
      JSON.stringify(asRohan.body.semester_story) === JSON.stringify(asMeera.body.semester_story) &&
      asRohan.body.count === asMeera.body.count,
    `left ₹${asRohan.body.semester_story?.left}`);

  const dbRows = new Map(db.prepare('SELECT l.id, l.user_id, l.reference_id, l.description, u.name AS user_name FROM ledger_transactions l LEFT JOIN users u ON u.id = l.user_id').all().map((r) => [r.id, r]));
  const own = asRohan.body.transactions.filter((t) => dbRows.get(t.id).user_id === rohanId);
  check('Rohan sees his own rows in full: his name, his real ticket/order/membership codes',
    own.length >= 3 && own.every((t) => !t.masked && t.user_name === 'Rohan Verma' && t.user_id === rohanId &&
      t.reference_id === dbRows.get(t.id).reference_id && t.description === dbRows.get(t.id).description),
    own.map((t) => t.reference_id).join(', '));

  const others = asRohan.body.transactions.filter((t) => { const r = dbRows.get(t.id); return r.user_id !== null && r.user_id !== rohanId; });
  const labelOk = (t) => t.user_name === (t.category === 'EXPENSE_REIMBURSEMENT' ? 'Volunteer' : 'Club Member');
  check("other members' rows: name -> 'Club Member' ('Volunteer' on reimbursements), no user id, code masked to its prefix",
    others.length >= 5 && others.every((t) => t.masked && labelOk(t) && t.user_id === null && /-•••$/.test(t.reference_id) &&
      t.reference_id !== dbRows.get(t.id).reference_id),
    [...new Set(others.map((t) => `${t.category}:${t.user_name}`))].join(', '));
  const leaks = others.filter((t) => othersNames().some((n) => t.description.includes(n)) || t.description.includes(dbRows.get(t.id).reference_id));
  check("no other member's name or code survives inside a description", leaks.length === 0, leaks.map((t) => t.description).join(' | ') || `${others.length} rows clean`);
  const body = JSON.stringify(asRohan.body);
  const leakedNames = othersNames().filter((n) => body.includes(n));
  check("no other member's name appears anywhere in the student's response", leakedNames.length === 0, leakedNames.join(', ') || 'clean');
  const unowned = asRohan.body.transactions.filter((t) => dbRows.get(t.id).user_id === null);
  check('rows with no person attached (box office, fundraiser takings) are not masked',
    unowned.length > 0 && unowned.every((t) => !t.masked && t.reference_id === dbRows.get(t.id).reference_id));
  check('privacy block reports the masking: masked_for_viewer = true, masked_rows matches',
    asRohan.body.privacy.masked_for_viewer === true && asRohan.body.privacy.masked_rows === others.length);

  const staffClean = (res) => res.status === 200 && res.body.privacy.masked_for_viewer === false && res.body.privacy.masked_rows === 0 &&
    res.body.transactions.every((t) => !t.masked && t.user_name === dbRows.get(t.id).user_name && t.reference_id === dbRows.get(t.id).reference_id);
  const asNeha = await api('GET', '/api/finance/ledger', { token: volunteer });
  check('Treasurer Meera, Admin Vikram and Volunteer Neha see every real name and code',
    staffClean(asMeera) && staffClean(asVikram) && staffClean(asNeha) &&
      ['Meera Joshi', 'Neha Sharma', 'Rohan Verma', 'Vikram Desai'].every((n) => JSON.stringify(asMeera.body).includes(n)));

  const asKabir = await api('GET', '/api/finance/ledger', { token: kabir });
  check('a student with no rows of his own (Kabir) sees every personal row masked',
    asKabir.status === 200 && asKabir.body.transactions.filter((t) => dbRows.get(t.id).user_id !== null).every((t) => t.masked));
  const duesOnly = await api('GET', '/api/finance/ledger?category=MEMBERSHIP_DUES', { token: rohan });
  check('filters still work for students, and stay masked',
    duesOnly.status === 200 && duesOnly.body.transactions.every((t) => t.category === 'MEMBERSHIP_DUES') &&
      duesOnly.body.transactions.filter((t) => t.masked).length === duesOnly.body.count - 1);

  await api('PATCH', '/api/auth/profile', { token: volunteer, body: { name: 'Neha S. Sharma' } });
  const afterRename = await api('GET', '/api/finance/ledger', { token: rohan });
  const nehaRows = afterRename.body.transactions.filter((t) => dbRows.get(t.id).user_id === idOf('neha@skyline.edu'));
  check('a member who changed their name is still hidden (the old name in the description is stripped too)',
    nehaRows.length > 0 && nehaRows.every((t) => !/Neha/.test(t.description) && !/Neha/.test(t.user_name)),
    nehaRows.map((t) => t.description).join(' | '));

  // ------------------------------------------------------------ restock
  section('Admin restock: PATCH /api/merch/variants/:id/restock');
  const soldOut = db.prepare("SELECT v.id, v.size, v.stock_count, i.name FROM merch_variants v JOIN merch_items i ON i.id = v.item_id WHERE v.stock_count = 0 ORDER BY v.id LIMIT 1").get();
  const stockOf = (id) => db.prepare('SELECT stock_count FROM merch_variants WHERE id = ?').get(id).stock_count;
  const blocked = await api('POST', '/api/merch/orders', { token: kabir, body: { variant_id: soldOut.id, quantity: 1 } });
  check(`fixture: ${soldOut.name} size ${soldOut.size} is sold out, so an order is refused (409)`, blocked.status === 409);

  const restock = await api('PATCH', `/api/merch/variants/${soldOut.id}/restock`, { token: admin, body: { add_quantity: 10 } });
  const itemTotal = db.prepare('SELECT SUM(stock_count) AS n FROM merch_variants WHERE item_id = (SELECT item_id FROM merch_variants WHERE id = ?)').get(soldOut.id).n;
  check('admin restocks +10 -> 200; stock 0 -> 10 in the database; response carries the item and its new total',
    restock.status === 200 && restock.body.variant.previous_stock === 0 && restock.body.variant.stock_count === 10 &&
      restock.body.variant.added === 10 && stockOf(soldOut.id) === 10 && restock.body.item.total_stock === itemTotal,
    JSON.stringify(restock.body));
  const bought = await api('POST', '/api/merch/orders', { token: kabir, body: { variant_id: soldOut.id, quantity: 1 } });
  check('the restocked size sells again (201) and stock drops to 9', bought.status === 201 && stockOf(soldOut.id) === 9);

  const before = stockOf(soldOut.id);
  const bad = await Promise.all([0, -5, 9999, 2.5, 'ten', null].map((q) => api('PATCH', `/api/merch/variants/${soldOut.id}/restock`, { token: admin, body: { add_quantity: q } })));
  const missingQty = await api('PATCH', `/api/merch/variants/${soldOut.id}/restock`, { token: admin, body: {} });
  check('add_quantity 0, -5, 9999, 2.5, "ten", null or missing -> 400 and stock untouched',
    bad.every((r) => r.status === 400) && missingQty.status === 400 && stockOf(soldOut.id) === before,
    bad.map((r) => r.status).join(','));
  const ghost = await api('PATCH', '/api/merch/variants/99999/restock', { token: admin, body: { add_quantity: 10 } });
  const badId = await api('PATCH', '/api/merch/variants/abc/restock', { token: admin, body: { add_quantity: 10 } });
  check('unknown variant -> 404; malformed id -> 400', ghost.status === 404 && badId.status === 400);
  const refused = await Promise.all([treasurer, volunteer, rohan].map((token) => api('PATCH', `/api/merch/variants/${soldOut.id}/restock`, { token, body: { add_quantity: 10 } })));
  const anon = await api('PATCH', `/api/merch/variants/${soldOut.id}/restock`, { body: { add_quantity: 10 } });
  check('Treasurer, Volunteer and Student -> 403; no token -> 401; stock untouched',
    refused.every((r) => r.status === 403) && anon.status === 401 && stockOf(soldOut.id) === before,
    `${refused.map((r) => r.status).join(',')},${anon.status}`);
  const numeric = await api('PATCH', `/api/merch/variants/${soldOut.id}/restock`, { token: admin, body: { add_quantity: '5' } });
  check('a numeric string from a form field ("5") is accepted', numeric.status === 200 && stockOf(soldOut.id) === before + 5);
  const burst = await Promise.all(Array.from({ length: 5 }, () => api('PATCH', `/api/merch/variants/${soldOut.id}/restock`, { token: admin, body: { add_quantity: 1 } })));
  check('5 simultaneous +1 restocks all land: stock rises by exactly 5 (increment in SQL, under the write lock)',
    burst.every((r) => r.status === 200) && stockOf(soldOut.id) === before + 10);

  // ------------------------------------------------------------ voucher data
  section('Payment voucher data');
  const claims = await api('GET', '/api/finance/reimbursements', { token: treasurer });
  const approved = claims.body.reimbursements.filter((r) => r.status === 'APPROVED_PAID');
  const pending = claims.body.reimbursements.filter((r) => r.status === 'PENDING');
  const ledgerRow = (id) => db.prepare('SELECT * FROM ledger_transactions WHERE id = ?').get(id);
  check('approved claims carry their ledger payout row (id, OUT, same receipt and volunteer) and paid_at; pending ones carry none',
    approved.length > 0 && approved.every((r) => {
      const l = ledgerRow(r.ledger_transaction_id);
      return l && l.type === 'OUT' && l.category === 'EXPENSE_REIMBURSEMENT' && l.reference_id === r.receipt_reference &&
        l.user_id === r.volunteer_id && l.amount === r.amount && r.paid_at === l.created_at && r.approved_by_name;
    }) && pending.every((r) => r.ledger_transaction_id === null && r.paid_at === null),
    approved.map((r) => `${r.receipt_reference} -> ledger #${r.ledger_transaction_id}`).join(', '));

  // ------------------------------------------------------------ passes (static)
  section('Digital passes, barcode and print stylesheet');
  const syntax = spawnSync(process.execPath, ['--check', path.join(PUBLIC_DIR, 'app.js')], { encoding: 'utf8' });
  check('node --check public/app.js -> no syntax errors', syntax.status === 0, syntax.stderr.trim());
  const app = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(PUBLIC_DIR, 'styles.css'), 'utf8');
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const parts = ['function passModal', 'function ticketPass', 'function memberPass', 'function voucherPass', 'View Digital Pass',
    'View Voucher', 'Spring Gala ', 'Official Member ID Pass', 'Official Treasurer Payment Voucher', 'VALID FOR ENTRY', 'CHECKED IN AT',
    'window.print()', '/api/merch/variants/', '/restock', 'Restock'];
  const missing = parts.filter((p) => !app.includes(p));
  check('app.js has the three passes, the print action and the admin restock control', missing.length === 0, missing.join(', '));
  const print = /@media print\s*{([\s\S]*?)\n}/.exec(css)?.[1] || '';
  check('styles.css has an @media print stylesheet that prints only the open pass',
    /body\.has-pass > :not\(#modal-root\)\s*{\s*display: none !important;/.test(print) && /\.no-print\s*{\s*display: none/.test(print) &&
      /print-color-adjust: exact/.test(print) && html.includes('<div id="modal-root"></div>'));
  const external = [];
  for (const file of fs.readdirSync(PUBLIC_DIR)) {
    const text = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
    for (const url of text.match(/https?:\/\/[^\s'")]+/g) || []) if (!url.startsWith('http://www.w3.org/2000/svg')) external.push(`${file}: ${url}`);
  }
  check('still fully offline: no external URL anywhere in public/ (the barcode needs no library)', external.length === 0, external.join(', '));

  const barcode = loadBarcodeModule();
  const table = barcode.CODE128_PATTERNS;
  const sums = table.slice(0, 106).every((p) => p.length === 6 && [...p].reduce((a, b) => a + Number(b), 0) === 11 && (Number(p[0]) + Number(p[2]) + Number(p[4])) % 2 === 0);
  check('Code 128 table: 106 symbols of 11 modules with even bar width, 107 unique patterns, 13-module stop, spec anchors match',
    table.length === 107 && sums && new Set(table).size === 107 && [...table[106]].reduce((a, b) => a + Number(b), 0) === 13 &&
      Object.entries(SPEC_ANCHORS).every(([value, pattern]) => table[value] === pattern));
  const samples = ['SKY-2026-001', 'TKT-GALA26-0001', 'TKT-E1-3QB4C2', 'ORD-2026-0002', 'RCPT-2026-0917', 'RCP-2026-884'];
  const decoded = samples.map((code) => {
    try {
      return decodeCode128(barcode.barcodeSvg(code), table);
    } catch (err) {
      return `ERR ${err.message}`;
    }
  });
  check('every code (SKY-, TKT-, ORD-, RCPT-) decodes back from its SVG with a valid mod-103 checksum and quiet zones',
    decoded.every((d, i) => d === samples[i]), decoded.join(' | '));
  check('the generator is deterministic and rejects characters Code 128-B cannot carry',
    barcode.barcodeSvg('SKY-2026-001') === barcode.barcodeSvg('SKY-2026-001') && (() => {
      try { barcode.code128Widths('TKTé'); return false; } catch { return true; }
    })());
}

async function main() {
  console.log(`Phase 7 verification (temp DB: ${DB_FILE})`);
  try {
    await run();
  } catch (err) {
    check('verification ran to completion', false, err.stack);
  } finally {
    if (server) {
      await stopServer(server.child);
      console.log(`\nTest server stopped (pid ${server.child.pid}); port 3000 was never used.`);
    }
    if (db) db.close();
    removeDb(DB_FILE);
  }
  summarize();
}

main();
