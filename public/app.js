'use strict';

/*
 * Skyline Student Association ERP: single-page client (no build step, no CDN).
 *
 * One `state` object drives every view. Mutations never patch state locally:
 * they flip a loading flag, call the API, then re-fetch the affected endpoints
 * and re-render, so the screen always shows what SQLite holds. Every request is
 * recorded in the Live API Inspector at the bottom of the page.
 */

// ============================================================================ config

const TOKEN_KEY = 'skyline.token';
const MEMBERSHIP_FEE = 500; // label only: the server charges its own fee
const RENEWAL_WINDOW_DAYS = 30; // label only: the server enforces the window
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CAMPAIGN = 'Spring Bake Sale';
const STAFF_ROLES = new Set(['VOLUNTEER', 'ADMIN']);
const INSPECTOR_LIMIT = 40;
const SEARCH_DELAY_MS = 220;

const SVG_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const ICONS = {
  overview: `<svg ${SVG_ATTRS}><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="12" r="2.5"/><path d="M14 10h4M14 14h3"/></svg>`,
  events: `<svg ${SVG_ATTRS}><path d="M4 7h16v3a2 2 0 0 0 0 4v3H4v-3a2 2 0 0 0 0-4z"/><path d="M14 7v10" stroke-dasharray="2 2"/></svg>`,
  announcements: `<svg ${SVG_ATTRS}><path d="M3 11v2a1 1 0 0 0 1 1h3l5 4V6L7 10H4a1 1 0 0 0-1 1z"/><path d="M16 8a5 5 0 0 1 0 8"/><path d="M19 5a9 9 0 0 1 0 14"/></svg>`,
  merch: `<svg ${SVG_ATTRS}><path d="M8 3 3 6l2 5 3-1v11h8V10l3 1 2-5-5-3a4 4 0 0 1-8 0z"/></svg>`,
  tasks: `<svg ${SVG_ATTRS}><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16"/><path d="M5.5 8h1.5M11.5 8h1.5M11.5 11h1.5M17.5 8h1.5"/></svg>`,
  finance: `<svg ${SVG_ATTRS}><path d="M4 7a2 2 0 0 1 2-2h12v2"/><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M16 13.5h2"/></svg>`,
};

const PRODUCT_ART = {
  hoodie: `<svg viewBox="0 0 120 120" aria-hidden="true"><path d="M42 18c4 10 32 10 36 0l22 12 10 34-14 5-4-12v53H30V57l-4 12-14-5 10-34z" fill="#714B67"/><path d="M47 20c3 17 23 17 26 0" fill="#5b3b53"/><rect x="44" y="80" width="32" height="15" rx="3" fill="#5b3b53"/><path d="M54 36v12M66 36v12" stroke="#fde68a" stroke-width="2" stroke-linecap="round"/><text x="60" y="68" text-anchor="middle" font-size="9" font-weight="800" fill="#fde68a" font-family="system-ui, sans-serif">SKYLINE</text></svg>`,
  tee: `<svg viewBox="0 0 120 120" aria-hidden="true"><path d="M44 20c4 8 28 8 32 0l26 12-8 20-12-5v55H30V47l-12 5-8-20z" fill="#017e84"/><path d="M44 20c4 10 28 10 32 0" fill="none" stroke="#015f63" stroke-width="3"/><path d="M38 66l8-10 6 6 8-14 8 10 6-6 8 14" fill="none" stroke="#e6f4f4" stroke-width="3" stroke-linejoin="round"/><text x="60" y="86" text-anchor="middle" font-size="8" font-weight="800" fill="#e6f4f4" font-family="system-ui, sans-serif">SKYLINE</text></svg>`,
};

const TABS = [
  { id: 'overview', label: 'Overview & Membership', scene: 'Scene 1' },
  { id: 'events', label: 'Events & Ticketing', scene: 'Scene 2' },
  { id: 'announcements', label: 'Announcements', scene: 'Scene 3' },
  { id: 'merch', label: 'Merch Store', scene: 'Scene 4' },
  { id: 'tasks', label: 'Bake Sale Planner', scene: 'Scene 5' },
  { id: 'finance', label: 'Finance & Books', scene: 'Scene 6' },
];

const STATUS_TEXT = {
  0: 'Network Error', 200: 'OK', 201: 'Created', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
  404: 'Not Found', 409: 'Conflict', 413: 'Payload Too Large', 500: 'Internal Server Error', 503: 'Service Unavailable',
};
const ROLE_LABEL = { ADMIN: 'Admin', VOLUNTEER: 'Volunteer', STUDENT: 'Student' };
const MEMBERSHIP_TONE = { ACTIVE: 'green', EXPIRED: 'red', NONE: 'slate' };
const FULFILLMENT = { PAID_PENDING_PICKUP: ['Awaiting pickup', 'amber'], PICKED_UP: ['Picked up', 'green'] };
const REIMBURSEMENT = { PENDING: ['Pending', 'amber'], APPROVED_PAID: ['Approved & paid', 'green'], REJECTED: ['Rejected', 'red'] };
const TASK_STATUS = { TODO: ['To do', 'slate'], IN_PROGRESS: ['In progress', 'blue'], DONE: ['Done', 'green'] };
const TASK_MOVES = {
  TODO: [['Start Task', 'IN_PROGRESS', 'primary']],
  IN_PROGRESS: [['Mark Done', 'DONE', 'success']],
  DONE: [['Reopen', 'TODO', 'secondary']],
};
const ANNOUNCEMENT_CATEGORIES = ['MEETING', 'DEADLINE', 'EVENT', 'GENERAL'];
const ANNOUNCEMENT_TONE = { MEETING: 'blue', DEADLINE: 'red', EVENT: 'plum', GENERAL: 'slate' };
const LEDGER_CATEGORIES = ['MEMBERSHIP_DUES', 'TICKET_SALE', 'MERCH_SALE', 'FUNDRAISER_INCOME', 'EXPENSE_REIMBURSEMENT'];
const LEDGER_LABEL = {
  MEMBERSHIP_DUES: 'Membership dues',
  TICKET_SALE: 'Ticket sales',
  MERCH_SALE: 'Merch sales',
  FUNDRAISER_INCOME: 'Fundraiser income',
  EXPENSE_REIMBURSEMENT: 'Expense reimbursements',
};
const LEDGER_TONE = { MEMBERSHIP_DUES: 'plum', TICKET_SALE: 'blue', MERCH_SALE: 'teal', FUNDRAISER_INCOME: 'amber', EXPENSE_REIMBURSEMENT: 'red' };
const EXPENSE_CATEGORIES = [
  ['FUNDRAISER_SUPPLIES', 'Fundraiser supplies'],
  ['EVENT_COSTS', 'Event costs'],
  ['OPERATIONS', 'Operations'],
  ['MARKETING', 'Marketing'],
];

// ============================================================================ state

function blankData() {
  return {
    events: null,
    eventsViewer: null,
    desk: null,
    lookup: null,
    lookupMs: null,
    announcements: null,
    merch: null,
    orders: null,
    tasks: null,
    assignees: null,
    reimbursements: null,
    ledger: null,
  };
}

function blankForms() {
  return {
    login: { email: '', password: '' },
    register: { name: '', email: '', password: '' },
    checkin: { code: '' },
    event: { title: '', event_date: '', location: '', total_seats: '', member_price: '', guest_price: '', description: '' },
    announcement: { title: '', content: '', category: 'GENERAL', target_audience: 'ALL' },
    task: { title: '', assigned_to: '', due_date: '', campaign_name: DEFAULT_CAMPAIGN },
    expense: { title: '', category: 'FUNDRAISER_SUPPLIES', amount: '', receipt_reference: '' },
    income: { amount: '', description: '', reference_id: '' },
  };
}

const state = {
  user: null,
  token: null,
  activeTab: 'overview',
  isLoading: false, // a mutation is in flight: every mutation button is disabled
  pendingAction: null, // the one button that shows "Processing..."
  tabLoading: false,
  booting: true,
  health: null,
  demo: { password: null, accounts: [] },
  data: blankData(),
  ui: {
    lookupQuery: '',
    deskEventId: null,
    rosterQuery: '',
    lastCheckIn: null,
    showEventForm: false,
    annCategory: 'ALL',
    annQuery: '',
    lastBroadcast: null,
    selectedVariant: {},
    quantity: {},
    orderStatus: '',
    orderQuery: '',
    campaign: null,
    reimbStatus: '',
    ledgerType: '',
    ledgerCategory: '',
    authMode: null,
    authError: null,
  },
  forms: blankForms(),
  inspector: { open: false, entries: [], selectedId: null, seq: 0 },
  toasts: [],
};

let toastSeq = 0;
const searchTimers = {};

// ============================================================================ helpers

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

function inr(amount) {
  return `₹${Number(amount || 0).toLocaleString('en-IN')}`;
}

function signedInr(amount) {
  return `${amount < 0 ? '−' : '+'}₹${Math.abs(amount).toLocaleString('en-IN')}`;
}

function pct(part, whole) {
  return whole ? Math.round((part * 100) / whole) : 0;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function fmtDate(iso) {
  return iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
}

function fmtTime(iso) {
  return iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '—';
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }), hour: '2-digit', minute: '2-digit' });
}

// Due dates are calendar days (YYYY-MM-DD), so parse them as local dates.
function fmtDay(ymd) {
  if (!ymd) return '—';
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

const relativeFormat = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
function relTime(iso) {
  if (!iso) return '';
  const diff = Date.parse(iso) - Date.now();
  const abs = Math.abs(diff);
  if (abs < 60 * 60 * 1000) return relativeFormat.format(Math.round(diff / 60000), 'minute');
  if (abs < DAY_MS) return relativeFormat.format(Math.round(diff / 3600000), 'hour');
  return relativeFormat.format(Math.round(diff / DAY_MS), 'day');
}

function firstName(name) {
  return String(name || '').split(' ')[0];
}

function initials(name) {
  return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}

function roleLabel(role) {
  return ROLE_LABEL[role] || role || '';
}

function isStaff() {
  return Boolean(state.user && STAFF_ROLES.has(state.user.role));
}

function isAdmin() {
  return state.user?.role === 'ADMIN';
}

function toNumber(value) {
  return value === '' || value === null || value === undefined ? null : Number(value);
}

function getPath(path) {
  return path.split('.').reduce((obj, key) => (obj == null ? undefined : obj[key]), state);
}

function setPath(path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((obj, key) => obj[key], state);
  target[last] = value;
}

function modelId(model) {
  return model.replace(/\./g, '-');
}

function renewalOpensAt(membership) {
  return new Date(Date.parse(membership.expires_at) - RENEWAL_WINDOW_DAYS * DAY_MS).toISOString();
}

function personaInfo(account) {
  if (account.role === 'ADMIN') {
    return { label: 'Admin & Treasurer', blurb: 'Full ERP access: approves reimbursements, closes the semester books, creates events.' };
  }
  if (account.role === 'VOLUNTEER') {
    return { label: 'Volunteer Lead', blurb: 'Door check-in, posts announcements, runs the Bake Sale board, submits expense receipts.' };
  }
  const m = account.membership;
  if (m.status === 'ACTIVE' && m.renewal_due) {
    return {
      label: 'Active Member — Renewal Due!',
      blurb: `Member prices on the Gala and hoodies, sees members-only posts, and the membership expires in ${plural(m.days_remaining, 'day')}.`,
    };
  }
  if (m.status === 'ACTIVE') return { label: 'Active Member', blurb: 'Member prices on events and merch, and sees members-only announcements.' };
  if (m.status === 'EXPIRED') return { label: 'Expired Member', blurb: 'Back to guest prices until the membership is renewed.' };
  return { label: 'Non-Member Student', blurb: 'Pays guest and regular prices; members-only announcements stay hidden until joining.' };
}

// ============================================================================ API + inspector

function redact(body) {
  if (!body || typeof body !== 'object') return body;
  return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, /password/i.test(k) ? '••••••••' : v]));
}

async function api(method, path, body, { mutation = false } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = state.token;
  if (token) headers.Authorization = `Bearer ${token}`;

  const started = performance.now();
  let status = 0;
  let data = null;
  try {
    const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    status = res.status;
    const text = await res.text();
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
  } catch {
    data = { error: 'Network error: is the Skyline server running?' };
  }

  const entry = {
    id: ++state.inspector.seq,
    method,
    path,
    status,
    ms: Math.round(performance.now() - started),
    at: new Date().toISOString(),
    token,
    request: body === undefined ? null : redact(body),
    response: data,
    mutation,
  };
  state.inspector.entries.unshift(entry);
  state.inspector.entries.length = Math.min(state.inspector.entries.length, INSPECTOR_LIMIT);
  if (mutation || state.inspector.selectedId === null) state.inspector.selectedId = entry.id;
  renderInspector();

  const result = { ok: status >= 200 && status < 300, status, data, entry, sessionExpired: false };
  if (status === 401 && token && token === state.token && !path.startsWith('/api/auth/login')) {
    result.sessionExpired = true; // reported once here, not again by the caller
    clearSession();
    toast(result, 'Your session is no longer valid. Please sign in again.');
    render();
  }
  return result;
}

