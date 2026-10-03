'use strict';

const express = require('express');
const { db, withTransaction } = require('../db');
const { HttpError, validationFailed, parseInteger, parseSearchQuery, escapeLike } = require('../lib/http');
const { uniqueCode } = require('../lib/codes');
const { recordTransaction } = require('../lib/ledger');
const { holdForRaceTest } = require('../lib/testHooks');
const { membershipSnapshot } = require('../lib/users');
const { loadViewer } = require('../lib/viewer');
const { requireAuth, optionalAuth, requireRole } = require('../middleware/requireAuth');

const SIZES = ['S', 'M', 'L', 'XL'];
const MAX_QUANTITY = 5;
const FULFILLMENT_STATUSES = ['PAID_PENDING_PICKUP', 'PICKED_UP'];
const STAFF_ROLES = new Set(['VOLUNTEER', 'ADMIN']);
const ORDER_CODE_RE = /^[A-Z0-9-]{4,40}$/;

const router = express.Router();

const VARIANT_WITH_ITEM_SQL = `
  SELECT v.id, v.item_id, v.size, v.stock_count, i.name AS item_name, i.member_price, i.regular_price
  FROM merch_variants v
  JOIN merch_items i ON i.id = v.item_id`;

const ORDER_SQL = `
  SELECT o.id, o.order_code, o.quantity, o.total_paid, o.fulfillment_status, o.created_at,
         o.picked_up_at, o.picked_up_by, p.name AS picked_up_by_name,
         v.id AS variant_id, v.size, i.id AS item_id, i.name AS item_name,
         u.id AS user_id, u.name AS user_name, u.email AS user_email
  FROM merch_orders o
  JOIN merch_variants v ON v.id = o.variant_id
  JOIN merch_items i ON i.id = v.item_id
  JOIN users u ON u.id = o.user_id
  -- LEFT JOIN: orders still awaiting pickup have picked_up_by = NULL
  LEFT JOIN users p ON p.id = o.picked_up_by`;

function toOrderView(row) {
  return {
    id: row.id,
    order_code: row.order_code,
    item_id: row.item_id,
    item_name: row.item_name,
    variant_id: row.variant_id,
    size: row.size,
    quantity: row.quantity,
    unit_price: row.total_paid / row.quantity,
    total_paid: row.total_paid,
    fulfillment_status: row.fulfillment_status,
    created_at: row.created_at,
    buyer: { id: row.user_id, name: row.user_name, email: row.user_email },
    picked_up_at: row.picked_up_at,
    picked_up_by: row.picked_up_by ? { id: row.picked_up_by, name: row.picked_up_by_name } : null,
  };
}

// Public; a signed-in caller also gets the tier and unit price that
// POST /orders will charge them.
router.get('/items', optionalAuth, (req, res) => {
  const viewer = loadViewer(req.user);
  const tier = viewer.authenticated ? (viewer.is_member ? 'MEMBER' : 'REGULAR') : null;
  const items = db
    .prepare(`
      SELECT i.*, COALESCE(s.units_sold, 0) AS units_sold
      FROM merch_items i
      LEFT JOIN (
        SELECT v.item_id, SUM(o.quantity) AS units_sold
        FROM merch_orders o
        JOIN merch_variants v ON v.id = o.variant_id
        GROUP BY v.item_id
      ) s ON s.item_id = i.id
      ORDER BY i.id`)
    .all();
  const variants = db
    .prepare(`
      SELECT id, item_id, size, stock_count FROM merch_variants
      ORDER BY item_id, CASE size WHEN 'S' THEN 1 WHEN 'M' THEN 2 WHEN 'L' THEN 3 WHEN 'XL' THEN 4 END`)
    .all();

  const variantsByItem = new Map(items.map((item) => [item.id, []]));
  for (const v of variants) {
    variantsByItem.get(v.item_id).push({ variant_id: v.id, size: v.size, stock_count: v.stock_count });
  }

  res.json({
    viewer: { authenticated: viewer.authenticated, membership_status: viewer.membership_status, tier },
    items: items.map((item) => {
      const itemVariants = variantsByItem.get(item.id);
      return {
        id: item.id,
        name: item.name,
        description: item.description,
        category: item.category,
        member_price: item.member_price,
        regular_price: item.regular_price,
        your_price: tier === null ? null : tier === 'MEMBER' ? item.member_price : item.regular_price,
        created_at: item.created_at,
        total_stock: itemVariants.reduce((sum, v) => sum + v.stock_count, 0),
        units_sold: item.units_sold,
        variants: itemVariants,
      };
    }),
  });
});

