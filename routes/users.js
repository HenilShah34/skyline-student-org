'use strict';

const express = require('express');
const { db, withTransaction } = require('../db');
const { HttpError, validationFailed, parsePositiveInt } = require('../lib/http');
const { membershipSnapshot } = require('../lib/users');
const { requireAuth, requireRole } = require('../middleware/requireAuth');

const ROLES = ['STUDENT', 'VOLUNTEER', 'TREASURER', 'ADMIN'];
// The first account (the club's founding admin) sits at the top of the access
// hierarchy: nobody can change it, and only it can grant or change ADMIN.
const FOUNDING_ADMIN_ID = 1;
const SECOND_ADMIN_LIMIT =
  'Only the Founding Admin can grant or modify Admin access. You may assign Student, Volunteer, or Treasurer roles.';

const router = express.Router();

function toAccessView(user) {
  const membership = membershipSnapshot(user);
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    membership_code: user.membership_code,
    membership_status: membership.status,
    is_founding_admin: user.id === FOUNDING_ADMIN_ID,
    created_at: user.created_at,
  };
}

router.get('/', requireAuth, requireRole('ADMIN'), (req, res) => {
  const users = db.prepare('SELECT * FROM users ORDER BY id').all().map(toAccessView);
  res.json({
    viewer: { id: req.user.id, is_founding_admin: req.user.id === FOUNDING_ADMIN_ID },
    count: users.length,
    users,
  });
});

router.patch('/:id/role', requireAuth, requireRole('ADMIN'), (req, res) => {
  const targetId = parsePositiveInt(req.params.id);
  const role = typeof req.body?.role === 'string' ? req.body.role.trim().toUpperCase() : '';

  const details = {};
  if (!targetId) details.id = 'User id must be a positive integer';
  if (!ROLES.includes(role)) details.role = `role must be one of ${ROLES.join(', ')}`;
  if (Object.keys(details).length) throw validationFailed(details);

  if (targetId === req.user.id) throw new HttpError(403, 'Forbidden', { reason: 'You cannot change your own role' });
  if (targetId === FOUNDING_ADMIN_ID) throw new HttpError(403, 'Forbidden', { reason: "The Founding Admin's role cannot be modified" });

  const isFounder = req.user.id === FOUNDING_ADMIN_ID;
  const result = withTransaction(() => {
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
    if (!target) throw new HttpError(404, 'User not found');
    if (!isFounder && (role === 'ADMIN' || target.role === 'ADMIN')) {
      throw new HttpError(403, 'Forbidden', { reason: SECOND_ADMIN_LIMIT });
    }
    if (target.role !== role) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, targetId);
    return { previous: target.role, user: db.prepare('SELECT * FROM users WHERE id = ?').get(targetId) };
  });

  res.json({ user: toAccessView(result.user), previous_role: result.previous, changed: result.previous !== role });
});

module.exports = router;
