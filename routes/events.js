'use strict';

const express = require('express');
const { db, withTransaction } = require('../db');
const { HttpError, validationFailed, parsePositiveInt, parseInteger, parseSearchQuery, escapeLike } = require('../lib/http');
const { uniqueCode } = require('../lib/codes');
const { recordTransaction } = require('../lib/ledger');
const { holdForRaceTest } = require('../lib/testHooks');
const { membershipSnapshot } = require('../lib/users');
const { loadViewer } = require('../lib/viewer');
const { requireAuth, optionalAuth, requireRole } = require('../middleware/requireAuth');

const STAFF_ROLES = new Set(['VOLUNTEER', 'ADMIN']);
const MAX_SEATS = 100000;
const MAX_PRICE = 1000000;
const TICKET_CODE_RE = /^[A-Z0-9-]{4,40}$/;

const router = express.Router();

function toEventView(row, now = Date.now()) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    event_date: row.event_date,
    location: row.location,
    total_seats: row.total_seats,
    seats_left: row.seats_left,
    member_price: row.member_price,
    guest_price: row.guest_price,
    created_at: row.created_at,
    is_past: Date.parse(row.event_date) < now,
    // seats_sold includes any seats sold offline; tickets_sold counts issued tickets.
    seats_sold: row.total_seats - row.seats_left,
    tickets_sold: row.tickets_sold,
    checked_in_count: row.checked_in_count,
    ticket_revenue: row.ticket_revenue,
    attendance_rate: row.tickets_sold ? Math.round((row.checked_in_count / row.tickets_sold) * 1000) / 1000 : 0,
  };
}

function toTicketView(row) {
  return {
    id: row.id,
    ticket_code: row.ticket_code,
    price_paid: row.price_paid,
    checked_in: row.checked_in === 1,
    checked_in_at: row.checked_in_at,
    created_at: row.created_at,
    attendee: { id: row.user_id, name: row.name, email: row.email, membership: membershipSnapshot(row) },
  };
}

function parseEventId(value) {
  const id = parsePositiveInt(value);
  if (!id) throw validationFailed({ id: 'Event id must be a positive integer' });
  return id;
}

function validateEventInput(body) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const location = typeof body.location === 'string' ? body.location.trim() : '';
  const description = body.description == null ? null : typeof body.description === 'string' ? body.description.trim() || null : undefined;
  const eventMs = typeof body.event_date === 'string' ? Date.parse(body.event_date) : NaN;
  const totalSeats = parseInteger(body.total_seats);
  const memberPrice = parseInteger(body.member_price);
  const guestPrice = parseInteger(body.guest_price);

  const details = {};
  if (title.length < 3 || title.length > 120) details.title = 'Title must be 3-120 characters';
  if (description === undefined || (description && description.length > 2000)) {
    details.description = 'Description must be text of at most 2000 characters';
  }
  if (!Number.isFinite(eventMs)) details.event_date = 'event_date must be a valid ISO 8601 date/time';
  if (location.length < 2 || location.length > 120) details.location = 'Location must be 2-120 characters';
  if (totalSeats === null || totalSeats < 1 || totalSeats > MAX_SEATS) {
    details.total_seats = `total_seats must be an integer from 1 to ${MAX_SEATS}`;
  }
  if (memberPrice === null || memberPrice < 0 || memberPrice > MAX_PRICE) {
    details.member_price = 'member_price must be a non-negative integer (₹)';
  }
  if (guestPrice === null || guestPrice < 0 || guestPrice > MAX_PRICE) {
    details.guest_price = 'guest_price must be a non-negative integer (₹)';
  }
  if (Object.keys(details).length) throw validationFailed(details);

  return { title, description, eventDate: new Date(eventMs).toISOString(), location, totalSeats, memberPrice, guestPrice };
}

// Ticket stats come from one grouped pass over tickets joined back to events,
// so the list costs a single query however many events there are.
const EVENTS_WITH_STATS_SQL = `
  SELECT e.*,
         COALESCE(t.tickets_sold, 0)     AS tickets_sold,
         COALESCE(t.checked_in_count, 0) AS checked_in_count,
         COALESCE(t.ticket_revenue, 0)   AS ticket_revenue
  FROM events e
  LEFT JOIN (
    SELECT event_id, COUNT(*) AS tickets_sold, SUM(checked_in) AS checked_in_count, SUM(price_paid) AS ticket_revenue
    FROM tickets
    GROUP BY event_id
  ) t ON t.event_id = e.id`;