function errorText(result) {
  const d = result.data;
  if (typeof d === 'string') return d || STATUS_TEXT[result.status] || 'Request failed';
  let message = d?.error || STATUS_TEXT[result.status] || 'Request failed';
  if (d?.reason) message += ` — ${d.reason}`;
  if (d?.details) message += `: ${Object.values(d.details).join('; ')}`;
  return message;
}

function toastIfError(result) {
  if (!result.ok && !result.sessionExpired) toast(result, errorText(result));
}

// Every write goes through here: one in-flight mutation at a time, a labelled
// spinner on the clicked button, then an authoritative re-fetch, never a local
// guess. A 409 also re-fetches, because it means the data changed under us.
async function mutate(key, method, path, body, { success, refresh, onSuccess, onError } = {}) {
  if (state.isLoading) return null;
  state.isLoading = true;
  state.pendingAction = key;
  render();

  const res = await api(method, path, body, { mutation: true });
  try {
    if (res.ok) {
      onSuccess?.(res.data);
      toast(res, typeof success === 'function' ? success(res.data) : success || STATUS_TEXT[res.status]);
      await (refresh ? refresh() : reloadActiveTab());
    } else {
      onError?.(res);
      if (!res.sessionExpired) toast(res, errorText(res));
      if (res.status === 409) await (refresh ? refresh() : reloadActiveTab());
    }
  } finally {
    state.isLoading = false;
    state.pendingAction = null;
    render();
  }
  return res;
}

// ============================================================================ toasts

function toast(result, message) {
  const id = ++toastSeq;
  state.toasts.push({
    id,
    ok: result.ok,
    status: result.status,
    statusText: STATUS_TEXT[result.status] || '',
    request: result.entry ? `${result.entry.method} ${result.entry.path}` : '',
    message,
  });
  if (state.toasts.length > 4) state.toasts.shift();
  renderToasts();
  setTimeout(() => dismissToast(id), result.ok ? 5000 : 8000);
}

function infoToast(message) {
  const id = ++toastSeq;
  state.toasts.push({ id, ok: true, status: null, statusText: 'INFO', request: '', message });
  renderToasts();
  setTimeout(() => dismissToast(id), 3500);
}

function dismissToast(id) {
  const before = state.toasts.length;
  state.toasts = state.toasts.filter((t) => t.id !== id);
  if (state.toasts.length !== before) renderToasts();
}

// ============================================================================ session

function setSession(token, user) {
  state.token = token;
  state.user = user;
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // storage blocked (private mode): the session just won't survive a reload
  }
}

function clearSession() {
  state.token = null;
  state.user = null;
  state.data = blankData();
  state.ui.lastCheckIn = null;
  state.ui.lastBroadcast = null;
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
}

async function refreshSession() {
  if (!state.token) {
    state.user = null;
    return;
  }
  const res = await api('GET', '/api/auth/me');
  if (res.ok) state.user = res.data.user;
}

async function loadDemoAccounts() {
  const res = await api('GET', '/api/auth/demo-accounts');
  if (res.ok) state.demo = res.data;
}

async function loadHealth() {
  const res = await api('GET', '/api/health');
  state.health = res.ok ? res.data : null;
}

// ============================================================================ loaders

async function loadEvents() {
  const res = await api('GET', '/api/events');
  if (!res.ok) return toastIfError(res);
  state.data.events = res.data.events;
  state.data.eventsViewer = res.data.viewer;
  pickDeskEvent();
}

function pickDeskEvent() {
  const events = state.data.events || [];
  if (events.some((e) => String(e.id) === String(state.ui.deskEventId))) return;
  const upcoming = events.filter((e) => !e.is_past);
  const pool = upcoming.length ? upcoming : events;
  const busiest = pool.reduce((best, e) => (!best || e.tickets_sold > best.tickets_sold ? e : best), null);
  state.ui.deskEventId = busiest ? String(busiest.id) : null;
}

async function loadDesk() {
  if (!isStaff()) return;
  pickDeskEvent();
  const id = state.ui.deskEventId;
  if (!id) {
    state.data.desk = null;
    return;
  }
  const q = state.ui.rosterQuery.trim();
  const res = await api('GET', `/api/events/${id}/tickets${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  if (id !== state.ui.deskEventId || q !== state.ui.rosterQuery.trim()) return; // a newer search won
  if (res.ok) state.data.desk = res.data;
  else toastIfError(res);
}

async function loadLookup() {
  if (!isStaff()) return;
  const q = state.ui.lookupQuery.trim();
  const res = await api('GET', `/api/memberships/lookup${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  if (q !== state.ui.lookupQuery.trim()) return;
  if (res.ok) {
    state.data.lookup = res.data;
    state.data.lookupMs = res.entry.ms;
  } else {
    toastIfError(res);
  }
}

async function loadAnnouncements() {
  const params = new URLSearchParams();
  if (state.ui.annCategory !== 'ALL') params.set('category', state.ui.annCategory);
  const q = state.ui.annQuery.trim();
  if (q) params.set('q', q);
  const query = params.toString();
  const res = await api('GET', `/api/announcements${query ? `?${query}` : ''}`);
  if (q !== state.ui.annQuery.trim()) return;
  if (res.ok) state.data.announcements = res.data;
  else toastIfError(res);
}

async function loadMerchItems() {
  const res = await api('GET', '/api/merch/items');
  if (!res.ok) return toastIfError(res);
  state.data.merch = res.data;
  for (const item of res.data.items) {
    const chosen = item.variants.find((v) => v.variant_id === state.ui.selectedVariant[item.id]);
    if (!chosen || chosen.stock_count === 0) {
      state.ui.selectedVariant[item.id] = item.variants.find((v) => v.stock_count > 0)?.variant_id ?? null;
    }
    clampQuantity(item);
  }
}

async function loadOrders() {
  if (!state.user) return;
  const params = new URLSearchParams();
  if (state.ui.orderStatus) params.set('status', state.ui.orderStatus);
  const q = state.ui.orderQuery.trim();
  if (q && isStaff()) params.set('q', q);
  const query = params.toString();
  const res = await api('GET', `/api/merch/orders${query ? `?${query}` : ''}`);
  if (q !== state.ui.orderQuery.trim()) return;
  if (res.ok) state.data.orders = res.data;
  else toastIfError(res);
}

async function loadTasks() {
  if (!state.user) return;
  const res = await api('GET', '/api/tasks');
  if (res.ok) state.data.tasks = res.data;
  else toastIfError(res);
}

async function loadAssignees() {
  if (!isStaff()) return;
  const res = await api('GET', '/api/tasks/assignees');
  if (res.ok) state.data.assignees = res.data.users;
}

async function loadReimbursements() {
  if (!state.user) return;
  const status = state.ui.reimbStatus;
  const res = await api('GET', `/api/finance/reimbursements${status ? `?status=${status}` : ''}`);
  if (res.ok) state.data.reimbursements = res.data;
  else toastIfError(res);
}

async function loadLedger() {
  if (!isStaff()) return;
  const params = new URLSearchParams();
  if (state.ui.ledgerType) params.set('type', state.ui.ledgerType);
  if (state.ui.ledgerCategory) params.set('category', state.ui.ledgerCategory);
  const query = params.toString();
  const res = await api('GET', `/api/finance/ledger${query ? `?${query}` : ''}`);
  if (res.ok) state.data.ledger = res.data;
  else toastIfError(res);
}

const LOADERS = {
  overview: () => Promise.all([loadEvents(), loadMerchItems(), loadLookup()]),
  events: async () => {
    await loadEvents();
    await loadDesk();
  },
  announcements: () => loadAnnouncements(),
  merch: () => Promise.all([loadMerchItems(), loadOrders()]),
  tasks: () => Promise.all([loadTasks(), state.data.assignees ? null : loadAssignees()]),
  finance: () => Promise.all([loadReimbursements(), loadLedger()]),
};

const SEARCHERS = { lookup: loadLookup, desk: loadDesk, announcements: loadAnnouncements, orders: loadOrders };

async function loadTab(tab = state.activeTab) {
  state.tabLoading = true;
  renderMain();
  try {
    await LOADERS[tab]?.();
  } finally {
    state.tabLoading = false;
    if (tab === state.activeTab) render();
  }
}

async function reloadActiveTab() {
  await refreshSession();
  await LOADERS[state.activeTab]?.();
}

function scheduleSearch(kind) {
  clearTimeout(searchTimers[kind]);
  searchTimers[kind] = setTimeout(async () => {
    await SEARCHERS[kind]?.();
    renderMain();
  }, SEARCH_DELAY_MS);
}

function clampQuantity(item) {
  const variant = item.variants.find((v) => v.variant_id === state.ui.selectedVariant[item.id]);
  const max = variant ? Math.max(1, Math.min(5, variant.stock_count)) : 1;
  state.ui.quantity[item.id] = Math.min(Math.max(1, state.ui.quantity[item.id] || 1), max);
}

// ============================================================================ mutations

async function signIn(key, email, password) {
  return mutate(key, 'POST', '/api/auth/login', { email, password }, {
    onSuccess: (d) => {
      setSession(d.token, d.user);
      state.data = blankData();
      state.ui.authMode = null;
      state.ui.authError = null;
      state.forms.login = blankForms().login;
    },
    onError: (res) => {
      state.ui.authError = errorText(res);
    },
    success: (d) => `Signed in as ${d.user.name} (${roleLabel(d.user.role)})`,
    refresh: () => Promise.all([loadDemoAccounts(), LOADERS[state.activeTab]?.()]),
  });
}

function switchPersona(email) {
  if (state.user?.email === email) return null;
  return signIn(`persona:${email}`, email, state.demo.password);
}

function joinOrRenew() {
  return mutate('joinOrRenew', 'POST', '/api/memberships/join-or-renew', undefined, {
    success: (d) => (d.action === 'JOINED'
      ? `Welcome to Skyline! Member code ${d.user.membership.code} · paid ${inr(d.fee)}`
      : `Renewed until ${fmtDate(d.user.membership.expires_at)} · paid ${inr(d.fee)}`),
    refresh: async () => {
      await Promise.all([refreshSession(), loadDemoAccounts()]);
      await LOADERS[state.activeTab]?.();
    },
  });
}

function checkIn(rawCode, key) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) return infoToast('Enter or scan a ticket code first.');
  return mutate(key || `checkIn:${code}`, 'POST', `/api/tickets/${encodeURIComponent(code)}/check-in`, undefined, {
    onSuccess: (d) => {
      state.forms.checkin.code = '';
      state.ui.lastCheckIn = {
        ok: true,
        title: `${d.attendee.name} is in`,
        detail: `${d.ticket.ticket_code} · ${d.attendee.membership.status === 'ACTIVE' ? 'Active member' : 'Guest'} · ${d.event.checked_in_count}/${d.event.tickets_sold} checked in`,
      };
    },
    onError: (res) => {
      state.ui.lastCheckIn = {
        ok: false,
        title: res.status === 409 ? 'Already checked in: do not admit twice' : STATUS_TEXT[res.status] || 'Check-in failed',
        detail: `${code} · ${errorText(res)}${res.data?.attendee?.name ? ` (${res.data.attendee.name})` : ''}`,
      };
    },
    success: (d) => `${d.attendee.name} checked in · ${d.event.checked_in_count}/${d.event.tickets_sold} present`,
    refresh: () => Promise.all([loadEvents(), loadDesk()]),
  });
}

// ============================================================================ components

function actionKey(action, data = {}) {
  return [action, ...Object.values(data)].join(':');
}

function btn(label, action, { data = {}, variant = 'primary', size = '', disabled = false, title = '', mutation = true, block = false } = {}) {
  const busy = mutation && state.pendingAction === actionKey(action, data);
  const off = disabled || (mutation && state.isLoading);
  const attrs = Object.entries(data).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('');
  const cls = ['btn', `btn-${variant}`, size && `btn-${size}`, block && 'btn-block'].filter(Boolean).join(' ');
  return `<button type="button" class="${cls}" data-action="${action}"${attrs}${off ? ' disabled' : ''}${title ? ` title="${esc(title)}"` : ''}>${busy ? '<span class="spinner"></span>Processing...' : label}</button>`;
}

