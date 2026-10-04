'use strict';

const { db } = require('../db');
const { verify } = require('../lib/token');

const BEARER_RE = /^Bearer\s+(\S+)\s*$/i;

function unauthorized(res, reason) {
  res.set('WWW-Authenticate', 'Bearer');
  return res.status(401).json({ error: 'Unauthorized', reason });
}

// { user } for a valid token, { reason } for a bad one, {} when no header was sent.
function authenticate(req) {
  const header = req.get('authorization');
  if (!header) return {};
  const match = BEARER_RE.exec(header);
  if (!match) return { reason: 'missing bearer token' };

  const result = verify(match[1]);
  if (!result.valid) return { reason: result.reason };

  const { sub, role } = result.payload;
  if (!Number.isInteger(sub) || typeof role !== 'string') return { reason: 'malformed payload' };

  // The role is read live from the users row, not trusted from the token, so a
  // promotion or demotion by an admin takes effect on the very next request.
  const current = db.prepare('SELECT role, email, access_scope FROM users WHERE id = ?').get(sub);
  if (!current) return { reason: 'user no longer exists' };
  return { user: { id: sub, role: current.role, email: current.email, access_scope: current.access_scope || 'ALL' } };
}

function requireAuth(req, res, next) {
  const { user, reason } = authenticate(req);
  if (!user) return unauthorized(res, reason || 'missing bearer token');
  req.user = user;
  next();
}

// For public endpoints that show more to signed-in users. No token means
// anonymous (req.user = null); a token that is sent but invalid is still a 401,
// so a client holding a stale or tampered token finds out.
function optionalAuth(req, res, next) {
  const { user, reason } = authenticate(req);
  if (reason) return unauthorized(res, reason);
  req.user = user || null;
  next();
}

// Usage: router.post('/x', requireAuth, requireRole('ADMIN', 'VOLUNTEER'), handler)
function requireRole(...allowedRoles) {
  const allowed = new Set(allowedRoles);
  return function roleGuard(req, res, next) {
    if (!req.user) return unauthorized(res, 'missing bearer token');
    if (!allowed.has(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden', reason: `requires role: ${allowedRoles.join(' or ')}` });
    }
    next();
  };
}

// Project boundaries for delegated admins and staff. A user scoped to one
// module (e.g. BAKE_SALE_ONLY) can manage only that module; 'ALL' is unrestricted.
const SCOPE_LABEL = {
  ALL: 'Full Club Access',
  EVENTS_ONLY: 'Events Project',
  MERCH_ONLY: 'Merch Store',
  BAKE_SALE_ONLY: 'Bake Sale Project',
  FINANCE_ONLY: 'Finance & Books',
};

// Usage: router.post('/x', requireAuth, requireRole('ADMIN'), requireScope('MERCH'), handler)
function requireScope(module) {
  return function scopeGuard(req, res, next) {
    const scope = req.user?.access_scope || 'ALL';
    if (scope === 'ALL' || scope === `${module}_ONLY`) return next();
    return res.status(403).json({ error: 'Forbidden', reason: `Your admin access is scoped strictly to: ${SCOPE_LABEL[scope] || scope}` });
  };
}

module.exports = { requireAuth, optionalAuth, requireRole, requireScope, SCOPE_LABEL };
