'use strict';

const express = require('express');
const { db, withTransaction } = require('../db');
const { HttpError, validationFailed, parseInteger, parsePositiveInt, parseSearchQuery, escapeLike } = require('../lib/http');
const { uniqueCode } = require('../lib/codes');
const { recordTransaction } = require('../lib/ledger');
const { holdForRaceTest } = require('../lib/testHooks');
const { membershipSnapshot } = require('../lib/users');
const { loadViewer } = require('../lib/viewer');
const { requireAuth, optionalAuth, requireRole, requireScope, SCOPE_LABEL } = require('../middleware/requireAuth');

const SIZES = ['S', 'M', 'L', 'XL'];
const MAX_QUANTITY = 5;
const MAX_RESTOCK = 500; // units per restock call
const FULFILLMENT_STATUSES = ['PAID_PENDING_PICKUP', 'PICKED_UP'];
const STAFF_ROLES = new Set(['VOLUNTEER', 'TREASURER', 'ADMIN']);
const ORDER_CODE_RE = /^[A-Z0-9-]{4,40}$/;
const ADMIN_NO_PURCHASE = 'Admins manage events and inventory and do not purchase tickets or merch';
const CATEGORIES = ['HOODIES', 'T_SHIRTS', 'CAPS', 'PANTS', 'ACCESSORIES'];
// Each category is drawn by its own product artwork; four camera angles per item.
const CATEGORY_STYLE = { HOODIES: 'hoodie', T_SHIRTS: 'tee', CAPS: 'cap', PANTS: 'pants', ACCESSORIES: 'tote' };
const ANGLES = [
  { view: 'front', label: 'Front View' },
  { view: 'back', label: 'Back View' },
  { view: 'side', label: 'Side Profile' },
  { view: 'closeup', label: 'Fabric & Stitch Close-Up' },
];
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const PERIOD_DAYS = { '7d': 7, '30d': 30, '90d': 90, all: null };

// images_json -> { style, color, angles[] } (older rows have none: derive from the category).
function galleryOf(item) {
  let stored = null;
  try {
    stored = item.images_json ? JSON.parse(item.images_json) : null;
  } catch {
    stored = null;
  }
  const style = stored?.style || CATEGORY_STYLE[item.category] || (/cap/i.test(item.name) ? 'cap' : /hoodie/i.test(item.name) ? 'hoodie' : 'tee');
  return { style, color: stored?.color || '#1e2a4a', angles: ANGLES };
}

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

  const managers = new Map(db.prepare('SELECT id, name FROM users WHERE id IN (SELECT assigned_manager_id FROM merch_items)').all().map((u) => [u.id, u.name]));
  const seesCost = viewer.role === 'ADMIN' || viewer.role === 'TREASURER';
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
        cost_price: seesCost ? item.cost_price : undefined,
        low_stock_threshold: item.low_stock_threshold,
        low_stock: itemVariants.filter((v) => v.stock_count <= item.low_stock_threshold).map((v) => ({ variant_id: v.variant_id, size: v.size, stock_count: v.stock_count })),
        assigned_manager: item.assigned_manager_id ? { id: item.assigned_manager_id, name: managers.get(item.assigned_manager_id) || null } : null,
        gallery: galleryOf(item),
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
  if (req.user.role === 'ADMIN') throw new HttpError(403, 'Forbidden', { reason: ADMIN_NO_PURCHASE });
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

