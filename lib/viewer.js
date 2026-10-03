'use strict';

const { db } = require('../db');
const { membershipSnapshot } = require('./users');

const ANONYMOUS = Object.freeze({ authenticated: false, id: null, role: null, membership_status: 'NONE', is_member: false });

// Who is looking, from the live users row rather than the token, so a member
// who renewed or lapsed since logging in is priced and filtered correctly.
// tokenUser is req.user from requireAuth/optionalAuth (or null).
function loadViewer(tokenUser) {
  if (!tokenUser) return ANONYMOUS;
  const user = db
    .prepare('SELECT id, role, membership_code, membership_status, membership_expires_at FROM users WHERE id = ?')
    .get(tokenUser.id);
  if (!user) return ANONYMOUS;
  const status = membershipSnapshot(user).status;
  return { authenticated: true, id: user.id, role: user.role, membership_status: status, is_member: status === 'ACTIVE' };
}

module.exports = { loadViewer };
