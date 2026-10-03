'use strict';

const { sleepSync } = require('../db');

// Test-only: the verify scripts set TEST_PURCHASE_HOLD_MS to hold a purchase
// transaction open between the availability check and the decrement, so
// concurrent buyers in separate server processes are guaranteed to overlap.
// Unset in normal runs, where this is a no-op.
const PURCHASE_HOLD_MS = Number.parseInt(process.env.TEST_PURCHASE_HOLD_MS, 10) || 0;

function holdPurchaseForTests() {
  if (PURCHASE_HOLD_MS > 0) sleepSync(PURCHASE_HOLD_MS);
}

module.exports = { holdPurchaseForTests };
