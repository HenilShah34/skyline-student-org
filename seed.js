'use strict';

const { db, withTransaction, TABLES } = require('./db');
const { hashPassword } = require('./lib/password');
const { DAY_MS, MEMBERSHIP_FEE, MEMBERSHIP_TERM_DAYS } = require('./lib/users');
const { DEFAULT_CAMPAIGN: BAKE_SALE, localDate } = require('./lib/fundraising');

const DEMO_PASSWORD = 'skyline123';

// Rohan paid 355 days ago, so his membership expires in 10 days and the
// renewal reminder shows up on first login.
const DEMO_ACCOUNTS = [
  { key: 'vikram', name: 'Vikram Desai', email: 'vikram@skyline.edu', role: 'ADMIN', persona: 'Club President / Admin', membershipCode: 'SKY-2026-001', joinedDaysAgo: 400, duesPaidDaysAgo: 60 },
  { key: 'meera', name: 'Meera Joshi', email: 'meera@skyline.edu', role: 'TREASURER', persona: 'Club Treasurer', membershipCode: 'SKY-2026-002', joinedDaysAgo: 390, duesPaidDaysAgo: 62 },
  { key: 'neha', name: 'Neha Sharma', email: 'neha@skyline.edu', role: 'VOLUNTEER', persona: 'Volunteer Lead', membershipCode: 'SKY-2026-003', joinedDaysAgo: 380, duesPaidDaysAgo: 58 },
  { key: 'rohan', name: 'Rohan Verma', email: 'rohan@skyline.edu', role: 'STUDENT', persona: 'Active Member (renewal due in 10 days)', membershipCode: 'SKY-2026-004', joinedDaysAgo: 360, duesPaidDaysAgo: 355 },
  { key: 'kabir', name: 'Kabir Singh', email: 'kabir@skyline.edu', role: 'STUDENT', persona: 'Non-member Student', membershipCode: null, joinedDaysAgo: 5, duesPaidDaysAgo: null },
];

function userCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

