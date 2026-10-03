'use strict';

const express = require('express');
const { db, withTransaction } = require('../db');
const { HttpError, validationFailed, parsePositiveInt, parseInteger, parseEnumParam } = require('../lib/http');
const { recordTransaction } = require('../lib/ledger');
const { holdForRaceTest } = require('../lib/testHooks');
const { requireAuth, requireRole } = require('../middleware/requireAuth');

const STAFF_ROLES = new Set(['VOLUNTEER', 'TREASURER', 'ADMIN']);
const EXPENSE_CATEGORIES = ['FUNDRAISER_SUPPLIES', 'EVENT_COSTS', 'OPERATIONS', 'MARKETING'];
const REIMBURSEMENT_STATUSES = ['PENDING', 'APPROVED_PAID', 'REJECTED'];
const DECISIONS = ['APPROVED_PAID', 'REJECTED'];
const LEDGER_TYPES = ['IN', 'OUT'];
const LEDGER_CATEGORIES = ['MEMBERSHIP_DUES', 'TICKET_SALE', 'MERCH_SALE', 'FUNDRAISER_INCOME', 'EXPENSE_REIMBURSEMENT'];
const MAX_AMOUNT = 1000000; // ₹10 lakh
const MAX_TITLE = 150;
const MAX_DESCRIPTION = 200;
const MAX_REFERENCE = 60;

const router = express.Router();

const REIMBURSEMENT_SQL = `
  SELECT r.id, r.title, r.category, r.amount, r.receipt_reference, r.status, r.created_at,
         r.volunteer_id, v.name AS volunteer_name, v.email AS volunteer_email,
         r.approved_by, a.name AS approved_by_name,
         l.id AS ledger_transaction_id, l.created_at AS paid_at
  FROM expense_reimbursements r
  JOIN users v ON v.id = r.volunteer_id
  -- LEFT JOIN: PENDING requests have approved_by = NULL and must still be listed
  LEFT JOIN users a ON a.id = r.approved_by
  -- The payout row (for the payment voucher). Seeks idx_ledger_type_category on
  -- (type, category); the reference and volunteer pin the one matching row.
  LEFT JOIN ledger_transactions l
    ON r.status = 'APPROVED_PAID' AND l.type = 'OUT' AND l.category = 'EXPENSE_REIMBURSEMENT'
   AND l.reference_id = r.receipt_reference AND l.user_id = r.volunteer_id`;

function readText(value, max) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && text.length <= max ? text : null;
}

function readAmount(value) {
  const amount = parseInteger(value);
  return amount !== null && amount > 0 && amount <= MAX_AMOUNT ? amount : null;
}

// Whole-book totals. net_balance is summed independently in SQL, so
// total_in - total_out === net_balance is a real cross-check, not a tautology.
function ledgerSummary() {
  return db
    .prepare(`
      SELECT COALESCE(SUM(CASE WHEN type = 'IN' THEN amount ELSE 0 END), 0) AS total_in,
             COALESCE(SUM(CASE WHEN type = 'OUT' THEN amount ELSE 0 END), 0) AS total_out,
             COALESCE(SUM(CASE WHEN type = 'IN' THEN amount ELSE -amount END), 0) AS net_balance,
             COUNT(*) AS transaction_count
      FROM ledger_transactions`)
    .get();
}

router.get('/reimbursements', requireAuth, (req, res) => {
  const status = parseEnumParam(req.query.status, REIMBURSEMENT_STATUSES, 'status');
  const isStaff = STAFF_ROLES.has(req.user.role);

  const where = [];
  const params = [];
  if (!isStaff) {
    where.push('r.volunteer_id = ?');
    params.push(req.user.id);
  }
  if (status) {
    where.push('r.status = ?');
    params.push(status);
  }

  // Pending first: that's the treasurer's review queue.
  const reimbursements = db
    .prepare(`${REIMBURSEMENT_SQL}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
      ORDER BY CASE r.status WHEN 'PENDING' THEN 0 ELSE 1 END, r.created_at DESC, r.id DESC`)
    .all(...params);

  if (!isStaff) return res.json({ filters: { status }, count: reimbursements.length, reimbursements });

  const summary = db
    .prepare(`
      SELECT COALESCE(SUM(CASE WHEN status = 'PENDING' THEN amount END), 0) AS pending_amount,
             COALESCE(SUM(CASE WHEN status = 'APPROVED_PAID' THEN amount END), 0) AS approved_paid_amount,
             COALESCE(SUM(CASE WHEN status = 'REJECTED' THEN amount END), 0) AS rejected_amount,
             COALESCE(SUM(status = 'PENDING'), 0) AS pending_count,
             COALESCE(SUM(status = 'APPROVED_PAID'), 0) AS approved_paid_count,
             COALESCE(SUM(status = 'REJECTED'), 0) AS rejected_count
      FROM expense_reimbursements`)
    .get();

  res.json({ filters: { status }, summary, count: reimbursements.length, reimbursements });
});

