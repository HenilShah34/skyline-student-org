'use strict';

const crypto = require('node:crypto');

// A fixed dev default keeps demo sessions valid across server restarts.
// Set TOKEN_SECRET in any real deployment.
const DEFAULT_SECRET = 'skyline-student-org-dev-secret-ldce-2026';
const SECRET = process.env.TOKEN_SECRET || DEFAULT_SECRET;
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

if (!process.env.TOKEN_SECRET && process.env.NODE_ENV === 'production') {
  console.warn('[token] TOKEN_SECRET is not set; using the built-in development secret');
}

function signatureFor(encodedPayload) {
  return crypto.createHmac('sha256', SECRET).update(encodedPayload).digest('base64url');
}

// Token format: base64url(JSON payload) + "." + base64url(HMAC-SHA256)
function sign(payload, { ttlSeconds = DEFAULT_TTL_SECONDS } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const body = { iat: now, exp: now + ttlSeconds, ...payload };
  const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  return `${encoded}.${signatureFor(encoded)}`;
}

function invalid(reason) {
  return { valid: false, reason };
}

// Returns { valid: true, payload } or { valid: false, reason }.
// The signature is checked before the payload is decoded or trusted.
function verify(token) {
  if (typeof token !== 'string') return invalid('malformed token');
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return invalid('malformed token');
  const [encoded, signature] = parts;

  const expected = Buffer.from(signatureFor(encoded), 'utf8');
  const given = Buffer.from(signature, 'utf8');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return invalid('signature mismatch');
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return invalid('malformed payload');
  }
  if (!payload || typeof payload !== 'object' || typeof payload.exp !== 'number') {
    return invalid('malformed payload');
  }
  if (payload.exp <= Math.floor(Date.now() / 1000)) return invalid('token expired');

  return { valid: true, payload };
}

module.exports = { sign, verify };
