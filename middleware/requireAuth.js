'use strict';

const { verify } = require('../lib/token');

const BEARER_RE = /^Bearer\s+(\S+)\s*$/i;

function unauthorized(res, reason) {
  res.set('WWW-Authenticate', 'Bearer');
  return res.status(401).json({ error: 'Unauthorized', reason });
}

function requireAuth(req, res, next) {
  const match = BEARER_RE.exec(req.get('authorization') || '');
  if (!match) return unauthorized(res, 'missing bearer token');

  const result = verify(match[1]);
  if (!result.valid) return unauthorized(res, result.reason);

  const { sub, role, email } = result.payload;
  if (!Number.isInteger(sub) || typeof role !== 'string') return unauthorized(res, 'malformed payload');

  req.user = { id: sub, role, email };
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

module.exports = { requireAuth, requireRole };
