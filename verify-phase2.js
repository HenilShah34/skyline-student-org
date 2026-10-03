'use strict';

// Phase 2 self-verification: membership lifecycle, door lookup, tiered ticket
// sales, the cross-process overselling race, and door check-in. Runs the real
// server against a throwaway database on ephemeral ports. Every server process is
// stopped and the temp database removed, pass or fail.

const { check, section, summarize, tempDbPath, removeDb, startServer, stopServer } = require('./verify-helpers');

const DB_FILE = tempDbPath('verify2');
process.env.DB_PATH = DB_FILE; // must be set before ./db is required

const DAY_MS = 24 * 60 * 60 * 1000;
const RACE_PROCESSES = 5;
const HOLD_MS = 150; // test-only gap between capacity check and seat decrement
const SERVER_ENV = { TEST_PURCHASE_HOLD_MS: String(HOLD_MS) };

const servers = [];
let db = null;

function ledger(category) {
  return db
    .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM ledger_transactions WHERE category = ?')
    .get(category);
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

  // ---------------------------------------------------------------- Scene 1
  section('1) Membership renewal — Rohan (expiring in 10 days)');
  const before = (await api('GET', '/api/auth/me', { token: tokens.rohan })).body.user.membership;
  check('Rohan starts ACTIVE with 10 days left and renewal_due = true',
    before.status === 'ACTIVE' && before.days_remaining === 10 && before.renewal_due === true,
    `expires_at=${before.expires_at}`);

  const dues0 = ledger('MEMBERSHIP_DUES');
  const renew = await api('POST', '/api/memberships/join-or-renew', { token: tokens.rohan });
  const after = renew.body?.user?.membership;
  const dues1 = ledger('MEMBERSHIP_DUES');
  check('POST /api/memberships/join-or-renew -> 200 RENEWED, renewal_due flips to false',
    renew.status === 200 && renew.body.action === 'RENEWED' && after.renewal_due === false && after.code === 'SKY-2026-003',
    `status=${renew.status} membership=${JSON.stringify(after)}`);
  check('expiry extended exactly 365 days from the current expiry (not from today)',
    Date.parse(after.expires_at) - Date.parse(before.expires_at) === 365 * DAY_MS && renew.body.extended_from === 'CURRENT_EXPIRY',
    `${before.expires_at} -> ${after.expires_at}`);
  check('ledger +₹500 MEMBERSHIP_DUES, referenced to SKY-2026-003',
    dues1.n - dues0.n === 1 && dues1.total - dues0.total === 500 &&
      renew.body.transaction.amount === 500 && renew.body.transaction.reference_id === 'SKY-2026-003',
    `dues total ₹${dues0.total} -> ₹${dues1.total}; "${renew.body.transaction?.description}"`);

  // ---------------------------------------------------------------- Scene 2
  section('2-4) Tiered ticket sales — Spring Annual Gala 2026');
  const listed = await api('GET', '/api/events');
  const events = listed.body.events;
  const gala = events.find((e) => e.title === 'Spring Annual Gala 2026');
  const sorted = events.every((e, i) => i === 0 || events[i - 1].event_date <= e.event_date);
  check('GET /api/events -> date-ordered, with seats and ticket aggregates',
    listed.status === 200 && sorted && gala.seats_left === 42 && gala.tickets_sold === 2 && gala.ticket_revenue === 500,
    `gala: seats_left=${gala.seats_left} tickets_sold=${gala.tickets_sold} revenue=₹${gala.ticket_revenue}`);

  const sales0 = ledger('TICKET_SALE');
  const rohanBuy = await api('POST', `/api/events/${gala.id}/tickets`, { token: tokens.rohan });
  const sales1 = ledger('TICKET_SALE');
  check('2) Rohan (ACTIVE) buys -> 201, MEMBER tier at ₹250, seats_left 42 -> 41',
    rohanBuy.status === 201 && rohanBuy.body.tier === 'MEMBER' && rohanBuy.body.price_paid === 250 && rohanBuy.body.seats_left === 41,
    `ticket=${rohanBuy.body?.ticket?.ticket_code} tier=${rohanBuy.body?.tier} price=₹${rohanBuy.body?.price_paid}`);
  check('2) ledger +₹250 TICKET_SALE', sales1.n - sales0.n === 1 && sales1.total - sales0.total === 250);

  // Kabir tries to smuggle a member price through the request body.
  const kabirBuy = await api('POST', `/api/events/${gala.id}/tickets`, {
    token: tokens.kabir,
    body: { price_paid: 0, tier: 'MEMBER', member_price: 1 },
  });
  const sales2 = ledger('TICKET_SALE');
  check('3) Kabir (NONE) buys -> 201, GUEST tier at ₹500 (body price ignored), seats_left 41 -> 40',
    kabirBuy.status === 201 && kabirBuy.body.tier === 'GUEST' && kabirBuy.body.price_paid === 500 && kabirBuy.body.seats_left === 40,
    `ticket=${kabirBuy.body?.ticket?.ticket_code} tier=${kabirBuy.body?.tier} price=₹${kabirBuy.body?.price_paid}`);
  check('3) ledger +₹500 TICKET_SALE', sales2.n - sales1.n === 1 && sales2.total - sales1.total === 500);

  const dup = await api('POST', `/api/events/${gala.id}/tickets`, { token: tokens.rohan });
  const galaRow = db.prepare('SELECT seats_left FROM events WHERE id = ?').get(gala.id);
  check('4) Rohan buys again -> 409, no seat or ledger change',
    dup.status === 409 && dup.body.error === 'You already hold a ticket for this event' &&
      galaRow.seats_left === 40 && ledger('TICKET_SALE').n === sales2.n,
    `body=${JSON.stringify(dup.body)}`);

  const badId = await api('POST', '/api/events/abc/tickets', { token: tokens.rohan });
  const noEvent = await api('POST', '/api/events/99999/tickets', { token: tokens.rohan });
  check('bad event id -> 400, unknown event -> 404', badId.status === 400 && noEvent.status === 404);

  section('Membership join — Kabir (no membership)');
  const join = await api('POST', '/api/memberships/join-or-renew', { token: tokens.kabir });
  const joined = join.body?.user?.membership;
  const daysOut = (Date.parse(joined?.expires_at) - Date.now()) / DAY_MS;
  check('Kabir joins -> 200 JOINED, new code SKY-2026-004, ACTIVE for 365 days from today',
    join.status === 200 && join.body.action === 'JOINED' && joined.code === 'SKY-2026-004' &&
      joined.status === 'ACTIVE' && join.body.extended_from === 'TODAY' && Math.abs(daysOut - 365) < 0.001,
    `membership=${JSON.stringify(joined)}`);
  check('ledger +₹500 MEMBERSHIP_DUES for Kabir', ledger('MEMBERSHIP_DUES').total - dues1.total === 500);

  // ---------------------------------------------------------------- Race
  section(`5) Concurrency race — 5 buyers, 1 seat, ${RACE_PROCESSES} separate server processes`);
  const eventBody = {
    title: 'Concurrency Test Night',
    event_date: new Date(Date.now() + 30 * DAY_MS).toISOString(),
    location: 'Innovation Lab, Block C',
    total_seats: 1,
    member_price: 100,
    guest_price: 200,
  };
  const studentCreate = await api('POST', '/api/events', { token: tokens.kabir, body: eventBody });
  const invalidCreate = await api('POST', '/api/events', {
    token: tokens.vikram,
    body: { ...eventBody, title: '', total_seats: 0, member_price: -5, event_date: 'next friday' },
  });
  check('POST /api/events as STUDENT -> 403; invalid input -> 400 before touching the DB',
    studentCreate.status === 403 && invalidCreate.status === 400 &&
      ['title', 'total_seats', 'member_price', 'event_date'].every((f) => f in invalidCreate.body.details),
    `details=${JSON.stringify(invalidCreate.body?.details)}`);

  const created = await api('POST', '/api/events', { token: tokens.vikram, body: eventBody });
  const raceEvent = created.body?.event;
  check('ADMIN creates 1-seat event -> 201, seats_left = 1',
    created.status === 201 && raceEvent.total_seats === 1 && raceEvent.seats_left === 1, `event id=${raceEvent?.id}`);

  const racers = [];
  for (let i = 1; i <= RACE_PROCESSES; i++) {
    const reg = await api('POST', '/api/auth/register', {
      body: { name: `Race Tester ${i}`, email: `racer${i}@test.skyline.edu`, password: 'racecondition' },
    });
    racers.push(reg.body.token);
  }

  const replicas = await Promise.all(
    Array.from({ length: RACE_PROCESSES - 1 }, () => startServer(DB_FILE, SERVER_ENV)),
  );
  servers.push(...replicas);
  const pool = [primary, ...replicas];
  console.log(`  ${pool.length} servers on one DB: pids ${pool.map((s) => s.child.pid).join(', ')}`);

  const raceSales0 = ledger('TICKET_SALE');
  const attempts = await Promise.all(
    racers.map((token, i) =>
      timed(() => pool[i].api('POST', `/api/events/${raceEvent.id}/tickets`, { token, body: { price_paid: 0 } }))),
  );
  const raceSales1 = ledger('TICKET_SALE');
  const won = attempts.filter((a) => a.status === 201);
  const lost = attempts.filter((a) => a.status === 409 && a.body.error === 'Event is sold out');
  check('exactly 1 purchase -> 201, the other 4 -> 409 "Event is sold out"',
    won.length === 1 && lost.length === 4,
    attempts.map((a, i) => `pid ${pool[i].child.pid}: ${a.status} in ${a.ms}ms`).join(' | '));

  const raceRow = db.prepare('SELECT seats_left FROM events WHERE id = ?').get(raceEvent.id);
  const raceTickets = db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE event_id = ?').get(raceEvent.id).n;
  check('seats_left = 0 (never negative) and exactly 1 ticket row',
    raceRow.seats_left === 0 && raceTickets === 1, `seats_left=${raceRow.seats_left} tickets=${raceTickets}`);
  check('ledger recorded exactly 1 sale at guest price ₹200 (body price ignored)',
    raceSales1.n - raceSales0.n === 1 && raceSales1.total - raceSales0.total === 200,
    `TICKET_SALE rows ${raceSales0.n} -> ${raceSales1.n}`);

  await Promise.all(replicas.map((s) => stopServer(s.child)));

  // ---------------------------------------------------------------- Door
  section('6) Door check-in — Volunteer Neha');
  const rohanCode = rohanBuy.body.ticket.ticket_code;
  const checkIn = await api('POST', `/api/tickets/${rohanCode}/check-in`, { token: tokens.neha });
  check(`Neha checks in ${rohanCode} -> 200 with attendee + attendance count`,
    checkIn.status === 200 && checkIn.body.attendee.name === 'Rohan Verma' &&
      checkIn.body.attendee.membership.status === 'ACTIVE' && checkIn.body.event.checked_in_count === 1,
    `message="${checkIn.body?.message}" attendance=${checkIn.body?.event?.checked_in_count}/${checkIn.body?.event?.tickets_sold}`);

  const again = await api('POST', `/api/tickets/${rohanCode}/check-in`, { token: tokens.neha });
  check('second check-in on the same code -> 409 "already checked in at <timestamp>"',
    again.status === 409 && again.body.error === `Ticket already checked in at ${checkIn.body.ticket.checked_in_at}`,
    `body=${JSON.stringify(again.body)}`);

  const kabirCheckIn = await api('POST', `/api/tickets/${rohanCode}/check-in`, { token: tokens.kabir });
  check('Student Kabir calling /check-in -> 403 Forbidden', kabirCheckIn.status === 403, `body=${JSON.stringify(kabirCheckIn.body)}`);

  const unknownCode = await api('POST', '/api/tickets/TKT-E1-ZZZZZZ/check-in', { token: tokens.neha });
  check('unknown ticket code -> 404', unknownCode.status === 404);

  section('Door roster and member lookup');
  const roster = await api('GET', `/api/events/${gala.id}/tickets?q=rohan`, { token: tokens.neha });
  check('staff roster ?q=rohan -> 1 match, checked in; stats cover the whole event',
    roster.status === 200 && roster.body.count === 1 && roster.body.tickets[0].checked_in === true &&
      roster.body.stats.tickets_sold === 4 && roster.body.stats.checked_in_count === 1 &&
      roster.body.stats.no_show_count === 3 && roster.body.stats.ticket_revenue === 1250,
    `stats=${JSON.stringify(roster.body?.stats)}`);

  const ownTickets = await api('GET', `/api/events/${gala.id}/tickets`, { token: tokens.kabir });
  check('student sees only their own ticket and no event stats',
    ownTickets.status === 200 && ownTickets.body.tickets.length === 1 &&
      ownTickets.body.tickets[0].attendee.name === 'Kabir Singh' && !('stats' in ownTickets.body));

  const exact = await api('GET', '/api/memberships/lookup?q=sky-2026-003', { token: tokens.neha });
  const hit = exact.body?.results?.[0];
  check('lookup by membership code (any case) -> Rohan first, ACTIVE, 2 tickets',
    exact.status === 200 && hit.name === 'Rohan Verma' && hit.membership.is_active && hit.tickets_purchased === 2,
    `first=${JSON.stringify(hit)}`);

  const prefix = await api('GET', '/api/memberships/lookup?q=SKY-2026-00', { token: tokens.neha });
  const byName = await api('GET', '/api/memberships/lookup?q=kab', { token: tokens.vikram });
  check('lookup by code prefix -> all 4 members; by partial name -> Kabir (now a member)',
    prefix.body.count === 4 && byName.body.count === 1 && byName.body.results[0].membership.code === 'SKY-2026-004');

  const all = await api('GET', '/api/memberships/lookup', { token: tokens.neha });
  const createdDesc = all.body.results.every((r, i, a) => i === 0 || a[i - 1].created_at >= r.created_at);
  check('lookup with empty q -> members only, newest first',
    all.status === 200 && all.body.count === 4 && all.body.results.every((r) => r.membership.code) && createdDesc,
    all.body.results.map((r) => r.membership.code).join(', '));

  const studentLookup = await api('GET', '/api/memberships/lookup?q=rohan', { token: tokens.kabir });
  check('student calling lookup -> 403', studentLookup.status === 403);

  const finalGala = (await api('GET', '/api/events')).body.events.find((e) => e.id === gala.id);
  check('post-event analytics on GET /api/events reflect sales and check-ins',
    finalGala.tickets_sold === 4 && finalGala.checked_in_count === 1 && finalGala.seats_sold === 60 &&
      finalGala.ticket_revenue === 1250 && finalGala.attendance_rate === 0.25,
    `seats_sold=${finalGala.seats_sold} tickets_sold=${finalGala.tickets_sold} checked_in=${finalGala.checked_in_count} revenue=₹${finalGala.ticket_revenue} attendance=${finalGala.attendance_rate}`);

  section('EXPLAIN QUERY PLAN — door paths');
  const plans = [
    ['check-in lookup by ticket_code', /SEARCH t USING INDEX sqlite_autoindex_tickets_1/,
      `SELECT t.*, u.name FROM tickets t JOIN users u ON u.id = t.user_id JOIN events e ON e.id = t.event_id WHERE t.ticket_code = ?`, ['X']],
    ['duplicate-ticket check by (event_id, user_id)', /SEARCH tickets USING (COVERING )?INDEX idx_tickets_event_user/,
      'SELECT ticket_code FROM tickets WHERE event_id = ? AND user_id = ?', [1, 1]],
    ['member lookup by exact code', /SEARCH users USING (COVERING )?INDEX sqlite_autoindex_users_2/,
      'SELECT id FROM users WHERE membership_code = ?', ['SKY-2026-003']],
  ];
  for (const [label, expected, sql, params] of plans) {
    const detail = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((r) => r.detail).join(' | ');
    check(label, expected.test(detail), detail);
  }
}

async function main() {
  console.log(`Phase 2 verification (temp DB: ${DB_FILE})`);
  try {
    await run();
  } catch (err) {
    check('verification ran to completion', false, err.stack);
  } finally {
    await Promise.all(servers.map((s) => stopServer(s.child)));
    if (servers.length) console.log(`\nStopped ${servers.length} test server process(es); port 3000 was never used.`);
    if (db) db.close();
    removeDb(DB_FILE);
  }
  summarize();
}

main();