function submitBtn(form, label, { variant = 'primary', block = false } = {}) {
  const busy = state.pendingAction === `form:${form}`;
  return `<button type="submit" class="btn btn-${variant}${block ? ' btn-block' : ''}"${state.isLoading ? ' disabled' : ''}>${busy ? '<span class="spinner"></span>Processing...' : label}</button>`;
}

function input(model, { id, type = 'text', placeholder = '', cls = '', attrs = '' } = {}) {
  return `<input id="${id || modelId(model)}" class="input ${cls}" type="${type}" data-model="${model}" value="${esc(getPath(model))}" placeholder="${esc(placeholder)}" ${attrs}>`;
}

function textarea(model, { id, placeholder = '', attrs = '' } = {}) {
  return `<textarea id="${id || modelId(model)}" class="textarea" data-model="${model}" placeholder="${esc(placeholder)}" ${attrs}>${esc(getPath(model))}</textarea>`;
}

function select(model, options, { id, attrs = '' } = {}) {
  const current = String(getPath(model) ?? '');
  const opts = options.map(([value, label]) => `<option value="${esc(value)}"${String(value) === current ? ' selected' : ''}>${esc(label)}</option>`).join('');
  return `<select id="${id || modelId(model)}" class="select" data-model="${model}" ${attrs}>${opts}</select>`;
}

function field(label, control, { span2 = false, forId = '' } = {}) {
  return `<div class="field${span2 ? ' span-2' : ''}"><label${forId ? ` for="${forId}"` : ''}>${label}</label>${control}</div>`;
}

function badge(text, tone = 'slate') {
  return `<span class="badge badge-${tone}">${esc(text)}</span>`;
}

function membershipBadge(status) {
  return badge(status, MEMBERSHIP_TONE[status] || 'slate');
}

function kpi(label, value, sub = '', tone = '') {
  return `<div class="kpi${tone ? ` tone-${tone}` : ''}"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ''}</div>`;
}

function progress(percent, tone = '', large = false) {
  const width = Math.max(0, Math.min(100, percent));
  return `<div class="progress${large ? ' progress-lg' : ''}${tone ? ` tone-${tone}` : ''}" role="progressbar" aria-valuenow="${width}" aria-valuemin="0" aria-valuemax="100"><span style="width:${width}%"></span></div>`;
}

function avatar(name, role) {
  return `<span class="avatar role-${esc(role)}" aria-hidden="true">${esc(initials(name))}</span>`;
}

function pageHead(scene, title, sub = '', right = '') {
  return `<div class="page-head"><div><div class="scene">${scene}</div><h1>${title}</h1>${sub ? `<p class="sub">${sub}</p>` : ''}</div>${right}</div>`;
}

function banner(tone, icon, title, text, action = '') {
  return `<div class="banner banner-${tone}"><div class="banner-text"><span class="banner-icon" aria-hidden="true">${icon}</span><div><b>${title}</b>${text ? `<span>${text}</span>` : ''}</div></div>${action}</div>`;
}

function lockedPanel(title, text, action = '') {
  return `<div class="locked"><span class="lock-icon" aria-hidden="true">🔒</span><div><b>${title}</b><div>${text}</div></div>${action ? `<div style="margin-left:auto">${action}</div>` : ''}</div>`;
}

function emptyState(icon, text) {
  return `<div class="empty"><span class="empty-icon" aria-hidden="true">${icon}</span>${text}</div>`;
}

function loadingBlock(text = 'Loading live data…') {
  return `<div class="loading-page"><span class="spinner"></span>${text}</div>`;
}

function signInPrompt(what) {
  return lockedPanel('Sign in required', `Pick a demo persona in the top bar, or sign in, to ${what}.`,
    btn('Sign in', 'openAuth', { data: { mode: 'login' }, mutation: false, variant: 'secondary' }));
}

function priceTile(label, amount, yours) {
  return `<div class="price-tile${yours ? ' yours' : ''}">${yours ? '<span class="yours-tag">YOUR PRICE</span>' : ''}<div class="pt-label">${label}</div><div class="pt-value">${inr(amount)}</div></div>`;
}

function codeChip(code) {
  return `<span class="code-chip">${esc(code)}</span>`;
}

// ============================================================================ view: overview (scene 1)

function viewOverview() {
  if (!state.user) return viewWelcome();
  const u = state.user;
  return `
    ${pageHead('Scene 1 · Membership lifecycle', `Welcome back, ${esc(firstName(u.name))}`, `${roleLabel(u.role)} · ${esc(u.email)}`)}
    ${membershipBanner(u.membership)}
    <div class="grid grid-2">
      <div class="stack">${membershipCard(u)}</div>
      ${benefitsCard()}
    </div>
    <div class="mt-16">${isStaff() ? lookupPanel() : lockedPanel('Door Member Lookup', 'Volunteers and admins use this at the door to verify a member in under a second. The lookup endpoint returns 403 for students.')}</div>`;
}

function viewWelcome() {
  const accounts = state.demo.accounts;
  const cards = accounts.length
    ? accounts.map((a) => {
      const info = personaInfo(a);
      const busy = state.pendingAction === `persona:${a.email}`;
      return `<button type="button" class="persona-card" data-action="persona" data-email="${esc(a.email)}"${state.isLoading ? ' disabled' : ''}>
          <span class="pc-head">${avatar(a.name, a.role)}<span><b>${esc(a.name)}</b><br><small>${esc(info.label)}</small></span></span>
          <p>${esc(info.blurb)}</p>
          <span class="pc-cta">${busy ? '<span class="spinner"></span> Signing in…' : 'Sign in as ' + esc(firstName(a.name)) + ' →'}</span>
        </button>`;
    }).join('')
    : `<p>${state.booting ? 'Loading demo personas…' : 'Demo personas are disabled on this server. Sign in or register to continue.'}</p>`;

  return `
    <section class="hero">
      <div class="scene" style="color:#fde68a">ODOO × LDCE HACKATHON 2026 · GRAND FINALE</div>
      <h1>Skyline Student Association ERP</h1>
      <p>Memberships, event ticketing with door check-in, announcements, the merch store, the bake-sale planner and the treasurer's books, all on one transactional SQLite backend. Pick a persona to see the app through their eyes.</p>
      <div class="persona-cards">${cards}</div>
      <div class="row mt-16">
        ${btn('Sign in', 'openAuth', { data: { mode: 'login' }, mutation: false, variant: 'secondary' })}
        ${btn('Register a new student', 'openAuth', { data: { mode: 'register' }, mutation: false, variant: 'ghost' })}
      </div>
    </section>
    <div class="grid grid-3">
      ${welcomeTip('🎟️', 'Tiered ticketing', 'Members pay the member price, everyone else the guest price, decided by the server from the live membership row.')}
      ${welcomeTip('🔒', 'Race-proof writes', 'Every purchase, check-in, pickup and payout runs in a BEGIN IMMEDIATE transaction, so nothing is ever sold or paid twice.')}
      ${welcomeTip('🧾', 'Live API proof', 'Open the Live API Inspector at the bottom to see each request, its status code and the exact JSON the server returned.')}
    </div>`;
}

function welcomeTip(icon, title, text) {
  return `<div class="card"><div class="card-body"><div style="font-size:22px">${icon}</div><h3 class="mt-8">${title}</h3><p class="muted mt-8">${text}</p></div></div>`;
}

function membershipBanner(m) {
  const fee = inr(MEMBERSHIP_FEE);
  if (m.status === 'ACTIVE' && m.renewal_due) {
    return banner('warn', '⏳', `Expiring in ${plural(m.days_remaining, 'day')} — Renew Now (${fee})`,
      `Membership ${esc(m.code)} ends on ${fmtDate(m.expires_at)}. Renewing adds a full year from that date, so renewing early costs you nothing.`,
      btn(`Renew Now (${fee})`, 'joinOrRenew', { variant: 'warn' }));
  }
  if (m.status === 'EXPIRED') {
    return banner('danger', '⚠️', `Membership expired — Renew (${fee})`,
      `It ended on ${fmtDate(m.expires_at)}. Until you renew you pay guest prices and members-only posts are hidden.`,
      btn(`Renew Membership (${fee})`, 'joinOrRenew'));
  }
  if (m.status === 'NONE') {
    return banner('info', '✨', `Join Skyline for ${fee} a year`,
      savingsLine() || 'Members get lower prices on events and merch, and unlock members-only announcements.',
      btn(`Join Club (${fee})`, 'joinOrRenew'));
  }
  return '';
}

function savingsLine() {
  const events = (state.data.events || []).filter((e) => !e.is_past && e.guest_price > e.member_price);
  const items = state.data.merch?.items || [];
  if (!events.length && !items.length) return '';
  const saving = events.reduce((s, e) => s + e.guest_price - e.member_price, 0)
    + items.reduce((s, i) => s + i.regular_price - i.member_price, 0);
  return `An active member saves ${inr(saving)} across ${plural(events.length, 'upcoming event')} and ${plural(items.length, 'merch item')}, and unlocks members-only announcements.`;
}

function membershipCard(u) {
  const m = u.membership;
  const active = m.status === 'ACTIVE';
  const fee = inr(MEMBERSHIP_FEE);
  let action;
  if (m.status === 'NONE') {
    action = btn(`Join Club (${fee})`, 'joinOrRenew', { size: 'lg', block: true });
  } else if (!active || m.renewal_due) {
    action = btn(`Renew Membership (+1 Year, ${fee})`, 'joinOrRenew', { size: 'lg', block: true });
  } else {
    action = `<div class="note note-green">Active and paid up. Renewal opens on <b>${fmtDate(renewalOpensAt(m))}</b>, ${RENEWAL_WINDOW_DAYS} days before expiry, so an accidental double-click can never charge you twice.</div>
      <div class="mt-8">${btn('Test the double-charge guard', 'joinOrRenew', { variant: 'ghost', size: 'sm', title: 'Calls the renew endpoint anyway. The server should answer 409 Conflict.' })}</div>`;
  }

  return `
    <div class="member-card status-${esc(m.status)}">
      <div class="mc-top"><span class="mc-brand">SKYLINE STUDENT ASSOCIATION</span>${membershipBadge(m.status)}</div>
      <div><div class="mc-name">${esc(u.name)}</div><div class="mc-code">${m.code ? esc(m.code) : 'NOT A MEMBER'}</div></div>
      <div class="mc-meta">
        <div>Valid until<b>${m.expires_at ? fmtDate(m.expires_at) : '—'}</b></div>
        <div>${active ? 'Days left' : 'Status'}<b>${active ? m.days_remaining : m.status === 'NONE' ? 'No membership' : 'Lapsed'}</b></div>
        <div>Role<b>${roleLabel(u.role)}</b></div>
      </div>
      ${active ? progress((m.days_remaining / 365) * 100) : ''}
    </div>
    <div class="card"><div class="card-body">${action}</div></div>`;
}

function benefitsCard() {
  const events = (state.data.events || []).filter((e) => !e.is_past);
  const items = state.data.merch?.items || [];
  const tier = state.data.eventsViewer?.tier;
  const isMember = tier === 'MEMBER';
  const priceRow = (name, member, other, otherLabel) => `
    <div class="benefit"><span>${esc(name)}</span>
      <span class="prices">${badge(`Member ${inr(member)}`, isMember ? 'plum' : 'slate')}${badge(`${otherLabel} ${inr(other)}`, isMember ? 'slate' : 'amber')}</span></div>`;

  return `<section class="card">
    <div class="card-head"><h2>💳 Member pricing</h2><span class="sub">live from the catalogue · your tier: ${tier ? badge(tier, isMember ? 'plum' : 'amber') : '—'}</span></div>
    <div class="card-body">
      ${!state.data.events ? loadingBlock() : ''}
      ${events.map((e) => priceRow(e.title, e.member_price, e.guest_price, 'Guest')).join('')}
      ${items.map((i) => priceRow(i.name, i.member_price, i.regular_price, 'Regular')).join('')}
      <div class="benefit"><span>Members-only announcements</span><span class="prices">${isMember || isStaff() ? badge('Unlocked', 'green') : badge('Locked', 'slate')}</span></div>
    </div>
    ${savingsLine() ? `<div class="card-foot small muted">${savingsLine()}</div>` : ''}
  </section>`;
}

