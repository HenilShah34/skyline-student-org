'use strict';

// Phase 6 self-verification: ledger CSV export, the live DB/index proof,
// role separation, the Founding Admin hierarchy, the task workflow, the
// semester-at-a-glance numbers, and a security and edge-case sweep. Runs the
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
  const treasurer = await login('meera@skyline.edu');
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

  const csvTreasurer = await fetchRaw('/api/finance/ledger/export.csv', treasurer);
  const csvVolunteer = await fetchRaw('/api/finance/ledger/export.csv', volunteer);
  const csvStudent = await fetchRaw('/api/finance/ledger/export.csv', student);
  const csvAnon = await fetchRaw('/api/finance/ledger/export.csv');
  check('treasurer -> 200; volunteer -> 403; student -> 403; no token -> 401',
    csvTreasurer.status === 200 && csvVolunteer.status === 403 && csvStudent.status === 403 && csvAnon.status === 401,
    `${csvTreasurer.status}/${csvVolunteer.status}/${csvStudent.status}/${csvAnon.status}`);

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
    ['DELETE', '/api/tasks/1'], ['GET', '/api/users'], ['PATCH', '/api/users/2/role'],
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
    ['GET', '/api/finance/ledger/export.csv'], ['POST', '/api/finance/fundraiser-income', {}],
    ['GET', '/api/system/proof'], ['POST', '/api/tickets/TKT-GALA26-0001/check-in'], ['DELETE', '/api/tasks/1'],
    ['GET', '/api/users'], ['PATCH', '/api/users/3/role', { role: 'STUDENT' }],
  ];
  const asStudent = await Promise.all(studentForbidden.map(([m, r, b]) => api(m, r, { token: student, body: b })));
  check(`student role -> 403 on all ${studentForbidden.length} staff/admin routes`, asStudent.every((r) => r.status === 403),
    studentForbidden.filter((_, i) => asStudent[i].status !== 403).map(([m, r]) => `${m} ${r}`).join(', ') || 'all 403');

  const volunteerForbidden = [
    ['POST', '/api/events', {}], ['PATCH', '/api/finance/reimbursements/1/review', { decision: 'REJECTED' }],
    ['POST', '/api/finance/fundraiser-income', {}], ['GET', '/api/finance/ledger/export.csv'], ['DELETE', '/api/tasks/1'],
    ['GET', '/api/users'], ['PATCH', '/api/users/4/role', { role: 'VOLUNTEER' }],
  ];
  const asVolunteer = await Promise.all(volunteerForbidden.map(([m, r, b]) => api(m, r, { token: volunteer, body: b })));
  check('volunteer role -> 403 on admin-only routes', asVolunteer.every((r) => r.status === 403), asVolunteer.map((r) => r.status).join(','));

  // ------------------------------------------------------------ Roles
  section('Role separation: ADMIN · TREASURER · VOLUNTEER · STUDENT');
  const me = await api('GET', '/api/auth/me', { token: treasurer });
  check('Meera is seeded as TREASURER with an active membership (SKY-2026-002)',
    me.body.user.role === 'TREASURER' && me.body.user.membership.code === 'SKY-2026-002' && me.body.user.membership.status === 'ACTIVE');
  const treasurerReads = await Promise.all([
    api('GET', '/api/memberships/lookup?q=rohan', { token: treasurer }),
    api('GET', '/api/tasks', { token: treasurer }),
    api('GET', '/api/finance/ledger', { token: treasurer }),
    api('GET', '/api/announcements', { token: treasurer }),
    api('GET', '/api/system/proof', { token: treasurer }),
  ]);
  check('treasurer has staff read access: lookup, tasks, ledger, proof, and members-only announcements',
    treasurerReads.every((r) => r.status === 200) && treasurerReads[3].body.viewer.can_view_members_only === true &&
      treasurerReads[3].body.hidden_members_only_count === 0);
  const treasurerEvent = await api('POST', '/api/events', {
    token: treasurer,
    body: { title: 'Treasurer Mixer', event_date: new Date(Date.now() + 864e5 * 9).toISOString(), location: 'Hall', total_seats: 10, member_price: 0, guest_price: 0 },
  });
  check('creating events is ADMIN only: treasurer -> 403', treasurerEvent.status === 403, treasurerEvent.body?.reason);
  const income = await api('POST', '/api/finance/fundraiser-income', { token: treasurer, body: { amount: 50, description: 'Raffle', reference_id: 'RAFFLE-1' } });
  const incomeAdmin = await api('POST', '/api/finance/fundraiser-income', { token: admin, body: { amount: 50, description: 'Raffle 2', reference_id: 'RAFFLE-2' } });
  check('fundraiser income: treasurer -> 201 and admin -> 201', income.status === 201 && incomeAdmin.status === 201);
  const claim = await api('POST', '/api/finance/reimbursements', {
    token: volunteer,
    body: { title: 'Napkins', category: 'FUNDRAISER_SUPPLIES', amount: 90, receipt_reference: 'NAP-1' },
  });
  const volunteerReview = await api('PATCH', `/api/finance/reimbursements/${claim.body.reimbursement.id}/review`, { token: volunteer, body: { decision: 'REJECTED' } });
  const treasurerReview = await api('PATCH', `/api/finance/reimbursements/${claim.body.reimbursement.id}/review`, { token: treasurer, body: { decision: 'REJECTED' } });
  check('reviewing claims: volunteer -> 403 (requires TREASURER or ADMIN); treasurer -> 200',
    volunteerReview.status === 403 && volunteerReview.body.reason === 'requires role: TREASURER or ADMIN' && treasurerReview.status === 200);

  // ------------------------------------------------------------ Auth recovery + profile
  section('Account recovery & profile');
  const byCode = await api('POST', '/api/auth/forgot-email', { body: { query: 'sky-2026-004' } });
  const byName = await api('POST', '/api/auth/forgot-email', { body: { query: '  ROHAN verma ' } });
  check('forgot-email finds Rohan by membership code or full name (any case)',
    byCode.status === 200 && byCode.body.account.email === 'rohan@skyline.edu' && byCode.body.account.membership_code === 'SKY-2026-004' &&
      byName.status === 200 && byName.body.account.email === 'rohan@skyline.edu' && /^ro•+@skyline\.edu$/.test(byName.body.account.masked_email),
    `${byCode.body?.account?.email} · ${byName.body?.account?.masked_email}`);
  const noMatch = await api('POST', '/api/auth/forgot-email', { body: { query: 'Nobody Here' } });
  const emptyQuery = await api('POST', '/api/auth/forgot-email', { body: { query: '   ' } });
  check('forgot-email: unknown -> 404; empty -> 400', noMatch.status === 404 && emptyQuery.status === 400);

  const wrongProof = await api('POST', '/api/auth/forgot-password', { body: { email: 'rohan@skyline.edu', verification: 'SKY-2026-001', new_password: 'newpass1' } });
  const unknownEmail = await api('POST', '/api/auth/forgot-password', { body: { email: 'ghost@skyline.edu', verification: 'Ghost', new_password: 'newpass1' } });
  const badReset = await api('POST', '/api/auth/forgot-password', { body: { email: 'not-an-email', verification: '', new_password: '123' } });
  check('forgot-password: wrong verification and unknown email -> same 401; invalid input -> 400 with 3 field errors',
    wrongProof.status === 401 && unknownEmail.status === 401 && wrongProof.body.error === unknownEmail.body.error &&
      badReset.status === 400 && ['email', 'verification', 'new_password'].every((f) => f in badReset.body.details));
  const reset = await api('POST', '/api/auth/forgot-password', { body: { email: 'ROHAN@skyline.edu', verification: 'sky-2026-004', new_password: 'gala-2026' } });
  const oldLogin = await api('POST', '/api/auth/login', { body: { email: 'rohan@skyline.edu', password: 'skyline123' } });
  const newLogin = await api('POST', '/api/auth/login', { body: { email: 'rohan@skyline.edu', password: 'gala-2026' } });
  const stored = db.prepare('SELECT password_hash FROM users WHERE email = ?').get('rohan@skyline.edu').password_hash;
  check('forgot-password with the membership code -> 200 + token; old password now 401, new password 200',
    reset.status === 200 && typeof reset.body.token === 'string' && reset.body.user.email === 'rohan@skyline.edu' &&
      oldLogin.status === 401 && newLogin.status === 200 && /^[0-9a-f]{32}:[0-9a-f]{128}$/.test(stored));
  const resetByName = await api('POST', '/api/auth/forgot-password', { body: { email: 'kabir@skyline.edu', verification: 'kabir singh', new_password: 'kabir-pass' } });
  check('forgot-password also verifies by full name (case-insensitive)', resetByName.status === 200);

  const rohan = newLogin.body.token;
  const rename = await api('PATCH', '/api/auth/profile', { token: rohan, body: { name: 'Rohan K. Verma' } });
  const wrongCurrent = await api('PATCH', '/api/auth/profile', { token: rohan, body: { current_password: 'nope', new_password: 'another-1' } });
  const changePw = await api('PATCH', '/api/auth/profile', { token: rohan, body: { current_password: 'gala-2026', new_password: 'another-1' } });
  const afterChange = await api('POST', '/api/auth/login', { body: { email: 'rohan@skyline.edu', password: 'another-1' } });
  check('profile: rename -> 200; wrong current password -> 403; correct one -> 200 and the new password works',
    rename.status === 200 && rename.body.user.name === 'Rohan K. Verma' && wrongCurrent.status === 403 &&
      changePw.status === 200 && afterChange.status === 200,
    `${rename.status}/${wrongCurrent.status}/${changePw.status}/${afterChange.status}`);
  const emptyPatch = await api('PATCH', '/api/auth/profile', { token: rohan, body: {} });
  const shortName = await api('PATCH', '/api/auth/profile', { token: rohan, body: { name: 'R' } });
  const anonPatch = await api('PATCH', '/api/auth/profile', { body: { name: 'Hacker' } });
  check('profile: empty or invalid -> 400; no token -> 401', emptyPatch.status === 400 && shortName.status === 400 && anonPatch.status === 401);

  // ------------------------------------------------------------ Semester at a glance
  section('Semester money at a glance (any signed-in member)');
  const glance = await api('GET', '/api/finance/ledger', { token: student });
  const story = glance.body?.semester_story;
  const pendingDb = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount FROM expense_reimbursements WHERE status = 'PENDING'").get();
  const sumIn = story && story.dues_collected.amount + story.tickets_sold.amount + story.merch_sold.amount + story.fundraiser_income.amount;
  check('a student reads the ledger -> 200 with semester_story: the four income lines add up to what came in',
    glance.status === 200 && sumIn === story.came_in && story.came_in === glance.body.summary.total_in &&
      story.expenses_reimbursed.amount === story.went_out && story.came_in - story.went_out === story.left,
    story && `in ${story.came_in} − out ${story.went_out} = left ${story.left}`);
  const countOf = (c) => db.prepare('SELECT COUNT(*) AS n FROM ledger_transactions WHERE category = ?').get(c).n;
  check('semester_story counts match the ledger rows, with pending claims reported separately',
    story.dues_collected.count === countOf('MEMBERSHIP_DUES') && story.tickets_sold.count === countOf('TICKET_SALE') &&
      story.merch_sold.count === countOf('MERCH_SALE') && story.expenses_reimbursed.count === countOf('EXPENSE_REIMBURSEMENT') &&
      story.expenses_reimbursed.pending_count === pendingDb.n && story.expenses_reimbursed.pending_amount === pendingDb.amount,
    JSON.stringify(story.expenses_reimbursed));
  const combo = await api('GET', '/api/finance/ledger?category=merch_sale,FUNDRAISER_INCOME', { token: student });
  const badCombo = await api('GET', '/api/finance/ledger?category=MERCH_SALE,PIZZA', { token: student });
  check('?category= takes a comma list (merch + fundraisers); an unknown category in the list -> 400',
    combo.status === 200 && combo.body.count === countOf('MERCH_SALE') + countOf('FUNDRAISER_INCOME') &&
      combo.body.transactions.every((t) => ['MERCH_SALE', 'FUNDRAISER_INCOME'].includes(t.category)) &&
      combo.body.filters.category === 'MERCH_SALE,FUNDRAISER_INCOME' && badCombo.status === 400);
  const studentWrites = await Promise.all([
    fetchRaw('/api/finance/ledger/export.csv', student).then((r) => r.status),
    api('POST', '/api/finance/fundraiser-income', { token: student, body: { amount: 5, description: 'x' } }).then((r) => r.status),
  ]);
  check('reading is open, but export and income stay Treasurer/Admin: student -> 403', studentWrites.every((s) => s === 403));

  // ------------------------------------------------------------ Task workflow
  section('Bake-sale tasks: moves in every direction, unassigned guard, admin delete');
  const users = Object.fromEntries(db.prepare('SELECT id, email FROM users').all().map((u) => [u.email.split('@')[0], u.id]));
  const move = (id, body, token = volunteer) => api('PATCH', `/api/tasks/${id}/status`, { token, body });
  const openTask = db.prepare("SELECT id FROM fundraiser_tasks WHERE assigned_to IS NULL AND status = 'TODO' ORDER BY id LIMIT 1").get();
  const startUnassigned = await move(openTask.id, { status: 'IN_PROGRESS' });
  const finishUnassigned = await move(openTask.id, { status: 'DONE' });
  check('starting or finishing an unassigned task -> 409 with a clear message; it stays in To do',
    startUnassigned.status === 409 && finishUnassigned.status === 409 &&
      startUnassigned.body.error === 'Please assign a volunteer or member to this task before starting or completing it' &&
      db.prepare('SELECT status FROM fundraiser_tasks WHERE id = ?').get(openTask.id).status === 'TODO',
    startUnassigned.body?.error);
  const assignOnly = await move(openTask.id, { assigned_to: users.neha });
  const started = await move(openTask.id, { status: 'IN_PROGRESS' });
  check('inline assign (assigned_to only, no status) -> 200 still To do; then Start -> 200 In progress',
    assignOnly.status === 200 && assignOnly.body.task.status === 'TODO' && assignOnly.body.task.assignee_name === 'Neha Sharma' &&
      started.status === 200 && started.body.task.status === 'IN_PROGRESS');
  const back = await move(openTask.id, { status: 'TODO' });
  check('IN_PROGRESS -> TODO (move back to To do) -> 200', back.status === 200 && back.body.task.status === 'TODO');
  const path = [];
  for (const status of ['IN_PROGRESS', 'DONE', 'IN_PROGRESS', 'TODO']) {
    const r = await move(openTask.id, { status });
    path.push(`${r.status}:${r.body?.task?.status}`);
  }
  check('TODO -> IN_PROGRESS -> DONE -> IN_PROGRESS -> TODO: every step 200', path.join(' ') === '200:IN_PROGRESS 200:DONE 200:IN_PROGRESS 200:TODO', path.join(' '));
  const reassignAndStart = await move(openTask.id, { assigned_to: users.rohan, status: 'IN_PROGRESS' });
  const unassignInProgress = await move(openTask.id, { assigned_to: null });
  const unassignToTodo = await move(openTask.id, { assigned_to: null, status: 'TODO' });
  const emptyMove = await move(openTask.id, {});
  check('reassign + start together -> 200; unassigning an in-progress task -> 409; unassign + back to To do -> 200; empty body -> 400',
    reassignAndStart.status === 200 && reassignAndStart.body.task.assignee_name === 'Rohan K. Verma' &&
      unassignInProgress.status === 409 && unassignToTodo.status === 200 && unassignToTodo.body.task.assigned_to === null &&
      emptyMove.status === 400,
    `${reassignAndStart.status}/${unassignInProgress.status}/${unassignToTodo.status}/${emptyMove.status}`);

  const doomed = db.prepare('SELECT id, campaign_name FROM fundraiser_tasks ORDER BY id DESC LIMIT 1').get();
  const tasksBefore = db.prepare('SELECT COUNT(*) AS n FROM fundraiser_tasks WHERE campaign_name = ?').get(doomed.campaign_name).n;
  const nonAdminDeletes = await Promise.all([volunteer, treasurer, student].map((token) => api('DELETE', `/api/tasks/${doomed.id}`, { token })));
  check('DELETE /api/tasks/:id by volunteer, treasurer or student -> 403; the task is untouched',
    nonAdminDeletes.every((r) => r.status === 403) && db.prepare('SELECT 1 FROM fundraiser_tasks WHERE id = ?').get(doomed.id) !== undefined,
    nonAdminDeletes.map((r) => r.status).join(','));
  const removed = await api('DELETE', `/api/tasks/${doomed.id}`, { token: admin });
  const removedAgain = await api('DELETE', `/api/tasks/${doomed.id}`, { token: admin });
  const removedBadId = await api('DELETE', '/api/tasks/abc', { token: admin });
  check('admin delete -> 200 with the updated campaigns_summary; again -> 404; bad id -> 400',
    removed.status === 200 && removed.body.deleted.id === doomed.id &&
      removed.body.campaigns_summary[doomed.campaign_name].total_tasks === tasksBefore - 1 &&
      !db.prepare('SELECT 1 FROM fundraiser_tasks WHERE id = ?').get(doomed.id) &&
      removedAgain.status === 404 && removedBadId.status === 400,
    `${removed.status}/${removedAgain.status}/${removedBadId.status}`);

  // ------------------------------------------------------------ Access control
  section('Club access & roles: Founding Admin hierarchy');
  const roster = await api('GET', '/api/users', { token: admin });
  const nonAdminRoster = await Promise.all([treasurer, volunteer, student].map((token) => api('GET', '/api/users', { token })));
  check('GET /api/users: admin -> 200 with role, live membership and is_founding_admin only on user 1; others -> 403',
    roster.status === 200 && roster.body.users.length === db.prepare('SELECT COUNT(*) AS n FROM users').get().n &&
      roster.body.users.filter((u) => u.is_founding_admin).map((u) => u.id).join() === '1' &&
      roster.body.users.every((u) => u.role && u.membership_status && !('password_hash' in u)) &&
      nonAdminRoster.every((r) => r.status === 403),
    nonAdminRoster.map((r) => r.status).join(','));
  const setRole = (id, role, token) => api('PATCH', `/api/users/${id}/role`, { token, body: { role } });
  const promoteMeera = await setRole(users.meera, 'ADMIN', admin);
  check('Founding Admin promotes Meera (Treasurer) to a second ADMIN -> 200',
    promoteMeera.status === 200 && promoteMeera.body.user.role === 'ADMIN' && promoteMeera.body.previous_role === 'TREASURER');
  const meeraRoster = await api('GET', '/api/users', { token: treasurer });
  check("the role is read live: Meera's existing token now opens the admin-only roster", meeraRoster.status === 200);

  const kabirUp = await setRole(users.kabir, 'volunteer', treasurer);
  const kabirStaffRead = await api('GET', '/api/tasks/assignees', { token: student });
  check('second Admin promotes student Kabir to VOLUNTEER -> 200, and his old token gets staff access at once',
    kabirUp.status === 200 && kabirUp.body.user.role === 'VOLUNTEER' && kabirStaffRead.status === 200);
  const secondToAdmin = await setRole(users.rohan, 'ADMIN', treasurer);
  check('second Admin trying to grant ADMIN -> 403 (only the Founding Admin can)',
    secondToAdmin.status === 403 && secondToAdmin.body.reason ===
      'Only the Founding Admin can grant or modify Admin access. You may assign Student, Volunteer, or Treasurer roles.' &&
      db.prepare('SELECT role FROM users WHERE id = ?').get(users.rohan).role === 'STUDENT');
  const promoteNeha = await setRole(users.neha, 'ADMIN', admin);
  const secondEditsAdmin = await setRole(users.neha, 'STUDENT', treasurer);
  const secondEditsFounder = await setRole(1, 'STUDENT', treasurer);
  const secondEditsSelf = await setRole(users.meera, 'TREASURER', treasurer);
  const founderEditsSelf = await setRole(1, 'STUDENT', admin);
  check("second Admin can't change another Admin, the Founding Admin, or themselves -> 403 each; nor can the founder change their own role",
    promoteNeha.status === 200 && secondEditsAdmin.status === 403 && /Only the Founding Admin/.test(secondEditsAdmin.body.reason) &&
      secondEditsFounder.status === 403 && secondEditsFounder.body.reason === "The Founding Admin's role cannot be modified" &&
      secondEditsSelf.status === 403 && secondEditsSelf.body.reason === 'You cannot change your own role' &&
      founderEditsSelf.status === 403 && db.prepare('SELECT role FROM users WHERE id = 1').get().role === 'ADMIN',
    `${secondEditsAdmin.status}/${secondEditsFounder.status}/${secondEditsSelf.status}/${founderEditsSelf.status}`);
  const badRole = await setRole(users.rohan, 'KING', admin);
  const ghostUser = await setRole(99999, 'STUDENT', admin);
  const badUserId = await setRole('abc', 'STUDENT', admin);
  check('invalid role or id -> 400; unknown user -> 404', badRole.status === 400 && badUserId.status === 400 && ghostUser.status === 404);
  const kabirDown = await setRole(users.kabir, 'STUDENT', treasurer);
  const kabirAfter = await api('GET', '/api/tasks/assignees', { token: student });
  const nehaDown = await setRole(users.neha, 'VOLUNTEER', admin);
  check('a demotion also applies at once: Kabir back to STUDENT -> his token is refused (403); founder returns Neha to VOLUNTEER',
    kabirDown.status === 200 && kabirAfter.status === 403 && nehaDown.status === 200 && nehaDown.body.user.role === 'VOLUNTEER');

  // ------------------------------------------------------------ Migration
  section('Schema migration: adding TREASURER to an existing users table');
  const { connect, applySchema } = require('./db');
  const fixtureFile = `${DB_FILE}-roles`;
  const fixture = connect(fixtureFile);
  try {
    fixture.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('STUDENT', 'VOLUNTEER', 'ADMIN')),
        membership_code TEXT UNIQUE, membership_status TEXT NOT NULL DEFAULT 'NONE' CHECK (membership_status IN ('NONE', 'ACTIVE', 'EXPIRED')),
        membership_expires_at TEXT, created_at TEXT NOT NULL);
      CREATE TABLE announcements (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, content TEXT NOT NULL,
        category TEXT NOT NULL, target_audience TEXT NOT NULL DEFAULT 'ALL', author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL);
      INSERT INTO users (name, email, password_hash, role, created_at) VALUES ('Old Admin', 'old@x.edu', 'a:b', 'ADMIN', 'x');
      INSERT INTO announcements (title, content, category, author_id, created_at) VALUES ('Hi', 'Hello', 'GENERAL', 1, 'x');`);
    let before = null;
    try {
      fixture.prepare("INSERT INTO users (name, email, password_hash, role, created_at) VALUES ('T', 't@x.edu', 'a:b', 'TREASURER', 'x')").run();
    } catch (err) {
      before = err.message;
    }
    applySchema(fixture);
    fixture.prepare("INSERT INTO users (name, email, password_hash, role, created_at) VALUES ('T', 't@x.edu', 'a:b', 'TREASURER', 'x')").run();
    const kept = fixture.prepare('SELECT COUNT(*) AS n FROM announcements WHERE author_id = 1').get().n;
    const fk = fixture.prepare('PRAGMA foreign_keys').get().foreign_keys;
    let bad = null;
    try {
      fixture.prepare("INSERT INTO users (name, email, password_hash, role, created_at) VALUES ('K', 'k@x.edu', 'a:b', 'KING', 'x')").run();
    } catch (err) {
      bad = err.message;
    }
    check('old table rejected TREASURER; after startup migration it is accepted, rows and foreign keys intact',
      /CHECK constraint failed/.test(before || '') && kept === 1 && fk === 1 && /CHECK constraint failed/.test(bad || '') &&
        fixture.prepare('PRAGMA foreign_key_check').all().length === 0);
  } finally {
    fixture.close();
    removeDb(fixtureFile);
  }

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