router.post('/reimbursements', requireAuth, requireRole('VOLUNTEER', 'TREASURER', 'ADMIN'), (req, res) => {
  const body = req.body || {};
  const title = readText(body.title, MAX_TITLE);
  const category = typeof body.category === 'string' ? body.category.trim().toUpperCase() : '';
  const amount = readAmount(body.amount);
  const receipt = readText(body.receipt_reference, MAX_REFERENCE);

  const details = {};
  if (!title) details.title = `Title is required (at most ${MAX_TITLE} characters)`;
  if (!EXPENSE_CATEGORIES.includes(category)) details.category = `category must be one of ${EXPENSE_CATEGORIES.join(', ')}`;
  if (!amount) details.amount = `amount must be a positive whole number of rupees up to ${MAX_AMOUNT}`;
  if (!receipt) details.receipt_reference = `receipt_reference is required (at most ${MAX_REFERENCE} characters)`;
  if (Object.keys(details).length) throw validationFailed(details);

  // No ledger entry here: money only leaves the club when an admin approves it.
  const reimbursement = withTransaction(() => {
    // The same receipt can't be claimed twice unless the earlier claim was rejected.
    const existing = db
      .prepare(`
        SELECT id, status, receipt_reference FROM expense_reimbursements
        WHERE volunteer_id = ? AND UPPER(receipt_reference) = UPPER(?) AND status != 'REJECTED'`)
      .get(req.user.id, receipt);
    if (existing) {
      throw new HttpError(409, `Receipt ${existing.receipt_reference} was already submitted (request #${existing.id}, ${existing.status})`, {
        reimbursement_id: existing.id,
      });
    }

    const { lastInsertRowid } = db
      .prepare(`
        INSERT INTO expense_reimbursements (volunteer_id, title, category, amount, receipt_reference, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'PENDING', ?)`)
      .run(req.user.id, title, category, amount, receipt, new Date().toISOString());
    return db.prepare(`${REIMBURSEMENT_SQL} WHERE r.id = ?`).get(lastInsertRowid);
  });

  res.status(201).json({ reimbursement });
});

router.patch('/reimbursements/:id/review', requireAuth, requireRole('TREASURER', 'ADMIN'), (req, res) => {
  const id = parsePositiveInt(req.params.id);
  if (!id) throw validationFailed({ id: 'Reimbursement id must be a positive integer' });
  const decision = typeof req.body?.decision === 'string' ? req.body.decision.trim().toUpperCase() : '';
  if (!DECISIONS.includes(decision)) throw validationFailed({ decision: `decision must be one of ${DECISIONS.join(', ')}` });

  // BEGIN IMMEDIATE holds the write lock from the PENDING check to the payout, so
  // two admins clicking Approve at once can't both pay the same receipt.
  const result = withTransaction(() => {
    const row = db.prepare(`${REIMBURSEMENT_SQL} WHERE r.id = ?`).get(id);
    if (!row) throw new HttpError(404, 'Reimbursement not found');
    if (row.volunteer_id === req.user.id) {
      throw new HttpError(403, 'Forbidden', { reason: 'nobody can review their own reimbursement' });
    }
    if (row.status !== 'PENDING') {
      throw new HttpError(409, `Reimbursement already ${row.status}`, { status: row.status, approved_by_name: row.approved_by_name });
    }

    holdForRaceTest();

    const update = db
      .prepare(`UPDATE expense_reimbursements SET status = ?, approved_by = ? WHERE id = ? AND status = 'PENDING'`)
      .run(decision, req.user.id, id);
    if (update.changes !== 1) throw new HttpError(409, 'Reimbursement already reviewed');

    const transaction = decision === 'APPROVED_PAID'
      ? recordTransaction({
        type: 'OUT',
        category: 'EXPENSE_REIMBURSEMENT',
        amount: row.amount,
        description: `Reimbursement: ${row.title} (${row.receipt_reference}) - ${row.volunteer_name}`,
        referenceId: row.receipt_reference,
        userId: row.volunteer_id,
      })
      : null;

    return { reimbursement: db.prepare(`${REIMBURSEMENT_SQL} WHERE r.id = ?`).get(id), transaction };
  });

  res.json(result);
});

// ?category= takes one category or a comma-separated list (MERCH_SALE,FUNDRAISER_INCOME).
function parseCategories(value) {
  if (value === undefined) return [];
  const list = typeof value === 'string' ? value.split(',').map((c) => c.trim().toUpperCase()).filter(Boolean) : [];
  if (!list.length || list.some((c) => !LEDGER_CATEGORIES.includes(c))) {
    throw validationFailed({ category: `category must be one or more of ${LEDGER_CATEGORIES.join(', ')} (comma-separated)` });
  }
  return [...new Set(list)];
}