function lookupPanel() {
  const data = state.data.lookup;
  const rows = data?.results || [];
  const status = data
    ? `${plural(data.count, 'result')} ${data.query ? `for “${esc(data.query)}”` : '(all members, newest first)'} · answered in ${state.data.lookupMs} ms`
    : 'Loading…';
  const body = rows.length
    ? rows.map((r) => {
      const m = r.membership;
      return `<tr>
        <td><div class="row">${avatar(r.name, r.role)}<div><b>${esc(r.name)}</b><div class="small muted">${esc(r.email)}</div></div></div></td>
        <td>${m.code ? codeChip(m.code) : '<span class="muted">—</span>'}</td>
        <td>${membershipBadge(m.status)}${m.renewal_due && m.status === 'ACTIVE' ? ` ${badge('Renewal due', 'amber')}` : ''}</td>
        <td class="nowrap">${m.expires_at ? fmtDate(m.expires_at) : '—'}${m.days_remaining !== null ? `<div class="small muted">${plural(m.days_remaining, 'day')} left</div>` : ''}</td>
        <td class="num">${r.tickets_purchased}</td>
        <td>${m.is_active ? '<span class="verdict verdict-yes">✓ ACTIVE MEMBER</span>' : '<span class="verdict verdict-no">✗ NOT ACTIVE — guest prices</span>'}</td>
      </tr>`;
    }).join('')
    : `<tr><td colspan="6">${emptyState('🔍', data ? 'No one matches that search.' : 'Loading…')}</td></tr>`;

  return `<section class="card">
    <div class="card-head"><h2>🚪 Door Member Lookup ${badge('Volunteer · Admin', 'teal')}</h2><span class="sub">GET /api/memberships/lookup</span></div>
    <div class="card-body">
      ${input('ui.lookupQuery', { id: 'lookup-q', placeholder: 'Search by name, email or SKY-2026-XXX…', cls: 'input-search input-lg', attrs: 'data-search="lookup" autocomplete="off" aria-label="Search members"' })}
      <div class="small muted mt-8">${status}</div>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Student</th><th>Code</th><th>Status</th><th>Valid until</th><th class="num">Tickets</th><th>Door verdict</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>
  </section>`;
}

// ============================================================================ view: events (scene 2)

function viewEvents() {
  const events = state.data.events;
  const head = pageHead('Scene 2 · Events', 'Events & Spring Gala Ticketing',
    'The server picks member or guest pricing from your live membership and claims the seat inside a locked transaction.',
    isAdmin() ? btn(state.ui.showEventForm ? 'Close form' : '+ Create Event', 'toggleEventForm', { variant: 'secondary', mutation: false }) : '');
  if (!events) return head + loadingBlock();

  const mine = events.filter((e) => e.my_ticket);
  return `${head}<div class="stack">
    ${isAdmin() && state.ui.showEventForm ? createEventForm() : ''}
    ${!state.user ? banner('info', '🎟️', 'Sign in to buy tickets', 'Members pay the member price; everyone else pays the guest price.', btn('Sign in', 'openAuth', { data: { mode: 'login' }, mutation: false })) : ''}
    <div class="grid grid-auto">${events.map(eventCard).join('')}</div>
    ${state.user ? myTickets(mine) : ''}
    ${isStaff() ? checkInDesk() : ''}
  </div>`;
}

function eventCard(e) {
  const tier = state.data.eventsViewer?.tier;
  const soldPct = pct(e.seats_sold, e.total_seats);
  const soldOut = e.seats_left <= 0;
  const when = new Date(e.event_date);

  let action;
  if (e.my_ticket) action = `${badge("✓ You're going", 'green')} ${codeChip(e.my_ticket.ticket_code)}`;
  else if (e.is_past) action = badge('Event ended', 'slate');
  else if (soldOut) action = btn('Sold out', 'buyTicket', { data: { id: e.id }, disabled: true, variant: 'secondary' });
  else if (!state.user) action = btn('Sign in to buy', 'openAuth', { data: { mode: 'login' }, mutation: false });
  else action = btn(`Buy Ticket · ${inr(e.your_price)}`, 'buyTicket', { data: { id: e.id } });

  return `<article class="card event-card">
    <div class="card-body">
      <div class="event-top">
        <div class="date-chip"><span>${when.toLocaleDateString('en-IN', { month: 'short' }).toUpperCase()}</span><b>${when.getDate()}</b></div>
        <div style="min-width:0"><h3>${esc(e.title)}</h3>
          <div class="event-meta"><span>🕡 ${when.toLocaleDateString('en-IN', { weekday: 'long' })}, ${fmtTime(e.event_date)}</span><span>📍 ${esc(e.location)}</span></div>
        </div>
      </div>
      ${e.description ? `<p class="small muted">${esc(e.description)}</p>` : ''}
      <div>
        <div class="row-between small"><span><b>${e.seats_sold}</b> / ${e.total_seats} seats sold</span><span class="${e.seats_left <= 10 ? 'strong' : 'muted'}">${soldOut ? 'Sold out' : `${e.seats_left} left`}</span></div>
        <div class="mt-8">${progress(soldPct, soldOut ? 'red' : soldPct >= 80 ? 'amber' : '')}</div>
      </div>
      <div class="price-compare">${priceTile('Member', e.member_price, tier === 'MEMBER')}${priceTile('Guest', e.guest_price, tier === 'GUEST')}</div>
      ${isStaff() ? `<div class="event-stats"><div><b>${e.tickets_sold}</b>tickets issued</div><div><b>${e.checked_in_count}</b>checked in</div><div><b>${inr(e.ticket_revenue)}</b>ticket revenue</div></div>` : ''}
      <div class="event-actions">${action}</div>
    </div>
  </article>`;
}

function myTickets(mine) {
  const stubs = mine.length
    ? mine.map((e) => {
      const t = e.my_ticket;
      return `<div class="ticket-stub${t.checked_in ? ' checked' : ''}">
        <div class="ts-main">
          <div class="small muted">${fmtDate(e.event_date)} · ${fmtTime(e.event_date)} · ${esc(e.location)}</div>
          <b>${esc(e.title)}</b>
          <div class="small mt-8">Paid <b>${inr(t.price_paid)}</b> · bought ${relTime(t.created_at)}</div>
        </div>
        <div class="ts-side">
          <div class="ts-code">${esc(t.ticket_code)}</div>
          <div class="barcode" aria-hidden="true"></div>
          ${t.checked_in ? badge(`Checked in ${fmtTime(t.checked_in_at)}`, 'green') : '<span class="small muted">Show at the door</span>'}
        </div>
      </div>`;
    }).join('')
    : emptyState('🎫', 'No tickets yet. Buy one above and it appears here with its door code.');
  return `<section class="card">
    <div class="card-head"><h2>🎫 My Tickets</h2><span class="sub">${plural(mine.length, 'ticket')}</span></div>
    <div class="card-body"><div class="grid grid-2">${stubs}</div></div>
  </section>`;
}

function createEventForm() {
  return `<section class="card">
    <div class="card-head"><h2>🗓️ Create Event ${badge('Admin', 'plum')}</h2><span class="sub">POST /api/events</span></div>
    <form class="card-body form" data-form="event">
      <div class="form-grid">
        ${field('Title', input('forms.event.title', { placeholder: 'e.g. Winter Cultural Night' }), { forId: 'forms-event-title' })}
        ${field('Date & time', input('forms.event.event_date', { type: 'datetime-local' }), { forId: 'forms-event-event_date' })}
        ${field('Location', input('forms.event.location', { placeholder: 'e.g. Grand Hall' }), { forId: 'forms-event-location' })}
        ${field('Total seats', input('forms.event.total_seats', { type: 'number', attrs: 'min="1"' }), { forId: 'forms-event-total_seats' })}
        ${field('Member price (₹)', input('forms.event.member_price', { type: 'number', attrs: 'min="0"' }), { forId: 'forms-event-member_price' })}
        ${field('Guest price (₹)', input('forms.event.guest_price', { type: 'number', attrs: 'min="0"' }), { forId: 'forms-event-guest_price' })}
        ${field('Description', textarea('forms.event.description', { placeholder: 'What should attendees know?' }), { span2: true, forId: 'forms-event-description' })}
      </div>
      <div>${submitBtn('event', 'Create Event')}</div>
    </form>
  </section>`;
}

function checkInDesk() {
  const events = state.data.events || [];
  const ev = events.find((e) => String(e.id) === String(state.ui.deskEventId));
  const desk = state.data.desk && ev && state.data.desk.event.id === ev.id ? state.data.desk : null;
  const stats = desk?.stats;
  const options = events.map((e) => [e.id, `${e.title} · ${fmtDate(e.event_date)}`]);

  const last = state.ui.lastCheckIn;
  const result = last
    ? `<div class="checkin-result ${last.ok ? 'ok' : 'fail'}"><span class="big" aria-hidden="true">${last.ok ? '✅' : '⛔'}</span><div><b>${esc(last.title)}</b><div class="small">${esc(last.detail)}</div></div></div>`
    : '';

  const rows = desk?.tickets.length
    ? desk.tickets.map((t) => `<tr>
        <td><div class="row">${avatar(t.attendee.name, 'STUDENT')}<div><b>${esc(t.attendee.name)}</b><div class="small muted">${esc(t.attendee.email)}</div></div></div></td>
        <td>${membershipBadge(t.attendee.membership.status)}${t.attendee.membership.code ? `<div class="small muted mono">${esc(t.attendee.membership.code)}</div>` : ''}</td>
        <td><button type="button" class="code-chip" data-action="fillCode" data-code="${esc(t.ticket_code)}" title="Put this code in the scanner">${esc(t.ticket_code)}</button></td>
        <td class="num">${inr(t.price_paid)}</td>
        <td>${t.checked_in ? badge(`✓ In at ${fmtTime(t.checked_in_at)}`, 'green') : badge('Not arrived', 'slate')}</td>
        <td class="right">${t.checked_in ? '' : btn('Check In', 'checkIn', { data: { code: t.ticket_code }, variant: 'teal', size: 'sm' })}</td>
      </tr>`).join('')
    : `<tr><td colspan="6">${emptyState('🧾', desk ? (desk.query ? 'No attendee matches that search.' : 'No tickets issued for this event yet.') : 'Loading attendee list…')}</td></tr>`;

  return `<section class="card">
    <div class="card-head">
      <h2>🛂 Door Ticket Scanner & Check-In Desk ${badge('Volunteer · Admin', 'teal')}</h2>
      <div class="row"><label class="small strong" for="desk-event">Event</label>${select('ui.deskEventId', options, { id: 'desk-event', attrs: 'data-reload="desk"' })}</div>
    </div>
    <div class="card-body stack" style="gap:14px">
      <div class="kpis">
        ${kpi('Seats Sold', ev ? `${ev.seats_sold} / ${ev.total_seats}` : '—', 'incl. box-office sales')}
        ${kpi('Tickets Issued', stats ? stats.tickets_sold : '—', 'sold through the ERP')}
        ${kpi('Checked In at Door', stats ? stats.checked_in_count : '—', stats ? `${stats.no_show_count} not yet arrived` : '')}
        ${kpi('Attendance Rate', stats ? `${pct(stats.checked_in_count, stats.tickets_sold)}%` : '—', 'checked in ÷ issued')}
        ${kpi('Event Revenue', stats ? inr(stats.ticket_revenue) : '—', 'from issued tickets')}
      </div>
      <form class="row" data-form="checkin">
        <input id="checkin-code" class="input input-lg input-mono" style="flex:1;min-width:220px" data-model="forms.checkin.code" value="${esc(state.forms.checkin.code)}" placeholder="Scan or type a ticket code, e.g. TKT-E1-7K3M9Q" autocomplete="off" aria-label="Ticket code">
        ${submitBtn('checkin', 'Check In', { variant: 'teal' })}
      </form>
      ${result}
      ${input('ui.rosterQuery', { id: 'roster-q', placeholder: 'Search attendees by name, email or ticket code…', cls: 'input-search', attrs: 'data-search="desk" autocomplete="off" aria-label="Search attendees"' })}
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Attendee</th><th>Membership</th><th>Ticket code</th><th class="num">Paid</th><th>Door status</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </section>`;
}

// ============================================================================ view: announcements (scene 3)

