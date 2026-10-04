'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
// renewal_due turns on this many days before expiry; join-or-renew refuses
// active members outside the window, so a double-click can't charge twice.
const RENEWAL_WINDOW_DAYS = 30;
const MEMBERSHIP_FEE = 500; // ₹ per annual term
const MEMBERSHIP_TERM_DAYS = 365;

// Live view of a membership: an ACTIVE row whose expiry has passed reports
// EXPIRED, and anything expiring within the renewal window is flagged.
function membershipSnapshot(user, now = Date.now()) {
  const expiresMs = user.membership_expires_at ? Date.parse(user.membership_expires_at) : NaN;
  let status = user.membership_status;
  if (status === 'ACTIVE' && Number.isFinite(expiresMs) && expiresMs <= now) status = 'EXPIRED';

  const daysRemaining =
    status === 'ACTIVE' && Number.isFinite(expiresMs) ? Math.ceil((expiresMs - now) / DAY_MS) : null;

  return {
    code: user.membership_code,
    status,
    expires_at: user.membership_expires_at,
    days_remaining: daysRemaining,
    is_active: status === 'ACTIVE',
    renewal_due: status === 'EXPIRED' || (daysRemaining !== null && daysRemaining <= RENEWAL_WINDOW_DAYS),
  };
}

// Never expose password_hash.
function toPublicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    created_at: user.created_at,
    access_scope: user.access_scope || 'ALL',
    membership: membershipSnapshot(user),
  };
}

module.exports = {
  membershipSnapshot,
  toPublicUser,
  DAY_MS,
  RENEWAL_WINDOW_DAYS,
  MEMBERSHIP_FEE,
  MEMBERSHIP_TERM_DAYS,
};