function tableCounts() {
  const counts = {};
  for (const table of TABLES) counts[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  return counts;
}

function wipeAll() {
  for (const table of [...TABLES].reverse()) db.exec(`DELETE FROM ${table}`);
  db.exec('DELETE FROM sqlite_sequence');
}

function insertSeedData(passwordHashes) {
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const daysAgo = (days) => iso(now - days * DAY_MS);
  const daysAhead = (days, hour = 18, minute = 30) => {
    const d = new Date(now + days * DAY_MS);
    d.setHours(hour, minute, 0, 0);
    return d.toISOString();
  };
  const dueIn = (days) => localDate(now + days * DAY_MS);

  const insertLedger = db.prepare(`
    INSERT INTO ledger_transactions (type, category, amount, description, reference_id, user_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);

  // Users + membership dues
  const insertUser = db.prepare(`
    INSERT INTO users (name, email, password_hash, role, membership_code, membership_status, membership_expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const users = {};
  for (const a of DEMO_ACCOUNTS) {
    const paidAt = a.membershipCode ? now - a.duesPaidDaysAgo * DAY_MS : null;
    const { lastInsertRowid } = insertUser.run(
      a.name,
      a.email,
      passwordHashes.get(a.email),
      a.role,
      a.membershipCode,
      a.membershipCode ? 'ACTIVE' : 'NONE',
      a.membershipCode ? iso(paidAt + MEMBERSHIP_TERM_DAYS * DAY_MS) : null,
      daysAgo(a.joinedDaysAgo),
    );
    users[a.key] = { id: Number(lastInsertRowid), name: a.name };
    if (a.membershipCode) {
      insertLedger.run('IN', 'MEMBERSHIP_DUES', MEMBERSHIP_FEE, `Annual Membership Dues - ${a.name}`, a.membershipCode, users[a.key].id, iso(paidAt));
    }
  }

  // Events + tickets. seats_left = total_seats - box-office sales - online tickets.
  const insertEvent = db.prepare(`
    INSERT INTO events (title, description, event_date, location, total_seats, seats_left, member_price, guest_price, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertTicket = db.prepare(`
    INSERT INTO tickets (ticket_code, event_id, user_id, price_paid, created_at)
    VALUES (?, ?, ?, ?, ?)`);

  const events = [
    {
      title: 'Spring Annual Gala 2026',
      description: "An evening of live music, awards for the year's standout volunteers, and a three-course dinner. Formal attire.",
      eventDate: daysAhead(21, 18, 30),
      location: 'Grand Hall, Student Activity Centre',
      totalSeats: 100,
      memberPrice: 250,
      guestPrice: 500,
      createdDaysAgo: 30,
      // Sold at the physical counter before online ticketing launched.
      boxOffice: { member: 32, guest: 24, referenceId: 'GALA26-BOXOFFICE', daysAgo: 20 },
      tickets: [
        { code: 'TKT-GALA26-0001', user: 'vikram', daysAgo: 14 },
        { code: 'TKT-GALA26-0002', user: 'neha', daysAgo: 13 },
      ],
    },
    {
      title: 'Odoo ERP Workshop & Hack Night',
      description: 'Hands-on session: model a student-club workflow in Odoo, then hack on it overnight with mentors. Laptops required; dinner and chai provided.',
      eventDate: daysAhead(9, 17, 0),
      location: 'Innovation Lab, Block C',
      totalSeats: 60,
      memberPrice: 50,
      guestPrice: 150,
      createdDaysAgo: 15,
      boxOffice: null,
      tickets: [{ code: 'TKT-ODOO26-0001', user: 'rohan', daysAgo: 4 }],
    },
  ];

  for (const e of events) {
    const boxOfficeSeats = e.boxOffice ? e.boxOffice.member + e.boxOffice.guest : 0;
    const seatsLeft = e.totalSeats - boxOfficeSeats - e.tickets.length;
    const { lastInsertRowid } = insertEvent.run(e.title, e.description, e.eventDate, e.location, e.totalSeats, seatsLeft, e.memberPrice, e.guestPrice, daysAgo(e.createdDaysAgo));
    const eventId = Number(lastInsertRowid);

    if (e.boxOffice) {
      const { member, guest, referenceId } = e.boxOffice;
      insertLedger.run(
        'IN', 'TICKET_SALE', member * e.memberPrice + guest * e.guestPrice,
        `${e.title} — box-office pre-sales (${member} member × ₹${e.memberPrice}, ${guest} guest × ₹${e.guestPrice})`,
        referenceId, null, daysAgo(e.boxOffice.daysAgo),
      );
    }
    // All seeded ticket holders are active members, so they paid member price.
    for (const t of e.tickets) {
      const user = users[t.user];
      insertTicket.run(t.code, eventId, user.id, e.memberPrice, daysAgo(t.daysAgo));
      insertLedger.run('IN', 'TICKET_SALE', e.memberPrice, `Ticket ${t.code} — ${e.title} (member price)`, t.code, user.id, daysAgo(t.daysAgo));
    }
  }

  // Announcements
  const insertAnnouncement = db.prepare(`
    INSERT INTO announcements (title, content, category, target_audience, author_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`);
  insertAnnouncement.run(
    'General Body Meeting — Budget Review',
    'All members and volunteers: join us this Friday at 5:30 PM in Seminar Hall B. Agenda: Q3 ledger review, Gala logistics, and the bake sale roster.',
    'MEETING', 'ALL', users.vikram.id, daysAgo(2),
  );
  insertAnnouncement.run(
    'Membership renewals are open',
    'If your membership expires this month, renew from your dashboard to keep member pricing on Gala tickets and merch. It takes under a minute.',
    'DEADLINE', 'MEMBERS_ONLY', users.vikram.id, daysAgo(1),
  );
  insertAnnouncement.run(
    'Spring Annual Gala 2026 — under 50 seats left',
    'Members pay ₹250 and guests ₹500. Grab your ticket before the Grand Hall fills up.',
    'EVENT', 'ALL', users.neha.id, daysAgo(0.5),
  );

  // Merch catalogue. Stock counts are what remains after the seeded orders.
  const insertItem = db.prepare(`
    INSERT INTO merch_items (name, description, category, member_price, regular_price, created_at, cost_price, low_stock_threshold, assigned_manager_id, images_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertVariant = db.prepare('INSERT INTO merch_variants (item_id, size, stock_count) VALUES (?, ?, ?)');
  const insertOrder = db.prepare(`
    INSERT INTO merch_orders (order_code, user_id, variant_id, quantity, total_paid, fulfillment_status, created_at, picked_up_at, picked_up_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const merch = [
    {
      key: 'hoodie',
      name: 'Skyline Signature Hoodie',
      description: 'Heavyweight 320 GSM cotton-fleece hoodie with the embroidered Skyline crest. Midnight navy.',
      memberPrice: 899,
      regularPrice: 1199,
      stock: { S: 12, M: 24, L: 18, XL: 3 },
      category: 'HOODIES', costPrice: 520, style: 'hoodie', color: '#1e2a4a',
    },
    {
      key: 'tee',
      name: 'Campus Club Tee',
      description: 'Soft-washed 180 GSM cotton tee with the Skyline city-line print across the back.',
      memberPrice: 349,
      regularPrice: 499,
      stock: { S: 30, M: 40, L: 20, XL: 0 },
      category: 'T_SHIRTS', costPrice: 180, style: 'tee', color: '#0f766e',
    },
    {
      key: 'cap',
      name: 'Skyline Embroidered Snapback Cap',
      description: 'Structured six-panel snapback with a raised 3D-embroidered Skyline emblem and a curved-brim option.',
      memberPrice: 399,
      regularPrice: 549,
      stock: { S: 6, M: 14, L: 9, XL: 2 },
      category: 'CAPS', costPrice: 210, style: 'cap', color: '#7c2d12',
    },
    {
      key: 'pants',
      name: 'Skyline Athletic Track Pants',
      description: 'Four-way-stretch joggers with zip pockets, tapered cuffs and reflective Skyline side piping.',
      memberPrice: 799,
      regularPrice: 1049,
      stock: { S: 10, M: 2, L: 16, XL: 8 },
      category: 'PANTS', costPrice: 450, style: 'pants', color: '#111827',
    },
    {
      key: 'tote',
      name: 'Insulated Campus Tote & Bottle',
      description: 'Heavy canvas tote with a double-wall steel bottle that keeps chai hot for 12 hours. Sizes are bottle capacities.',
      memberPrice: 499,
      regularPrice: 699,
      stock: { S: 20, M: 3, L: 15, XL: 11 },
      category: 'ACCESSORIES', costPrice: 260, style: 'tote', color: '#5b3f8c',
    },
  ];
  const variants = {};
  for (const m of merch) {
    const itemId = Number(insertItem.run(
      m.name, m.description, m.category, m.memberPrice, m.regularPrice, daysAgo(45),
      m.costPrice, 5, users.vikram.id, JSON.stringify({ style: m.style, color: m.color }),
    ).lastInsertRowid);
    for (const [size, stock] of Object.entries(m.stock)) {
      variants[`${m.key}:${size}`] = { id: Number(insertVariant.run(itemId, size, stock).lastInsertRowid), item: m };
    }
  }

  const orders = [
    { code: 'ORD-2026-0001', user: 'rohan', variant: 'hoodie:M', quantity: 1, status: 'PICKED_UP', daysAgo: 12, pickedUp: { by: 'neha', daysAgo: 11 } },
    { code: 'ORD-2026-0002', user: 'neha', variant: 'tee:L', quantity: 2, status: 'PAID_PENDING_PICKUP', daysAgo: 3, pickedUp: null },
  ];
  for (const o of orders) {
    const variant = variants[o.variant];
    const user = users[o.user];
    const total = variant.item.memberPrice * o.quantity;
    insertOrder.run(
      o.code, user.id, variant.id, o.quantity, total, o.status, daysAgo(o.daysAgo),
      o.pickedUp ? daysAgo(o.pickedUp.daysAgo) : null, o.pickedUp ? users[o.pickedUp.by].id : null,
    );
    insertLedger.run('IN', 'MERCH_SALE', total, `Order ${o.code} — ${o.quantity} × ${variant.item.name} (${o.variant.split(':')[1]})`, o.code, user.id, daysAgo(o.daysAgo));
  }

  // Bake sale fundraiser
  const insertTask = db.prepare(`
    INSERT INTO fundraiser_tasks (campaign_name, title, assigned_to, status, due_date, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`);
  const tasks = [
    { title: 'Book the Student Centre atrium stall', user: 'neha', status: 'DONE', due: -2 },
    { title: 'Buy flour, butter & chocolate from the wholesale market', user: 'neha', status: 'IN_PROGRESS', due: 2 },
    { title: 'Design posters and the Instagram story', user: 'rohan', status: 'IN_PROGRESS', due: 3 },
    { title: 'Recruit 8 bakers for the Saturday shift', user: 'neha', status: 'TODO', due: 4 },
    { title: 'Set up the UPI QR code and cash float', user: null, status: 'TODO', due: 6 },
  ];
  for (const t of tasks) {
    insertTask.run(BAKE_SALE, t.title, t.user ? users[t.user].id : null, t.status, dueIn(t.due), daysAgo(7));
  }
  insertLedger.run('IN', 'FUNDRAISER_INCOME', 1850, `${BAKE_SALE} — advance pre-orders collected via UPI`, 'BAKESALE26-PREORDERS', null, daysAgo(2));

  // Volunteer expense reimbursements
  const insertExpense = db.prepare(`
    INSERT INTO expense_reimbursements (volunteer_id, title, category, amount, receipt_reference, status, approved_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const paidExpense = {
    title: 'Gala décor — fairy lights and drapes',
    category: 'EVENT_COSTS',
    amount: 2350,
    receipt: 'RCPT-2026-0917',
  };
  insertExpense.run(
    users.neha.id, paidExpense.title, paidExpense.category, paidExpense.amount, paidExpense.receipt, 'APPROVED_PAID', users.meera.id, daysAgo(10),
  );
  insertLedger.run(
    'OUT', 'EXPENSE_REIMBURSEMENT', paidExpense.amount,
    `Reimbursement: ${paidExpense.title} (${paidExpense.receipt}) - ${users.neha.name}`,
    paidExpense.receipt, users.neha.id, daysAgo(9),
  );

  insertExpense.run(users.neha.id, 'Bake sale ingredients — first batch', 'FUNDRAISER_SUPPLIES', 1640, 'RCPT-2026-1001', 'PENDING', null, daysAgo(1));
  return { users, insertLedger, now };
}

// ---------------------------------------------------------------- full semester dataset
// 100 more students (IDs 6-105): 55 club members (SKY-2026-005 … 059), 30
// non-members and 15 volunteers, with dues, Gala and workshop tickets, merch
// orders spread over the last 120 days, and 3 pending task requests. The test
// suites seed the compact profile (just the 5 named accounts) so their exact
// counts stay stable; verify-phase8.js checks this full profile.
const FIRST = ['Aarav', 'Ananya', 'Ishaan', 'Diya', 'Vihaan', 'Saanvi', 'Arjun', 'Myra', 'Reyansh', 'Kiara', 'Aditya', 'Navya', 'Krishna', 'Pari', 'Sai', 'Riya', 'Atharv', 'Aadhya', 'Dhruv', 'Ira', 'Kabir', 'Tara', 'Ayaan', 'Meher', 'Vivaan', 'Anika', 'Shaurya', 'Prisha', 'Rudra', 'Siya'];
const LAST = ['Patel', 'Shah', 'Mehta', 'Iyer', 'Nair', 'Reddy', 'Gupta', 'Kulkarni', 'Desai', 'Chopra', 'Bose', 'Menon', 'Trivedi', 'Pandya', 'Joshi', 'Rao', 'Malhotra', 'Bhatt', 'Kapoor', 'Saxena', 'Pillai', 'Chauhan', 'Parekh', 'Banerjee'];

function insertBulkData(users, passwordHash, insertLedger, now) {
  const iso = (ms) => new Date(ms).toISOString();
  const daysAgo = (days) => iso(now - days * DAY_MS);
  let seed = 20260;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const pick = (list) => list[Math.floor(rand() * list.length)];

  const insertUser = db.prepare(`
    INSERT INTO users (name, email, password_hash, role, membership_code, membership_status, membership_expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const bulk = [];
  const emails = new Set();
  for (let i = 0; i < 100; i++) {
    const first = FIRST[i % FIRST.length];
    const last = LAST[(i * 7 + Math.floor(i / FIRST.length)) % LAST.length];
    let email = `${first}.${last}@skyline.edu`.toLowerCase();
    for (let n = 2; emails.has(email); n++) email = `${first}.${last}${n}@skyline.edu`.toLowerCase();
    emails.add(email);
    const kind = i < 55 ? 'MEMBER' : i < 85 ? 'NON_MEMBER' : 'VOLUNTEER';
    const code = kind === 'MEMBER' ? `SKY-2026-${String(i + 5).padStart(3, '0')}` : null;
    // A few members paid ~11 months ago, so their renewal reminder is live.
    const paidDaysAgo = kind === 'MEMBER' ? (i % 11 === 0 ? 340 + (i % 20) : 5 + Math.floor(rand() * 200)) : null;
    const joined = kind === 'MEMBER' ? paidDaysAgo + 3 : 2 + Math.floor(rand() * 150);
    const id = Number(insertUser.run(
      `${first} ${last}`, email, passwordHash, kind === 'VOLUNTEER' ? 'VOLUNTEER' : 'STUDENT', code,
      code ? 'ACTIVE' : 'NONE', code ? iso(now - paidDaysAgo * DAY_MS + MEMBERSHIP_TERM_DAYS * DAY_MS) : null, daysAgo(joined),
    ).lastInsertRowid);
    if (code) insertLedger.run('IN', 'MEMBERSHIP_DUES', MEMBERSHIP_FEE, `Annual Membership Dues - ${first} ${last}`, code, id, daysAgo(paidDaysAgo));
    bulk.push({ id, name: `${first} ${last}`, kind });
  }
  const members = bulk.filter((u) => u.kind === 'MEMBER');
  const others = bulk.filter((u) => u.kind !== 'MEMBER');

  // Tickets: 28 for the Gala, 18 for the workshop.
  const insertTicket = db.prepare('INSERT INTO tickets (ticket_code, event_id, user_id, price_paid, created_at) VALUES (?, ?, ?, ?, ?)');
  const plan = [['Spring Annual Gala 2026', 'GALA26', 28, 3], ['Odoo ERP Workshop & Hack Night', 'ODOO26', 18, 2]];
  for (const [title, tag, count, firstNo] of plan) {
    const event = db.prepare('SELECT * FROM events WHERE title = ?').get(title);
    const buyers = [...members.slice(0, Math.ceil(count * 0.7)), ...others.slice(0, count - Math.ceil(count * 0.7))];
    buyers.forEach((u, n) => {
      const price = u.kind === 'MEMBER' ? event.member_price : event.guest_price;
      const code = `TKT-${tag}-${String(firstNo + n).padStart(4, '0')}`;
      const when = daysAgo(1 + Math.floor(rand() * 12));
      insertTicket.run(code, event.id, u.id, price, when);
      insertLedger.run('IN', 'TICKET_SALE', price, `Ticket ${code} — ${title} (${u.kind === 'MEMBER' ? 'member' : 'guest'} price)`, code, u.id, when);
    });
    db.prepare('UPDATE events SET seats_left = seats_left - ? WHERE id = ?').run(buyers.length, event.id);
  }

  // 64 merch orders across the last 120 days (stock counts are what is left now).
  const variants = db.prepare('SELECT v.id, v.size, i.name, i.member_price, i.regular_price FROM merch_variants v JOIN merch_items i ON i.id = v.item_id').all();
  const insertOrder = db.prepare(`
    INSERT INTO merch_orders (order_code, user_id, variant_id, quantity, total_paid, fulfillment_status, created_at, picked_up_at, picked_up_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (let n = 0; n < 64; n++) {
    const u = n % 3 === 2 ? pick(others) : pick(members);
    const v = pick(variants);
    const qty = rand() < 0.8 ? 1 : 2;
    const total = (u.kind === 'MEMBER' ? v.member_price : v.regular_price) * qty;
    const age = n < 14 ? 1 + Math.floor(rand() * 6) : n < 34 ? 8 + Math.floor(rand() * 22) : 31 + Math.floor(rand() * 90);
    const code = `ORD-2026-${String(3 + n).padStart(4, '0')}`;
    const picked = age > 7;
    insertOrder.run(code, u.id, v.id, qty, total, picked ? 'PICKED_UP' : 'PAID_PENDING_PICKUP', daysAgo(age),
      picked ? daysAgo(age - 1) : null, picked ? users.neha.id : null);
    insertLedger.run('IN', 'MERCH_SALE', total, `Order ${code} — ${qty} × ${v.name} (${v.size})`, code, u.id, daysAgo(age));
  }

  // Two more open bake-sale tasks, and 3 pending requests to take them.
  const insertTask = db.prepare(`
    INSERT INTO fundraiser_tasks (campaign_name, title, assigned_to, status, due_date, created_at)
    VALUES (?, ?, NULL, 'TODO', ?, ?)`);
  const labels = Number(insertTask.run(BAKE_SALE, 'Print price labels and allergen cards', localDate(now + 5 * DAY_MS), daysAgo(3)).lastInsertRowid);
  insertTask.run(BAKE_SALE, 'Arrange 20 trestle tables and two gazebos', localDate(now + 6 * DAY_MS), daysAgo(3));
  const upi = db.prepare("SELECT id FROM fundraiser_tasks WHERE title = 'Set up the UPI QR code and cash float'").get().id;
  const volunteers = bulk.filter((u) => u.kind === 'VOLUNTEER');
  const insertRequest = db.prepare("INSERT INTO task_requests (task_id, user_id, note, status, created_at) VALUES (?, ?, ?, 'PENDING', ?)");
  insertRequest.run(upi, volunteers[0].id, 'I handle the UPI collections at my family shop, happy to set this up.', daysAgo(1));
  insertRequest.run(upi, members[1].id, 'I can bring a cash box and ₹2,000 in change on Saturday morning.', daysAgo(0.5));
  insertRequest.run(labels, members[2].id, 'I can design and laminate 40 labels on Friday.', daysAgo(0.3));
}

// Seeds only when the users table is empty, unless reset is true (wipe + reseed).
// profile: 'full' (the 105-user semester, the default) or 'compact' (5 users;
// the test suites set SEED_PROFILE=compact).
function seedDatabase({ reset = false, profile = process.env.SEED_PROFILE || 'full' } = {}) {
  if (!reset && userCount() > 0) return { seeded: false };

  // scrypt is deliberately slow; hash before taking the write lock.
  const passwordHashes = new Map(DEMO_ACCOUNTS.map((a) => [a.email, hashPassword(DEMO_PASSWORD)]));
  // The 100 extra demo students share one hash of the demo password (same password, so nothing leaks).
  const bulkHash = profile === 'compact' ? null : hashPassword(DEMO_PASSWORD);

  return withTransaction(() => {
    if (reset) wipeAll();
    else if (userCount() > 0) return { seeded: false }; // another process seeded first
    const { users, insertLedger, now } = insertSeedData(passwordHashes);
    if (bulkHash) insertBulkData(users, bulkHash, insertLedger, now);
    return { seeded: true, profile: bulkHash ? 'full' : 'compact', counts: tableCounts() };
  });
}

function seedIfEmpty() {
  return seedDatabase({ reset: false });
}

module.exports = { seedDatabase, seedIfEmpty, DEMO_ACCOUNTS, DEMO_PASSWORD, FIRST, LAST };

if (require.main === module) {
  const reset = process.argv.includes('--reset');
  const result = seedDatabase({ reset });
  if (result.seeded) {
    console.log(`[seed] ${reset ? 'Reset and seeded' : 'Seeded'} demo data:`, result.counts);
  } else {
    console.log('[seed] Database already has users; nothing to do. Run `node seed.js --reset` to wipe and reseed.');
  }
  db.close();
}
