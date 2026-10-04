'use strict';

const express = require('express');
const { db, withTransaction } = require('../db');
const { HttpError, validationFailed, parsePositiveInt } = require('../lib/http');
const { membershipSnapshot } = require('../lib/users');
const { requireAuth, requireRole } = require('../middleware/requireAuth');

const ROLES = ['STUDENT', 'VOLUNTEER', 'TREASURER', 'ADMIN'];
const SCOPES = ['ALL', 'EVENTS_ONLY', 'MERCH_ONLY', 'BAKE_SALE_ONLY', 'FINANCE_ONLY'];
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
    access_scope: user.access_scope || 'ALL',
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
  // role and/or access_scope; whichever is left out keeps its current value.
  const roleSent = req.body?.role !== undefined;
  const scopeSent = req.body?.access_scope !== undefined;
  const requested = typeof req.body?.role === 'string' ? req.body.role.trim().toUpperCase() : '';
  const scope = typeof req.body?.access_scope === 'string' ? req.body.access_scope.trim().toUpperCase() : '';

  const details = {};
  if (!targetId) details.id = 'User id must be a positive integer';
  if ((roleSent || !scopeSent) && !ROLES.includes(requested)) details.role = `role must be one of ${ROLES.join(', ')}`;
  if (scopeSent && !SCOPES.includes(scope)) details.access_scope = `access_scope must be one of ${SCOPES.join(', ')}`;
  if (Object.keys(details).length) throw validationFailed(details);

  if (targetId === req.user.id) throw new HttpError(403, 'Forbidden', { reason: 'You cannot change your own role' });
  if (targetId === FOUNDING_ADMIN_ID) throw new HttpError(403, 'Forbidden', { reason: "The Founding Admin's role cannot be modified" });

  const isFounder = req.user.id === FOUNDING_ADMIN_ID;
  const result = withTransaction(() => {
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
    if (!target) throw new HttpError(404, 'User not found');
    const role = roleSent ? requested : target.role;
    const accessScope = scopeSent ? scope : target.access_scope || 'ALL';
    if (!isFounder && (role === 'ADMIN' || target.role === 'ADMIN')) {
      throw new HttpError(403, 'Forbidden', { reason: SECOND_ADMIN_LIMIT });
    }
    db.prepare('UPDATE users SET role = ?, access_scope = ? WHERE id = ?').run(role, accessScope, targetId);
    return { previous: target.role, previousScope: target.access_scope || 'ALL', user: db.prepare('SELECT * FROM users WHERE id = ?').get(targetId) };
  });

  res.json({
    user: toAccessView(result.user),
    previous_role: result.previous,
    previous_scope: result.previousScope,
    changed: result.previous !== result.user.role || result.previousScope !== result.user.access_scope,
  });
});

module.exports = router;
