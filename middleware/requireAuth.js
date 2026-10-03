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
  const current = db.prepare('SELECT role, email FROM users WHERE id = ?').get(sub);
  if (!current) return { reason: 'user no longer exists' };
  return { user: { id: sub, role: current.role, email: current.email } };
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

module.exports = { requireAuth, optionalAuth, requireRole };
