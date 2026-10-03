# Skyline Student Association ERP

A small, complete ERP for a student association, built for the **Odoo × LDCE Hackathon 2026**. It covers memberships, event ticketing with door check-in, announcements, a merch store, a fundraiser task board, and the treasurer's books, all on one transactional SQLite database with a zero-dependency browser UI. Four roles (Admin, Treasurer, Volunteer, Student) each see exactly what they're allowed to do.

- **Backend:** Node.js 22.5+ · Express 5 · SQLite (`better-sqlite3`, with an automatic fallback to Node's built-in `node:sqlite`)
- **Frontend:** plain HTML, CSS and JavaScript in `public/`. No build step, no CDN, no web fonts, so it works with no internet connection. Full-screen sign-in with account recovery, a profile page, a collapsible sidebar that becomes a drawer on phones, and light/dark themes.
- **Proof:** 6 automated verification suites (183 checks) run against real server processes on both SQLite drivers, plus two live terminal demos for concurrency and index performance.

---

## The six scenes and how they connect

| # | Scene | What happens | Writes to |
|---|---|---|---|
| 1 | **Membership** | Join or renew for ₹500/year. Renewal opens 30 days before expiry, so a double click can't charge twice. Door staff look members up by name, email or `SKY-2026-NNN` code. | `users`, `ledger_transactions` |
| 2 | **Events & door check-in** | Members pay the member price and everyone else the guest price, decided **on the server** from the live membership. Seats are claimed in a locked transaction. Volunteers scan `TKT-…` codes at the door; a second scan is refused. | `events`, `tickets`, `ledger_transactions` |
| 3 | **Announcements** | Category and keyword archive. Members-only posts are filtered out in SQL for non-members, who see how many are hidden. Staff broadcasts report a recipient count. | `announcements` |
| 4 | **Merch store** | Hoodies and tees with per-size stock (S/M/L/XL), member vs regular pricing, and a pickup desk that records who handed each order over and when. | `merch_variants`, `merch_orders`, `ledger_transactions` |
| 5 | **Bake-sale planner** | A To do / In progress / Done board with campaign progress and an "on track" flag (no overdue unfinished tasks). Students may move only tasks assigned to them. | `fundraiser_tasks` |
| 6 | **Treasurer's books** | Staff submit receipts; only the Treasurer or Admin can approve, never on their own claim, and approval writes exactly one money-out row. A live ledger shows totals and a per-category breakdown; the Treasurer and Admin also export it as CSV and record fundraiser income. | `expense_reimbursements`, `ledger_transactions` |

**The thread that ties them together is the ledger.** Every rupee that moves (dues, ticket sales, merch sales, fundraiser income, reimbursements) is appended to `ledger_transactions` *in the same transaction* as the change that caused it. The treasurer's totals therefore always reconcile: `total_in − total_out = net_balance`, and the five categories add up to the whole.

---

## Architecture

```
Browser (public/app.js)            Express 5 (server.js)                         SQLite (skyline.db)
 one state object  ── fetch + ──▶   requireAuth / optionalAuth / requireRole  ──▶ WAL · foreign_keys=ON
 re-fetch after      Bearer         routes/*.js  (validate → withTransaction)     10 tables, 3NF
 every write         token          lib/*.js     (pricing, codes, ledger)         BEGIN IMMEDIATE writes
 friendly toasts    ◀── JSON ────    HttpError → JSON status codes
```

| Concern | How it's done | Where |
|---|---|---|
| Database safety | `PRAGMA foreign_keys = ON`, `journal_mode = WAL` and `busy_timeout` on every connection; startup fails loudly if foreign keys aren't on. | `db.js` `connect()` |
| Schema | `CREATE TABLE IF NOT EXISTS` for 10 tables, `CHECK` constraints (`seats_left >= 0`, `stock_count >= 0`, enum columns), plus startup migrations: newer columns are added to older databases, and the `users` table is rebuilt in place (foreign keys checked) to accept the `TREASURER` role. | `db.js` `SCHEMA`, `applySchema()`, `upgradeUserRoles()` |
| Atomic writes | `withTransaction(fn)`: `BEGIN IMMEDIATE … COMMIT`, `ROLLBACK` on any error, savepoints for nesting, `SQLITE_BUSY` retry with backoff. | `db.js` |
| Passwords | `scrypt` with a random 16-byte salt (`saltHex:hashHex`), compared with `crypto.timingSafeEqual`. Unknown emails are checked against a dummy hash, so response time doesn't reveal which accounts exist. | `lib/password.js` |
| Sessions | Stateless tokens: `base64url(JSON payload).HMAC-SHA256`, 7-day expiry. The signature is verified **before** the payload is trusted. | `lib/token.js`, `middleware/requireAuth.js` |
| Authorization | `requireAuth` (401), `requireRole(...)` (403), plus row-level rules in routes: students move only their own tasks, and nobody (Treasurer or Admin) can review their own claim. | `middleware/`, `routes/` |
| Account recovery | Forgot email: look an account up by membership code or full name; the email comes back for that account only. Forgot password: email **plus** membership code or full name, a new password of 6+ characters, and an immediate sign-in. A wrong pair and an unknown email get the same `401`. | `server.js` `/api/auth/*` |
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
        TEXT role "STUDENT | VOLUNTEER | TREASURER | ADMIN"
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

`GET /api/system/proof` (staff token required; checked by `verify-phase6.js`) returns the live `EXPLAIN QUERY PLAN` for each lookup: every one is a `SEARCH … USING INDEX`, none a `SCAN`.

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
| One ₹650 receipt (5 treasurer approvals) | 1 × `200 OK`, 4 × `409 Reimbursement already APPROVED_PAID`, one −₹650 ledger row |

---

## Quick start

```bash
npm install
npm run seed -- --reset     # fresh demo data (the server also seeds an empty database on first start)
npm start                   # http://localhost:3000
```

### Roles and demo accounts

All five passwords are `skyline123`. On the sign-in page, open **🔑 Quick Fill Credentials** and click an account: it fills the email and password, and you press **Sign In** yourself.

| Account | Email | Role | Shows off |
|---|---|---|---|
| Vikram Desai | `vikram@skyline.edu` | Admin (`SKY-2026-001`) | Creates events, approves claims (including the Treasurer's), runs everything staff can |
| Meera Joshi | `meera@skyline.edu` | Treasurer (`SKY-2026-002`) | Approves or rejects reimbursements, records fundraiser income, exports the books as CSV |
| Neha Sharma | `neha@skyline.edu` | Volunteer (`SKY-2026-003`) | Door check-in, pickup desk, announcements, task board, submits expense receipts |
| Rohan Verma | `rohan@skyline.edu` | Student, member expiring in 10 days (`SKY-2026-004`) | Member prices (₹250 Gala, ₹899 hoodie), members-only posts, renewal banner |
| Kabir Singh | `kabir@skyline.edu` | Student, not a member | Guest prices (₹500 Gala, ₹1,199 hoodie), hidden members-only posts, refused staff actions |

**Who can do what.** "Staff" means Volunteer, Treasurer and Admin. Every rule is enforced on the server with `requireRole`; the UI only hides what the server would refuse anyway.

| Action | Student | Volunteer | Treasurer | Admin |
|---|:-:|:-:|:-:|:-:|
| Join/renew, buy tickets and merch, read announcements | ✓ | ✓ | ✓ | ✓ |
| Move a bake-sale task | own tasks only | ✓ | ✓ | ✓ |
| Door lookup and check-in, pickup desk, post announcements, add tasks | | ✓ | ✓ | ✓ |
| Submit an expense receipt, view the ledger, `GET /api/system/proof` | | ✓ | ✓ | ✓ |
| Approve or reject a reimbursement (never your own) | | | ✓ | ✓ |
| Record fundraiser income, export the ledger as CSV | | | ✓ | ✓ |
| Create an event | | | | ✓ |

### Sign-in, recovery and profile

- **Sign in / Create account:** a full-screen split page with a show/hide password toggle. Registration asks for the password twice (8+ characters) and signs you in straight away.
- **Forgot email** (`POST /api/auth/forgot-email`): enter your membership code (`SKY-2026-004`) or full name. The account's email appears, and one click puts it in the sign-in form.
- **Forgot password** (`POST /api/auth/forgot-password`): enter your email plus your membership code or full name, then choose a new password (6+ characters). You're signed in with it immediately.
- **My Profile & Settings** (`PATCH /api/auth/profile`): your membership ID card, edit your display name, change your password (the current one is required), pick a light or dark theme, and sign out. Click your name chip in the top bar to get there.
- **Theme:** the ☀/☾ button in the top bar switches themes. The choice is saved on the device (`localStorage` key `skyline.theme`) and applied before the first paint; with no saved choice, the operating system's preference wins.
- **Layout:** the ☰ button collapses the sidebar to icons on desktop. Below 900 px it opens a slide-out drawer with a backdrop; Esc or a tap outside closes it.
- **Messages:** every result appears as a toast with a plain-language title and sentence (for example "Sold Out" or "Action Not Allowed"), never a raw status code.

### Verification and live proofs

```bash
npm run verify:fast          # all 6 suites on better-sqlite3 (183 checks, ~15 s)
npm run verify               # the same suites on both SQLite drivers
npm run proof:concurrency    # 3 multi-process races with per-process timings
npm run proof:indexes        # B-tree SEARCH vs full SCAN on 25,000 synthetic rows
```

| Suite | Covers |
|---|---|
| `verify-phase1.js` | Pragmas, foreign keys, rollback, busy retry, the 5 seeded accounts across 4 roles, login, register, tampered tokens, index plans |
| `verify-phase2.js` | Membership renewal, member/guest pricing, duplicate tickets, seat race, door check-in |
| `verify-phase3.js` | Double-renewal guard, members-only announcements, merch pricing, stock race, pickup |
| `verify-phase4.js` | Schema migration, task board, reimbursements, Treasurer approvals and the no-self-approval rule, double-payout race, ledger integrity |
| `verify-phase5.js` | Static client, offline guarantee, no file leaks, per-viewer pricing fields |
| `verify-phase6.js` | CSV export (Treasurer/Admin only) and formula-injection guard, live index proof, role separation, account recovery and profile, the TREASURER role migration, security and edge-case sweep |

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
| `DEMO_ACCOUNTS` | on | Set to `off` to hide the demo-accounts endpoint and the Quick Fill card |