function viewAnnouncements() {
  const data = state.data.announcements;
  const head = pageHead('Scene 3 · Announcements', 'Announcements & Mailing Archive',
    'Members-only posts are filtered on the server from your live membership, never in the browser.');
  if (!data) return head + loadingBlock();

  const viewer = data.viewer;
  const hidden = data.hidden_members_only_count;
  let hiddenBanner = '';
  if (hidden > 0) {
    const action = state.user
      ? btn(`Join Club (${inr(MEMBERSHIP_FEE)})`, 'joinOrRenew')
      : btn('Sign in', 'openAuth', { data: { mode: 'login' }, mutation: false });
    hiddenBanner = banner('info', '🔒', `${plural(hidden, 'Members-Only Announcement')} Hidden — Join Club (${inr(MEMBERSHIP_FEE)}) to Unlock!`,
      data.filters.q || data.filters.category ? 'Counted with your current filters.' : 'Members see every post, including seating previews and renewal deadlines.', action);
  }

  const filters = `<div class="row-between">
    <div class="pills" role="group" aria-label="Category">${['ALL', ...ANNOUNCEMENT_CATEGORIES].map((c) => `<button type="button" class="pill${state.ui.annCategory === c ? ' active' : ''}" data-action="annCategory" data-category="${c}">${c}</button>`).join('')}</div>
    <div style="flex:1;max-width:360px;min-width:200px">${input('ui.annQuery', { id: 'ann-q', placeholder: 'Search title or content…', cls: 'input-search', attrs: 'data-search="announcements" autocomplete="off" aria-label="Search announcements"' })}</div>
  </div>`;

  const viewerLine = viewer.authenticated
    ? `Viewing as ${esc(state.user?.name || '')} · ${membershipBadge(viewer.membership_status)} · ${viewer.can_view_members_only ? 'all announcements visible' : 'public announcements only'}`
    : 'Viewing as a visitor · public announcements only';

  const list = data.announcements.length
    ? data.announcements.map((a) => `<article class="announcement${a.target_audience === 'MEMBERS_ONLY' ? ' members-only' : ''}">
        <div class="row">${badge(a.category, ANNOUNCEMENT_TONE[a.category])}${a.target_audience === 'MEMBERS_ONLY' ? badge('🔒 Members only', 'plum') : badge('Everyone', 'slate')}</div>
        <h3>${esc(a.title)}</h3>
        <p class="content">${esc(a.content)}</p>
        <div class="byline">${avatar(a.author_name, a.author_role)}<b>${esc(a.author_name)}</b><span>· ${roleLabel(a.author_role)} · ${fmtDateTime(a.created_at)} (${relTime(a.created_at)})</span></div>
      </article>`).join('')
    : emptyState('📭', 'No announcements match these filters.');

  const listCard = `<section class="card">
    <div class="card-head"><h2>📰 Archive <span class="sub">${plural(data.count, 'post')}</span></h2><span class="sub">${viewerLine}</span></div>
    ${list}
  </section>`;

  return `${head}${hiddenBanner}<div class="stack">${filters}${isStaff() ? `<div class="split">${listCard}${postForm()}</div>` : listCard}</div>`;
}

function postForm() {
  const f = state.forms.announcement;
  const audience = ['ALL', 'MEMBERS_ONLY'].map((value) => `<label><input type="radio" name="audience" value="${value}" data-model="forms.announcement.target_audience"${f.target_audience === value ? ' checked' : ''}>${value === 'ALL' ? 'Everyone' : '🔒 Members only'}</label>`).join('');
  const last = state.ui.lastBroadcast;
  return `<section class="card">
    <div class="card-head"><h2>📣 Post Official Announcement</h2>${badge('Volunteer · Admin', 'teal')}</div>
    <form class="card-body form" data-form="announcement">
      ${field('Title', input('forms.announcement.title', { placeholder: 'e.g. Gala seating chart is live' }), { forId: 'forms-announcement-title' })}
      ${field('Message', textarea('forms.announcement.content', { placeholder: 'What do members need to know?' }), { forId: 'forms-announcement-content' })}
      ${field('Category', select('forms.announcement.category', ANNOUNCEMENT_CATEGORIES.map((c) => [c, c])), { forId: 'forms-announcement-category' })}
      <div class="field"><span class="label">Audience</span><div class="segmented" role="radiogroup" aria-label="Audience">${audience}</div></div>
      ${submitBtn('announcement', 'Publish & Broadcast', { block: true })}
      ${last ? `<div class="note note-green">📬 <b>Broadcast sent to ${plural(last.recipients, 'recipient')}</b> (${last.audience === 'MEMBERS_ONLY' ? 'active members' : 'every account'}) · “${esc(last.title)}”</div>` : ''}
    </form>
  </section>`;
}

// ============================================================================ view: merch (scene 4)

function viewMerch() {
  const merch = state.data.merch;
  const head = pageHead('Scene 4 · Merch', 'Club Merch Store — Hoodies & Tees',
    'Each size has its own stock, and the last unit is claimed inside a locked transaction, so two buyers can never get the same hoodie.');
  if (!merch) return head + loadingBlock();

  let orders;
  if (!state.user) orders = signInPrompt('order merch and track your pickups');
  else orders = isStaff() ? pickupQueue() : myOrders();

  return `${head}<div class="stack">
    <div class="grid grid-auto">${merch.items.map(productCard).join('')}</div>
    ${orders}
  </div>`;
}

function productCard(item) {
  const tier = state.data.merch.viewer.tier;
  const selectedId = state.ui.selectedVariant[item.id];
  const variant = item.variants.find((v) => v.variant_id === selectedId);
  const qty = state.ui.quantity[item.id] || 1;
  const maxQty = variant ? Math.min(5, variant.stock_count) : 1;
  const unit = item.your_price ?? item.regular_price;
  const art = /hoodie/i.test(item.name) ? PRODUCT_ART.hoodie : PRODUCT_ART.tee;

  const sizes = item.variants.map((v) => {
    const low = v.stock_count > 0 && v.stock_count <= 3;
    const label = v.stock_count === 0 ? 'Sold out' : low ? `Only ${v.stock_count}` : `${v.stock_count} left`;
    return `<button type="button" class="size${v.variant_id === selectedId ? ' selected' : ''}${low ? ' low' : ''}" data-action="selectSize" data-item="${item.id}" data-variant="${v.variant_id}"${v.stock_count === 0 ? ' disabled' : ''} aria-pressed="${v.variant_id === selectedId}"><b>${esc(v.size)}</b><small>${label}</small></button>`;
  }).join('');

  let action;
  if (!state.user) action = btn('Sign in to order', 'openAuth', { data: { mode: 'login' }, mutation: false, block: true });
  else if (!variant) action = btn(item.total_stock ? 'Choose a size' : 'Sold out', 'orderMerch', { data: { item: item.id }, disabled: true, block: true, variant: 'secondary' });
  else action = btn(`Order Now · ${inr(unit * qty)}`, 'orderMerch', { data: { item: item.id }, block: true });

  return `<article class="card product">
    <div class="product-visual">${art}</div>
    <div class="card-body">
      <div><h3>${esc(item.name)}</h3><p class="small muted mt-8">${esc(item.description || '')}</p></div>
      <div class="price-compare">${priceTile('Member', item.member_price, tier === 'MEMBER')}${priceTile('Regular', item.regular_price, tier === 'REGULAR')}</div>
      <div><div class="row-between"><span class="small strong">Size</span><span class="small muted">${item.total_stock} in stock · ${item.units_sold} sold</span></div><div class="sizes mt-8">${sizes}</div></div>
      <div class="row-between">
        <div class="row"><span class="small strong">Qty</span>
          <div class="qty"><button type="button" data-action="qty" data-item="${item.id}" data-delta="-1" aria-label="Decrease quantity"${qty <= 1 ? ' disabled' : ''}>−</button><span>${qty}</span><button type="button" data-action="qty" data-item="${item.id}" data-delta="1" aria-label="Increase quantity"${qty >= maxQty ? ' disabled' : ''}>+</button></div>
        </div>
        ${state.user ? `<span class="small muted">${tier === 'MEMBER' ? `Members save ${inr(item.regular_price - item.member_price)}` : 'Join to save'}</span>` : ''}
      </div>
      ${state.user ? `<div class="order-total"><span class="small muted">${tier === 'MEMBER' ? 'Member' : 'Regular'} price × ${qty}</span><b>${inr(unit * qty)}</b></div>` : ''}
      ${action}
    </div>
  </article>`;
}

function orderRow(o, { staff }) {
  const [label, tone] = FULFILLMENT[o.fulfillment_status];
  const handover = o.picked_up_by
    ? `<div class="small">by <b>${esc(o.picked_up_by.name)}</b></div><div class="small muted">${fmtDateTime(o.picked_up_at)}</div>`
    : o.fulfillment_status === 'PICKED_UP' ? '<span class="small muted">Before audit trail</span>' : '<span class="small muted">—</span>';
  return `<tr>
    <td>${codeChip(o.order_code)}<div class="small muted">${fmtDateTime(o.created_at)}</div></td>
    ${staff ? `<td><b>${esc(o.buyer.name)}</b><div class="small muted">${esc(o.buyer.email)}</div></td>` : ''}
    <td>${esc(o.item_name)}</td>
    <td><span class="badge badge-slate">${esc(o.size)}</span></td>
    <td class="num">${o.quantity}</td>
    <td class="num">${inr(o.total_paid)}</td>
    <td>${badge(label, tone)}</td>
    <td>${handover}</td>
    ${staff ? `<td class="right">${o.fulfillment_status === 'PAID_PENDING_PICKUP' ? btn('Mark Picked Up', 'pickup', { data: { code: o.order_code }, variant: 'teal', size: 'sm' }) : ''}</td>` : ''}
  </tr>`;
}

function myOrders() {
  const data = state.data.orders;
  const rows = data?.orders.length
    ? data.orders.map((o) => orderRow(o, { staff: false })).join('')
    : `<tr><td colspan="7">${emptyState('🛍️', data ? 'No orders yet. Pick a size above and order.' : 'Loading…')}</td></tr>`;
  return `<section class="card">
    <div class="card-head"><h2>🛍️ My Orders</h2><span class="sub">Collect at the club desk with your order code</span></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Order</th><th>Item</th><th>Size</th><th class="num">Qty</th><th class="num">Paid</th><th>Status</th><th>Handed over</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </section>`;
}

function pickupQueue() {
  const data = state.data.orders;
  const s = data?.summary;
  const filters = [['', 'All orders'], ['PAID_PENDING_PICKUP', 'Awaiting pickup'], ['PICKED_UP', 'Picked up']]
    .map(([value, label]) => `<button type="button" class="pill${state.ui.orderStatus === value ? ' active' : ''}" data-action="orderStatus" data-status="${value}">${label}</button>`).join('');
  const rows = data?.orders.length
    ? data.orders.map((o) => orderRow(o, { staff: true })).join('')
    : `<tr><td colspan="9">${emptyState('📦', data ? 'No orders match.' : 'Loading…')}</td></tr>`;

  return `<section class="card">
    <div class="card-head"><h2>📦 Desk Pickup Queue ${badge('Volunteer · Admin', 'teal')}</h2><span class="sub">PATCH /api/merch/orders/:code/pickup records who handed it over and when</span></div>
    <div class="card-body stack" style="gap:14px">
      <div class="kpis">
        ${kpi('Orders', s ? s.total_orders : '—')}
        ${kpi('Awaiting pickup', s ? s.pending_pickup : '—')}
        ${kpi('Picked up', s ? s.picked_up : '—')}
        ${kpi('Units sold', s ? s.units_sold : '—')}
        ${kpi('Merch revenue', s ? inr(s.revenue) : '—')}
      </div>
      <div class="row-between">
        <div class="pills">${filters}</div>
        <div style="flex:1;max-width:340px;min-width:200px">${input('ui.orderQuery', { id: 'order-q', placeholder: 'Order code or student name…', cls: 'input-search', attrs: 'data-search="orders" autocomplete="off" aria-label="Search orders"' })}</div>
      </div>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Order</th><th>Student</th><th>Item</th><th>Size</th><th class="num">Qty</th><th class="num">Paid</th><th>Status</th><th>Handed over</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </section>`;
}

// ============================================================================ view: tasks (scene 5)

