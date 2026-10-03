'use strict';

const { sleepSync } = require('../db');

// Test-only: the verify scripts set TEST_PURCHASE_HOLD_MS to hold a transaction
// open between its availability check (seats, stock, PENDING status) and the
// write, so concurrent requests in separate server processes are guaranteed to
// overlap. Unset in normal runs, where this is a no-op.
const HOLD_MS = Number.parseInt(process.env.TEST_PURCHASE_HOLD_MS, 10) || 0;

function holdForRaceTest() {
  if (HOLD_MS > 0) sleepSync(HOLD_MS);
}

module.exports = { holdForRaceTest };
