'use strict';

const express = require('express');
const { db, withTransaction } = require('../db');
const { HttpError, parseSearchQuery, escapeLike } = require('../lib/http');
const { recordTransaction } = require('../lib/ledger');
const {
  membershipSnapshot,
  toPublicUser,
  DAY_MS,
  MEMBERSHIP_FEE,
  MEMBERSHIP_TERM_DAYS,
  RENEWAL_WINDOW_DAYS,
} = require('../lib/users');
const { requireAuth, requireRole } = require('../middleware/requireAuth');

const LOOKUP_LIMIT = 200;

const router = express.Router();

// SKY-<year>-NNN, sequential within the year. Must run inside the purchase
// transaction so two concurrent joins can't be handed the same number.
function nextMembershipCode(year) {
  const prefix = `SKY-${year}-`;
  const { maxSeq } = db
    .prepare('SELECT MAX(CAST(SUBSTR(membership_code, ?) AS INTEGER)) AS maxSeq FROM users WHERE membership_code LIKE ?')
    .get(prefix.length + 1, `${prefix}%`);
  return prefix + String((maxSeq || 0) + 1).padStart(3, '0');
}

router.post('/memberships/join-or-renew', requireAuth, (req, res) => {
  const result = withTransaction(() => {
    const now = Date.now();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!user) throw new HttpError(401, 'Unauthorized', { reason: 'user no longer exists' });

    // An active member extends from their current expiry; anyone else starts today.
    const membership = membershipSnapshot(user, now);
    const currentExpiry = Date.parse(user.membership_expires_at);
    const extendFromExpiry = membership.status === 'ACTIVE' && Number.isFinite(currentExpiry);

    // Double-submit guard: renewals only open inside the renewal window.
    if (extendFromExpiry && !membership.renewal_due) {
      throw new HttpError(409, 'Membership is already active and not yet due for renewal', {
        expires_at: membership.expires_at,
        days_remaining: membership.days_remaining,
        renewal_opens_at: new Date(currentExpiry - RENEWAL_WINDOW_DAYS * DAY_MS).toISOString(),
      });
    }

    const expiresAt = new Date((extendFromExpiry ? currentExpiry : now) + MEMBERSHIP_TERM_DAYS * DAY_MS).toISOString();
    const code = user.membership_code || nextMembershipCode(new Date(now).getFullYear());

    db.prepare(`UPDATE users SET membership_code = ?, membership_status = 'ACTIVE', membership_expires_at = ? WHERE id = ?`)
      .run(code, expiresAt, user.id);

    const transaction = recordTransaction({
      type: 'IN',
      category: 'MEMBERSHIP_DUES',
      amount: MEMBERSHIP_FEE,
      description: `Annual Membership Dues - ${user.name}`,
      referenceId: code,
      userId: user.id,
      createdAt: new Date(now).toISOString(),
    });

    return {
      action: user.membership_code ? 'RENEWED' : 'JOINED',
      extendedFrom: extendFromExpiry ? 'CURRENT_EXPIRY' : 'TODAY',
      user: db.prepare('SELECT * FROM users WHERE id = ?').get(user.id),
      transaction,
    };
  });

  res.json({
    action: result.action,
    extended_from: result.extendedFrom,
    fee: MEMBERSHIP_FEE,
    user: toPublicUser(result.user),
    transaction: result.transaction,
  });
});

// Door verification: is the person in front of me an active member?
router.get('/memberships/lookup', requireAuth, requireRole('VOLUNTEER', 'TREASURER', 'ADMIN'), (req, res) => {
  const q = parseSearchQuery(req.query.q);

  // Ticket counts come from one grouped pass over tickets, not a query per user.
  const select = `
    SELECT u.id, u.name, u.email, u.role, u.membership_code, u.membership_status,
           u.membership_expires_at, u.created_at, COALESCE(tc.n, 0) AS tickets_purchased
    FROM users u
    LEFT JOIN (SELECT user_id, COUNT(*) AS n FROM tickets GROUP BY user_id) tc ON tc.user_id = u.id`;

  let rows;
  if (!q) {
    rows = db
      .prepare(`${select} WHERE u.membership_code IS NOT NULL ORDER BY u.created_at DESC, u.id DESC LIMIT ?`)
      .all(LOOKUP_LIMIT);
  } else {
    const code = q.toUpperCase();
    const contains = `%${escapeLike(q)}%`;
    rows = db
      .prepare(`${select}
        WHERE u.membership_code = ?
           OR u.membership_code LIKE ? ESCAPE '\\'
           OR u.email LIKE ? ESCAPE '\\'
           OR u.name LIKE ? ESCAPE '\\'
        ORDER BY CASE WHEN u.membership_code = ? THEN 0 ELSE 1 END, u.name
        LIMIT ?`)
      .all(code, `${escapeLike(code)}%`, contains, contains, code, LOOKUP_LIMIT);
  }

  res.json({
    query: q,
    count: rows.length,
    results: rows.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      role: row.role,
      created_at: row.created_at,
      membership: membershipSnapshot(row),
      tickets_purchased: row.tickets_purchased,
    })),
  });
});

module.exports = router;