// Public, but a signed-in caller also gets the tier and price the purchase
// endpoint will charge them and their own ticket for each event, all in the
// same single query.
router.get('/events', optionalAuth, (req, res) => {
  const now = Date.now();
  const viewer = loadViewer(req.user);
  const tier = viewer.authenticated ? (viewer.is_member ? 'MEMBER' : 'GUEST') : null;

  const rows = db
    .prepare(`
      SELECT s.*, mt.ticket_code AS my_ticket_code, mt.price_paid AS my_price_paid,
             mt.checked_in AS my_checked_in, mt.checked_in_at AS my_checked_in_at, mt.created_at AS my_ticket_created_at
      FROM (${EVENTS_WITH_STATS_SQL}) s
      -- LEFT JOIN: most events have no ticket for this caller (and none for visitors)
      LEFT JOIN tickets mt ON mt.event_id = s.id AND mt.user_id = ?
      ORDER BY s.event_date ASC, s.id ASC`)
    .all(viewer.id);

  res.json({
    viewer: { authenticated: viewer.authenticated, membership_status: viewer.membership_status, tier },
    events: rows.map((row) => ({
      ...toEventView(row, now),
      your_price: tier === null ? null : tier === 'MEMBER' ? row.member_price : row.guest_price,
      my_ticket: row.my_ticket_code
        ? {
          ticket_code: row.my_ticket_code,
          price_paid: row.my_price_paid,
          checked_in: row.my_checked_in === 1,
          checked_in_at: row.my_checked_in_at,
          created_at: row.my_ticket_created_at,
        }
        : null,
    })),
  });
});