function viewTasks() {
  const head = pageHead('Scene 5 · Fundraising', 'Bake Sale Fundraiser Planner',
    'Unassigned tasks still show up (the board uses a LEFT JOIN). Students can move only the tasks assigned to them.');
  if (!state.user) return head + signInPrompt('see the fundraiser board');
  const data = state.data.tasks;
  if (!data) return head + loadingBlock();

  const campaigns = Object.keys(data.campaigns_summary);
  if (!campaigns.length) return head + emptyState('🧁', 'No fundraiser tasks yet.') + (isStaff() ? addTaskForm([]) : '');
  const campaign = campaigns.includes(state.ui.campaign) ? state.ui.campaign : campaigns.includes(DEFAULT_CAMPAIGN) ? DEFAULT_CAMPAIGN : campaigns[0];
  const summary = data.campaigns_summary[campaign];
  const tasks = data.tasks.filter((t) => t.campaign_name === campaign);

  const switcher = campaigns.length > 1
    ? `<div class="pills">${campaigns.map((c) => `<button type="button" class="pill${c === campaign ? ' active' : ''}" data-action="campaign" data-name="${esc(c)}">${esc(c)}</button>`).join('')}</div>`
    : '';

  const health = `<section class="card"><div class="card-body health">
    <div>
      <div class="row"><h2>${esc(campaign)}</h2>${summary.on_track ? badge('On track', 'green') : badge('At risk — overdue tasks', 'red')}</div>
      <div class="row mt-8"><span class="pct">${summary.completion_percentage}%</span><span class="muted">complete · ${summary.done_count} of ${plural(summary.total_tasks, 'task')} done</span></div>
      <div class="mt-8">${progress(summary.completion_percentage, summary.on_track ? 'green' : 'amber', true)}</div>
    </div>
    ${kpi('To do', summary.todo_count)}
    ${kpi('In progress', summary.in_progress_count)}
    ${kpi('Done', summary.done_count, '', 'green')}
    ${kpi('Overdue', summary.overdue_count, summary.overdue_count ? 'needs attention' : 'nothing late', summary.overdue_count ? 'red' : '')}
  </div></section>`;

  const board = `<div class="board">${['TODO', 'IN_PROGRESS', 'DONE'].map((status) => {
    const column = tasks.filter((t) => t.status === status);
    return `<div class="column col-${status}">
      <div class="column-head"><span>${TASK_STATUS[status][0]}</span><span class="count">${column.length}</span></div>
      ${column.length ? column.map(taskCard).join('') : '<div class="small muted" style="padding:8px">Nothing here.</div>'}
    </div>`;
  }).join('')}</div>`;

  return `${head}<div class="stack">${switcher}${health}${isStaff() ? addTaskForm(campaigns) : ''}${board}</div>`;
}

function taskCard(t) {
  const mine = t.assigned_to === state.user.id;
  const canMove = isStaff() || mine;
  const assignee = t.assigned_to
    ? `<span class="assignee">${avatar(t.assignee_name, t.assignee_role)}${esc(t.assignee_name)}${mine ? ' (you)' : ''}</span>`
    : '<span class="assignee unassigned">Unassigned</span>';
  const due = t.due_date
    ? `<span class="due${t.is_overdue ? ' overdue' : ''}">${t.is_overdue ? '⚠ Overdue · ' : 'Due '}${fmtDay(t.due_date)}</span>`
    : '<span class="due">No due date</span>';
  const actions = TASK_MOVES[t.status].map(([label, next, variant]) => (canMove
    ? btn(label, 'taskStatus', { data: { id: t.id, status: next }, variant, size: 'sm' })
    : btn(`🔒 ${label}`, 'taskStatus', {
      data: { id: t.id, status: next },
      variant: 'locked',
      size: 'sm',
      title: 'Only the assignee or a volunteer/admin can move this task. Click to watch the server refuse it (403).',
    }))).join('');

  return `<div class="task${t.is_overdue ? ' overdue' : ''}${t.status === 'DONE' ? ' done' : ''}">
    <div class="task-title">${esc(t.title)}</div>
    <div class="task-meta">${assignee}${due}</div>
    <div class="task-actions">${actions}</div>
  </div>`;
}

