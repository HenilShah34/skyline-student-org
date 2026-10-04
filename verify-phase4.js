'use strict';

// Phase 4 self-verification: pickup audit migration, fundraiser task board,
// expense reimbursements, the cross-process double-payout race, and the
// treasurer's ledger integrity. Runs the real server against a throwaway database
// on ephemeral ports. Every server process is stopped and the temp databases
// removed, pass or fail.

const { check, section, summarize, tempDbPath, removeDb, startServer, stopServer } = require('./verify-helpers');

const DB_FILE = tempDbPath('verify4');
const FIXTURE_DB = tempDbPath('verify4-phase3-fixture');
process.env.DB_PATH = DB_FILE; // must be set before ./db is required

const DAY_MS = 24 * 60 * 60 * 1000;
const RACE_PROCESSES = 5;
const HOLD_MS = 150; // test-only gap between the PENDING check and the payout
const SERVER_ENV = { TEST_PURCHASE_HOLD_MS: String(HOLD_MS) };
const CAMPAIGN = 'Spring Bake Sale';
const STATUS_ORDER = { TODO: 0, IN_PROGRESS: 1, DONE: 2 };

const servers = [];
let dbModule = null;
let db = null;

function localDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function ledgerTotals() {
  return db
    .prepare(`
      SELECT COUNT(*) AS n,
             COALESCE(SUM(CASE WHEN type = 'IN' THEN amount ELSE 0 END), 0) AS total_in,
             COALESCE(SUM(CASE WHEN type = 'OUT' THEN amount ELSE 0 END), 0) AS total_out
      FROM ledger_transactions`)
    .get();
}

async function timed(fn) {
  const started = Date.now();
  const result = await fn();
  return { ...result, ms: Date.now() - started };
}

