'use strict';

const crypto = require('node:crypto');

const SALT_BYTES = 16;
const KEY_LENGTH = 64;
const HEX_RE = /^[0-9a-f]+$/i;

// Stored format: "<saltHex>:<hashHex>"
function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = crypto.scryptSync(password, salt, KEY_LENGTH);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split(':');
  if (parts.length !== 2) return false;
  const [saltHex, hashHex] = parts;
  if (!HEX_RE.test(saltHex) || !HEX_RE.test(hashHex)) return false;

  const expected = Buffer.from(hashHex, 'hex');
  if (expected.length !== KEY_LENGTH) return false;
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), KEY_LENGTH);
  return crypto.timingSafeEqual(actual, expected);
}

// A real hash of a random secret. Login verifies against it when the email is
// unknown, so "no such user" and "wrong password" take the same time.
let dummyHash = null;
function getDummyHash() {
  if (!dummyHash) dummyHash = hashPassword(crypto.randomBytes(16).toString('hex'));
  return dummyHash;
}

module.exports = { hashPassword, verifyPassword, getDummyHash };