// The treasurer's four questions, answered from the same grouped totals:
// dues collected, tickets sold, merchandise sold (plus fundraiser takings), and
// every volunteer expense reimbursed, with claims still awaiting review.
function semesterStory(byCategory, summary) {
  const of = (category) => byCategory.find((c) => c.category === category);
  const inflow = (category) => ({ amount: of(category).total_in, count: of(category).transaction_count });
  const expenses = of('EXPENSE_REIMBURSEMENT');
  const pending = db
    .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount FROM expense_reimbursements WHERE status = 'PENDING'")
    .get();
  return {
    came_in: summary.total_in,
    went_out: summary.total_out,
    left: summary.net_balance,
    dues_collected: inflow('MEMBERSHIP_DUES'),
    tickets_sold: inflow('TICKET_SALE'),
    merch_sold: inflow('MERCH_SALE'),
    fundraiser_income: inflow('FUNDRAISER_INCOME'),
    expenses_reimbursed: {
      amount: expenses.total_out,
      count: expenses.transaction_count,
      pending_count: pending.n,
      pending_amount: pending.amount,
    },
  };
}

// Codes are bearer credentials: a ticket code gets someone in at the door, an
// order code collects merch at the desk, and a membership code is one of the
// two facts that reset a password. A masked code keeps only its prefix.
function maskCode(code) {
  if (!code) return code;
  const cut = code.lastIndexOf('-');
  return `${cut > 0 ? code.slice(0, cut + 1) : ''}•••`;
}

// Categories whose description ends in " - <member name at the time>".
const NAME_SUFFIX_CATEGORIES = new Set(['MEMBERSHIP_DUES', 'MERCH_SALE', 'EXPENSE_REIMBURSEMENT']);

// A student sees every amount, but another person's row loses their name, their
// codes and the name inside the description. The trailing name is replaced by
// position, so it is hidden even if that member has since changed their name.
function maskTransaction(t) {
  const label = t.category === 'EXPENSE_REIMBURSEMENT' ? 'Volunteer' : 'Club Member';
  let description = t.description;
  if (t.reference_id) description = description.split(t.reference_id).join(maskCode(t.reference_id));
  if (t.user_name) description = description.split(t.user_name).join(label);
  if (NAME_SUFFIX_CATEGORIES.has(t.category)) description = description.replace(/ - (?:(?! - ).)*$/, ` - ${label}`);
  return { ...t, user_id: null, user_name: label, reference_id: maskCode(t.reference_id), description, masked: true };
}

// Open to every signed-in member: the club wants anyone on the team to see what
// came in, what went out and what is left. Changing the books stays with the
// Treasurer and Admin (review, fundraiser income, CSV export).
router.get('/ledger', requireAuth, (req, res) => {
  const type = parseEnumParam(req.query.type, LEDGER_TYPES, 'type');
  const categories = parseCategories(req.query.category);

  // Every category appears, even with no rows, so the breakdown always reads the
  // same way. In and out are split per category so a future refund (OUT on
  // TICKET_SALE) still adds up.
  const grouped = new Map(
    db
      .prepare(`
        SELECT category, COUNT(*) AS transaction_count,
               SUM(CASE WHEN type = 'IN' THEN amount ELSE 0 END) AS total_in,
               SUM(CASE WHEN type = 'OUT' THEN amount ELSE 0 END) AS total_out
        FROM ledger_transactions
        GROUP BY category`)
      .all()
      .map((r) => [r.category, r]),
  );
  const byCategory = LEDGER_CATEGORIES.map((c) => {
    const r = grouped.get(c) || { transaction_count: 0, total_in: 0, total_out: 0 };
    return { category: c, transaction_count: r.transaction_count, total_in: r.total_in, total_out: r.total_out, net: r.total_in - r.total_out };
  });

  // Filters seek on idx_ledger_type_category(type, category, created_at). With
  // only ?category=, "type IN ('IN', 'OUT')" is always true (CHECK constraint)
  // but gives the planner the leading column it needs to use the index.
  const where = [];
  const params = [];
  if (type) {
    where.push('l.type = ?');
    params.push(type);
  } else if (categories.length) {
    where.push("l.type IN ('IN', 'OUT')");
  }
  if (categories.length) {
    where.push(`l.category IN (${categories.map(() => '?').join(', ')})`);
    params.push(...categories);
  }

  const transactions = db
    .prepare(`
      SELECT l.id, l.type, l.category, l.amount, l.description, l.reference_id, l.created_at,
             l.user_id, u.name AS user_name
      FROM ledger_transactions l
      -- LEFT JOIN: box-office sales and fundraiser income have no user attached
      LEFT JOIN users u ON u.id = l.user_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY l.created_at DESC, l.id DESC`)
    .all(...params)
    .map((t) => ({ ...t, signed_amount: t.type === 'IN' ? t.amount : -t.amount, masked: false }));

  // Students see their own rows in full; other people's rows are masked here,
  // on the server, so the names never reach the browser. Rows with no person
  // attached (fundraiser takings) have nothing to hide. Staff see everything.
  const maskOthers = req.user.role === 'STUDENT';
  const visible = maskOthers
    ? transactions.map((t) => (t.user_id !== null && t.user_id !== req.user.id ? maskTransaction(t) : t))
    : transactions;
  const maskedRows = visible.filter((t) => t.masked).length;

  const summary = ledgerSummary();
  res.json({
    generated_at: new Date().toISOString(),
    summary,
    semester_story: semesterStory(byCategory, summary),
    by_category: byCategory,
    filters: { type, category: categories.length ? categories.join(',') : null },
    privacy: { masked_for_viewer: maskOthers, masked_rows: maskedRows },
    count: visible.length,
    transactions: visible,
  });
});