// A merch_orders table exactly as Phase 3 shipped it (no pickup audit columns).
function verifyMigration() {
  section('Schema migration — merch_orders pickup audit columns');
  const { connect, applySchema } = dbModule;
  const fixture = connect(FIXTURE_DB);
  try {
    fixture.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('STUDENT', 'VOLUNTEER', 'ADMIN')),
        membership_code TEXT UNIQUE,
        membership_status TEXT NOT NULL DEFAULT 'NONE' CHECK (membership_status IN ('NONE', 'ACTIVE', 'EXPIRED')),
        membership_expires_at TEXT, created_at TEXT NOT NULL);
      CREATE TABLE merch_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT, category TEXT NOT NULL,
        member_price INTEGER NOT NULL, regular_price INTEGER NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE merch_variants (
        id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL REFERENCES merch_items(id) ON DELETE CASCADE,
        size TEXT NOT NULL CHECK (size IN ('S', 'M', 'L', 'XL')), stock_count INTEGER NOT NULL CHECK (stock_count >= 0),
        UNIQUE (item_id, size));
      CREATE TABLE merch_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT, order_code TEXT UNIQUE NOT NULL,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        variant_id INTEGER NOT NULL REFERENCES merch_variants(id) ON DELETE RESTRICT,
        quantity INTEGER NOT NULL CHECK (quantity > 0), total_paid INTEGER NOT NULL,
        fulfillment_status TEXT NOT NULL DEFAULT 'PAID_PENDING_PICKUP' CHECK (fulfillment_status IN ('PAID_PENDING_PICKUP', 'PICKED_UP')),
        created_at TEXT NOT NULL);
      INSERT INTO users (name, email, password_hash, role, created_at) VALUES ('Old Buyer', 'old@x.edu', 'x:y', 'STUDENT', '2026-01-01');
      INSERT INTO merch_items (name, category, member_price, regular_price, created_at) VALUES ('Old Tee', 'APPAREL', 1, 2, '2026-01-01');
      INSERT INTO merch_variants (item_id, size, stock_count) VALUES (1, 'M', 5);
      INSERT INTO merch_orders (order_code, user_id, variant_id, quantity, total_paid, fulfillment_status, created_at)
        VALUES ('ORD-OLD-1', 1, 1, 1, 2, 'PICKED_UP', '2026-01-02');`);
    const columns = () => fixture.prepare('PRAGMA table_info(merch_orders)').all().map((c) => c.name);
    const before = columns();

    applySchema(fixture);
    const after = columns();
    applySchema(fixture); // a second startup must be a no-op
    const again = columns();
    const fresh = db.prepare('PRAGMA table_info(merch_orders)').all().map((c) => c.name);
    const oldRow = fixture.prepare("SELECT * FROM merch_orders WHERE order_code = 'ORD-OLD-1'").get();

    check('Phase 3 database gains picked_up_at + picked_up_by on startup; existing rows kept',
      !before.includes('picked_up_at') && after.includes('picked_up_at') && after.includes('picked_up_by') &&
        oldRow && oldRow.picked_up_at === null && oldRow.picked_up_by === null,
      `${before.length} -> ${after.length} columns`);
    check('migration is idempotent and ends with the same column order as a fresh database',
      again.join() === after.join() && after.join() === fresh.join(), after.join(', '));

    let fkError = null;
    try {
      fixture.prepare("UPDATE merch_orders SET picked_up_by = 999 WHERE order_code = 'ORD-OLD-1'").run();
    } catch (err) {
      fkError = err.message;
    }
    check('migrated picked_up_by enforces its foreign key to users', /FOREIGN KEY constraint failed/.test(fkError || ''), fkError);
  } finally {
    fixture.close();
  }
}

async function run() {
  const primary = await startServer(DB_FILE, SERVER_ENV);
  servers.push(primary);
  console.log(`Primary server started (pid ${primary.child.pid}, port ${primary.port})`);
  dbModule = require('./db'); // the server has created and seeded the DB by now
  ({ db } = dbModule);
  const { api } = primary;

  const users = {};
  for (const name of ['vikram', 'meera', 'neha', 'rohan', 'kabir']) {
    const res = await api('POST', '/api/auth/login', { body: { email: `${name}@skyline.edu`, password: 'skyline123' } });
    users[name] = { token: res.body.token, id: res.body.user.id };
  }
  const tok = (name) => users[name].token;

  verifyMigration();

  // ------------------------------------------------------------ Pickup audit
  section('Merch pickup audit trail');
  const seeded = await api('GET', '/api/merch/orders?q=ORD-2026-0001', { token: tok('neha') });
  const seededOrder = seeded.body?.orders?.[0];
  check('seeded picked-up order carries who handed it over and when',
    seededOrder?.picked_up_by?.name === 'Neha Sharma' && Boolean(seededOrder.picked_up_at), JSON.stringify(seededOrder?.picked_up_by));

  const pickup = await api('PATCH', '/api/merch/orders/ORD-2026-0002/pickup', { token: tok('vikram') });
  const pickedAt = Date.parse(pickup.body?.order?.picked_up_at);
  check('Vikram hands over ORD-2026-0002 -> 200 with picked_up_at (now) and picked_up_by = Vikram',
    pickup.status === 200 && pickup.body.order.picked_up_by.id === users.vikram.id &&
      pickup.body.order.picked_up_by.name === 'Vikram Desai' && Math.abs(Date.now() - pickedAt) < 60000,
    `picked_up_at=${pickup.body?.order?.picked_up_at}`);
  const pickupAgain = await api('PATCH', '/api/merch/orders/ORD-2026-0002/pickup', { token: tok('neha') });
  check('repeat pickup -> 409 naming who already handed it over and when',
    pickupAgain.status === 409 && pickupAgain.body.picked_up_by === 'Vikram Desai' &&
      pickupAgain.body.picked_up_at === pickup.body.order.picked_up_at,
    `body=${JSON.stringify(pickupAgain.body)}`);

  // ------------------------------------------------------------ Scene 5
  section('1) Bake sale task board');
  const board = await api('GET', '/api/tasks', { token: tok('kabir') });
  const tasks = board.body.tasks;
  const unassigned = tasks.filter((t) => t.assigned_to === null);
  const ordered = tasks.every((t, i) => {
    if (i === 0) return true;
    const prev = tasks[i - 1];
    if (STATUS_ORDER[prev.status] !== STATUS_ORDER[t.status]) return STATUS_ORDER[prev.status] < STATUS_ORDER[t.status];
    return prev.due_date === null || (t.due_date !== null && prev.due_date <= t.due_date);
  });
  check('GET /api/tasks -> all 5 tasks incl. unassigned (LEFT JOIN), ordered by status then due date',
    board.status === 200 && tasks.length === 5 && unassigned.length === 1 && unassigned[0].assignee_name === null && ordered,
    tasks.map((t) => `${t.status}:${t.due_date}:${t.assignee_name ?? 'unassigned'}`).join(' | '));

  const summary0 = board.body.campaigns_summary[CAMPAIGN];
  const doneFromList = tasks.filter((t) => t.status === 'DONE').length;
  check(`campaigns_summary["${CAMPAIGN}"] -> 1/5 done = 20%, on track`,
    summary0 && summary0.total_tasks === 5 && summary0.todo_count === 2 && summary0.in_progress_count === 2 &&
      summary0.done_count === doneFromList && summary0.completion_percentage === 20 && summary0.on_track === true,
    JSON.stringify(summary0));

  const byStatus = await api('GET', '/api/tasks?status=todo', { token: tok('kabir') });
  const byAssignee = await api('GET', `/api/tasks?assigned_to=${users.neha.id}`, { token: tok('kabir') });
  const noCampaign = await api('GET', '/api/tasks?campaign=Winter%20Car%20Wash', { token: tok('kabir') });
  const badFilters = await Promise.all([
    api('GET', '/api/tasks?status=DOING', { token: tok('kabir') }),
    api('GET', '/api/tasks?assigned_to=abc', { token: tok('kabir') }),
  ]);
  check('filters: ?status, ?assigned_to, ?campaign apply; invalid values -> 400',
    byStatus.body.count === 2 && byStatus.body.tasks.every((t) => t.status === 'TODO') &&
      byAssignee.body.count === 3 && byAssignee.body.tasks.every((t) => t.assigned_to === users.neha.id) &&
      noCampaign.body.count === 0 && Object.keys(noCampaign.body.campaigns_summary).length === 0 &&
      badFilters.every((r) => r.status === 400));

  const yesterday = localDate(Date.now() - DAY_MS);
  const created = await api('POST', '/api/tasks', {
    token: tok('meera'),
    body: { title: 'Print price labels and allergen cards', assigned_to: users.rohan.id, due_date: yesterday },
  });
  const newTask = created.body?.task;
  check(`Treasurer Meera creates a task (default campaign "${CAMPAIGN}") -> 201 TODO with assignee name`,
    created.status === 201 && newTask.campaign_name === CAMPAIGN && newTask.status === 'TODO' &&
      newTask.assignee_name === 'Rohan Verma' && created.body.campaign.total_tasks === 6,
    `task #${newTask?.id} due ${newTask?.due_date}`);
  check('an overdue unfinished task flips the campaign to on_track = false',
    newTask.is_overdue === true && created.body.campaign.overdue_count === 1 && created.body.campaign.on_track === false);

  const badCreates = await Promise.all([
    api('POST', '/api/tasks', { token: tok('meera'), body: { title: 'x', assigned_to: 'someone' } }),
    api('POST', '/api/tasks', { token: tok('meera'), body: { title: '   ' } }),
    api('POST', '/api/tasks', { token: tok('meera'), body: { title: 'x', due_date: '2026-02-30' } }),
  ]);
  const ghostAssignee = await api('POST', '/api/tasks', { token: tok('meera'), body: { title: 'x', assigned_to: 99999 } });
  const studentCreate = await api('POST', '/api/tasks', { token: tok('kabir'), body: { title: 'x' } });
  const volunteerCreate = await api('POST', '/api/tasks', { token: tok('neha'), body: { title: 'x' } });
  check('task validation: bad assignee/title/date -> 400, unknown assignee -> 404, student and volunteer -> 403',
    badCreates.every((r) => r.status === 400) && ghostAssignee.status === 404 && studentCreate.status === 403 && volunteerCreate.status === 403,
    `statuses=${badCreates.map((r) => r.status).join(',')},${ghostAssignee.status},${studentCreate.status},${volunteerCreate.status}`);

  const kabirMove = await api('PATCH', `/api/tasks/${newTask.id}/status`, { token: tok('kabir'), body: { status: 'DONE' } });
  check("unassigned student Kabir moving someone else's task -> 403", kabirMove.status === 403, `body=${JSON.stringify(kabirMove.body)}`);

  const rohanReassign = await api('PATCH', `/api/tasks/${newTask.id}/status`, {
    token: tok('rohan'),
    body: { status: 'IN_PROGRESS', assigned_to: users.kabir.id },
  });
  check('assignee student trying to reassign -> 403', rohanReassign.status === 403);

  const volunteerMove = await api('PATCH', `/api/tasks/${newTask.id}/status`, { token: tok('neha'), body: { status: 'IN_PROGRESS' } });
  check("a volunteer can't move a task that isn't assigned to them -> 403", volunteerMove.status === 403);
  const toProgress = await api('PATCH', `/api/tasks/${newTask.id}/status`, { token: tok('vikram'), body: { status: 'IN_PROGRESS' } });
  const toDone = await api('PATCH', `/api/tasks/${newTask.id}/status`, { token: tok('vikram'), body: { status: 'DONE' } });
  check('the Admin moves it TODO -> IN_PROGRESS -> DONE (200 each) with live campaign stats',
    toProgress.status === 200 && toProgress.body.task.status === 'IN_PROGRESS' &&
      toDone.status === 200 && toDone.body.task.status === 'DONE' &&
      toDone.body.campaign.done_count === 2 && toDone.body.campaign.completion_percentage === 33 &&
      toDone.body.campaign.on_track === true,
    `campaign=${JSON.stringify(toDone.body?.campaign)}`);

  const rohanTask = tasks.find((t) => t.assigned_to === users.rohan.id);
  const rohanDone = await api('PATCH', `/api/tasks/${rohanTask.id}/status`, { token: tok('rohan'), body: { status: 'done' } });
  check('a student can move a task assigned to them (Rohan finishes his posters)',
    rohanDone.status === 200 && rohanDone.body.task.status === 'DONE' && rohanDone.body.campaign.completion_percentage === 50);

  const badPatches = await Promise.all([
    api('PATCH', `/api/tasks/${newTask.id}/status`, { token: tok('neha'), body: { status: 'FINISHED' } }),
    api('PATCH', '/api/tasks/abc/status', { token: tok('neha'), body: { status: 'DONE' } }),
  ]);
  const missingTask = await api('PATCH', '/api/tasks/99999/status', { token: tok('neha'), body: { status: 'DONE' } });
  check('bad status or id -> 400; unknown task -> 404', badPatches.every((r) => r.status === 400) && missingTask.status === 404);

  // ------------------------------------------------------------ Scene 6
  section('2) Expense reimbursement submission');
  const ledger0 = ledgerTotals();
  const submit = await api('POST', '/api/finance/reimbursements', {
    token: tok('neha'),
    body: { title: 'Bake Sale Cocoa & Sugar', category: 'FUNDRAISER_SUPPLIES', amount: 650, receipt_reference: 'RCP-2026-884' },
  });
  const claim = submit.body?.reimbursement;
  const ledger1 = ledgerTotals();
  check('Neha submits ₹650 receipt -> 201 PENDING, no approver yet, ledger untouched',
    submit.status === 201 && claim.status === 'PENDING' && claim.amount === 650 && claim.volunteer_name === 'Neha Sharma' &&
      claim.approved_by === null && claim.approved_by_name === null &&
      ledger1.n === ledger0.n && ledger1.total_out === ledger0.total_out,
    `reimbursement #${claim?.id}; ledger rows ${ledger0.n} -> ${ledger1.n}`);

  const dupReceipt = await api('POST', '/api/finance/reimbursements', {
    token: tok('neha'),
    body: { title: 'Cocoa again', category: 'FUNDRAISER_SUPPLIES', amount: 650, receipt_reference: 'rcp-2026-884' },
  });
  check('same receipt submitted again (any case) -> 409', dupReceipt.status === 409, `error="${dupReceipt.body?.error}"`);

  const badClaim = await api('POST', '/api/finance/reimbursements', {
    token: tok('neha'),
    body: { title: '', category: 'FOOD', amount: 0, receipt_reference: ' ' },
  });
  const fractional = await api('POST', '/api/finance/reimbursements', {
    token: tok('neha'),
    body: { title: 'Napkins', category: 'FUNDRAISER_SUPPLIES', amount: 99.5, receipt_reference: 'RCP-1' },
  });
  const studentClaim = await api('POST', '/api/finance/reimbursements', {
    token: tok('kabir'),
    body: { title: 'Napkins', category: 'FUNDRAISER_SUPPLIES', amount: 99, receipt_reference: 'RCP-1' },
  });
  check('invalid claim -> 400 with all 4 field errors; fractional amount -> 400; student -> 403',
    badClaim.status === 400 && ['title', 'category', 'amount', 'receipt_reference'].every((f) => f in badClaim.body.details) &&
      fractional.status === 400 && studentClaim.status === 403);

  const selfApprove = await api('PATCH', `/api/finance/reimbursements/${claim.id}/review`, {
    token: tok('neha'),
    body: { decision: 'APPROVED_PAID' },
  });
  check('Neha (VOLUNTEER) approving her own claim -> 403 Forbidden', selfApprove.status === 403, `body=${JSON.stringify(selfApprove.body)}`);

  const queue = await api('GET', '/api/finance/reimbursements', { token: tok('neha') });
  const approvedSeed = queue.body.reimbursements.find((r) => r.status === 'APPROVED_PAID');
  check('staff list: one query returns volunteer + approver names (approver NULL while PENDING); totals by status',
    queue.status === 200 && queue.body.reimbursements[0].status === 'PENDING' &&
      queue.body.reimbursements.some((r) => r.id === claim.id && r.approved_by_name === null) &&
      approvedSeed?.approved_by_name === 'Meera Joshi' &&
      queue.body.summary.pending_amount === 1640 + 650 && queue.body.summary.approved_paid_amount === 2350 &&
      queue.body.summary.rejected_amount === 0,
    `summary=${JSON.stringify(queue.body?.summary)}`);

  const pendingOnly = await api('GET', '/api/finance/reimbursements?status=pending', { token: tok('meera') });
  const studentList = await api('GET', '/api/finance/reimbursements', { token: tok('kabir') });
  check('?status=PENDING filters; a student sees only their own (none) and no totals',
    pendingOnly.body.count === 2 && pendingOnly.body.reimbursements.every((r) => r.status === 'PENDING') &&
      studentList.status === 200 && studentList.body.count === 0 && !('summary' in studentList.body));

  // ------------------------------------------------------------ Race
  section(`3) Double-payout race — 5 approvals of one claim, ${RACE_PROCESSES} separate server processes`);
  const replicas = await Promise.all(
    Array.from({ length: RACE_PROCESSES - 1 }, () => startServer(DB_FILE, SERVER_ENV)),
  );
  servers.push(...replicas);
  const pool = [primary, ...replicas];
  console.log(`  ${pool.length} servers on one DB: pids ${pool.map((s) => s.child.pid).join(', ')}`);

  const outRows = () => db
    .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM ledger_transactions WHERE type = 'OUT' AND category = 'EXPENSE_REIMBURSEMENT'")
    .get();
  const out0 = outRows();
  const attempts = await Promise.all(
    pool.map((server) =>
      timed(() => server.api('PATCH', `/api/finance/reimbursements/${claim.id}/review`, {
        token: tok('meera'),
        body: { decision: 'APPROVED_PAID' },
      }))),
  );
  const out1 = outRows();
  const won = attempts.filter((a) => a.status === 200);
  const lost = attempts.filter((a) => a.status === 409 && a.body.error === 'Reimbursement already APPROVED_PAID');
  check('exactly 1 approval -> 200, the other 4 -> 409 "Reimbursement already APPROVED_PAID"',
    won.length === 1 && lost.length === 4,
    attempts.map((a, i) => `pid ${pool[i].child.pid}: ${a.status} in ${a.ms}ms`).join(' | '));
  check('ledger records exactly ONE -₹650 OUT row for the claim',
    out1.n - out0.n === 1 && out1.total - out0.total === 650 &&
      db.prepare("SELECT COUNT(*) AS n FROM ledger_transactions WHERE reference_id = 'RCP-2026-884'").get().n === 1,
    `EXPENSE_REIMBURSEMENT OUT rows ${out0.n} -> ${out1.n}; "${won[0]?.body?.transaction?.description}"`);
  const paidRow = db.prepare('SELECT status, approved_by FROM expense_reimbursements WHERE id = ?').get(claim.id);
  check('claim is APPROVED_PAID with Treasurer Meera recorded as approver',
    paidRow.status === 'APPROVED_PAID' && paidRow.approved_by === users.meera.id &&
      won[0]?.body?.reimbursement?.approved_by_name === 'Meera Joshi');

  await Promise.all(replicas.map((s) => stopServer(s.child)));

  const seededPending = pendingOnly.body.reimbursements.find((r) => r.id !== claim.id);
  const beforeReject = ledgerTotals();
  const reject = await api('PATCH', `/api/finance/reimbursements/${seededPending.id}/review`, {
    token: tok('meera'),
    body: { decision: 'rejected' },
  });
  const afterReject = ledgerTotals();
  const reReview = await api('PATCH', `/api/finance/reimbursements/${seededPending.id}/review`, {
    token: tok('meera'),
    body: { decision: 'APPROVED_PAID' },
  });
  check('rejecting a claim -> 200 REJECTED, no ledger row; reviewing it again -> 409',
    reject.status === 200 && reject.body.reimbursement.status === 'REJECTED' && reject.body.transaction === null &&
      afterReject.n === beforeReject.n && reReview.status === 409 && reReview.body.error === 'Reimbursement already REJECTED');

  const ownClaim = await api('POST', '/api/finance/reimbursements', {
    token: tok('vikram'),
    body: { title: 'Poster printing', category: 'MARKETING', amount: 300, receipt_reference: 'PRN-77' },
  });
  const ownApprove = await api('PATCH', `/api/finance/reimbursements/${ownClaim.body.reimbursement.id}/review`, {
    token: tok('vikram'),
    body: { decision: 'APPROVED_PAID' },
  });
  const badDecision = await api('PATCH', `/api/finance/reimbursements/${ownClaim.body.reimbursement.id}/review`, {
    token: tok('meera'),
    body: { decision: 'MAYBE' },
  });
  const ghostClaim = await api('PATCH', '/api/finance/reimbursements/99999/review', { token: tok('meera'), body: { decision: 'REJECTED' } });
  check('admin approving their own claim -> 403; bad decision -> 400; unknown claim -> 404',
    ownClaim.status === 201 && ownApprove.status === 403 && badDecision.status === 400 && ghostClaim.status === 404);

  const treasurerClaim = await api('POST', '/api/finance/reimbursements', {
    token: tok('meera'),
    body: { title: 'Ledger notebook', category: 'OPERATIONS', amount: 120, receipt_reference: 'BK-12' },
  });
  const treasurerSelf = await api('PATCH', `/api/finance/reimbursements/${treasurerClaim.body.reimbursement.id}/review`, {
    token: tok('meera'),
    body: { decision: 'APPROVED_PAID' },
  });
  const adminApprovesTreasurer = await api('PATCH', `/api/finance/reimbursements/${treasurerClaim.body.reimbursement.id}/review`, {
    token: tok('vikram'),
    body: { decision: 'APPROVED_PAID' },
  });
  check("treasurer approving their own claim -> 403; the admin may approve the treasurer's claim -> 200",
    treasurerClaim.status === 201 && treasurerSelf.status === 403 &&
      adminApprovesTreasurer.status === 200 && adminApprovesTreasurer.body.transaction.amount === 120,
    `${treasurerSelf.status}/${adminApprovesTreasurer.status}`);

  // ------------------------------------------------------------ Ledger
  section('4) Treasurer ledger');
  const book0 = (await api('GET', '/api/finance/ledger', { token: tok('meera') })).body.summary;
  const income = await api('POST', '/api/finance/fundraiser-income', {
    token: tok('meera'),
    body: { amount: 4250, description: 'Spring Bake Sale — Saturday stall takings (cash + UPI)', reference_id: 'BAKESALE-DAY1' },
  });
  check('Treasurer records ₹4250 bake sale income -> 201, net balance +₹4250',
    income.status === 201 && income.body.transaction.category === 'FUNDRAISER_INCOME' && income.body.transaction.type === 'IN' &&
      income.body.summary.net_balance - book0.net_balance === 4250);
  const incomeAgain = await api('POST', '/api/finance/fundraiser-income', {
    token: tok('meera'),
    body: { amount: 4250, description: 'dup', reference_id: 'bakesale-day1' },
  });
  const volunteerIncome = await api('POST', '/api/finance/fundraiser-income', { token: tok('neha'), body: { amount: 10, description: 'x' } });
  const badIncome = await api('POST', '/api/finance/fundraiser-income', { token: tok('meera'), body: { amount: -5, description: '' } });
  check('same reference recorded twice -> 409; volunteer -> 403; invalid -> 400',
    incomeAgain.status === 409 && volunteerIncome.status === 403 && badIncome.status === 400);

  const ledgerRes = await api('GET', '/api/finance/ledger', { token: tok('meera') });
  const { summary, by_category: byCategory, transactions } = ledgerRes.body;
  const raw = ledgerTotals();
  check('summary: total_in - total_out === net_balance, and matches raw SQL totals',
    ledgerRes.status === 200 && summary.total_in - summary.total_out === summary.net_balance &&
      summary.total_in === raw.total_in && summary.total_out === raw.total_out && summary.transaction_count === raw.n,
    `in ₹${summary.total_in} - out ₹${summary.total_out} = net ₹${summary.net_balance} over ${summary.transaction_count} rows`);

  const rawByCategory = db
    .prepare(`
      SELECT category, COUNT(*) AS n,
             COALESCE(SUM(CASE WHEN type = 'IN' THEN amount ELSE 0 END), 0) AS total_in,
             COALESCE(SUM(CASE WHEN type = 'OUT' THEN amount ELSE 0 END), 0) AS total_out
      FROM ledger_transactions GROUP BY category`)
    .all();
  const sum = (key) => byCategory.reduce((acc, c) => acc + c[key], 0);
  const categoriesMatch = rawByCategory.every((r) => {
    const c = byCategory.find((x) => x.category === r.category);
    return c && c.transaction_count === r.n && c.total_in === r.total_in && c.total_out === r.total_out;
  });
  check('by_category: all 5 categories, each matches raw rows, and the parts sum to the whole',
    byCategory.length === 5 && categoriesMatch &&
      sum('total_in') === summary.total_in && sum('total_out') === summary.total_out && sum('transaction_count') === summary.transaction_count,
    byCategory.map((c) => `${c.category}: ${c.transaction_count} rows, net ₹${c.net}`).join(' | '));

  const chronological = transactions.every((t, i) => i === 0 || transactions[i - 1].created_at >= t.created_at);
  const signedTotal = transactions.reduce((acc, t) => acc + t.signed_amount, 0);
  const payout = transactions.find((t) => t.reference_id === 'RCP-2026-884');
  check('transactions: every row, newest first, signed amounts sum to net_balance',
    transactions.length === raw.n && chronological && signedTotal === summary.net_balance);
  check('the -₹650 payout row names Neha; rows without a user survive the LEFT JOIN',
    payout?.signed_amount === -650 && payout.user_name === 'Neha Sharma' &&
      transactions.some((t) => t.user_id === null && t.user_name === null));

  const outOnly = await api('GET', '/api/finance/ledger?type=OUT', { token: tok('neha') });
  const merchOnly = await api('GET', '/api/finance/ledger?category=merch_sale', { token: tok('neha') });
  const badLedger = await api('GET', '/api/finance/ledger?type=SIDEWAYS', { token: tok('vikram') });
  const studentLedger = await api('GET', '/api/finance/ledger', { token: tok('kabir') });
  check('?type / ?category filter the list (summary stays whole-book); bad filter -> 400; a student can read it too',
    outOnly.status === 200 && outOnly.body.transactions.every((t) => t.type === 'OUT') &&
      outOnly.body.count === db.prepare("SELECT COUNT(*) AS n FROM ledger_transactions WHERE type = 'OUT'").get().n &&
      merchOnly.body.transactions.every((t) => t.category === 'MERCH_SALE') && merchOnly.body.count > 0 &&
      merchOnly.body.summary.net_balance === summary.net_balance && badLedger.status === 400 && studentLedger.status === 200);

  section('EXPLAIN QUERY PLAN — ledger filters');
  const plans = [
    ['?type=&category= seeks idx_ledger_type_category',
      'SELECT l.id FROM ledger_transactions l LEFT JOIN users u ON u.id = l.user_id WHERE l.type = ? AND l.category = ? ORDER BY l.created_at DESC, l.id DESC', ['IN', 'MERCH_SALE']],
    ['?category= alone still seeks the index (type IN (...) prefix)',
      "SELECT l.id FROM ledger_transactions l LEFT JOIN users u ON u.id = l.user_id WHERE l.type IN ('IN', 'OUT') AND l.category = ? ORDER BY l.created_at DESC, l.id DESC", ['MERCH_SALE']],
  ];
  for (const [label, sql, params] of plans) {
    const detail = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((r) => r.detail).join(' | ');
    check(label, /SEARCH l USING (COVERING )?INDEX idx_ledger_type_category \(type=\? AND category=\?\)/.test(detail), detail);
  }
}

async function main() {
  console.log(`Phase 4 verification (temp DB: ${DB_FILE})`);
  try {
    await run();
  } catch (err) {
    check('verification ran to completion', false, err.stack);
  } finally {
    await Promise.all(servers.map((srv) => stopServer(srv.child)));
    if (servers.length) console.log(`\nStopped ${servers.length} test server process(es); port 3000 was never used.`);
    if (db) db.close();
    removeDb(DB_FILE);
    removeDb(FIXTURE_DB);
  }
  summarize();
}

main();
