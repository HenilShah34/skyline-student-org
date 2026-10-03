'use strict';

const { db } = require('../db');

// Appends an immutable ledger row and returns it. Call inside withTransaction so
// the entry commits or rolls back together with the sale it records.
function recordTransaction({ type, category, amount, description, referenceId = null, userId = null, createdAt = new Date().toISOString() }) {
  const { lastInsertRowid } = db
    .prepare(`
      INSERT INTO ledger_transactions (type, category, amount, description, reference_id, user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(type, category, amount, description, referenceId, userId, createdAt);
  return db.prepare('SELECT * FROM ledger_transactions WHERE id = ?').get(lastInsertRowid);
}

module.exports = { recordTransaction };