router.post('/events', requireAuth, requireRole('ADMIN'), (req, res) => {
  const input = validateEventInput(req.body || {});
  const { lastInsertRowid } = db
    .prepare(`
      INSERT INTO events (title, description, event_date, location, total_seats, seats_left, member_price, guest_price, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(input.title, input.description, input.eventDate, input.location, input.totalSeats, input.totalSeats,
      input.memberPrice, input.guestPrice, new Date().toISOString());
  const event = db.prepare(`${EVENTS_WITH_STATS_SQL} WHERE e.id = ?`).get(lastInsertRowid);
  res.status(201).json({ event: toEventView(event) });
});

function ticketCodeTaken(code) {
  return Boolean(db.prepare('SELECT 1 FROM tickets WHERE ticket_code = ?').get(code));
}

router.post('/events/:id/tickets', requireAuth, (req, res) => {
  const eventId = parseEventId(req.params.id);

  // BEGIN IMMEDIATE holds the write lock from the first read, so the duplicate
  // and capacity checks below cannot go stale before the writes land.
  const result = withTransaction(() => {
    const now = Date.now();
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) throw new HttpError(404, 'Event not found');
    if (Date.parse(event.event_date) < now) throw new HttpError(409, 'This event has already taken place');

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!user) throw new HttpError(401, 'Unauthorized', { reason: 'user no longer exists' });

    const existing = db.prepare('SELECT ticket_code FROM tickets WHERE event_id = ? AND user_id = ?').get(eventId, user.id);
    if (existing) {
      throw new HttpError(409, 'You already hold a ticket for this event', { ticket_code: existing.ticket_code });
    }
    if (event.seats_left <= 0) throw new HttpError(409, 'Event is sold out');

    // Price comes from the live membership row, never from req.body.
    const tier = membershipSnapshot(user, now).status === 'ACTIVE' ? 'MEMBER' : 'GUEST';
    const pricePaid = tier === 'MEMBER' ? event.member_price : event.guest_price;

    holdForRaceTest();

    const seat = db.prepare('UPDATE events SET seats_left = seats_left - 1 WHERE id = ? AND seats_left > 0').run(eventId);
    if (seat.changes !== 1) throw new HttpError(409, 'Event is sold out');

    const ticketCode = uniqueCode(`TKT-E${eventId}`, ticketCodeTaken);
    const createdAt = new Date(now).toISOString();
    const { lastInsertRowid } = db
      .prepare('INSERT INTO tickets (ticket_code, event_id, user_id, price_paid, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(ticketCode, eventId, user.id, pricePaid, createdAt);

    const transaction = pricePaid > 0
      ? recordTransaction({
        type: 'IN',
        category: 'TICKET_SALE',
        amount: pricePaid,
        description: `Ticket ${ticketCode} — ${event.title} (${tier.toLowerCase()} price)`,
        referenceId: ticketCode,
        userId: user.id,
        createdAt,
      })
      : null;

    return {
      ticket: db.prepare('SELECT * FROM tickets WHERE id = ?').get(lastInsertRowid),
      event,
      tier,
      transaction,
    };
  });

  const { ticket, event, tier, transaction } = result;
  res.status(201).json({
    ticket: {
      id: ticket.id,
      ticket_code: ticket.ticket_code,
      event_id: ticket.event_id,
      price_paid: ticket.price_paid,
      checked_in: false,
      created_at: ticket.created_at,
    },
    tier,
    price_paid: ticket.price_paid,
    event: { id: event.id, title: event.title, event_date: event.event_date, location: event.location },
    seats_left: event.seats_left - 1,
    transaction,
  });
});

router.get('/events/:id/tickets', requireAuth, (req, res) => {
  const eventId = parseEventId(req.params.id);
  const q = parseSearchQuery(req.query.q);
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!event) throw new HttpError(404, 'Event not found');

  const isStaff = STAFF_ROLES.has(req.user.role);
  const where = ['t.event_id = ?'];
  const params = [eventId];
  if (!isStaff) {
    where.push('t.user_id = ?');
    params.push(req.user.id);
  } else if (q) {
    const like = `%${escapeLike(q)}%`;
    where.push(`(t.ticket_code LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')`);
    params.push(like, like, like);
  }

  const tickets = db
    .prepare(`
      SELECT t.id, t.ticket_code, t.price_paid, t.checked_in, t.checked_in_at, t.created_at,
             u.id AS user_id, u.name, u.email, u.membership_code, u.membership_status, u.membership_expires_at
      FROM tickets t
      JOIN users u ON u.id = t.user_id
      WHERE ${where.join(' AND ')}
      ORDER BY t.checked_in ASC, u.name ASC`)
    .all(...params)
    .map(toTicketView);

  const eventInfo = { id: event.id, title: event.title, event_date: event.event_date, location: event.location };
  if (!isStaff) return res.json({ event: eventInfo, tickets });

  // Stats cover the whole event, independent of the ?q= filter.
  const stats = db
    .prepare(`
      SELECT COUNT(*) AS tickets_sold,
             COALESCE(SUM(checked_in), 0) AS checked_in_count,
             COALESCE(SUM(price_paid), 0) AS ticket_revenue
      FROM tickets WHERE event_id = ?`)
    .get(eventId);

  res.json({
    event: {
      ...eventInfo,
      total_seats: event.total_seats,
      seats_left: event.seats_left,
      is_past: Date.parse(event.event_date) < Date.now(),
    },
    stats: {
      tickets_sold: stats.tickets_sold,
      checked_in_count: stats.checked_in_count,
      // Before the event this is "not yet arrived"; afterwards, true no-shows.
      no_show_count: stats.tickets_sold - stats.checked_in_count,
      ticket_revenue: stats.ticket_revenue,
    },
    query: q,
    count: tickets.length,
    tickets,
  });
});

router.post('/tickets/:code/check-in', requireAuth, requireRole('VOLUNTEER', 'ADMIN'), (req, res) => {
  const code = req.params.code.trim().toUpperCase();
  if (!TICKET_CODE_RE.test(code)) throw validationFailed({ code: 'Ticket code must be 4-40 letters, digits or dashes' });

  const result = withTransaction(() => {
    // ticket_code lookup is served by the UNIQUE autoindex on tickets(ticket_code).
    const ticket = db
      .prepare(`
        SELECT t.*, u.name, u.email, u.membership_code, u.membership_status, u.membership_expires_at,
               e.title AS event_title
        FROM tickets t
        JOIN users u ON u.id = t.user_id
        JOIN events e ON e.id = t.event_id
        WHERE t.ticket_code = ?`)
      .get(code);
    if (!ticket) throw new HttpError(404, 'Ticket not found');
    if (ticket.checked_in === 1) {
      throw new HttpError(409, `Ticket already checked in at ${ticket.checked_in_at}`, {
        checked_in_at: ticket.checked_in_at,
        attendee: { name: ticket.name },
      });
    }

    const checkedInAt = new Date().toISOString();
    const update = db
      .prepare('UPDATE tickets SET checked_in = 1, checked_in_at = ? WHERE id = ? AND checked_in = 0')
      .run(checkedInAt, ticket.id);
    if (update.changes !== 1) throw new HttpError(409, 'Ticket already checked in');

    const attendance = db
      .prepare('SELECT COUNT(*) AS tickets_sold, COALESCE(SUM(checked_in), 0) AS checked_in_count FROM tickets WHERE event_id = ?')
      .get(ticket.event_id);
    return { ticket, checkedInAt, attendance };
  });

  const { ticket, checkedInAt, attendance } = result;
  res.json({
    message: `Checked in: ${ticket.name}`,
    ticket: { ticket_code: ticket.ticket_code, price_paid: ticket.price_paid, checked_in: true, checked_in_at: checkedInAt },
    attendee: { id: ticket.user_id, name: ticket.name, email: ticket.email, membership: membershipSnapshot(ticket) },
    event: {
      id: ticket.event_id,
      title: ticket.event_title,
      tickets_sold: attendance.tickets_sold,
      checked_in_count: attendance.checked_in_count,
    },
  });
});

module.exports = router;
