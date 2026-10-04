'use strict';

// Phase 8 self-verification: event editing, admins don't buy, the task
// request workflow and task permissions, scoped admin access, the 5-category
// merch catalogue with products, low-stock data and P&L analytics, and the
// full 105-user seed profile. Runs the real server against throwaway databases.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { check, section, summarize, tempDbPath, removeDb, startServer, stopServer } = require('./verify-helpers');

const DB_FILE = tempDbPath('verify8');
const FULL_DB = tempDbPath('verify8-full');
process.env.DB_PATH = DB_FILE; // must be set before ./db is required

let server = null;
let db = null;

async function run() {
  server = await startServer(DB_FILE);
  console.log(`Test server started (pid ${server.child.pid}, port ${server.port})`);
  ({ db } = require('./db'));
  const { api } = server;
  const login = async (email) => (await api('POST', '/api/auth/login', { body: { email, password: 'skyline123' } })).body.token;
  const admin = await login('vikram@skyline.edu');
  const treasurer = await login('meera@skyline.edu');
  const volunteer = await login('neha@skyline.edu');
  const member = await login('rohan@skyline.edu');
  const nonMember = await login('kabir@skyline.edu');
  const id = (email) => db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;

  // ------------------------------------------------------------ events
  section('Event editing (Admin) and admins do not buy');
  const gala = db.prepare("SELECT * FROM events WHERE title LIKE 'Spring Annual Gala%'").get();
  const sold = gala.total_seats - gala.seats_left;
  const edit = await api('PATCH', `/api/events/${gala.id}`, { token: admin, body: { title: 'Spring Annual Gala 2026 — Grand Finale', total_seats: 120, guest_price: 550 } });
  check('admin edits title, capacity and guest price -> 200; sold seats stay sold (seats_left = new total − sold)',
    edit.status === 200 && edit.body.event.title.endsWith('Grand Finale') && edit.body.event.total_seats === 120 &&
      edit.body.event.seats_left === 120 - sold && edit.body.event.guest_price === 550 && edit.body.event.member_price === gala.member_price,
    `sold=${sold} seats_left=${edit.body?.event?.seats_left}`);
  const tooSmall = await api('PATCH', `/api/events/${gala.id}`, { token: admin, body: { total_seats: sold - 1 } });
  const empty = await api('PATCH', `/api/events/${gala.id}`, { token: admin, body: {} });
  const badDate = await api('PATCH', `/api/events/${gala.id}`, { token: admin, body: { event_date: 'soon' } });
  const ghost = await api('PATCH', '/api/events/99999', { token: admin, body: { title: 'Nope Event' } });
  const nonAdmin = await Promise.all([treasurer, volunteer, member].map((token) => api('PATCH', `/api/events/${gala.id}`, { token, body: { title: 'Hijack Night' } })));
  check('capacity below seats sold, empty body or bad date -> 400; unknown event -> 404; non-admins -> 403',
    tooSmall.status === 400 && empty.status === 400 && badDate.status === 400 && ghost.status === 404 && nonAdmin.every((r) => r.status === 403));
  const draft = await api('POST', '/api/events', {
    token: admin,
    body: { title: 'Alumni Mixer', event_date: '2026-12-12T13:00:00.000Z', location: 'Courtyard', total_seats: 40, member_price: 0, guest_price: 100 },
  });
  const deleteBy = await Promise.all([treasurer, volunteer, member].map((token) => api('DELETE', `/api/events/${draft.body.event.id}`, { token })));
  const delGala = await api('DELETE', `/api/events/${gala.id}`, { token: admin });
  const delDraft = await api('DELETE', `/api/events/${draft.body.event.id}`, { token: admin });
  const delAgain = await api('DELETE', `/api/events/${draft.body.event.id}`, { token: admin });
  const delBad = await api('DELETE', '/api/events/abc', { token: admin });
  check('DELETE /api/events/:id: non-admins -> 403; an event with sold seats -> 409 (kept); an unsold event -> 200; again -> 404; bad id -> 400',
    deleteBy.every((r) => r.status === 403) && delGala.status === 409 && /can't be deleted/.test(delGala.body.error) &&
      db.prepare('SELECT 1 FROM events WHERE id = ?').get(gala.id) !== undefined &&
      delDraft.status === 200 && delDraft.body.deleted.title === 'Alumni Mixer' && !db.prepare('SELECT 1 FROM events WHERE id = ?').get(draft.body.event.id) &&
      delAgain.status === 404 && delBad.status === 400,
    `${deleteBy.map((r) => r.status).join(',')}/${delGala.status}/${delDraft.status}/${delAgain.status}/${delBad.status}`);
  const adminTicket = await api('POST', `/api/events/${gala.id}/tickets`, { token: admin });
  const adminOrder = await api('POST', '/api/merch/orders', { token: admin, body: { item_id: 1, size: 'M' } });
  check('admin buying a ticket or merch -> 403 "Admins manage events and inventory and do not purchase tickets or merch"',
    adminTicket.status === 403 && adminOrder.status === 403 &&
      adminTicket.body.reason === 'Admins manage events and inventory and do not purchase tickets or merch' && adminOrder.body.reason === adminTicket.body.reason);

  // ------------------------------------------------------------ tasks
  section('Bake sale: permissions and the request workflow');
  const open = db.prepare("SELECT id FROM fundraiser_tasks WHERE assigned_to IS NULL AND status = 'TODO' ORDER BY id LIMIT 1").get().id;
  const tEdit = await api('PATCH', `/api/tasks/${open}`, { token: treasurer, body: { title: 'Set up the UPI QR code, card reader and cash float' } });
  const vEdit = await api('PATCH', `/api/tasks/${open}`, { token: volunteer, body: { title: 'x' } });
  const vCreate = await api('POST', '/api/tasks', { token: volunteer, body: { title: 'Volunteer task' } });
  check('Treasurer edits a task -> 200; a volunteer editing or creating -> 403',
    tEdit.status === 200 && tEdit.body.task.title.includes('card reader') && vEdit.status === 403 && vCreate.status === 403);

  const kabirReq = await api('POST', `/api/tasks/${open}/request`, { token: nonMember, body: { note: 'me please' } });
  const rohanReq = await api('POST', `/api/tasks/${open}/request`, { token: member, body: { note: 'I can bake 40 brownies on Friday' } });
  const rohanAgain = await api('POST', `/api/tasks/${open}/request`, { token: member, body: {} });
  const nehaReq = await api('POST', `/api/tasks/${open}/request`, { token: volunteer, body: { note: 'I have a card reader' } });
  check('non-member student -> 403; club member and volunteer -> 201 PENDING; asking twice -> 409',
    kabirReq.status === 403 && rohanReq.status === 201 && rohanReq.body.request.status === 'PENDING' &&
      rohanReq.body.request.note === 'I can bake 40 brownies on Friday' && rohanAgain.status === 409 && nehaReq.status === 201);
  const adminBoard = await api('GET', '/api/tasks', { token: admin });
  const rohanBoard = await api('GET', '/api/tasks', { token: member });
  check('GET /api/tasks: the Admin sees the pending queue; a member sees only their own requests',
    adminBoard.body.requests.filter((r) => r.status === 'PENDING' && r.task_id === open).length === 2 &&
      rohanBoard.body.requests.length === 1 && rohanBoard.body.requests[0].user.id === id('rohan@skyline.edu'));
  const reviewBy = await Promise.all([volunteer, treasurer].map((token) => api('PATCH', `/api/tasks/requests/${rohanReq.body.request.id}/review`, { token, body: { decision: 'APPROVE' } })));
  const approve = await api('PATCH', `/api/tasks/requests/${rohanReq.body.request.id}/review`, { token: admin, body: { decision: 'approve' } });
  const nehaRow = db.prepare('SELECT status FROM task_requests WHERE id = ?').get(nehaReq.body.request.id);
  check('only the Admin reviews (volunteer/treasurer -> 403); Approve & Assign -> task assigned, other pending request rejected',
    reviewBy.every((r) => r.status === 403) && approve.status === 200 && approve.body.task.assigned_to === id('rohan@skyline.edu') &&
      approve.body.request.status === 'APPROVED' && approve.body.other_requests_rejected === 1 && nehaRow.status === 'REJECTED');
  const again = await api('PATCH', `/api/tasks/requests/${rohanReq.body.request.id}/review`, { token: admin, body: { decision: 'REJECT' } });
  const badDecision = await api('PATCH', `/api/tasks/requests/${rohanReq.body.request.id}/review`, { token: admin, body: { decision: 'MAYBE' } });
  check('reviewing twice -> 409; bad decision -> 400', again.status === 409 && badDecision.status === 400);
  const vMove = await api('PATCH', `/api/tasks/${open}/status`, { token: volunteer, body: { status: 'IN_PROGRESS' } });
  const tMove = await api('PATCH', `/api/tasks/${open}/status`, { token: treasurer, body: { status: 'IN_PROGRESS' } });
  const ownMove = await api('PATCH', `/api/tasks/${open}/status`, { token: member, body: { status: 'IN_PROGRESS' } });
  check('only the assignee (or the Admin) moves the task: volunteer and treasurer -> 403, assignee Rohan -> 200',
    vMove.status === 403 && tMove.status === 403 && ownMove.status === 200);
  const scratch = await api('POST', '/api/tasks', { token: treasurer, body: { title: 'Temporary task' } });
  const tDelete = await api('DELETE', `/api/tasks/${scratch.body.task.id}`, { token: treasurer });
  check('the Treasurer can create and delete tasks', scratch.status === 201 && tDelete.status === 200);

  // ------------------------------------------------------------ scopes
  section('Scoped admin access');
  const nehaId = id('neha@skyline.edu');
  const scoped = await api('PATCH', `/api/users/${nehaId}/role`, { token: admin, body: { role: 'ADMIN', access_scope: 'BAKE_SALE_ONLY' } });
  check('Founding Admin makes Neha "Admin — Bake Sale Only" -> 200',
    scoped.status === 200 && scoped.body.user.role === 'ADMIN' && scoped.body.user.access_scope === 'BAKE_SALE_ONLY');
  const inScope = await api('POST', '/api/tasks', { token: volunteer, body: { title: 'Scoped admin task' } });
  const outEvents = await api('POST', '/api/events', { token: volunteer, body: { title: 'Out of scope', event_date: new Date(Date.now() + 864e5).toISOString(), location: 'Hall', total_seats: 5, member_price: 0, guest_price: 0 } });
  const outEdit = await api('PATCH', `/api/events/${gala.id}`, { token: volunteer, body: { title: 'Out of scope edit' } });
  const outDelete = await api('DELETE', `/api/events/${gala.id}`, { token: volunteer });
  const outMerch = await api('POST', '/api/merch/items', { token: volunteer, body: { name: 'Out of scope', category: 'CAPS', cost_price: 1, member_price: 2, regular_price: 3 } });
  const outRestock = await api('PATCH', '/api/merch/variants/1/restock', { token: volunteer, body: { add_quantity: 1 } });
  check('inside the scope -> 201; events, merch products and restock outside it -> 403 "scoped strictly to: Bake Sale Project"',
    inScope.status === 201 && [outEvents, outEdit, outDelete, outMerch, outRestock].every((r) => r.status === 403 && r.body.reason === 'Your admin access is scoped strictly to: Bake Sale Project'),
    [outEvents, outEdit, outDelete, outMerch, outRestock].map((r) => r.status).join(','));
  const me = await api('GET', '/api/auth/me', { token: volunteer });
  const badScope = await api('PATCH', `/api/users/${nehaId}/role`, { token: admin, body: { access_scope: 'EVERYTHING' } });
  const scopeOnly = await api('PATCH', `/api/users/${nehaId}/role`, { token: admin, body: { access_scope: 'ALL' } });
  check('/api/auth/me shows the scope; unknown scope -> 400; scope alone can be changed',
    me.body.user.access_scope === 'BAKE_SALE_ONLY' && badScope.status === 400 && scopeOnly.status === 200 && scopeOnly.body.user.role === 'ADMIN');
  await api('PATCH', `/api/users/${nehaId}/role`, { token: admin, body: { role: 'VOLUNTEER' } });

  // ------------------------------------------------------------ merch
  section('Merch: 5 categories, products, low stock, P&L');
  const asMember = await api('GET', '/api/merch/items', { token: member });
  const asAdmin = await api('GET', '/api/merch/items', { token: admin });
  const cats = new Set(asAdmin.body.items.map((i) => i.category));
  check('5 categories, each item with 4 gallery angles; cost price visible to the Admin only',
    ['HOODIES', 'T_SHIRTS', 'CAPS', 'PANTS', 'ACCESSORIES'].every((c) => cats.has(c)) &&
      asAdmin.body.items.every((i) => i.gallery.angles.length === 4 && typeof i.cost_price === 'number') &&
      asMember.body.items.every((i) => i.cost_price === undefined));
  const lows = asAdmin.body.items.flatMap((i) => i.low_stock.map((v) => `${i.name}:${v.size}:${v.stock_count}`));
  check('low_stock lists every size at or below its threshold (seeded 0, 2, 2-3 unit sizes trigger it)',
    lows.length >= 4 && asAdmin.body.items.every((i) => i.low_stock.every((v) => v.stock_count <= i.low_stock_threshold)), lows.join(', '));
  const created = await api('POST', '/api/merch/items', {
    token: admin,
    body: { name: 'Skyline Varsity Jacket', category: 'hoodies', cost_price: 900, member_price: 1499, regular_price: 1899, low_stock_threshold: 4, assigned_manager_id: nehaId, color: '#7c2d12', stock: { S: 5, M: 3, L: 8, XL: 1 } },
  });
  check('Admin adds a product with opening stock -> 201 with 4 sizes',
    created.status === 201 && created.body.variants.length === 4 && created.body.item.cost_price === 900 && created.body.item.assigned_manager_id === nehaId);
  const badItems = await Promise.all([
    api('POST', '/api/merch/items', { token: admin, body: { name: 'x', category: 'SHOES', cost_price: -1, member_price: 1, regular_price: 2 } }),
    api('POST', '/api/merch/items', { token: admin, body: { name: 'Pricey', category: 'CAPS', cost_price: 1, member_price: 900, regular_price: 500 } }),
  ]);
  const vItem = await api('POST', '/api/merch/items', { token: volunteer, body: { name: 'Nope', category: 'CAPS', cost_price: 1, member_price: 1, regular_price: 1 } });
  check('bad name/category/cost or member > regular -> 400; volunteer -> 403', badItems.every((r) => r.status === 400) && vItem.status === 403);
  const editItem = await api('PATCH', `/api/merch/items/${created.body.item.id}`, { token: admin, body: { cost_price: 950, regular_price: 1999 } });
  check('Admin edits a product -> 200', editItem.status === 200 && editItem.body.item.cost_price === 950 && editItem.body.item.regular_price === 1999);
  const jacketM = created.body.variants.find((v) => v.size === 'M').id;
  const managerRestock = await api('PATCH', `/api/merch/variants/${jacketM}/restock`, { token: volunteer, body: { add_quantity: 5 } });
  const otherRestock = await api('PATCH', '/api/merch/variants/1/restock', { token: volunteer, body: { add_quantity: 5 } });
  check("the item's inventory manager can restock it (200) but not someone else's item (403)", managerRestock.status === 200 && otherRestock.status === 403);

  const pnl = await api('GET', '/api/merch/analytics?period=all', { token: treasurer });
  const sum = (k) => pnl.body.products.reduce((t, p) => t + p[k], 0);
  const ranked = pnl.body.products.every((p, i, a) => i === 0 || a[i - 1].units_sold >= p.units_sold);
  const expectedRevenue = db.prepare('SELECT COALESCE(SUM(total_paid), 0) AS n FROM merch_orders').get().n;
  check('P&L: revenue matches the orders table, cost = cost_price × units, profit = revenue − cost, ranked by units sold',
    pnl.status === 200 && pnl.body.totals.revenue === expectedRevenue && pnl.body.totals.revenue === sum('revenue') &&
      pnl.body.products.every((p) => p.cost === p.cost_price * p.units_sold && p.profit === p.revenue - p.cost) &&
      pnl.body.totals.profit === pnl.body.totals.revenue - pnl.body.totals.cost && ranked,
    JSON.stringify(pnl.body.totals));
  const week = await api('GET', '/api/merch/analytics?period=7d', { token: admin });
  const badPeriod = await api('GET', '/api/merch/analytics?period=forever', { token: admin });
  const studentPnl = await api('GET', '/api/merch/analytics', { token: member });
  check('7-day window is a subset of all time; bad period -> 400; students -> 403',
    week.status === 200 && week.body.totals.units_sold <= pnl.body.totals.units_sold && badPeriod.status === 400 && studentPnl.status === 403);

  // ------------------------------------------------------------ client-side CSV + shortcut
  section('Client-side CSV exports and the "/" search shortcut');
  const app = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');
  const block = /\/\/ ---- csv:start([\s\S]*?)\/\/ ---- csv:end/.exec(app)?.[1] || '';
  const box = {};
  vm.createContext(box);
  vm.runInContext(`${block}\nthis.api = { csvCell, toCsv };`, box);
  const csv = box.api.toCsv(['code', 'name', 'note'], [['TKT-1', 'Rohan, Verma', 'said "hi"'], ['ORD-2', '=HYPERLINK("x")', '+91 98']]);
  check('toCsv quotes commas and quotes, defuses formula-like cells, and ends rows with CRLF',
    csv === 'code,name,note\r\nTKT-1,"Rohan, Verma","said ""hi"""\r\nORD-2,"\'=HYPERLINK(""x"")",\'+91 98\r\n', JSON.stringify(csv));
  check('Export Attendee Roster / Export Orders buttons and the "/" shortcut are wired in app.js',
    ['Export Attendee Roster (CSV)', 'Export Orders (CSV)', "exportRoster: () =>", "exportOrders: () =>", "event.key !== '/'", "'#main input[data-search]'"].every((t) => app.includes(t)));

  // ------------------------------------------------------------ full seed profile
  section('Full seed profile: 105 users and a semester of activity');
  removeDb(FULL_DB);
  const seeded = spawnSync(process.execPath, [path.join(__dirname, 'seed.js'), '--reset'], {
    env: { ...process.env, DB_PATH: FULL_DB, SEED_PROFILE: 'full' }, encoding: 'utf8',
  });
  check('node seed.js --reset (full profile) runs cleanly', seeded.status === 0, seeded.stderr.trim());
  const { connect } = require('./db');
  const full = connect(FULL_DB);
  try {
    const count = (sql) => full.prepare(sql).get().n;
    const codes = full.prepare("SELECT membership_code FROM users WHERE membership_code IS NOT NULL ORDER BY membership_code").all().map((r) => r.membership_code);
    check('105 users: IDs 1-5 are the named accounts, 55 more club members (SKY-2026-005 … 059), 30 non-members, 15 volunteers',
      count('SELECT COUNT(*) AS n FROM users') === 105 &&
        full.prepare('SELECT email FROM users WHERE id <= 5 ORDER BY id').all().map((r) => r.email).join() === 'vikram@skyline.edu,meera@skyline.edu,neha@skyline.edu,rohan@skyline.edu,kabir@skyline.edu' &&
        codes.length === 59 && codes[4] === 'SKY-2026-005' && codes[58] === 'SKY-2026-059' &&
        count("SELECT COUNT(*) AS n FROM users WHERE id > 5 AND role = 'STUDENT' AND membership_code IS NULL") === 30 &&
        count("SELECT COUNT(*) AS n FROM users WHERE id > 5 AND role = 'VOLUNTEER'") === 15);
    const ago = (days) => new Date(Date.now() - days * 864e5).toISOString();
    const inWindow = (days) => full.prepare('SELECT COUNT(*) AS n FROM merch_orders WHERE created_at >= ?').get(ago(days)).n;
    check('merch orders spread over 7 / 30 / 90+ days, 5 categories, 3 pending task requests',
      inWindow(7) > 0 && inWindow(30) > inWindow(7) && count('SELECT COUNT(*) AS n FROM merch_orders') > inWindow(30) &&
        count('SELECT COUNT(DISTINCT category) AS n FROM merch_items') === 5 &&
        count("SELECT COUNT(*) AS n FROM task_requests WHERE status = 'PENDING'") === 3,
      `7d=${inWindow(7)} 30d=${inWindow(30)} all=${count('SELECT COUNT(*) AS n FROM merch_orders')}`);
    const ledgerMatches = count("SELECT COUNT(*) AS n FROM merch_orders o LEFT JOIN ledger_transactions l ON l.reference_id = o.order_code AND l.category = 'MERCH_SALE' WHERE l.id IS NULL") === 0 &&
      count("SELECT COUNT(*) AS n FROM tickets t LEFT JOIN ledger_transactions l ON l.reference_id = t.ticket_code WHERE l.id IS NULL") === 0;
    const seatsOk = full.prepare('SELECT COUNT(*) AS n FROM events e WHERE seats_left < 0 OR seats_left > total_seats').get().n === 0;
    check('every seeded order and ticket has its ledger row; seats_left stays within 0 … total_seats; foreign keys intact',
      ledgerMatches && seatsOk && full.prepare('PRAGMA foreign_key_check').all().length === 0);
  } finally {
    full.close();
    removeDb(FULL_DB);
  }
}

async function main() {
  console.log(`Phase 8 verification (temp DB: ${DB_FILE})`);
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