router.patch('/orders/:code/pickup', requireAuth, requireRole('VOLUNTEER', 'TREASURER', 'ADMIN'), requireScope('MERCH'), (req, res) => {
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

// Admin restock of one size. The increment happens in SQL (stock_count + ?)
// inside the write lock, so it can't lose a sale that commits at the same time.
router.patch('/variants/:id/restock', requireAuth, (req, res) => {
  const isAdmin = req.user.role === 'ADMIN';
  const scope = req.user.access_scope || 'ALL';
  if (isAdmin && scope !== 'ALL' && scope !== 'MERCH_ONLY') {
    throw new HttpError(403, 'Forbidden', { reason: `Your admin access is scoped strictly to: ${SCOPE_LABEL[scope] || scope}` });
  }
  const id = parsePositiveInt(req.params.id);
  const add = parseInteger(req.body?.add_quantity);

  const details = {};
  if (!id) details.id = 'Variant id must be a positive integer';
  if (add === null || add < 1 || add > MAX_RESTOCK) details.add_quantity = `add_quantity must be a whole number from 1 to ${MAX_RESTOCK}`;
  if (Object.keys(details).length) throw validationFailed(details);

  const { before, after, totalStock } = withTransaction(() => {
    const current = db.prepare(`${VARIANT_WITH_ITEM_SQL} WHERE v.id = ?`).get(id);
    if (!isAdmin) {
      // Only the Admin, or the inventory manager assigned to this item, may restock.
      const managerId = current ? db.prepare('SELECT assigned_manager_id FROM merch_items WHERE id = ?').get(current.item_id).assigned_manager_id : null;
      if (!current || managerId !== req.user.id) {
        throw new HttpError(403, 'Forbidden', { reason: 'requires role: ADMIN' });
      }
    }
    if (!current) throw new HttpError(404, 'Variant not found');
    db.prepare('UPDATE merch_variants SET stock_count = stock_count + ? WHERE id = ?').run(add, id);
    return {
      before: current,
      after: db.prepare(`${VARIANT_WITH_ITEM_SQL} WHERE v.id = ?`).get(id),
      totalStock: db.prepare('SELECT SUM(stock_count) AS n FROM merch_variants WHERE item_id = ?').get(current.item_id).n,
    };
  });

  res.json({
    variant: { id: after.id, size: after.size, stock_count: after.stock_count, previous_stock: before.stock_count, added: add },
    item: { id: after.item_id, name: after.item_name, total_stock: totalStock },
  });
});

function readItemInput(body, { partial = false } = {}) {
  const has = (key) => !partial || body[key] !== undefined;
  const text = (v) => (typeof v === 'string' ? v.trim() : '');
  const out = { sent: (key) => body[key] !== undefined };
  const details = {};
  out.name = text(body.name);
  if (has('name') && (out.name.length < 3 || out.name.length > 80)) details.name = 'Name must be 3-80 characters';
  out.description = body.description == null ? null : text(body.description) || null;
  if (has('description') && out.description && out.description.length > 400) details.description = 'Description must be at most 400 characters';
  out.category = text(body.category).toUpperCase();
  if (has('category') && !CATEGORIES.includes(out.category)) details.category = `category must be one of ${CATEGORIES.join(', ')}`;
  for (const [key, field, max] of [['costPrice', 'cost_price', 100000], ['memberPrice', 'member_price', 100000], ['regularPrice', 'regular_price', 100000], ['threshold', 'low_stock_threshold', 1000]]) {
    out[key] = body[field] === undefined && field === 'low_stock_threshold' && !partial ? 5 : parseInteger(body[field]);
    if (has(field) && (out[key] === null || out[key] < 0 || out[key] > max)) details[field] = `${field} must be a whole number from 0 to ${max}`;
  }
  if (!partial && out.memberPrice !== null && out.regularPrice !== null && out.memberPrice > out.regularPrice) {
    details.member_price = 'member_price cannot be higher than regular_price';
  }
  out.managerId = body.assigned_manager_id == null || body.assigned_manager_id === '' ? null : parseInteger(body.assigned_manager_id);
  if (body.assigned_manager_id != null && body.assigned_manager_id !== '' && !(out.managerId > 0)) details.assigned_manager_id = 'assigned_manager_id must be a user id';
  out.color = body.color === undefined ? '#1e2a4a' : text(body.color);
  if (body.color !== undefined && !COLOR_RE.test(out.color)) details.color = 'color must be a hex colour like #1e2a4a';
  if (!partial) {
    out.stock = {};
    for (const size of SIZES) {
      const n = body.stock?.[size] === undefined ? 0 : parseInteger(body.stock[size]);
      if (n === null || n < 0 || n > 10000) details[`stock_${size}`] = `stock.${size} must be a whole number from 0 to 10000`;
      out.stock[size] = n;
    }
  }
  if (Object.keys(details).length) throw validationFailed(details);
  return out;
}

function assertManager(id) {
  if (id !== null && !db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) throw new HttpError(404, `User ${id} not found`);
}

// Add a product with its four sizes in one transaction.
router.post('/items', requireAuth, requireRole('ADMIN'), requireScope('MERCH'), (req, res) => {
  const input = readItemInput(req.body || {});
  const itemId = withTransaction(() => {
    assertManager(input.managerId);
    const gallery = JSON.stringify({ style: CATEGORY_STYLE[input.category], color: input.color });
    const { lastInsertRowid } = db
      .prepare(`
        INSERT INTO merch_items (name, description, category, member_price, regular_price, created_at, cost_price, low_stock_threshold, assigned_manager_id, images_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.name, input.description, input.category, input.memberPrice, input.regularPrice, new Date().toISOString(),
        input.costPrice, input.threshold, input.managerId, gallery);
    const insertVariant = db.prepare('INSERT INTO merch_variants (item_id, size, stock_count) VALUES (?, ?, ?)');
    for (const size of SIZES) insertVariant.run(lastInsertRowid, size, input.stock[size]);
    return Number(lastInsertRowid);
  });
  res.status(201).json({ item: db.prepare('SELECT * FROM merch_items WHERE id = ?').get(itemId), variants: db.prepare('SELECT * FROM merch_variants WHERE item_id = ?').all(itemId) });
});

// Edit a product's details (stock changes go through restock).
router.patch('/items/:id', requireAuth, requireRole('ADMIN'), requireScope('MERCH'), (req, res) => {
  const id = parsePositiveInt(req.params.id);
  if (!id) throw validationFailed({ id: 'Item id must be a positive integer' });
  const input = readItemInput(req.body || {}, { partial: true });
  const item = withTransaction(() => {
    const current = db.prepare('SELECT * FROM merch_items WHERE id = ?').get(id);
    if (!current) throw new HttpError(404, 'Item not found');
    if (input.sent('assigned_manager_id')) assertManager(input.managerId);
    const pick = (field, key) => (input.sent(field) ? input[key] : current[field]);
    const memberPrice = pick('member_price', 'memberPrice');
    const regularPrice = pick('regular_price', 'regularPrice');
    if (memberPrice > regularPrice) throw validationFailed({ member_price: 'member_price cannot be higher than regular_price' });
    const category = pick('category', 'category');
    const gallery = input.sent('color') || input.sent('category')
      ? JSON.stringify({ style: CATEGORY_STYLE[category] || galleryOf(current).style, color: input.sent('color') ? input.color : galleryOf(current).color })
      : current.images_json;
    db.prepare(`
      UPDATE merch_items SET name = ?, description = ?, category = ?, cost_price = ?, member_price = ?, regular_price = ?,
                             low_stock_threshold = ?, assigned_manager_id = ?, images_json = ?
      WHERE id = ?`)
      .run(pick('name', 'name'), pick('description', 'description'), category, pick('cost_price', 'costPrice'), memberPrice, regularPrice,
        pick('low_stock_threshold', 'threshold'), input.sent('assigned_manager_id') ? input.managerId : current.assigned_manager_id, gallery, id);
    return db.prepare('SELECT * FROM merch_items WHERE id = ?').get(id);
  });
  res.json({ item });
});

// Profit & loss per product for a period, ranked by units sold.
// Cost = the item's current cost_price × units sold in the period.
router.get('/analytics', requireAuth, requireRole('ADMIN', 'TREASURER'), (req, res) => {
  const period = typeof req.query.period === 'string' ? req.query.period : 'all';
  if (!(period in PERIOD_DAYS)) throw validationFailed({ period: 'period must be one of 7d, 30d, 90d, all' });
  const days = PERIOD_DAYS[period];
  const since = days === null ? null : new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const rows = db
    .prepare(`
      SELECT i.id, i.name, i.category, i.cost_price, i.member_price, i.regular_price,
             COALESCE(SUM(o.quantity), 0) AS units_sold,
             COALESCE(SUM(o.total_paid), 0) AS revenue,
             COUNT(o.id) AS orders
      FROM merch_items i
      LEFT JOIN merch_variants v ON v.item_id = i.id
      LEFT JOIN merch_orders o ON o.variant_id = v.id AND (? IS NULL OR o.created_at >= ?)
      GROUP BY i.id
      ORDER BY units_sold DESC, revenue DESC, i.id`)
    .all(since, since);
  const margin = (profit, revenue) => (revenue ? Math.round((profit / revenue) * 1000) / 10 : 0);
  const products = rows.map((r, i) => {
    const cost = r.cost_price * r.units_sold;
    return { rank: i + 1, ...r, cost, profit: r.revenue - cost, margin_pct: margin(r.revenue - cost, r.revenue) };
  });
  const totals = products.reduce((t, p) => ({
    units_sold: t.units_sold + p.units_sold, revenue: t.revenue + p.revenue, cost: t.cost + p.cost, orders: t.orders + p.orders,
  }), { units_sold: 0, revenue: 0, cost: 0, orders: 0 });
  totals.profit = totals.revenue - totals.cost;
  totals.margin_pct = margin(totals.profit, totals.revenue);
  res.json({ period, since, totals, products });
});

module.exports = router;