router.post('/fundraiser-income', requireAuth, requireRole('TREASURER', 'ADMIN'), (req, res) => {
  const body = req.body || {};
  const amount = readAmount(body.amount);
  const description = readText(body.description, MAX_DESCRIPTION);
  const referenceId = body.reference_id == null || body.reference_id === '' ? null : readText(body.reference_id, MAX_REFERENCE);

  const details = {};
  if (!amount) details.amount = `amount must be a positive whole number of rupees up to ${MAX_AMOUNT}`;
  if (!description) details.description = `description is required (at most ${MAX_DESCRIPTION} characters)`;
  if (body.reference_id != null && body.reference_id !== '' && !referenceId) {
    details.reference_id = `reference_id must be text of at most ${MAX_REFERENCE} characters`;
  }
  if (Object.keys(details).length) throw validationFailed(details);

  const transaction = withTransaction(() => {
    // Recording the same collection twice would inflate the books.
    if (referenceId) {
      const existing = db
        .prepare(`SELECT id FROM ledger_transactions WHERE category = 'FUNDRAISER_INCOME' AND UPPER(reference_id) = UPPER(?)`)
        .get(referenceId);
      if (existing) {
        throw new HttpError(409, `Fundraiser income ${referenceId} is already recorded (ledger #${existing.id})`, {
          transaction_id: existing.id,
        });
      }
    }
    return recordTransaction({ type: 'IN', category: 'FUNDRAISER_INCOME', amount, description, referenceId });
  });

  res.status(201).json({ transaction, summary: ledgerSummary() });
});

// ---------------------------------------------------------------- CSV export

const CSV_COLUMNS = ['id', 'created_at', 'type', 'category', 'signed_amount', 'reference_id', 'member_name', 'description'];

// One RFC 4180 field. Text that a spreadsheet would treat as a formula
// (=, +, -, @, tab, CR) gets a leading ' so opening the file can't run it.
// Numbers are written as-is so they stay numeric.
function csvCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvRow(values) {
  return values.map(csvCell).join(',');
}

// The whole book, oldest first, plus TOTAL_IN / TOTAL_OUT / NET_BALANCE rows
// that use the same 8 columns (label in "id", amount in "signed_amount").
router.get('/ledger/export.csv', requireAuth, requireRole('TREASURER', 'ADMIN'), (req, res) => {
  const rows = db
    .prepare(`
      SELECT l.id, l.created_at, l.type, l.category,
             CASE WHEN l.type = 'IN' THEN l.amount ELSE -l.amount END AS signed_amount,
             l.reference_id, u.name AS member_name, l.description
      FROM ledger_transactions l
      -- LEFT JOIN: box-office sales and fundraiser income have no user attached
      LEFT JOIN users u ON u.id = l.user_id
      ORDER BY l.created_at ASC, l.id ASC`)
    .all();
  const summary = ledgerSummary();

  const lines = [
    csvRow(CSV_COLUMNS),
    ...rows.map((r) => csvRow(CSV_COLUMNS.map((c) => r[c]))),
    csvRow(['TOTAL_IN', '', '', '', summary.total_in, '', '', '']),
    csvRow(['TOTAL_OUT', '', '', '', -summary.total_out, '', '', '']),
    csvRow(['NET_BALANCE', '', '', '', summary.net_balance, '', '', '']),
  ];

  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="skyline-semester-ledger.csv"');
  res.set('Cache-Control', 'no-store');
  // BOM so Excel reads the file as UTF-8 (₹, em dashes); RFC 4180 uses CRLF.
  res.send(`﻿${lines.join('\r\n')}\r\n`);
});

module.exports = router;