function addTaskForm(campaigns) {
  const people = [['', 'Unassigned'], ...(state.data.assignees || []).map((u) => [u.id, `${u.name} (${roleLabel(u.role)})`])];
  return `<section class="card">
    <div class="card-head"><h2>➕ Add Task ${badge('Volunteer · Admin', 'teal')}</h2><span class="sub">POST /api/tasks · new tasks start in To do</span></div>
    <form class="card-body form" data-form="task">
      <div class="form-grid" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr))">
        ${field('Task', input('forms.task.title', { placeholder: 'e.g. Print price labels' }), { forId: 'forms-task-title' })}
        ${field('Assignee', select('forms.task.assigned_to', people), { forId: 'forms-task-assigned_to' })}
        ${field('Due date', input('forms.task.due_date', { type: 'date' }), { forId: 'forms-task-due_date' })}
        ${field('Campaign', `${input('forms.task.campaign_name', { attrs: 'list="campaign-list"' })}<datalist id="campaign-list">${campaigns.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>`, { forId: 'forms-task-campaign_name' })}
      </div>
      <div>${submitBtn('task', 'Add Task')}</div>
    </form>
  </section>`;
}

// ============================================================================ view: finance (scene 6)

function viewFinance() {
  const head = pageHead("Scene 6 · Treasurer's office", "Treasurer's Financial Books & Reimbursements",
    'Money only leaves the club when an admin approves a claim; the payout and its ledger row commit together or not at all.');
  if (!state.user) return head + signInPrompt('see reimbursements and the club books');
  return `${head}<div class="stack">
    ${reimbursementsSection()}
    ${isStaff() ? ledgerSection() : lockedPanel("Treasurer's semester ledger", 'The books are visible to volunteers and admins only. The ledger endpoint returns 403 for students.')}
  </div>`;
}

function reimbursementsSection() {
  const data = state.data.reimbursements;
  const s = data?.summary;
  const filters = [['', 'All'], ['PENDING', 'Pending'], ['APPROVED_PAID', 'Approved & paid'], ['REJECTED', 'Rejected']]
    .map(([value, label]) => `<button type="button" class="pill${state.ui.reimbStatus === value ? ' active' : ''}" data-action="reimbStatus" data-status="${value}">${label}</button>`).join('');

  const rows = data?.reimbursements.length
    ? data.reimbursements.map(reimbursementRow).join('')
    : `<tr><td colspan="7">${emptyState('🧾', data ? (isStaff() ? 'No claims match.' : 'You have not submitted any expense claims.') : 'Loading…')}</td></tr>`;

  const table = `<section class="card">
    <div class="card-head"><h2>🧾 Volunteer Expense Reimbursements</h2><span class="sub">${isStaff() ? 'Pending claims first: this is the treasurer\'s review queue' : 'Your own claims'}</span></div>
    <div class="card-body stack" style="gap:14px">
      ${s ? `<div class="kpis">
        ${kpi('Pending review', inr(s.pending_amount), plural(s.pending_count, 'claim'))}
        ${kpi('Approved & paid', inr(s.approved_paid_amount), plural(s.approved_paid_count, 'claim'), 'green')}
        ${kpi('Rejected', inr(s.rejected_amount), plural(s.rejected_count, 'claim'))}
      </div>` : ''}
      <div class="pills">${filters}</div>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Expense</th><th>Submitted by</th><th>Receipt</th><th class="num">Amount</th><th>Status</th><th>Reviewed by</th><th>Action</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </section>`;

  if (!isStaff()) {
    return `${table}<div class="note mt-8">Only volunteers and admins can submit expense claims for club purchases.</div>`;
  }
  return `${table}${expenseForm()}`;
}

function reimbursementRow(r) {
  const [label, tone] = REIMBURSEMENT[r.status];
  const category = EXPENSE_CATEGORIES.find(([value]) => value === r.category)?.[1] || r.category;
  let action = '<span class="small muted">—</span>';
  if (r.status === 'PENDING') {
    if (isAdmin() && r.volunteer_id === state.user.id) {
      action = `<div class="note note-amber small" style="max-width:240px"><b>Segregation of duties:</b> you submitted this claim, so another admin must review it.</div>
        <div class="mt-8">${btn('🔒 Approve anyway', 'review', { data: { id: r.id, decision: 'APPROVED_PAID' }, variant: 'locked', size: 'sm', title: 'The server refuses self-approval with 403.' })}</div>`;
    } else if (isAdmin()) {
      action = `<div class="row">${btn('Approve & Reimburse', 'review', { data: { id: r.id, decision: 'APPROVED_PAID' }, variant: 'success', size: 'sm' })}${btn('Reject', 'review', { data: { id: r.id, decision: 'REJECTED' }, variant: 'danger', size: 'sm' })}</div>`;
    } else if (isStaff()) {
      action = `<div class="small muted">Awaiting the treasurer</div><div class="mt-8">${btn('🔒 Approve', 'review', { data: { id: r.id, decision: 'APPROVED_PAID' }, variant: 'locked', size: 'sm', title: 'Only admins can approve. Click to watch the server answer 403.' })}</div>`;
    } else {
      action = '<span class="small muted">Awaiting the treasurer</span>';
    }
  }
  return `<tr>
    <td><b>${esc(r.title)}</b><div class="small muted">${esc(category)} · ${fmtDate(r.created_at)}</div></td>
    <td>${esc(r.volunteer_name)}</td>
    <td>${codeChip(r.receipt_reference)}</td>
    <td class="num"><b>${inr(r.amount)}</b></td>
    <td>${badge(label, tone)}</td>
    <td>${r.approved_by_name ? esc(r.approved_by_name) : '<span class="muted">—</span>'}</td>
    <td>${action}</td>
  </tr>`;
}

function expenseForm() {
  return `<section class="card">
    <div class="card-head"><h2>➕ Submit Expense Receipt ${badge('Volunteer · Admin', 'teal')}</h2><span class="sub">Nothing is written to the ledger yet: money leaves the club only when an admin approves the claim</span></div>
    <form class="card-body form" data-form="expense">
      <div class="form-grid" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr))">
        ${field('What did you buy?', input('forms.expense.title', { placeholder: 'e.g. Bake Sale Cocoa & Sugar' }), { forId: 'forms-expense-title' })}
        ${field('Category', select('forms.expense.category', EXPENSE_CATEGORIES), { forId: 'forms-expense-category' })}
        ${field('Amount (₹)', input('forms.expense.amount', { type: 'number', attrs: 'min="1" step="1"' }), { forId: 'forms-expense-amount' })}
        ${field('Receipt reference', input('forms.expense.receipt_reference', { placeholder: 'RCP-2026-884', cls: 'input-mono' }), { forId: 'forms-expense-receipt_reference' })}
      </div>
      <div>${submitBtn('expense', 'Submit for Reimbursement')}</div>
    </form>
  </section>`;
}

function ledgerSection() {
  const L = state.data.ledger;
  if (!L) return `<section class="card"><div class="card-body">${loadingBlock()}</div></section>`;
  const s = L.summary;
  const categorySum = (key) => L.by_category.reduce((acc, c) => acc + c[key], 0);
  const balanced = s.total_in - s.total_out === s.net_balance;
  const categoriesMatch = categorySum('total_in') === s.total_in && categorySum('total_out') === s.total_out;

  const breakdown = L.by_category.map((c) => {
    const outflow = c.total_out > c.total_in;
    const amount = outflow ? c.total_out : c.total_in;
    const share = pct(amount, outflow ? s.total_out : s.total_in);
    return `<div class="cat-row">
      <div>${badge(LEDGER_LABEL[c.category], LEDGER_TONE[c.category])}<div class="small muted mt-8">${plural(c.transaction_count, 'transaction')}</div></div>
      <div class="bar ${outflow ? 'out' : 'in'}"><span style="width:${share}%"></span></div>
      <div class="num ${outflow ? 'amount-out' : 'amount-in'}">${signedInr(outflow ? -amount : amount)}</div>
      <div class="num small muted share">${share}% of ${outflow ? 'out' : 'in'}</div>
    </div>`;
  }).join('');

  const typeOptions = [['', 'All types'], ['IN', 'Money in'], ['OUT', 'Money out']];
  const categoryOptions = [['', 'All categories'], ...LEDGER_CATEGORIES.map((c) => [c, LEDGER_LABEL[c]])];
  const rows = L.transactions.length
    ? L.transactions.map((t) => `<tr>
        <td class="nowrap">${fmtDateTime(t.created_at)}</td>
        <td>${badge(t.type, t.type === 'IN' ? 'green' : 'red')}</td>
        <td>${badge(LEDGER_LABEL[t.category], LEDGER_TONE[t.category])}</td>
        <td>${esc(t.description)}</td>
        <td>${t.reference_id ? codeChip(t.reference_id) : '<span class="muted">—</span>'}</td>
        <td>${t.user_name ? esc(t.user_name) : '<span class="muted">—</span>'}</td>
        <td class="num ${t.signed_amount < 0 ? 'amount-out' : 'amount-in'}">${signedInr(t.signed_amount)}</td>
      </tr>`).join('')
    : `<tr><td colspan="7">${emptyState('📒', 'No transactions match these filters.')}</td></tr>`;

  return `<section class="stack">
    <div class="kpis">
      <div class="kpi kpi-lg tone-green"><div class="kpi-label">Total Money In</div><div class="kpi-value">${inr(s.total_in)}</div><div class="kpi-sub">dues, tickets, merch, fundraising</div></div>
      <div class="kpi kpi-lg tone-red"><div class="kpi-label">Total Money Out</div><div class="kpi-value">${inr(s.total_out)}</div><div class="kpi-sub">approved reimbursements</div></div>
      <div class="kpi kpi-lg tone-plum"><div class="kpi-label">Net Club Balance</div><div class="kpi-value">${inr(s.net_balance)}</div><div class="kpi-sub">${plural(s.transaction_count, 'ledger row')} · ${fmtDateTime(L.generated_at)}</div></div>
    </div>
    <div class="integrity">
      <span class="${balanced ? 'ok' : 'bad'}">${balanced ? '✓' : '✗'} In − Out = Net (${inr(s.total_in)} − ${inr(s.total_out)} = ${inr(s.net_balance)})</span>
      <span class="${categoriesMatch ? 'ok' : 'bad'}">${categoriesMatch ? '✓' : '✗'} Categories add up to the totals</span>
    </div>
    <div class="${isAdmin() ? 'split' : ''}">
      <section class="card">
        <div class="card-head"><h2>📊 Where every rupee came from and went</h2><span class="sub">all 5 ledger categories</span></div>
        <div class="card-body">${breakdown}</div>
      </section>
      ${isAdmin() ? incomeForm() : ''}
    </div>
    <section class="card">
      <div class="card-head">
        <h2>📒 Immutable Ledger <span class="sub">${plural(L.count, 'row')}${L.filters.type || L.filters.category ? ' (filtered)' : ''}</span></h2>
        <div class="row">
          ${select('ui.ledgerType', typeOptions, { id: 'ledger-type', attrs: 'data-reload="ledger" aria-label="Filter by type"' })}
          ${select('ui.ledgerCategory', categoryOptions, { id: 'ledger-category', attrs: 'data-reload="ledger" aria-label="Filter by category"' })}
        </div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>When</th><th>Type</th><th>Category</th><th>Description</th><th>Reference</th><th>User</th><th class="num">Amount</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </section>
  </section>`;
}

function incomeForm() {
  return `<section class="card">
    <div class="card-head"><h2>💰 Record Fundraiser Income</h2>${badge('Treasurer', 'plum')}</div>
    <form class="card-body form" data-form="income">
      ${field('Amount (₹)', input('forms.income.amount', { type: 'number', attrs: 'min="1" step="1"' }), { forId: 'forms-income-amount' })}
      ${field('Description', input('forms.income.description', { placeholder: 'Spring Bake Sale — Saturday stall takings' }), { forId: 'forms-income-description' })}
      ${field('Reference (optional)', input('forms.income.reference_id', { placeholder: 'BAKESALE-DAY1', cls: 'input-mono' }), { forId: 'forms-income-reference_id' })}
      ${submitBtn('income', 'Record Income', { block: true })}
      <div class="note">A reference can only be recorded once, so the same collection can't be counted twice.</div>
    </form>
  </section>`;
}

// ============================================================================ chrome: topbar, nav, inspector, toasts, modal

function renderTopbar() {
  const accounts = state.demo.accounts;
  const personas = accounts.length
    ? `<span class="persona-label">Demo</span>${accounts.map((a) => {
      const info = personaInfo(a);
      const active = state.user?.email === a.email;
      const busy = state.pendingAction === `persona:${a.email}`;
      const due = a.membership.status === 'ACTIVE' && a.membership.renewal_due;
      return `<button type="button" class="persona${active ? ' active' : ''}" data-action="persona" data-email="${esc(a.email)}" aria-pressed="${active}"${state.isLoading ? ' disabled' : ''} title="${esc(`${a.name} · ${info.label}: ${info.blurb}`)}">
          <span class="avatar role-${esc(a.role)}">${busy ? '<span class="spinner"></span>' : esc(initials(a.name))}</span>
          <span class="persona-text"><b>${esc(firstName(a.name))}</b><small>${esc(info.label)}</small></span>
          ${due ? '<span class="dot-alert" aria-label="Renewal due"></span>' : ''}
        </button>`;
    }).join('')}`
    : '';
  patch(document.getElementById('personas'), personas);

  const u = state.user;
  const session = u
    ? `<span class="who"><b>${esc(u.name)}</b><span>${roleLabel(u.role)} · ${esc(u.membership.status)}</span></span>
       <button type="button" class="btn btn-sm btn-topbar" data-action="logout">Log out</button>`
    : `<button type="button" class="btn btn-sm btn-topbar" data-action="openAuth" data-mode="login">Sign in</button>
       <button type="button" class="btn btn-sm btn-topbar" data-action="openAuth" data-mode="register">Register</button>`;
  patch(document.getElementById('session'), session);
}

function renderNav() {
  const h = state.health;
  const foot = h
    ? `<span class="ok">●</span> API healthy · ${esc(h.database.driver)}<br>SQLite ${esc(h.database.sqlite_version)} · ${esc(String(h.database.journal_mode).toUpperCase())} · FK ${h.database.foreign_keys ? 'ON' : 'OFF'}`
    : 'Checking API health…';
  const items = TABS.map((t) => `<a class="nav-item${state.activeTab === t.id ? ' active' : ''}" href="#${t.id}"${state.activeTab === t.id ? ' aria-current="page"' : ''}>
      ${ICONS[t.id]}<span class="nav-text"><b>${t.label}</b><small>${t.scene}</small></span></a>`).join('');
  patch(document.getElementById('nav'), `<div class="nav-heading">Skyline ERP</div>${items}<div class="nav-foot">${foot}</div>`);
}

const VIEWS = {
  overview: viewOverview,
  events: viewEvents,
  announcements: viewAnnouncements,
  merch: viewMerch,
  tasks: viewTasks,
  finance: viewFinance,
};

function renderMain() {
  let html;
  try {
    html = VIEWS[state.activeTab]();
  } catch (err) {
    console.error(err);
    html = banner('danger', '⚠️', 'This view failed to render', esc(err.message));
  }
  patch(document.getElementById('main'), html);
}

function methodTag(method) {
  return `<span class="method ${esc(method)}">${esc(method)}</span>`;
}

function statusTag(status) {
  return `<span class="status-code s${String(status)[0]}">${status || 'ERR'} ${esc(STATUS_TEXT[status] || '')}</span>`;
}

function highlightJson(value) {
  const json = esc(JSON.stringify(value, null, 2) ?? 'null');
  return json.replace(/(&quot;(?:\\.|[^&\\]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false)\b|\bnull\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g, (match, str, colon, bool) => {
    if (str) return colon ? `<span class="j-key">${str}</span>${colon}` : `<span class="j-str">${str}</span>`;
    if (bool) return `<span class="j-bool">${match}</span>`;
    if (match === 'null') return `<span class="j-null">${match}</span>`;
    return `<span class="j-num">${match}</span>`;
  });
}

function renderInspector() {
  const { open, entries, selectedId } = state.inspector;
  const selected = entries.find((e) => e.id === selectedId) || entries[0];
  const latest = entries.find((e) => e.mutation) || entries[0];
  const summary = latest
    ? `<span class="last">${methodTag(latest.method)}<code>${esc(latest.path)}</code>${statusTag(latest.status)}<span class="small" style="color:#94a3b8">${latest.ms} ms</span></span>`
    : '<span class="last small" style="color:#94a3b8">No requests yet</span>';

  let body = '';
  if (open) {
    const list = entries.length
      ? entries.map((e) => `<li><button type="button" class="${selected && e.id === selected.id ? 'selected' : ''}" data-action="inspect" data-id="${e.id}">
          ${methodTag(e.method)}<span class="path">${esc(e.path)}</span>${statusTag(e.status)}</button></li>`).join('')
      : '<li class="small" style="padding:12px;color:#94a3b8">Requests appear here as you use the app.</li>';
    const detail = selected
      ? `<div class="req-line">${methodTag(selected.method)}<span>${esc(selected.path)}</span>→${statusTag(selected.status)}<span style="color:#94a3b8">${selected.ms} ms · ${fmtTime(selected.at)}</span></div>
        <div><h4>Request headers</h4><div class="headers">Authorization: ${selected.token ? `Bearer …${esc(selected.token.slice(-10))}` : '(none: anonymous request)'}${selected.request ? '<br>Content-Type: application/json' : ''}</div></div>
        <div><h4>Request payload</h4><pre>${selected.request ? highlightJson(selected.request) : '<span class="j-null">(no body)</span>'}</pre></div>
        <div><h4>Response body · HTTP ${selected.status}</h4><pre>${highlightJson(selected.response)}</pre></div>
        <div class="row"><button type="button" class="btn btn-secondary btn-sm" data-action="copyCurl" data-id="${selected.id}">Copy as cURL</button><button type="button" class="btn btn-secondary btn-sm" data-action="clearInspector">Clear</button></div>`
      : '<p style="color:#94a3b8">Select a request.</p>';
    body = `<div class="inspector-body"><ul class="inspector-list">${list}</ul><div class="inspector-detail">${detail}</div></div>`;
  }

  patch(document.getElementById('inspector'), `<button type="button" class="inspector-bar" data-action="toggleInspector" aria-expanded="${open}">
      <span class="title"><span class="live-dot"></span>Live API Inspector</span>${summary}
      <span class="chev">${plural(entries.length, 'request')} · ${open ? 'Hide ▼' : 'Show ▲'}</span>
    </button>${body}`);
}

function renderToasts() {
  patch(document.getElementById('toasts'), state.toasts.map((t) => `<div class="toast ${t.ok ? 'ok' : 'err'}" data-action="dismissToast" data-id="${t.id}" role="status">
      <span class="status">${t.status ? `${t.status} ${esc(t.statusText)}` : esc(t.statusText)}</span>
      <div class="toast-body"><div class="toast-msg">${esc(t.message)}</div>${t.request ? `<div class="toast-req">${esc(t.request)}</div>` : ''}</div>
    </div>`).join(''));
}

function renderModal() {
  const mode = state.ui.authMode;
  if (!mode) return patch(document.getElementById('modal-root'), '');
  const demo = state.demo.password ? `<div class="note note-plum">Demo password for every persona: <code>${esc(state.demo.password)}</code></div>` : '';
  const form = mode === 'login'
    ? `<form class="card-body form" data-form="login">
        ${field('Email', input('forms.login.email', { type: 'email', placeholder: 'you@skyline.edu', attrs: 'autocomplete="username" required' }), { forId: 'forms-login-email' })}
        ${field('Password', input('forms.login.password', { type: 'password', attrs: 'autocomplete="current-password" required' }), { forId: 'forms-login-password' })}
        ${state.ui.authError ? `<div class="note note-amber">${esc(state.ui.authError)}</div>` : ''}
        ${submitBtn('login', 'Sign in', { block: true })}
        ${demo}
      </form>`
    : `<form class="card-body form" data-form="register">
        ${field('Full name', input('forms.register.name', { attrs: 'autocomplete="name" required' }), { forId: 'forms-register-name' })}
        ${field('Email', input('forms.register.email', { type: 'email', attrs: 'autocomplete="email" required' }), { forId: 'forms-register-email' })}
        ${field('Password (8+ characters)', input('forms.register.password', { type: 'password', attrs: 'autocomplete="new-password" minlength="8" required' }), { forId: 'forms-register-password' })}
        ${state.ui.authError ? `<div class="note note-amber">${esc(state.ui.authError)}</div>` : ''}
        ${submitBtn('register', 'Create account', { block: true })}
        <div class="note">New accounts start as students without a membership. Join from the Overview tab.</div>
      </form>`;

  patch(document.getElementById('modal-root'), `<div class="modal-backdrop" data-action="closeModal" data-self="1">
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="auth-title">
      <div class="card-head"><h2 id="auth-title">${mode === 'login' ? 'Sign in to Skyline' : 'Create your Skyline account'}</h2><button type="button" class="icon-btn" data-action="closeModal" aria-label="Close">×</button></div>
      <div class="tabs"><button type="button" class="${mode === 'login' ? 'active' : ''}" data-action="authMode" data-mode="login">Sign in</button><button type="button" class="${mode === 'register' ? 'active' : ''}" data-action="authMode" data-mode="register">Register</button></div>
      ${form}
    </div>
  </div>`);
  return undefined;
}

// Replaces a region's HTML only when it changed, keeping keyboard focus and the
// caret in place so live search boxes survive re-renders.
function patch(el, html) {
  if (!el || el.__html === html) return;
  const active = document.activeElement;
  const focus = active && active.id && el.contains(active)
    ? { id: active.id, start: safeSelection(active, 'selectionStart'), end: safeSelection(active, 'selectionEnd') }
    : null;
  el.__html = html;
  el.innerHTML = html;
  if (!focus) return;
  const next = document.getElementById(focus.id);
  if (!next) return;
  next.focus({ preventScroll: true });
  if (focus.start !== null) {
    try {
      next.setSelectionRange(focus.start, focus.end);
    } catch {
      // number/date inputs have no text selection
    }
  }
}

function safeSelection(el, prop) {
  try {
    return typeof el[prop] === 'number' ? el[prop] : null;
  } catch {
    return null;
  }
}

function render() {
  renderTopbar();
  renderNav();
  renderMain();
  renderInspector();
  renderToasts();
  renderModal();
}

// ============================================================================ event handlers

const ACTIONS = {
  persona: ({ email }) => switchPersona(email),
  logout: () => {
    clearSession();
    infoToast('Signed out. Stateless tokens need no server call; the browser simply forgets it.');
    loadTab();
    render();
  },
  openAuth: ({ mode }) => {
    state.ui.authMode = mode;
    state.ui.authError = null;
    renderModal();
    document.getElementById(mode === 'login' ? 'forms-login-email' : 'forms-register-name')?.focus();
  },
  authMode: ({ mode }) => {
    state.ui.authMode = mode;
    state.ui.authError = null;
    renderModal();
  },
  closeModal: () => {
    state.ui.authMode = null;
    renderModal();
  },
  joinOrRenew: () => joinOrRenew(),
  toggleEventForm: () => {
    state.ui.showEventForm = !state.ui.showEventForm;
    renderMain();
  },
  buyTicket: ({ id }) => mutate(`buyTicket:${id}`, 'POST', `/api/events/${id}/tickets`, undefined, {
    success: (d) => `Ticket ${d.ticket.ticket_code} · ${d.tier} price ${inr(d.price_paid)} · ${plural(d.seats_left, 'seat')} left`,
    refresh: async () => {
      await Promise.all([refreshSession(), loadEvents()]);
      await loadDesk();
    },
  }),
  checkIn: ({ code }) => checkIn(code),
  fillCode: ({ code }) => {
    state.forms.checkin.code = code;
    renderMain();
    document.getElementById('checkin-code')?.focus();
  },
  annCategory: async ({ category }) => {
    state.ui.annCategory = category;
    renderMain();
    await loadAnnouncements();
    renderMain();
  },
  selectSize: ({ item, variant }) => {
    state.ui.selectedVariant[item] = Number(variant);
    const found = state.data.merch?.items.find((i) => String(i.id) === String(item));
    if (found) clampQuantity(found);
    renderMain();
  },
  qty: ({ item, delta }) => {
    state.ui.quantity[item] = (state.ui.quantity[item] || 1) + Number(delta);
    const found = state.data.merch?.items.find((i) => String(i.id) === String(item));
    if (found) clampQuantity(found);
    renderMain();
  },
  orderMerch: ({ item }) => mutate(`orderMerch:${item}`, 'POST', '/api/merch/orders', {
    variant_id: state.ui.selectedVariant[item],
    quantity: state.ui.quantity[item] || 1,
  }, {
    success: (d) => `Order ${d.order.order_code} · ${d.order.quantity}× ${d.order.item_name} (${d.order.size}) · ${d.tier} price ${inr(d.total_paid)}`,
    onSuccess: () => {
      state.ui.quantity[item] = 1;
    },
    refresh: () => Promise.all([refreshSession(), loadMerchItems(), loadOrders()]),
  }),
  orderStatus: async ({ status }) => {
    state.ui.orderStatus = status;
    renderMain();
    await loadOrders();
    renderMain();
  },
  pickup: ({ code }) => mutate(`pickup:${code}`, 'PATCH', `/api/merch/orders/${encodeURIComponent(code)}/pickup`, undefined, {
    success: (d) => `${d.order.order_code} handed over to ${d.order.buyer.name}`,
    refresh: () => Promise.all([loadMerchItems(), loadOrders()]),
  }),
  campaign: ({ name }) => {
    state.ui.campaign = name;
    renderMain();
  },
  taskStatus: ({ id, status }) => mutate(`taskStatus:${id}:${status}`, 'PATCH', `/api/tasks/${id}/status`, { status }, {
    success: (d) => `“${d.task.title}” → ${TASK_STATUS[d.task.status][0]} · campaign ${d.campaign.completion_percentage}% done`,
    refresh: () => loadTasks(),
  }),
  reimbStatus: async ({ status }) => {
    state.ui.reimbStatus = status;
    renderMain();
    await loadReimbursements();
    renderMain();
  },
  review: ({ id, decision }) => mutate(`review:${id}:${decision}`, 'PATCH', `/api/finance/reimbursements/${id}/review`, { decision }, {
    success: (d) => (d.transaction
      ? `Approved · ${inr(d.transaction.amount)} paid to ${d.reimbursement.volunteer_name} (ledger ${signedInr(-d.transaction.amount)})`
      : `Claim #${d.reimbursement.id} rejected · no money moved`),
    refresh: () => Promise.all([loadReimbursements(), loadLedger()]),
  }),
  toggleInspector: () => {
    state.inspector.open = !state.inspector.open;
    renderInspector();
  },
  inspect: ({ id }) => {
    state.inspector.selectedId = Number(id);
    renderInspector();
  },
  clearInspector: () => {
    state.inspector.entries = [];
    state.inspector.selectedId = null;
    renderInspector();
  },
  copyCurl: ({ id }) => {
    const entry = state.inspector.entries.find((e) => e.id === Number(id));
    if (!entry) return;
    const parts = [`curl -i -X ${entry.method} '${location.origin}${entry.path}'`];
    if (entry.token) parts.push(`-H 'Authorization: Bearer ${entry.token}'`);
    if (entry.request) parts.push("-H 'Content-Type: application/json'", `-d '${JSON.stringify(entry.request).replace(/'/g, "'\\''")}'`);
    const text = parts.join(' \\\n  ');
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(() => infoToast('cURL command copied to the clipboard.'), () => window.prompt('Copy this cURL command:', text));
    } else {
      window.prompt('Copy this cURL command:', text);
    }
  },
  dismissToast: ({ id }) => dismissToast(Number(id)),
};

const FORMS = {
  login: () => signIn('form:login', state.forms.login.email, state.forms.login.password),
  register: () => {
    const f = state.forms.register;
    return mutate('form:register', 'POST', '/api/auth/register', { name: f.name, email: f.email, password: f.password }, {
      onSuccess: (d) => {
        setSession(d.token, d.user);
        state.data = blankData();
        state.ui.authMode = null;
        state.ui.authError = null;
        state.forms.register = blankForms().register;
      },
      onError: (res) => {
        state.ui.authError = errorText(res);
      },
      success: (d) => `Account created for ${d.user.name}. Welcome to Skyline!`,
      refresh: () => LOADERS[state.activeTab]?.(),
    });
  },
  checkin: () => checkIn(state.forms.checkin.code, 'form:checkin'),
  event: () => {
    const f = state.forms.event;
    const when = new Date(f.event_date);
    return mutate('form:event', 'POST', '/api/events', {
      title: f.title,
      description: f.description || null,
      event_date: Number.isNaN(when.getTime()) ? f.event_date : when.toISOString(),
      location: f.location,
      total_seats: toNumber(f.total_seats),
      member_price: toNumber(f.member_price),
      guest_price: toNumber(f.guest_price),
    }, {
      success: (d) => `Event “${d.event.title}” created with ${plural(d.event.total_seats, 'seat')}`,
      onSuccess: () => {
        state.forms.event = blankForms().event;
        state.ui.showEventForm = false;
      },
      refresh: () => loadEvents(),
    });
  },
  announcement: () => {
    const f = state.forms.announcement;
    return mutate('form:announcement', 'POST', '/api/announcements', { ...f }, {
      success: (d) => `Broadcast sent to ${plural(d.recipients_notified, 'recipient')}`,
      onSuccess: (d) => {
        state.ui.lastBroadcast = { recipients: d.recipients_notified, audience: d.announcement.target_audience, title: d.announcement.title };
        state.forms.announcement = blankForms().announcement;
      },
      refresh: () => loadAnnouncements(),
    });
  },
  task: () => {
    const f = state.forms.task;
    return mutate('form:task', 'POST', '/api/tasks', {
      title: f.title,
      campaign_name: f.campaign_name.trim() || undefined,
      assigned_to: f.assigned_to ? Number(f.assigned_to) : null,
      due_date: f.due_date || null,
    }, {
      success: (d) => `Task added to ${d.task.campaign_name} · ${d.campaign.total_tasks} tasks, ${d.campaign.completion_percentage}% done`,
      onSuccess: (d) => {
        state.ui.campaign = d.task.campaign_name;
        state.forms.task = { ...blankForms().task, campaign_name: d.task.campaign_name };
      },
      refresh: () => loadTasks(),
    });
  },
  expense: () => {
    const f = state.forms.expense;
    return mutate('form:expense', 'POST', '/api/finance/reimbursements', {
      title: f.title,
      category: f.category,
      amount: toNumber(f.amount),
      receipt_reference: f.receipt_reference,
    }, {
      success: (d) => `Claim #${d.reimbursement.id} for ${inr(d.reimbursement.amount)} submitted · pending review, ledger untouched`,
      onSuccess: () => {
        state.forms.expense = blankForms().expense;
      },
      refresh: () => Promise.all([loadReimbursements(), loadLedger()]),
    });
  },
  income: () => {
    const f = state.forms.income;
    return mutate('form:income', 'POST', '/api/finance/fundraiser-income', {
      amount: toNumber(f.amount),
      description: f.description,
      reference_id: f.reference_id || null,
    }, {
      success: (d) => `Recorded ${inr(d.transaction.amount)} fundraiser income · net balance ${inr(d.summary.net_balance)}`,
      onSuccess: () => {
        state.forms.income = blankForms().income;
      },
      refresh: () => loadLedger(),
    });
  },
};

const RELOADERS = { desk: loadDesk, ledger: loadLedger };

document.addEventListener('click', (event) => {
  const el = event.target.closest('[data-action]');
  if (!el || el.disabled) return;
  if (el.dataset.self && event.target !== el) return; // modal backdrop: only direct clicks close it
  const handler = ACTIONS[el.dataset.action];
  if (!handler) return;
  event.preventDefault();
  handler(el.dataset, el);
});

document.addEventListener('input', (event) => {
  const el = event.target;
  if (el.dataset?.model) setPath(el.dataset.model, el.value);
  if (el.dataset?.search) scheduleSearch(el.dataset.search);
});

document.addEventListener('change', async (event) => {
  const el = event.target;
  if (el.dataset?.model) setPath(el.dataset.model, el.value);
  if (el.dataset?.reload) {
    if (el.dataset.reload === 'desk') state.ui.lastCheckIn = null;
    await RELOADERS[el.dataset.reload]?.();
    renderMain();
  }
});

document.addEventListener('submit', (event) => {
  const form = event.target.closest('form[data-form]');
  if (!form) return;
  event.preventDefault();
  FORMS[form.dataset.form]?.();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.ui.authMode) ACTIONS.closeModal();
});

// ============================================================================ routing + boot

function tabFromHash() {
  const id = location.hash.replace('#', '');
  return TABS.some((t) => t.id === id) ? id : 'overview';
}

window.addEventListener('hashchange', () => {
  const tab = tabFromHash();
  if (tab === state.activeTab) return;
  state.activeTab = tab;
  render();
  window.scrollTo(0, 0);
  loadTab(tab);
});

async function boot() {
  try {
    state.token = localStorage.getItem(TOKEN_KEY);
  } catch {
    state.token = null;
  }
  state.activeTab = tabFromHash();
  render();

  await Promise.all([loadDemoAccounts(), loadHealth(), refreshSession()]);
  if (state.token && !state.user) clearSession();
  state.booting = false;

  // ?persona=rohan deep-links straight into a demo persona.
  const persona = new URLSearchParams(location.search).get('persona');
  const account = persona && state.demo.accounts.find((a) => a.email.split('@')[0] === persona.toLowerCase());
  if (account && state.user?.email !== account.email) {
    await switchPersona(account.email);
  } else {
    await loadTab();
  }
}

boot();