// Accepts { variant_id, quantity } or { item_id, size, quantity }.
function parseOrderInput(body) {
  const details = {};
  const quantity = body.quantity === undefined ? 1 : parseInteger(body.quantity);
  if (quantity === null || quantity < 1 || quantity > MAX_QUANTITY) {
    details.quantity = `quantity must be an integer from 1 to ${MAX_QUANTITY}`;
  }

  const byVariant = body.variant_id !== undefined;
  const byItem = body.item_id !== undefined || body.size !== undefined;
  let target = null;
  if (byVariant && byItem) {
    details.variant_id = 'Send either variant_id, or item_id + size, not both';
  } else if (byVariant) {
    const variantId = parseInteger(body.variant_id);
    if (variantId === null || variantId < 1) details.variant_id = 'variant_id must be a positive integer';
    else target = { variantId };
  } else if (byItem) {
    const itemId = parseInteger(body.item_id);
    const size = typeof body.size === 'string' ? body.size.trim().toUpperCase() : '';
    if (itemId === null || itemId < 1) details.item_id = 'item_id must be a positive integer';
    if (!SIZES.includes(size)) details.size = `size must be one of ${SIZES.join(', ')}`;
    if (!details.item_id && !details.size) target = { itemId, size };
  } else {
    details.variant_id = 'variant_id (or item_id + size) is required';
  }

  if (Object.keys(details).length) throw validationFailed(details);
  return { ...target, quantity };
}

function orderCodeTaken(code) {
  return Boolean(db.prepare('SELECT 1 FROM merch_orders WHERE order_code = ?').get(code));
}

router.post('/orders', requireAuth, (req, res) => {
  const input = parseOrderInput(req.body || {});

  // BEGIN IMMEDIATE holds the write lock from the stock read to the decrement, so
  // two buyers can never both claim the last unit of a size.
  const result = withTransaction(() => {
    const variant = input.variantId
      ? db.prepare(`${VARIANT_WITH_ITEM_SQL} WHERE v.id = ?`).get(input.variantId)
      : db.prepare(`${VARIANT_WITH_ITEM_SQL} WHERE v.item_id = ? AND v.size = ?`).get(input.itemId, input.size);
    if (!variant) throw new HttpError(404, 'Merch item or size not found');

    if (variant.stock_count < input.quantity) {
      const message = variant.stock_count === 0
        ? `Size ${variant.size} is out of stock`
        : `Only ${variant.stock_count} left in size ${variant.size}`;
      throw new HttpError(409, message, { stock_count: variant.stock_count });
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!user) throw new HttpError(401, 'Unauthorized', { reason: 'user no longer exists' });

    // Price comes from the live membership row and the catalogue, never from req.body.
    const tier = membershipSnapshot(user).status === 'ACTIVE' ? 'MEMBER' : 'REGULAR';
    const unitPrice = tier === 'MEMBER' ? variant.member_price : variant.regular_price;
    const totalPaid = unitPrice * input.quantity;

    holdForRaceTest();

    const stock = db
      .prepare('UPDATE merch_variants SET stock_count = stock_count - ? WHERE id = ? AND stock_count >= ?')
      .run(input.quantity, variant.id, input.quantity);
    if (stock.changes !== 1) throw new HttpError(409, `Size ${variant.size} is out of stock`);

    const orderCode = uniqueCode(`ORD-M${variant.item_id}`, orderCodeTaken);
    const createdAt = new Date().toISOString();
    const { lastInsertRowid } = db
      .prepare(`
        INSERT INTO merch_orders (order_code, user_id, variant_id, quantity, total_paid, fulfillment_status, created_at)
        VALUES (?, ?, ?, ?, ?, 'PAID_PENDING_PICKUP', ?)`)
      .run(orderCode, user.id, variant.id, input.quantity, totalPaid, createdAt);

    const transaction = totalPaid > 0
      ? recordTransaction({
        type: 'IN',
        category: 'MERCH_SALE',
        amount: totalPaid,
        description: `${input.quantity}x ${variant.item_name} (${variant.size}) - ${user.name}`,
        referenceId: orderCode,
        userId: user.id,
        createdAt,
      })
      : null;

    return {
      order: db.prepare(`${ORDER_SQL} WHERE o.id = ?`).get(lastInsertRowid),
      tier,
      unitPrice,
      stockLeft: variant.stock_count - input.quantity,
      transaction,
    };
  });

  res.status(201).json({
    order: toOrderView(result.order),
    tier: result.tier,
    unit_price: result.unitPrice,
    total_paid: result.order.total_paid,
    variant: { variant_id: result.order.variant_id, size: result.order.size, stock_count: result.stockLeft },
    transaction: result.transaction,
  });
});

