'use strict';

// Phase 3 self-verification: renewal double-submit guard, announcements
// visibility, merch tiered pricing, the cross-process variant stock race, and
// pickup fulfillment. Runs the real server against a throwaway database on
// ephemeral ports. Every server process is stopped and the temp database removed,
// pass or fail.

const { check, section, summarize, tempDbPath, removeDb, startServer, stopServer } = require('./verify-helpers');

const DB_FILE = tempDbPath('verify3');
process.env.DB_PATH = DB_FILE; // must be set before ./db is required

const RACE_PROCESSES = 5;
const HOLD_MS = 150; // test-only gap between the stock check and the decrement
const SERVER_ENV = { TEST_PURCHASE_HOLD_MS: String(HOLD_MS) };

const servers = [];
let db = null;

function ledger(category) {
  return db
    .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM ledger_transactions WHERE category = ?')
    .get(category);
}

function stockOf(variantId) {
  return db.prepare('SELECT stock_count FROM merch_variants WHERE id = ?').get(variantId).stock_count;
}

async function timed(fn) {
  const started = Date.now();
  const result = await fn();
  return { ...result, ms: Date.now() - started };
}

async function run() {
  const primary = await startServer(DB_FILE, SERVER_ENV);
  servers.push(primary);
  console.log(`Primary server started (pid ${primary.child.pid}, port ${primary.port})`);
  ({ db } = require('./db')); // the server has created and seeded the DB by now
  const { api } = primary;

  const login = async (email) =>
    (await api('POST', '/api/auth/login', { body: { email, password: 'skyline123' } })).body.token;
  const tokens = {
    vikram: await login('vikram@skyline.edu'),
    neha: await login('neha@skyline.edu'),
    rohan: await login('rohan@skyline.edu'),
    kabir: await login('kabir@skyline.edu'),
  };

  // ------------------------------------------------------------ Renewal guard
  section('1) Double-renewal guard');
  const dues0 = ledger('MEMBERSHIP_DUES');
  const first = await api('POST', '/api/memberships/join-or-renew', { token: tokens.rohan });
  check('Rohan (10 days left, renewal_due) renews -> 200, now 375 days left',
    first.status === 200 && first.body.user.membership.days_remaining === 375 && first.body.user.membership.renewal_due === false,
    `expires_at=${first.body?.user?.membership?.expires_at}`);

  const second = await api('POST', '/api/memberships/join-or-renew', { token: tokens.rohan });
  const dues1 = ledger('MEMBERSHIP_DUES');
  const rohanMe = (await api('GET', '/api/auth/me', { token: tokens.rohan })).body.user.membership;
  check('immediate second renewal (double-click) -> 409, no second ₹500 charge, expiry unchanged',
    second.status === 409 && second.body.error === 'Membership is already active and not yet due for renewal' &&
      dues1.n - dues0.n === 1 && dues1.total - dues0.total === 500 &&
      rohanMe.expires_at === first.body.user.membership.expires_at,
    `body=${JSON.stringify(second.body)}`);

  const vikramRenew = await api('POST', '/api/memberships/join-or-renew', { token: tokens.vikram });
  check('Vikram (305 days left) renewing early -> 409', vikramRenew.status === 409,
    `days_remaining=${vikramRenew.body?.days_remaining} renewal_opens_at=${vikramRenew.body?.renewal_opens_at}`);

  // ------------------------------------------------------------ Scene 3
  section('2) Announcements: members-only visibility');
  const membersPost = await api('POST', '/api/announcements', {
    token: tokens.neha,
    body: {
      title: 'Members-only: Gala seating preview',
      content: 'Members get first pick of Gala tables. The seating chart opens Friday at 6 PM; bring your membership code.',
      category: 'EVENT',
      target_audience: 'MEMBERS_ONLY',
    },
  });
  const secret = membersPost.body?.announcement;
  check('Neha posts MEMBERS_ONLY -> 201 with author details, recipients_notified = 4 active members',
    membersPost.status === 201 && secret.author_name === 'Neha Sharma' && secret.author_role === 'VOLUNTEER' &&
      secret.target_audience === 'MEMBERS_ONLY' && membersPost.body.recipients_notified === 4,
    `id=${secret?.id} recipients_notified=${membersPost.body?.recipients_notified}`);

  const publicPost = await api('POST', '/api/announcements', {
    token: tokens.vikram,
    body: { title: 'Bake sale volunteers needed', content: 'Sign up at the club desk for a Saturday shift.', category: 'general' },
  });
  check('ADMIN posts with default audience -> ALL, recipients_notified = every account (5)',
    publicPost.status === 201 && publicPost.body.announcement.target_audience === 'ALL' &&
      publicPost.body.announcement.category === 'GENERAL' && publicPost.body.recipients_notified === 5);

  const kabirFeed = await api('GET', '/api/announcements', { token: tokens.kabir });
  check('Kabir (NONE) does not see the MEMBERS_ONLY post; hidden_members_only_count >= 1',
    kabirFeed.status === 200 && !kabirFeed.body.announcements.some((a) => a.id === secret.id) &&
      kabirFeed.body.announcements.every((a) => a.target_audience === 'ALL') && kabirFeed.body.hidden_members_only_count >= 1,
    `visible=${kabirFeed.body?.count} hidden_members_only_count=${kabirFeed.body?.hidden_members_only_count}`);

  const anonFeed = await api('GET', '/api/announcements');
  check('anonymous visitor -> same public view',
    anonFeed.status === 200 && anonFeed.body.viewer.authenticated === false &&
      anonFeed.body.count === kabirFeed.body.count && anonFeed.body.hidden_members_only_count === kabirFeed.body.hidden_members_only_count);

  const rohanFeed = await api('GET', '/api/announcements', { token: tokens.rohan });
  const newestFirst = rohanFeed.body.announcements.every((a, i, all) => i === 0 || all[i - 1].created_at >= a.created_at);
  check('Rohan (ACTIVE) sees it; feed is newest first with author_name/author_role',
    rohanFeed.status === 200 && rohanFeed.body.announcements.some((a) => a.id === secret.id) &&
      rohanFeed.body.hidden_members_only_count === 0 && newestFirst &&
      rohanFeed.body.announcements.every((a) => a.author_name && a.author_role),
    `visible=${rohanFeed.body?.count}`);

  const rohanSearch = await api('GET', '/api/announcements?category=event&q=seating', { token: tokens.rohan });
  const kabirSearch = await api('GET', '/api/announcements?q=seating', { token: tokens.kabir });
  check('?category=&q= filters apply; a non-member search reports the hidden match',
    rohanSearch.body.count === 1 && rohanSearch.body.announcements[0].id === secret.id &&
      kabirSearch.body.count === 0 && kabirSearch.body.hidden_members_only_count === 1);

  const kabirPost = await api('POST', '/api/announcements', {
    token: tokens.kabir,
    body: { title: 'Free pizza', content: 'Not really', category: 'GENERAL' },
  });
  check('Student Kabir posting -> 403', kabirPost.status === 403);

  const badPost = await api('POST', '/api/announcements', {
    token: tokens.neha,
    body: { title: '  ', content: '', category: 'PARTY', target_audience: 'EVERYONE' },
  });
  const badFilter = await api('GET', '/api/announcements?category=PARTY');
  const badToken = await api('GET', '/api/announcements', { token: `${tokens.kabir.slice(0, -1)}x` });
  check('invalid post -> 400 with field details; bad ?category -> 400; tampered token -> 401',
    badPost.status === 400 && ['title', 'content', 'category', 'target_audience'].every((f) => f in badPost.body.details) &&
      badFilter.status === 400 && badToken.status === 401);

  // ------------------------------------------------------------ Scene 4
  section('3) Merch: catalogue and tiered pricing');
  const catalogue = await api('GET', '/api/merch/items');
  const hoodie = catalogue.body.items.find((i) => i.name === 'Skyline Signature Hoodie');
  const tee = catalogue.body.items.find((i) => i.name === 'Campus Club Tee');
  const size = (item, s) => item.variants.find((v) => v.size === s);
  check('GET /api/merch/items -> items with S/M/L/XL variants, total stock and units sold',
    catalogue.status === 200 && [hoodie, tee].every((i) => i.variants.map((v) => v.size).join() === 'S,M,L,XL') &&
      hoodie.total_stock === 57 && hoodie.units_sold === 1 && tee.units_sold === 2 && size(hoodie, 'M').stock_count === 24,
    `hoodie stock=${JSON.stringify(hoodie.variants.map((v) => `${v.size}:${v.stock_count}`))} units_sold=${hoodie.units_sold}`);

  const hoodieM = size(hoodie, 'M');
  const hoodieL = size(hoodie, 'L');
  const sales0 = ledger('MERCH_SALE');
  const rohanOrder = await api('POST', '/api/merch/orders', { token: tokens.rohan, body: { item_id: hoodie.id, size: 'm' } });
  const sales1 = ledger('MERCH_SALE');
  check(`Rohan (ACTIVE) orders 1 hoodie size M -> 201, MEMBER ₹${hoodie.member_price}, M stock 24 -> 23`,
    rohanOrder.status === 201 && rohanOrder.body.tier === 'MEMBER' && rohanOrder.body.total_paid === hoodie.member_price &&
      rohanOrder.body.variant.stock_count === 23 && stockOf(hoodieM.variant_id) === 23 &&
      rohanOrder.body.order.fulfillment_status === 'PAID_PENDING_PICKUP' && /^ORD-M\d+-[A-Z0-9]{6}$/.test(rohanOrder.body.order.order_code),
    `order=${rohanOrder.body?.order?.order_code} tier=${rohanOrder.body?.tier} total=₹${rohanOrder.body?.total_paid}`);
  check('MERCH_SALE ledger row created for Rohan',
    sales1.n - sales0.n === 1 && sales1.total - sales0.total === hoodie.member_price &&
      rohanOrder.body.transaction.reference_id === rohanOrder.body.order.order_code &&
      rohanOrder.body.transaction.description === '1x Skyline Signature Hoodie (M) - Rohan Verma',
    `"${rohanOrder.body?.transaction?.description}"`);

  const kabirOrder = await api('POST', '/api/merch/orders', {
    token: tokens.kabir,
    body: { variant_id: hoodieL.variant_id, quantity: 1, total_paid: 1, unit_price: 1, tier: 'MEMBER' },
  });
  const sales2 = ledger('MERCH_SALE');
  check(`Kabir (NONE) orders hoodie size L with spoofed total_paid: 1 -> REGULAR ₹${hoodie.regular_price}`,
    kabirOrder.status === 201 && kabirOrder.body.tier === 'REGULAR' && kabirOrder.body.total_paid === hoodie.regular_price &&
      stockOf(hoodieL.variant_id) === 17 && sales2.total - sales1.total === hoodie.regular_price,
    `tier=${kabirOrder.body?.tier} total=₹${kabirOrder.body?.total_paid} ledger +₹${sales2.total - sales1.total}`);

  const tooMany = await api('POST', '/api/merch/orders', { token: tokens.kabir, body: { variant_id: size(hoodie, 'XL').variant_id, quantity: 5 } });
  const soldOut = await api('POST', '/api/merch/orders', { token: tokens.kabir, body: { item_id: tee.id, size: 'XL' } });
  check('low stock -> 409 "Only 3 left in size XL"; empty size -> 409 "Size XL is out of stock"',
    tooMany.status === 409 && tooMany.body.error === 'Only 3 left in size XL' &&
      soldOut.status === 409 && soldOut.body.error === 'Size XL is out of stock');

  const invalid = await Promise.all([
    api('POST', '/api/merch/orders', { token: tokens.kabir, body: { variant_id: hoodieM.variant_id, quantity: 6 } }),
    api('POST', '/api/merch/orders', { token: tokens.kabir, body: {} }),
    api('POST', '/api/merch/orders', { token: tokens.kabir, body: { variant_id: 'abc' } }),
    api('POST', '/api/merch/orders', { token: tokens.kabir, body: { variant_id: 1, item_id: 1, size: 'M' } }),
    api('POST', '/api/merch/orders', { token: tokens.kabir, body: { item_id: hoodie.id, size: 'XXL' } }),
  ]);
  const missing = await api('POST', '/api/merch/orders', { token: tokens.kabir, body: { variant_id: 99999 } });
  check('invalid order input -> 400 before the DB (qty 6, empty, bad id, both shapes, bad size); unknown variant -> 404',
    invalid.every((r) => r.status === 400) && missing.status === 404, `statuses=${invalid.map((r) => r.status).join(',')},${missing.status}`);

  // ------------------------------------------------------------ Race
  section(`4) Variant stock race — 5 buyers, last unit, ${RACE_PROCESSES} separate server processes`);
  const teeXL = size(tee, 'XL');
  db.prepare('UPDATE merch_variants SET stock_count = 1 WHERE id = ?').run(teeXL.variant_id); // fixture: restock 1 unit
  check('fixture: Campus Club Tee size XL restocked to 1', stockOf(teeXL.variant_id) === 1);

  const racers = [];
  for (let i = 1; i <= RACE_PROCESSES; i++) {
    const reg = await api('POST', '/api/auth/register', {
      body: { name: `Merch Racer ${i}`, email: `merch-racer${i}@test.skyline.edu`, password: 'racecondition' },
    });
    racers.push(reg.body.token);
  }
  const replicas = await Promise.all(
    Array.from({ length: RACE_PROCESSES - 1 }, () => startServer(DB_FILE, SERVER_ENV)),
  );
  servers.push(...replicas);
  const pool = [primary, ...replicas];
  console.log(`  ${pool.length} servers on one DB: pids ${pool.map((s) => s.child.pid).join(', ')}`);

  const raceSales0 = ledger('MERCH_SALE');
  const attempts = await Promise.all(
    racers.map((token, i) =>
      timed(() => pool[i].api('POST', '/api/merch/orders', { token, body: { variant_id: teeXL.variant_id, total_paid: 0 } }))),
  );
  const raceSales1 = ledger('MERCH_SALE');
  const won = attempts.filter((a) => a.status === 201);
  const lost = attempts.filter((a) => a.status === 409 && a.body.error === 'Size XL is out of stock');
  check('exactly 1 order -> 201, the other 4 -> 409 "Size XL is out of stock"',
    won.length === 1 && lost.length === 4,
    attempts.map((a, i) => `pid ${pool[i].child.pid}: ${a.status} in ${a.ms}ms`).join(' | '));

  const raceOrders = db.prepare('SELECT COUNT(*) AS n FROM merch_orders WHERE variant_id = ?').get(teeXL.variant_id).n;
  check('stock_count = 0 (never negative) and exactly 1 order row for the variant',
    stockOf(teeXL.variant_id) === 0 && raceOrders === 1, `stock_count=${stockOf(teeXL.variant_id)} orders=${raceOrders}`);
  check(`ledger recorded exactly 1 sale at regular price ₹${tee.regular_price} (body price ignored)`,
    raceSales1.n - raceSales0.n === 1 && raceSales1.total - raceSales0.total === tee.regular_price,
    `MERCH_SALE rows ${raceSales0.n} -> ${raceSales1.n}`);

  await Promise.all(replicas.map((s) => stopServer(s.child)));

  // ------------------------------------------------------------ Pickup
  section('5) Order pickup at the club desk');
  const rohanCode = rohanOrder.body.order.order_code;
  const pickup = await api('PATCH', `/api/merch/orders/${rohanCode}/pickup`, { token: tokens.neha });
  check(`Neha marks ${rohanCode} PICKED_UP -> 200`,
    pickup.status === 200 && pickup.body.order.fulfillment_status === 'PICKED_UP' && pickup.body.order.buyer.name === 'Rohan Verma',
    `message="${pickup.body?.message}"`);

  const pickupAgain = await api('PATCH', `/api/merch/orders/${rohanCode}/pickup`, { token: tokens.neha });
  check('second pickup -> 409 "Order already picked up"',
    pickupAgain.status === 409 && pickupAgain.body.error === 'Order already picked up', `body=${JSON.stringify(pickupAgain.body)}`);

  const kabirCode = kabirOrder.body.order.order_code;
  const kabirPickup = await api('PATCH', `/api/merch/orders/${kabirCode}/pickup`, { token: tokens.kabir });
  const unknownPickup = await api('PATCH', '/api/merch/orders/ORD-M1-ZZZZZZ/pickup', { token: tokens.neha });
  check('student marking pickup -> 403; unknown order code -> 404', kabirPickup.status === 403 && unknownPickup.status === 404);

  const pending = await api('GET', '/api/merch/orders?status=PAID_PENDING_PICKUP', { token: tokens.neha });
  const s = pending.body?.summary;
  check('staff ?status=PAID_PENDING_PICKUP lists only pending orders; summary covers all orders',
    pending.status === 200 && pending.body.orders.every((o) => o.fulfillment_status === 'PAID_PENDING_PICKUP') &&
      !pending.body.orders.some((o) => o.order_code === rohanCode) && pending.body.orders.some((o) => o.order_code === kabirCode) &&
      s.total_orders === 5 && s.pending_pickup === 3 && s.picked_up === 2,
    `summary=${JSON.stringify(s)}`);

  const search = await api('GET', '/api/merch/orders?q=rohan', { token: tokens.vikram });
  check('staff ?q=rohan -> Rohan\'s orders only (seeded + new)',
    search.body.count === 2 && search.body.orders.every((o) => o.buyer.name === 'Rohan Verma'));

  const own = await api('GET', '/api/merch/orders', { token: tokens.kabir });
  check('student sees only their own orders and no desk summary',
    own.status === 200 && own.body.count === 1 && own.body.orders[0].order_code === kabirCode && !('summary' in own.body));

  section('EXPLAIN QUERY PLAN — store paths');
  const plans = [
    ['variant by (item_id, size)', /SEARCH v USING (COVERING )?INDEX sqlite_autoindex_merch_variants_1/,
      'SELECT v.id, v.stock_count, i.name, i.member_price, i.regular_price FROM merch_variants v JOIN merch_items i ON i.id = v.item_id WHERE v.item_id = ? AND v.size = ?', [1, 'M']],
    ['pickup lookup by order_code', /SEARCH o USING INDEX sqlite_autoindex_merch_orders_1/,
      'SELECT o.id FROM merch_orders o JOIN merch_variants v ON v.id = o.variant_id JOIN merch_items i ON i.id = v.item_id JOIN users u ON u.id = o.user_id WHERE o.order_code = ?', ['X']],
  ];
  for (const [label, expected, sql, params] of plans) {
    const detail = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((r) => r.detail).join(' | ');
    check(label, expected.test(detail), detail);
  }
}

async function main() {
  console.log(`Phase 3 verification (temp DB: ${DB_FILE})`);
  try {
    await run();
  } catch (err) {
    check('verification ran to completion', false, err.stack);
  } finally {
    await Promise.all(servers.map((srv) => stopServer(srv.child)));
    if (servers.length) console.log(`\nStopped ${servers.length} test server process(es); port 3000 was never used.`);
    if (db) db.close();
    removeDb(DB_FILE);
  }
  summarize();
}

main();
