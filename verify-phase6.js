'use strict';

// Phase 6 self-verification: ledger CSV export, the live DB/index proof
// endpoint, and a security and edge-case sweep across every route. Runs the
// real server against a throwaway database on an ephemeral port.

const { check, section, summarize, tempDbPath, removeDb, startServer, stopServer } = require('./verify-helpers');

const DB_FILE = tempDbPath('verify6');
process.env.DB_PATH = DB_FILE; // must be set before ./db is required

const CSV_HEADER = 'id,created_at,type,category,signed_amount,reference_id,member_name,description';

let server = null;
let db = null;

// Minimal RFC 4180 parser: quoted fields, doubled quotes, CRLF records.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; } else if (c === '\r' && text[i + 1] === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function fetchRaw(route, token) {
  const res = await fetch(`http://127.0.0.1:${server.port}${route}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

async function run() {
  server = await startServer(DB_FILE);
  console.log(`Test server started (pid ${server.child.pid}, port ${server.port})`);
  ({ db } = require('./db'));
  const { api } = server;
  const login = async (email) => (await api('POST', '/api/auth/login', { body: { email, password: 'skyline123' } })).body.token;
  const admin = await login('vikram@skyline.edu');
  const volunteer = await login('neha@skyline.edu');
  const student = await login('kabir@skyline.edu');

  // ------------------------------------------------------------ CSV export
  section('Ledger CSV export');
  // Text that a spreadsheet would run as a formula, plus a comma and quotes.
  const hostile = await api('POST', '/api/finance/fundraiser-income', {
    token: admin,
    body: { amount: 123, description: '=HYPERLINK("http://x","click"), "quoted", total', reference_id: '+CMD-1' },
  });
  check('fixture: fundraiser income with formula-like text recorded', hostile.status === 201);

  const csv = await fetchRaw('/api/finance/ledger/export.csv', admin);
  check('GET /api/finance/ledger/export.csv (admin) -> 200 text/csv attachment',
    csv.status === 200 && /^text\/csv; charset=utf-8/i.test(csv.headers.get('content-type') || '') &&
      csv.headers.get('content-disposition') === 'attachment; filename="skyline-semester-ledger.csv"',
    `${csv.status} ${csv.headers.get('content-type')} · ${csv.headers.get('content-disposition')}`);

  const body = csv.text.replace(/^﻿/, '');
  const rows = parseCsv(body);
  const raw = db.prepare(`
    SELECT COUNT(*) AS n,
           COALESCE(SUM(CASE WHEN type = 'IN' THEN amount ELSE 0 END), 0) AS total_in,
           COALESCE(SUM(CASE WHEN type = 'OUT' THEN amount ELSE 0 END), 0) AS total_out
    FROM ledger_transactions`).get();
  const dataRows = rows.slice(1, -3);
  const footer = Object.fromEntries(rows.slice(-3).map((r) => [r[0], Number(r[4])]));
  check('header row, CRLF records, every row has exactly 8 fields',
    body.split('\r\n')[0] === CSV_HEADER && body.endsWith('\r\n') && rows.every((r) => r.length === 8),
    `${rows.length} records`);
  check('one CSV row per ledger row, signed amounts sum to the net balance',
    dataRows.length === raw.n && dataRows.reduce((s, r) => s + Number(r[4]), 0) === raw.total_in - raw.total_out,
    `${dataRows.length} rows · Σ signed = ${dataRows.reduce((s, r) => s + Number(r[4]), 0)}`);
  check('footer TOTAL_IN / TOTAL_OUT / NET_BALANCE match the database',
    footer.TOTAL_IN === raw.total_in && footer.TOTAL_OUT === -raw.total_out && footer.NET_BALANCE === raw.total_in - raw.total_out,
    JSON.stringify(footer));
  const injected = dataRows.find((r) => r[5].includes('CMD-1'));
  check("formula injection neutralised: '=…' and '+…' cells are prefixed with '",
    injected && injected[7].startsWith("'=HYPERLINK") && injected[5] === "'+CMD-1",
    injected ? `description=${injected[7].slice(0, 24)}… reference=${injected[5]}` : 'row missing');
  check('commas and quotes survive a round trip through RFC 4180 quoting',
    injected && injected[7] === `'=HYPERLINK("http://x","click"), "quoted", total`);
  const outRow = dataRows.find((r) => r[2] === 'OUT');
  check('OUT rows export as negative numbers (not text-prefixed)', outRow && Number(outRow[4]) < 0 && !outRow[4].startsWith("'"), outRow?.[4]);

  const csvVolunteer = await fetchRaw('/api/finance/ledger/export.csv', volunteer);
  const csvStudent = await fetchRaw('/api/finance/ledger/export.csv', student);
  const csvAnon = await fetchRaw('/api/finance/ledger/export.csv');
  check('volunteer -> 200; student -> 403; no token -> 401',
    csvVolunteer.status === 200 && csvStudent.status === 403 && csvAnon.status === 401,
    `${csvVolunteer.status}/${csvStudent.status}/${csvAnon.status}`);

  // ------------------------------------------------------------ System proof
  section('Live DB & index proof');
  const proof = await api('GET', '/api/system/proof', { token: volunteer });
  const p = proof.body;
  check('GET /api/system/proof -> 200 with foreign_keys = 1 and WAL',
    proof.status === 200 && p.pragmas.foreign_keys === 1 && p.pragmas.journal_mode === 'wal');
  check('all 5 key lookups use an index and none is a full table SCAN',
    p.query_plans.length === 5 && p.query_plans.every((q) => /USING (COVERING )?INDEX/.test(q.plan) && !/\bSCAN\b/.test(q.plan)) &&
      p.all_queries_use_index === true,
    p.query_plans.map((q) => q.plan).join(' | '));
  const liveCounts = Object.fromEntries(Object.keys(p.table_counts).map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]));
  check('table_counts covers all 10 tables and matches the database',
    Object.keys(p.table_counts).length === 10 && Object.entries(p.table_counts).every(([t, n]) => liveCounts[t] === n));
  check('ledger_integrity: total_in - total_out === net_balance',
    p.ledger_integrity.balanced === true && p.ledger_integrity.total_in - p.ledger_integrity.total_out === p.ledger_integrity.net_balance &&
      p.ledger_integrity.total_in === raw.total_in);
  const proofStudent = await api('GET', '/api/system/proof', { token: student });
  const proofAnon = await api('GET', '/api/system/proof');
  check('student -> 403; no token -> 401', proofStudent.status === 403 && proofAnon.status === 401);

  // ------------------------------------------------------------ Security sweep
  section('Security & edge-case sweep');
  const usersBefore = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const hostileQueries = ['%', '_', "' OR 1=1 --", "'; DROP TABLE users; --", '%%%', '\\'];
  const searchResults = [];
  for (const q of hostileQueries) {
    const enc = encodeURIComponent(q);
    const lookup = await api('GET', `/api/memberships/lookup?q=${enc}`, { token: volunteer });
    const anns = await api('GET', `/api/announcements?q=${enc}`, { token: admin });
    const orders = await api('GET', `/api/merch/orders?q=${enc}`, { token: volunteer });
    const roster = await api('GET', `/api/events/1/tickets?q=${enc}`, { token: volunteer });
    searchResults.push({ q, statuses: [lookup.status, anns.status, orders.status, roster.status], counts: [lookup.body.count, anns.body.count, orders.body.count, roster.body.count] });
  }
  check('LIKE wildcards and SQL-injection strings are searched literally (200, zero matches)',
    searchResults.every((r) => r.statuses.every((s) => s === 200) && r.counts.every((c) => c === 0)),
    searchResults.map((r) => `${JSON.stringify(r.q)}→${r.counts.join('/')}`).join('  '));
  const usersAfter = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const usersTable = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'users'").get().n;
  check('injection attempts changed nothing (users table intact)', usersAfter === usersBefore && usersTable === 1);

  const longQ = await api('GET', `/api/memberships/lookup?q=${'a'.repeat(101)}`, { token: volunteer });
  const arrayQ = await api('GET', '/api/memberships/lookup?q=a&q=b', { token: volunteer });
  check('over-long or repeated search params -> 400', longQ.status === 400 && arrayQ.status === 400);

  const big = await api('POST', '/api/auth/login', { rawBody: JSON.stringify({ email: 'x@y.z', password: 'p'.repeat(150 * 1024) }) });
  const broken = await api('POST', '/api/auth/login', { rawBody: '{"email":' });
  check('oversized JSON body (>100kb) -> 413; malformed JSON -> 400', big.status === 413 && broken.status === 400, `${big.status}/${broken.status}`);

  const malformed = await Promise.all([
    api('POST', '/api/events/abc/tickets', { token: student }),
    api('POST', '/api/events/0/tickets', { token: student }),
    api('POST', '/api/events/1.5/tickets', { token: student }),
    api('GET', '/api/events/-1/tickets', { token: volunteer }),
    api('PATCH', '/api/tasks/abc/status', { token: volunteer, body: { status: 'DONE' } }),
    api('PATCH', '/api/finance/reimbursements/1e3/review', { token: admin, body: { decision: 'REJECTED' } }),
    api('POST', `/api/tickets/${encodeURIComponent("'; --")}/check-in`, { token: volunteer }),
    api('PATCH', `/api/merch/orders/${encodeURIComponent('<script>')}/pickup`, { token: volunteer }),
    api('POST', '/api/merch/orders', { token: student, body: { variant_id: 'DROP TABLE', quantity: 1 } }),
  ]);
  check('malformed ids and codes -> 400 before touching the database', malformed.every((r) => r.status === 400),
    malformed.map((r) => r.status).join(','));

  const protectedRoutes = [
    ['GET', '/api/auth/me'], ['POST', '/api/memberships/join-or-renew'], ['GET', '/api/memberships/lookup'],
    ['POST', '/api/events'], ['POST', '/api/events/1/tickets'], ['GET', '/api/events/1/tickets'],
    ['POST', '/api/tickets/TKT-E1-AAAAAA/check-in'], ['POST', '/api/announcements'], ['POST', '/api/merch/orders'],
    ['GET', '/api/merch/orders'], ['PATCH', '/api/merch/orders/ORD-M1-AAAAAA/pickup'], ['GET', '/api/tasks'],
    ['POST', '/api/tasks'], ['PATCH', '/api/tasks/1/status'], ['GET', '/api/tasks/assignees'],
    ['GET', '/api/finance/reimbursements'], ['POST', '/api/finance/reimbursements'],
    ['PATCH', '/api/finance/reimbursements/1/review'], ['GET', '/api/finance/ledger'],
    ['GET', '/api/finance/ledger/export.csv'], ['POST', '/api/finance/fundraiser-income'], ['GET', '/api/system/proof'],
  ];
  const noAuth = await Promise.all(protectedRoutes.map(([m, r]) => api(m, r, { body: m === 'GET' ? undefined : {} })));
  check(`missing token -> 401 on all ${protectedRoutes.length} protected routes`, noAuth.every((r) => r.status === 401),
    protectedRoutes.filter((_, i) => noAuth[i].status !== 401).map(([m, r], i) => `${m} ${r}`).join(', ') || 'all 401');

  const forged = `${student.split('.')[0].slice(0, -2)}xx.${student.split('.')[1]}`;
  const tampered = await Promise.all([
    api('GET', '/api/auth/me', { token: forged }),
    api('GET', '/api/events', { token: forged }),
    api('GET', '/api/finance/ledger', { token: `${admin}x` }),
  ]);
  check('tampered tokens -> 401, even on public endpoints', tampered.every((r) => r.status === 401), tampered.map((r) => r.status).join(','));

  const studentForbidden = [
    ['POST', '/api/events', {}], ['POST', '/api/announcements', {}], ['GET', '/api/memberships/lookup'],
    ['PATCH', '/api/merch/orders/ORD-2026-0002/pickup'], ['POST', '/api/tasks', { title: 'x' }], ['GET', '/api/tasks/assignees'],
    ['POST', '/api/finance/reimbursements', {}], ['PATCH', '/api/finance/reimbursements/1/review', { decision: 'REJECTED' }],
    ['GET', '/api/finance/ledger'], ['GET', '/api/finance/ledger/export.csv'], ['POST', '/api/finance/fundraiser-income', {}],
    ['GET', '/api/system/proof'], ['POST', '/api/tickets/TKT-GALA26-0001/check-in'],
  ];
  const asStudent = await Promise.all(studentForbidden.map(([m, r, b]) => api(m, r, { token: student, body: b })));
  check(`student role -> 403 on all ${studentForbidden.length} staff/admin routes`, asStudent.every((r) => r.status === 403),
    studentForbidden.filter((_, i) => asStudent[i].status !== 403).map(([m, r]) => `${m} ${r}`).join(', ') || 'all 403');

  const volunteerForbidden = [
    ['POST', '/api/events', {}], ['PATCH', '/api/finance/reimbursements/1/review', { decision: 'REJECTED' }],
    ['POST', '/api/finance/fundraiser-income', {}],
  ];
  const asVolunteer = await Promise.all(volunteerForbidden.map(([m, r, b]) => api(m, r, { token: volunteer, body: b })));
  check('volunteer role -> 403 on admin-only routes', asVolunteer.every((r) => r.status === 403), asVolunteer.map((r) => r.status).join(','));

  const unknown = await api('GET', '/api/does/not/exist', { token: admin });
  check('unknown API path -> JSON 404', unknown.status === 404 && unknown.body?.error === 'Not found');
}

async function main() {
  console.log(`Phase 6 verification (temp DB: ${DB_FILE})`);
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
