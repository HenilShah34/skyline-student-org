# Skyline Student Association ERP

A small, complete ERP for a student association, built for the **Odoo × LDCE Hackathon 2026**. It covers memberships, event ticketing with door check-in, announcements, a merch store, a fundraiser task board, and the treasurer's books, all on one transactional SQLite database with a zero-dependency browser UI.

- **Backend:** Node.js 22.5+ · Express 5 · SQLite (`better-sqlite3`, with an automatic fallback to Node's built-in `node:sqlite`)
- **Frontend:** plain HTML, CSS and JavaScript in `public/`. No build step, no CDN, no web fonts, so it works with no internet connection.
- **Proof:** 6 automated verification suites (169 checks) run against real server processes on both SQLite drivers, plus two live terminal demos for concurrency and index performance.

---

## The six scenes and how they connect

| # | Scene | What happens | Writes to |
|---|---|---|---|
| 1 | **Membership** | Join or renew for ₹500/year. Renewal opens 30 days before expiry, so a double click can't charge twice. Door staff look members up by name, email or `SKY-2026-NNN` code. | `users`, `ledger_transactions` |
| 2 | **Events & door check-in** | Members pay the member price and everyone else the guest price, decided **on the server** from the live membership. Seats are claimed in a locked transaction. Volunteers scan `TKT-…` codes at the door; a second scan is refused. | `events`, `tickets`, `ledger_transactions` |
| 3 | **Announcements** | Category and keyword archive. Members-only posts are filtered out in SQL for non-members, who see how many are hidden. Staff broadcasts report a recipient count. | `announcements` |
| 4 | **Merch store** | Hoodies and tees with per-size stock (S/M/L/XL), member vs regular pricing, and a pickup desk that records who handed each order over and when. | `merch_variants`, `merch_orders`, `ledger_transactions` |
| 5 | **Bake-sale planner** | A To do / In progress / Done board with campaign progress and an "on track" flag (no overdue unfinished tasks). Students may move only tasks assigned to them. | `fundraiser_tasks` |
| 6 | **Treasurer's books** | Volunteers submit receipts; only an admin who is *not* the claimant can approve, and approval writes exactly one money-out row. A live ledger shows totals, a per-category breakdown, a CSV export, and fundraiser income entry. | `expense_reimbursements`, `ledger_transactions` |

**The thread that ties them together is the ledger.** Every rupee that moves (dues, ticket sales, merch sales, fundraiser income, reimbursements) is appended to `ledger_transactions` *in the same transaction* as the change that caused it. The treasurer's totals therefore always reconcile: `total_in − total_out = net_balance`, and the five categories add up to the whole.

---

## Architecture

```
Browser (public/app.js)            Express 5 (server.js)                         SQLite (skyline.db)
 one state object  ── fetch + ──▶   requireAuth / optionalAuth / requireRole  ──▶ WAL · foreign_keys=ON
 re-fetch after      Bearer         routes/*.js  (validate → withTransaction)     10 tables, 3NF
 every write         token          lib/*.js     (pricing, codes, ledger)         BEGIN IMMEDIATE writes
 Live API Inspector ◀── JSON ────    HttpError → JSON status codes
```

| Concern | How it's done | Where |
|---|---|---|
| Database safety | `PRAGMA foreign_keys = ON`, `journal_mode = WAL` and `busy_timeout` on every connection; startup fails loudly if foreign keys aren't on. | `db.js` `connect()` |
| Schema | `CREATE TABLE IF NOT EXISTS` for 10 tables, `CHECK` constraints (`seats_left >= 0`, `stock_count >= 0`, enum columns), plus a startup migration that adds newer columns to older databases. | `db.js` `SCHEMA`, `applySchema()` |
| Atomic writes | `withTransaction(fn)`: `BEGIN IMMEDIATE … COMMIT`, `ROLLBACK` on any error, savepoints for nesting, `SQLITE_BUSY` retry with backoff. | `db.js` |
| Passwords | `scrypt` with a random 16-byte salt (`saltHex:hashHex`), compared with `crypto.timingSafeEqual`. Unknown emails are checked against a dummy hash, so response time doesn't reveal which accounts exist. | `lib/password.js` |
| Sessions | Stateless tokens: `base64url(JSON payload).HMAC-SHA256`, 7-day expiry. The signature is verified **before** the payload is trusted. | `lib/token.js`, `middleware/requireAuth.js` |
| Authorization | `requireAuth` (401), `requireRole(...)` (403), plus row-level rules in routes: students move only their own tasks, admins can't approve their own claims. | `middleware/`, `routes/` |
| Pricing | Always recalculated on the server from the live membership row. Prices in request bodies are ignored. | `routes/events.js`, `routes/merch.js` |
| Input handling | Strict parsers for ids, enums and integers (`400` before any DB work); parameterised SQL everywhere; `LIKE` wildcards escaped; 100 kb JSON limit (`413`). | `lib/http.js` |
| Static files | Only `public/` is web-reachable. Server code, the database and dotfiles return 404. | `server.js` |

---

## Data model: 10 tables in third normal form

Each fact is stored once. Prices live on `merch_items` while stock lives per size on `merch_variants`; orders point at the exact variant; names are joined in, never copied.

```mermaid
erDiagram
    users ||--o{ tickets : "buys"
    users ||--o{ announcements : "authors"
    users ||--o{ merch_orders : "places"
    users |o--o{ merch_orders : "hands over (picked_up_by)"
    users |o--o{ fundraiser_tasks : "assigned to"
    users ||--o{ expense_reimbursements : "submits (volunteer_id)"
    users |o--o{ expense_reimbursements : "reviews (approved_by)"
    users |o--o{ ledger_transactions : "pays / is paid"
    events ||--o{ tickets : "has"
    merch_items ||--|{ merch_variants : "comes in sizes"
    merch_variants ||--o{ merch_orders : "sold as"

    users {
        INTEGER id PK
        TEXT name
        TEXT email UK
        TEXT password_hash
        TEXT role "STUDENT | VOLUNTEER | ADMIN"
        TEXT membership_code UK "SKY-2026-NNN"
        TEXT membership_status "NONE | ACTIVE | EXPIRED"
        TEXT membership_expires_at
        TEXT created_at
    }
    events {
        INTEGER id PK
        TEXT title
        TEXT description
        TEXT event_date
        TEXT location
        INTEGER total_seats "CHECK > 0"
        INTEGER seats_left "CHECK >= 0"
        INTEGER member_price
        INTEGER guest_price
        TEXT created_at
    }
    tickets {
        INTEGER id PK
        TEXT ticket_code UK
        INTEGER event_id FK
        INTEGER user_id FK
        INTEGER price_paid
        INTEGER checked_in "0 | 1"
        TEXT checked_in_at
        TEXT created_at
    }
    announcements {
        INTEGER id PK
        TEXT title
        TEXT content
        TEXT category "MEETING | DEADLINE | EVENT | GENERAL"
        TEXT target_audience "ALL | MEMBERS_ONLY"
        INTEGER author_id FK
        TEXT created_at
    }
    merch_items {
        INTEGER id PK
        TEXT name
        TEXT description
        TEXT category
        INTEGER member_price
        INTEGER regular_price
        TEXT created_at
    }
    merch_variants {
        INTEGER id PK
        INTEGER item_id FK "UNIQUE with size"
        TEXT size "S | M | L | XL"
        INTEGER stock_count "CHECK >= 0"
    }
    merch_orders {
        INTEGER id PK
        TEXT order_code UK
        INTEGER user_id FK
        INTEGER variant_id FK
        INTEGER quantity "CHECK > 0"
        INTEGER total_paid
        TEXT fulfillment_status "PAID_PENDING_PICKUP | PICKED_UP"
        TEXT created_at
        TEXT picked_up_at
        INTEGER picked_up_by FK
    }
    fundraiser_tasks {
        INTEGER id PK
        TEXT campaign_name
        TEXT title
        INTEGER assigned_to FK "nullable"
        TEXT status "TODO | IN_PROGRESS | DONE"
        TEXT due_date
        TEXT created_at
    }
    expense_reimbursements {
        INTEGER id PK
        INTEGER volunteer_id FK
        TEXT title
        TEXT category
        INTEGER amount "CHECK > 0"
        TEXT receipt_reference
        TEXT status "PENDING | APPROVED_PAID | REJECTED"
        INTEGER approved_by FK "nullable"
        TEXT created_at
    }
    ledger_transactions {
        INTEGER id PK
        TEXT type "IN | OUT"
        TEXT category "MEMBERSHIP_DUES | TICKET_SALE | MERCH_SALE | FUNDRAISER_INCOME | EXPENSE_REIMBURSEMENT"
        INTEGER amount "CHECK > 0"
        TEXT description
        TEXT reference_id
        INTEGER user_id FK "nullable"
        TEXT created_at
    }
```

**Indexes.** `UNIQUE` columns (`users.email`, `users.membership_code`, `tickets.ticket_code`, `merch_orders.order_code`, `merch_variants(item_id, size)`) get B-tree indexes automatically. Three more are added on purpose:

| Index | Serves |
|---|---|
| `idx_tickets_event_user (event_id, user_id)` | Duplicate-ticket check on purchase; door roster and attendance stats |
| `idx_tasks_campaign_status (campaign_name, status)` | A campaign's board, grouped by status |
| `idx_ledger_type_category (type, category, created_at)` | Treasurer totals and filters by type, category and date |

`GET /api/system/proof` (staff only; the **🗄 DB & Index Proof** button in the inspector bar) shows the live `EXPLAIN QUERY PLAN` for each lookup: every one is a `SEARCH … USING INDEX`, none a `SCAN`.

---

## Concurrency and race-condition defense

Every check-then-write (is there a seat left? is this size in stock? is this claim still pending?) runs inside `withTransaction`:

```js
withTransaction(() => {
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
  if (event.seats_left <= 0) throw new HttpError(409, 'Event is sold out');
  db.prepare('UPDATE events SET seats_left = seats_left - 1 WHERE id = ? AND seats_left > 0').run(id);
  // …insert the ticket and its ledger row…
});
```

1. **`BEGIN IMMEDIATE`** takes SQLite's single write lock *before* the first read. A second buyer, even in another server process, waits at `BEGIN` and then reads the already-committed result, so the check can't go stale before the write (no time-of-check-to-time-of-use gap).
2. **Guarded updates** (`… AND seats_left > 0`, `… AND stock_count >= ?`, `… AND status = 'PENDING'`) refuse to act on a state that has already changed.
3. **`CHECK` constraints** (`seats_left >= 0`, `stock_count >= 0`) are the last line: the database itself rejects a negative value.
4. **`SQLITE_BUSY` handling:** a 1-second `busy_timeout`, then up to 5 retries with exponential backoff and jitter. The whole transaction is rolled back and re-run, so callbacks are synchronous and touch only the database.
5. **All-or-nothing:** the sale, the stock or seat change, and the ledger row commit together, or nothing does.

The UI adds a second layer: while a request is in flight every action button is disabled and shows "Processing…", and after each write the page re-fetches from the server instead of guessing.

**See it live:** `npm run proof:concurrency` starts 5 independent server processes against one temporary database and runs three races. Each produces exactly one winner and four `409`s:

| Race | Outcome |
|---|---|
| Last Spring Gala seat (5 buyers) | 1 × `201 Created`, 4 × `409 Event is sold out`, `seats_left = 0` |
| Last size XL hoodie (5 orders) | 1 × `201 Created`, 4 × `409 Size XL is out of stock`, `stock_count = 0` |
| One ₹650 receipt (5 admin approvals) | 1 × `200 OK`, 4 × `409 Reimbursement already APPROVED_PAID`, one −₹650 ledger row |

---

## Quick start

```bash
npm install
npm run seed -- --reset     # fresh demo data (the server also seeds an empty database on first start)
npm start                   # http://localhost:3000
```

### Demo personas

All passwords are `skyline123`. Click a persona pill in the top bar, or open `http://localhost:3000/?persona=rohan`.

| Persona | Email | Role | Shows off |
|---|---|---|---|
| Vikram Desai | `vikram@skyline.edu` | Admin / Treasurer | Approves reimbursements, records income, exports the books, creates events |
| Neha Sharma | `neha@skyline.edu` | Volunteer Lead | Door check-in, pickup desk, announcements, task board, expense receipts |
| Rohan Verma | `rohan@skyline.edu` | Active member (renewal due) | Member prices (₹250 Gala, ₹899 hoodie), members-only posts, renewal banner |
| Kabir Singh | `kabir@skyline.edu` | Non-member student | Guest prices (₹500 Gala, ₹1,199 hoodie), hidden members-only posts, 403s on staff actions |

The **Live API Inspector** at the bottom of the page records every request with its method, path, status code, payload and JSON response, plus a "Copy as cURL" button.

### Verification and live proofs

```bash
npm run verify:fast          # all 6 suites on better-sqlite3 (169 checks, ~15 s)
npm run verify               # the same suites on both SQLite drivers
npm run proof:concurrency    # 3 multi-process races with per-process timings
npm run proof:indexes        # B-tree SEARCH vs full SCAN on 25,000 synthetic rows
```

| Suite | Covers |
|---|---|
| `verify-phase1.js` | Pragmas, foreign keys, rollback, busy retry, login, tampered tokens, index plans |
| `verify-phase2.js` | Membership renewal, member/guest pricing, duplicate tickets, seat race, door check-in |
| `verify-phase3.js` | Double-renewal guard, members-only announcements, merch pricing, stock race, pickup |
| `verify-phase4.js` | Schema migration, task board, reimbursements, double-payout race, ledger integrity |
| `verify-phase5.js` | Static client, offline guarantee, no file leaks, per-viewer pricing fields |
| `verify-phase6.js` | CSV export and formula-injection guard, live index proof, security and edge-case sweep |

Every suite starts a real `node server.js` on a random port against a temporary database. Port 3000 and `skyline.db` are never touched.

---

## Project layout

```
server.js                 Express app: static files, auth routes, system proof, route mounting, error handler
db.js                     Connection + pragmas, schema + migrations, withTransaction()
seed.js                   Demo data (auto on an empty DB, or `npm run seed -- --reset`)
lib/                      password, token, users (membership status), viewer, ledger,
                          codes, fundraising, http (errors + parsers), testHooks
middleware/requireAuth.js requireAuth · optionalAuth · requireRole
routes/                   memberships · events · announcements · merch · tasks · finance
public/                   index.html · styles.css · app.js (the whole UI)
verify-*.js               Verification suites (verify-all.js runs them)
proof-*.js                Live terminal demos
```

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `./skyline.db` | SQLite file |
| `TOKEN_SECRET` | built-in development secret | HMAC key for login tokens. **Set this in any real deployment.** |
| `SQLITE_DRIVER` | `better-sqlite3` | Set to `node` to force the built-in `node:sqlite` driver |
| `DEMO_ACCOUNTS` | on | Set to `off` to hide the demo persona endpoint |
