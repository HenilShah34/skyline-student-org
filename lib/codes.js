'use strict';

const crypto = require('node:crypto');

// No 0/O, 1/I/L: codes get read aloud and typed in at the door.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomCode(length) {
  let code = '';
  for (let i = 0; i < length; i++) code += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return code;
}

// `${prefix}-XXXXXX`, retried until isTaken(code) is false. Call inside the
// transaction that inserts the code so the check can't go stale.
function uniqueCode(prefix, isTaken, length = 6) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = `${prefix}-${randomCode(length)}`;
    if (!isTaken(code)) return code;
  }
  throw new Error(`Could not generate a unique ${prefix} code`);
}

module.exports = { randomCode, uniqueCode };