router.get('/orders', requireAuth, (req, res) => {
  let status = null;
  if (req.query.status !== undefined) {
    status = typeof req.query.status === 'string' ? req.query.status.trim().toUpperCase() : '';
    if (!FULFILLMENT_STATUSES.includes(status)) {
      throw validationFailed({ status: `status must be one of ${FULFILLMENT_STATUSES.join(', ')}` });
    }
  }
  const q = parseSearchQuery(req.query.q);
  const isStaff = STAFF_ROLES.has(req.user.role);

  const where = [];
  const params = [];
  if (!isStaff) {
    where.push('o.user_id = ?');
    params.push(req.user.id);
  }
  if (status) {
    where.push('o.fulfillment_status = ?');
    params.push(status);
  }
  if (isStaff && q) {
    const like = `%${escapeLike(q)}%`;
    where.push(`(o.order_code LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\')`);
    params.push(like, like);
  }

  const orders = db
    .prepare(`${ORDER_SQL}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY o.created_at DESC, o.id DESC`)
    .all(...params)
    .map(toOrderView);

  if (!isStaff) return res.json({ filters: { status }, count: orders.length, orders });

  // Desk totals cover every order, independent of the filters.
  const summary = db
    .prepare(`
      SELECT COUNT(*) AS total_orders,
             COALESCE(SUM(fulfillment_status = 'PAID_PENDING_PICKUP'), 0) AS pending_pickup,
             COALESCE(SUM(fulfillment_status = 'PICKED_UP'), 0) AS picked_up,
             COALESCE(SUM(quantity), 0) AS units_sold,
             COALESCE(SUM(total_paid), 0) AS revenue
      FROM merch_orders`)
    .get();

  res.json({ filters: { status, q }, summary, count: orders.length, orders });
});

router.patch('/orders/:code/pickup', requireAuth, requireRole('VOLUNTEER', 'ADMIN'), (req, res) => {
  const code = req.params.code.trim().toUpperCase();
  if (!ORDER_CODE_RE.test(code)) throw validationFailed({ code: 'Order code must be 4-40 letters, digits or dashes' });

  const order = withTransaction(() => {
    // order_code lookup is served by the UNIQUE autoindex on merch_orders(order_code).
    const row = db.prepare(`${ORDER_SQL} WHERE o.order_code = ?`).get(code);
    if (!row) throw new HttpError(404, 'Order not found');
    if (row.fulfillment_status === 'PICKED_UP') {
      throw new HttpError(409, 'Order already picked up', {
        order_code: row.order_code,
        buyer: { name: row.user_name },
        picked_up_at: row.picked_up_at,
        picked_up_by: row.picked_up_by_name,
      });
    }

    const update = db
      .prepare(`
        UPDATE merch_orders SET fulfillment_status = 'PICKED_UP', picked_up_at = ?, picked_up_by = ?
        WHERE id = ? AND fulfillment_status = 'PAID_PENDING_PICKUP'`)
      .run(new Date().toISOString(), req.user.id, row.id);
    if (update.changes !== 1) throw new HttpError(409, 'Order already picked up');
    return db.prepare(`${ORDER_SQL} WHERE o.id = ?`).get(row.id);
  });

  res.json({ message: `Handed over to ${order.user_name}`, order: toOrderView(order) });
});

module.exports = router;
