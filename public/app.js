'use strict';

/*
 * Skyline Student Association ERP: single-page client (no build step, no CDN).
 *
 * One `state` object drives every view. Mutations never patch state locally:
 * they flip a loading flag, call the API, then re-fetch the affected endpoints
 * and re-render, so the screen always shows what SQLite holds. Failures are
 * shown as plain-language toasts, never as raw HTTP status codes.
 */

// ============================================================================ config

const TOKEN_KEY = 'skyline.token';
const THEME_KEY = 'skyline.theme';
const MEMBERSHIP_FEE = 500; // label only: the server charges its own fee
const RENEWAL_WINDOW_DAYS = 30; // label only: the server enforces the window
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CAMPAIGN = 'Spring Bake Sale';
const STAFF_ROLES = new Set(['VOLUNTEER', 'TREASURER', 'ADMIN']);
const FINANCE_ROLES = new Set(['TREASURER', 'ADMIN']);
const SEARCH_DELAY_MS = 220;

const SVG_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const ICONS = {
  overview: `<svg ${SVG_ATTRS}><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="12" r="2.5"/><path d="M14 10h4M14 14h3"/></svg>`,
  events: `<svg ${SVG_ATTRS}><path d="M4 7h16v3a2 2 0 0 0 0 4v3H4v-3a2 2 0 0 0 0-4z"/><path d="M14 7v10" stroke-dasharray="2 2"/></svg>`,
  announcements: `<svg ${SVG_ATTRS}><path d="M3 11v2a1 1 0 0 0 1 1h3l5 4V6L7 10H4a1 1 0 0 0-1 1z"/><path d="M16 8a5 5 0 0 1 0 8"/><path d="M19 5a9 9 0 0 1 0 14"/></svg>`,
  merch: `<svg ${SVG_ATTRS}><path d="M8 3 3 6l2 5 3-1v11h8V10l3 1 2-5-5-3a4 4 0 0 1-8 0z"/></svg>`,
  tasks: `<svg ${SVG_ATTRS}><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16"/><path d="M5.5 8h1.5M11.5 8h1.5M11.5 11h1.5M17.5 8h1.5"/></svg>`,
  finance: `<svg ${SVG_ATTRS}><path d="M4 7a2 2 0 0 1 2-2h12v2"/><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M16 13.5h2"/></svg>`,
  profile: `<svg ${SVG_ATTRS}><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>`,
  menu: `<svg ${SVG_ATTRS}><path d="M4 6h16M4 12h16M4 18h16"/></svg>`,
  sun: `<svg ${SVG_ATTRS}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`,
  moon: `<svg ${SVG_ATTRS}><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>`,
  eye: `<svg ${SVG_ATTRS}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>`,
  eyeOff: `<svg ${SVG_ATTRS}><path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.1 6.1C3.4 7.9 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 4-.9"/></svg>`,
  search: `<svg ${SVG_ATTRS}><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`,
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
  { id: 'profile', label: 'My Profile & Settings', scene: 'Account' },
];

const ROLE_LABEL = { ADMIN: 'Admin', TREASURER: 'Treasurer', VOLUNTEER: 'Volunteer', STUDENT: 'Student' };
const ROLE_TONE = { ADMIN: 'plum', TREASURER: 'amber', VOLUNTEER: 'teal', STUDENT: 'blue' };
const MEMBERSHIP_TONE = { ACTIVE: 'green', EXPIRED: 'red', NONE: 'slate' };
const FULFILLMENT = { PAID_PENDING_PICKUP: ['Awaiting pickup', 'amber'], PICKED_UP: ['Picked up', 'green'] };
const REIMBURSEMENT = { PENDING: ['Pending', 'amber'], APPROVED_PAID: ['Approved & paid', 'green'], REJECTED: ['Rejected', 'red'] };
const TASK_STATUS = { TODO: ['To do', 'slate'], IN_PROGRESS: ['In progress', 'blue'], DONE: ['Done', 'green'] };
// Every column can move a card either way, so a task started by mistake can go back.
const TASK_MOVES = {
  TODO: [['Start Task →', 'IN_PROGRESS', 'primary']],
  IN_PROGRESS: [['← Move to To Do', 'TODO', 'secondary'], ['Mark Done ✓', 'DONE', 'success']],
  DONE: [['← Move to In Progress', 'IN_PROGRESS', 'secondary'], ['↺ Reopen to To Do', 'TODO', 'secondary']],
};
const TASK_TOAST = { TODO: 'Moved to To Do', IN_PROGRESS: 'Task In Progress', DONE: 'Task Completed' };
const ROLES = ['STUDENT', 'VOLUNTEER', 'TREASURER', 'ADMIN'];
const FOUNDING_ADMIN_ID = 1; // label only: the server enforces the hierarchy
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
    users: null,
  };
}

function blankForms() {
  return {
    login: { email: '', password: '' },
    register: { name: '', email: '', password: '', confirm: '' },
    forgotPassword: { email: '', verification: '', new_password: '' },
    forgotEmail: { query: '' },
    profile: { name: '' },
    password: { current: '', next: '', confirm: '' },
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
    roleDraft: {}, // user id -> role picked in the access table
    authView: 'signin', // signin | register | forgot-password | forgot-email
    authError: null,
    showPassword: false,
    quickFillOpen: false,
    recoveredAccount: null,
    navCollapsed: false, // desktop: icon-only sidebar
    navOpen: false, // mobile: slide-out drawer
    theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
  },
  forms: blankForms(),
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

// The Treasurer and the Admin run the books: approvals, income, CSV export.
function isFinance() {
  return Boolean(state.user && FINANCE_ROLES.has(state.user.role));
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

// ============================================================================ API

// raw: true returns a successful response as a Blob (file downloads).
async function api(method, path, body, { raw = false } = {}) {
  const headers = { Accept: raw ? '*/*' : 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = state.token;
  if (token) headers.Authorization = `Bearer ${token}`;

  const started = performance.now();
  let status = 0;
  let data = null;
  let blob = null;
  try {
    const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    status = res.status;
    if (raw && res.ok) {
      blob = await res.blob();
      data = { file: true, bytes: blob.size };
    } else {
      const text = await res.text();
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
    }
  } catch {
    data = { error: 'Could not reach the Skyline server.' };
  }

  const entry = { method, path, ms: Math.round(performance.now() - started) };
  const result = { ok: status >= 200 && status < 300, status, data, blob, entry, sessionExpired: false };
  if (status === 401 && token && token === state.token && !path.startsWith('/api/auth/')) {
    result.sessionExpired = true; // reported once here, not again by the caller
    clearSession();
    toast(result, { title: 'Session Expired', message: 'Please sign in again to continue.' });
    render();
  }
  return result;
}

const WHO = { VOLUNTEER: 'volunteers', TREASURER: 'the Treasurer', ADMIN: 'the Admin', STUDENT: 'students' };

// What the user was trying to do, from the request path (for "Only X can …").
function actionFor({ method, path }) {
  if (path.includes('/review')) return 'approve or reject expense reimbursements';
  if (path.includes('/fundraiser-income')) return 'record fundraiser income';
  if (path.includes('/export.csv')) return 'export the semester books';
  if (path === '/api/events' && method === 'POST') return 'create events';
  if (path.includes('/check-in')) return 'check tickets in at the door';
  if (path.includes('/pickup')) return 'hand over merch orders';
  if (path.startsWith('/api/announcements')) return 'post announcements';
  if (path.startsWith('/api/tasks') && method === 'DELETE') return 'delete fundraiser tasks';
  if (path.startsWith('/api/tasks')) return 'manage fundraiser tasks';
  if (path.startsWith('/api/users')) return 'manage club access and roles';
  if (path.startsWith('/api/finance/reimbursements')) return 'submit expense claims';
  if (path.startsWith('/api/finance/ledger')) return 'view the club ledger';
  if (path.startsWith('/api/memberships/lookup')) return 'look up members';
  if (path.startsWith('/api/system')) return 'view database diagnostics';
  return 'do this';
}

function joinWords(words) {
  return words.length > 1 ? `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}` : words[0];
}

// Server conflicts (409) as a human title and sentence.
function friendlyConflict(error, d) {
  if (/not yet due for renewal/.test(error)) {
    return { title: 'Already Renewed', message: `Your membership is active until ${fmtDate(d.expires_at)}. Renewal opens on ${fmtDate(d.renewal_opens_at)}.` };
  }
  if (/sold out/i.test(error)) return { title: 'Sold Out', message: 'Every seat for this event has been taken.' };
  if (/assign a volunteer or member/.test(error)) {
    return { title: 'Assign Someone First', message: 'Pick a volunteer or member in the task’s “Assigned to” menu, then start or finish it.' };
  }
  if (/already hold a ticket/.test(error)) return { title: 'Already Booked', message: `You already have ticket ${d.ticket_code} for this event.` };
  if (/already taken place/.test(error)) return { title: 'Event Has Ended', message: 'Tickets can only be bought for upcoming events.' };
  if (/already checked in/i.test(error)) {
    return { title: 'Already Checked In', message: `This ticket was used at ${fmtTime(d.checked_in_at)}${d.attendee?.name ? ` by ${d.attendee.name}` : ''}. Do not admit twice.` };
  }
  if (/out of stock|left in size/i.test(error)) return { title: 'Not Enough Stock', message: `${error}.` };
  if (/already picked up/i.test(error)) {
    return { title: 'Already Picked Up', message: `This order was handed over${d.picked_up_by ? ` by ${d.picked_up_by}` : ''}${d.picked_up_at ? ` on ${fmtDateTime(d.picked_up_at)}` : ''}.` };
  }
  const reviewed = /Reimbursement already (\w+)/.exec(error);
  if (reviewed) {
    const [label] = REIMBURSEMENT[reviewed[1]] || [reviewed[1]];
    return { title: 'Already Reviewed', message: `This claim is already ${label.toLowerCase()}${d.approved_by_name ? ` (by ${d.approved_by_name})` : ''}.` };
  }
  if (/Receipt .* already submitted/.test(error)) return { title: 'Duplicate Receipt', message: `${error}.` };
  if (/already recorded/.test(error)) return { title: 'Already Recorded', message: `${error}.` };
  if (/email already exists/.test(error)) return { title: 'Email Already Registered', message: 'Sign in instead, or use “Forgot password?” to reset it.' };
  return { title: 'Already Done', message: error || 'Someone else changed this first. The page has been refreshed.' };
}

// Any failed response as { title, message } in plain language, never a status code.
function friendlyError(result) {
  const d = result.data && typeof result.data === 'object' ? result.data : {};
  const error = d.error || (typeof result.data === 'string' ? result.data : '');
  const path = result.entry?.path || '';
  switch (result.status) {
    case 0: return { title: 'Connection Problem', message: 'Could not reach the Skyline server. Check that it is running.' };
    case 400: return { title: 'Please Check the Details', message: d.details ? Object.values(d.details).join(' · ') : error || 'Some information is missing or invalid.' };
    case 401: return path.startsWith('/api/auth/')
      ? { title: 'Sign-In Failed', message: error && error !== 'Unauthorized' ? error : 'Please check your details and try again.' }
      : { title: 'Please Sign In', message: 'Your session has ended. Please sign in again.' };
    case 403: {
      if (/own reimbursement/.test(d.reason)) return { title: 'Separation of Duties', message: 'You can’t approve your own expense claim — another Treasurer or Admin must review it.' };
      if (/assigned to them/.test(d.reason)) return { title: 'Action Not Allowed', message: 'Students can only move tasks that are assigned to them.' };
      if (/reassign/.test(d.reason)) return { title: 'Action Not Allowed', message: 'Only volunteers, the Treasurer or the Admin can reassign tasks.' };
      if (/Founding Admin|own role/.test(d.reason || '')) return { title: 'Access Change Not Allowed', message: /[.!]$/.test(d.reason) ? d.reason : `${d.reason}.` };
      const roles = /requires role: (.+)$/.exec(d.reason || '');
      if (roles) {
        const who = joinWords(roles[1].split(' or ').map((r) => WHO[r] || r));
        return { title: 'Action Not Allowed', message: `Only ${who} can ${actionFor(result.entry)}.` };
      }
      return { title: 'Action Not Allowed', message: error || 'You don’t have permission to do that.' };
    }
    case 404: return { title: 'Not Found', message: error || 'That item no longer exists.' };
    case 409: return friendlyConflict(error, d);
    case 413: return { title: 'Too Much Data', message: 'That request was too large to send.' };
    default: return { title: 'Something Went Wrong', message: error || 'Please try again in a moment.' };
  }
}

function errorText(result) {
  return friendlyError(result).message;
}

function toastIfError(result) {
  if (!result.ok && !result.sessionExpired) toast(result);
}

// Every write goes through here: one in-flight mutation at a time, a labelled
// spinner on the clicked button, then an authoritative re-fetch, never a local
// guess. A 409 also re-fetches, because it means the data changed under us.
async function mutate(key, method, path, body, { success, refresh, onSuccess, onError, raw = false } = {}) {
  if (state.isLoading) return null;
  state.isLoading = true;
  state.pendingAction = key;
  render();

  const res = await api(method, path, body, { raw });
  try {
    if (res.ok) {
      onSuccess?.(res.data, res);
      toast(res, typeof success === 'function' ? success(res.data) : success || 'Saved.');
      await (refresh ? refresh() : reloadActiveTab());
    } else {
      onError?.(res);
      if (!res.sessionExpired) toast(res);
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

// content: a message string, or { title, message }. Failures without content
// are described by friendlyError(). No HTTP status codes are ever shown.
function toast(result, content) {
  let note;
  if (content && typeof content === 'object') note = content;
  else if (result.ok) note = { title: 'Done', message: content || 'All set.' };
  else note = content ? { title: friendlyError(result).title, message: content } : friendlyError(result);
  pushToast({ kind: result.ok ? 'ok' : 'err', ...note }, result.ok ? 5000 : 8000);
}

function infoToast(message, title = 'Done') {
  pushToast({ kind: 'info', title, message }, 4000);
}

function pushToast(note, ms) {
  const id = ++toastSeq;
  state.toasts.push({ id, ...note });
  if (state.toasts.length > 4) state.toasts.shift();
  renderToasts();
  setTimeout(() => dismissToast(id), ms);
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
  if (!state.user) return;
  const params = new URLSearchParams();
  if (state.ui.ledgerType) params.set('type', state.ui.ledgerType);
  if (state.ui.ledgerCategory) params.set('category', state.ui.ledgerCategory);
  const query = params.toString();
  const res = await api('GET', `/api/finance/ledger${query ? `?${query}` : ''}`);
  if (res.ok) state.data.ledger = res.data;
  else toastIfError(res);
}

async function loadUsers() {
  if (!isAdmin()) return;
  const res = await api('GET', '/api/users');
  if (!res.ok) return toastIfError(res);
  state.data.users = res.data;
  state.ui.roleDraft = Object.fromEntries(res.data.users.map((u) => [u.id, u.role]));
}

const LOADERS = {
  overview: () => Promise.all([loadEvents(), loadMerchItems(), loadLookup(), loadUsers()]),
  events: async () => {
    await loadEvents();
    await loadDesk();
  },
  announcements: () => loadAnnouncements(),
  merch: () => Promise.all([loadMerchItems(), loadOrders()]),
  tasks: () => Promise.all([loadTasks(), loadAssignees()]),
  finance: () => Promise.all([loadReimbursements(), loadLedger()]),
  profile: async () => {
    await refreshSession();
    if (state.user) state.forms.profile.name = state.user.name;
  },
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

// Shared by Sign In, Register and Forgot Password: all three return { token, user }.
function startSession(d) {
  setSession(d.token, d.user);
  state.data = blankData();
  state.ui.authError = null;
  state.ui.recoveredAccount = null;
  state.ui.showPassword = false;
  state.forms = blankForms();
  if (state.activeTab === 'profile' || !location.hash) state.activeTab = 'overview';
  history.replaceState(null, '', '#' + state.activeTab);
}

async function signIn(key, email, password) {
  return mutate(key, 'POST', '/api/auth/login', { email, password }, {
    onSuccess: startSession,
    onError: (res) => {
      state.ui.authError = errorText(res);
    },
    success: (d) => ({ title: `Welcome back, ${firstName(d.user.name)}`, message: `Signed in as ${roleLabel(d.user.role)}.` }),
    refresh: () => LOADERS[state.activeTab]?.(),
  });
}

function joinOrRenew() {
  return mutate('joinOrRenew', 'POST', '/api/memberships/join-or-renew', undefined, {
    success: (d) => (d.action === 'JOINED'
      ? { title: 'Welcome to Skyline!', message: `Your member code is ${d.user.membership.code}. Paid ${inr(d.fee)}.` }
      : { title: 'Membership Renewed', message: `Active until ${fmtDate(d.user.membership.expires_at)}. Paid ${inr(d.fee)}.` }),
    refresh: async () => {
      await refreshSession();
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
        title: res.status === 409 ? 'Already checked in: do not admit twice' : friendlyError(res).title,
        detail: `${code} · ${errorText(res)}`,
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
  const el = `<input id="${id || modelId(model)}" class="input ${cls}" type="${type}" data-model="${model}" value="${esc(getPath(model))}" placeholder="${esc(placeholder)}" ${attrs}>`;
  return /\binput-search\b/.test(cls) ? `<div class="search-field"><span class="search-icon" aria-hidden="true">${ICONS.search}</span>${el}</div>` : el;
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
  const u = state.user;
  return `
    ${pageHead('Scene 1 · Membership lifecycle', `Welcome back, ${esc(firstName(u.name))}`, `${roleLabel(u.role)} · ${esc(u.email)}`)}
    ${membershipBanner(u.membership)}
    <div class="grid grid-2">
      <div class="stack">${membershipCard(u)}</div>
      ${benefitsCard()}
    </div>
    <div class="mt-16">${isStaff() ? lookupPanel() : lockedPanel('Door Member Lookup', 'Club staff (volunteers, the Treasurer and the Admin) use this at the door to verify a member in under a second.')}</div>
    ${isAdmin() ? `<div class="mt-16">${accessPanel()}</div>` : ''}`;
}

function accessRoleBadge(u) {
  return u.is_founding_admin ? badge('👑 Founding Admin', 'plum') : badge(roleLabel(u.role), ROLE_TONE[u.role]);
}

// Club Access & Role Management (admins). The server is the authority; this
// table only hides choices it would refuse: a second admin can't grant or
// change Admin, nobody edits the Founding Admin, and nobody edits themselves.
function accessPanel() {
  const data = state.data.users;
  if (!data) return `<section class="card"><div class="card-body">${loadingBlock('Loading club members…')}</div></section>`;
  const founder = data.viewer.is_founding_admin;
  const rows = data.users.map((u) => {
    let control;
    if (u.is_founding_admin) control = '<span class="small muted">🔒 Protected · the Founding Admin’s role never changes</span>';
    else if (u.id === state.user.id) control = '<span class="small muted">This is you · ask the Founding Admin to change your role</span>';
    else if (u.role === 'ADMIN' && !founder) control = '<span class="small muted">🔒 Only the Founding Admin can change an Admin</span>';
    else {
      const draft = state.ui.roleDraft[u.id] || u.role;
      const options = ROLES.map((r) => {
        const locked = r === 'ADMIN' && !founder;
        return `<option value="${r}"${r === draft ? ' selected' : ''}${locked ? ' disabled' : ''}>${roleLabel(r)}${locked ? ' (Founding Admin only)' : ''}</option>`;
      }).join('');
      control = `<div class="access-control">
          <select id="role-${u.id}" class="select select-sm" data-model="ui.roleDraft.${u.id}" data-rerender="1" aria-label="New role for ${esc(u.name)}"${state.isLoading ? ' disabled' : ''}>${options}</select>
          ${btn('Update Access', 'updateRole', { data: { id: u.id }, size: 'sm', disabled: draft === u.role, title: draft === u.role ? 'Pick a different role first' : `Make ${u.name} ${roleLabel(draft)}` })}
        </div>`;
    }
    return `<tr>
        <td><div class="person">${avatar(u.name, u.role)}<div><b>${esc(u.name)}</b>${u.id === state.user.id ? ' <span class="small muted">(you)</span>' : ''}<div class="small muted">${esc(u.email)}</div></div></div></td>
        <td>${u.membership_code ? codeChip(u.membership_code) : '<span class="muted">—</span>'}</td>
        <td>${membershipBadge(u.membership_status)}</td>
        <td>${accessRoleBadge(u)}</td>
        <td>${control}</td>
      </tr>`;
  }).join('');
  const note = founder
    ? 'As the Founding Admin you can grant any role, including Admin. Changes apply on the member’s very next click; no sign-out needed.'
    : 'You can move members between Student, Volunteer and Treasurer. Only the Founding Admin can grant or change Admin access.';
  return `<section class="card">
    <div class="card-head"><h2>🛡️ Club Access & Role Management ${badge('Admin', 'plum')}</h2><span class="sub">${plural(data.count, 'member')} · PATCH /api/users/:id/role</span></div>
    <div class="card-body"><div class="note note-plum">${note}</div></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Member</th><th>Code</th><th>Membership</th><th>Current role</th><th>Change access</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </section>`;
}

// ============================================================================ view: sign-in page (logged out)

// Light/Dark pill: a sliding knob over the sun and moon, plus the current mode.
function themeToggle(extraClass = '') {
  const dark = state.ui.theme === 'dark';
  return `<button type="button" class="theme-pill${dark ? ' is-dark' : ''} ${extraClass}" data-action="toggleTheme" title="Switch to ${dark ? 'light' : 'dark'} mode" aria-label="Switch to ${dark ? 'light' : 'dark'} mode" aria-pressed="${dark}">
      <span class="tp-track"><span class="tp-knob"></span><span class="tp-ico tp-sun">${ICONS.sun}</span><span class="tp-ico tp-moon">${ICONS.moon}</span></span>
      <span class="tp-label">${dark ? 'Dark' : 'Light'}</span>
    </button>`;
}

// The Skyline emblem: campus spires under a rising arc and star on a gradient
// badge. Each copy needs its own gradient ids: a copy inside a hidden element
// (the topbar while signed out) can't lend its gradients to another one.
function brandLogo(id) {
  return `<svg class="brand-logo" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id="${id}-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a0729a"/><stop offset="0.5" stop-color="#5b3f8c"/><stop offset="1" stop-color="#312e81"/></linearGradient>
      <radialGradient id="${id}-glow" cx="0.5" cy="0.28" r="0.62"><stop offset="0" stop-color="#fff" stop-opacity="0.42"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
      <linearGradient id="${id}-gold" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fef3c7"/><stop offset="0.5" stop-color="#fbbf24"/><stop offset="1" stop-color="#f59e0b"/></linearGradient>
      <linearGradient id="${id}-city" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#c7d2fe"/></linearGradient>
    </defs>
    <rect x="1.5" y="1.5" width="45" height="45" rx="13" fill="url(#${id}-bg)"/>
    <rect x="1.5" y="1.5" width="45" height="45" rx="13" fill="url(#${id}-glow)"/>
    <rect x="2.25" y="2.25" width="43.5" height="43.5" rx="12.25" fill="none" stroke="#fff" stroke-opacity="0.3" stroke-width="1.2"/>
    <path d="M10.5 29a13.5 13.5 0 0 1 27 0" fill="none" stroke="url(#${id}-gold)" stroke-width="2.2" stroke-linecap="round"/>
    <path d="M24 10.6l1.3 3.1 3.1 1.3-3.1 1.3L24 19.4l-1.3-3.1-3.1-1.3 3.1-1.3z" fill="url(#${id}-gold)"/>
    <g fill="url(#${id}-city)">
      <path d="M11.5 37.5V30.5h4.4v7z"/>
      <path d="M16.8 37.5V25.6l2.3-1.9 2.3 1.9v11.9z"/>
      <path d="M22.2 37.5V23.2l1.8-3 1.8 3v14.3z"/>
      <path d="M26.6 37.5V26.2h4.6v11.3z"/>
      <path d="M32.1 37.5V31.2h4.4v6.3z"/>
    </g>
    <g fill="#4c3a8a" fill-opacity="0.55">
      <rect x="13" y="32.4" width="1.4" height="1.6" rx="0.3"/><rect x="18.4" y="27.6" width="1.4" height="1.6" rx="0.3"/><rect x="18.4" y="31.2" width="1.4" height="1.6" rx="0.3"/>
      <rect x="23.3" y="26" width="1.4" height="1.8" rx="0.3"/><rect x="23.3" y="30" width="1.4" height="1.8" rx="0.3"/>
      <rect x="28.2" y="28.4" width="1.4" height="1.6" rx="0.3"/><rect x="28.2" y="32" width="1.4" height="1.6" rx="0.3"/><rect x="33.6" y="33.2" width="1.4" height="1.6" rx="0.3"/>
    </g>
    <rect x="9.5" y="37.4" width="29" height="1.9" rx="0.95" fill="#fff" fill-opacity="0.9"/>
  </svg>`;
}

function passwordInput(model, { autocomplete = 'current-password', placeholder = '' } = {}) {
  const shown = state.ui.showPassword;
  return `<div class="password-field">
      ${input(model, { type: shown ? 'text' : 'password', placeholder, attrs: `autocomplete="${autocomplete}" required` })}
      <button type="button" class="reveal" data-action="togglePassword" aria-label="${shown ? 'Hide' : 'Show'} password" title="${shown ? 'Hide' : 'Show'} password">${shown ? ICONS.eyeOff : ICONS.eye}</button>
    </div>`;
}

function authLink(view, label) {
  return `<button type="button" class="link-btn" data-action="authView" data-view="${view}">${label}</button>`;
}

function quickFillCard() {
  const { accounts, password } = state.demo;
  if (!accounts.length) return '';
  const open = state.ui.quickFillOpen;
  const rows = accounts.map((a) => `<button type="button" class="qf-row" data-action="quickFill" data-email="${esc(a.email)}">
      ${avatar(a.name, a.role)}
      <span class="qf-text"><b>${esc(a.name)}</b><small>${esc(a.email)}</small></span>
      ${badge(roleLabel(a.role), ROLE_TONE[a.role])}
    </button>`).join('');
  return `<div class="quickfill${open ? ' open' : ''}">
      <button type="button" class="qf-head" data-action="toggleQuickFill" aria-expanded="${open}">
        <span>🔑 Quick Fill Credentials</span><span class="small">${open ? 'Hide ▲' : `${accounts.length} demo accounts ▼`}</span>
      </button>
      ${open ? `<div class="qf-body"><p class="small">Click an account to fill the sign-in form. Password for all: <code>${esc(password)}</code></p>${rows}</div>` : ''}
    </div>`;
}

function authForm() {
  const view = state.ui.authView;
  const error = state.ui.authError ? `<div class="note note-amber">${esc(state.ui.authError)}</div>` : '';
  if (view === 'register') {
    return `<form class="form" data-form="register">
        <div><h2>Create your student account</h2><p class="muted">New accounts start as students without a membership. You can join the club from your dashboard.</p></div>
        ${field('Full name', input('forms.register.name', { placeholder: 'e.g. Ananya Patel', attrs: 'autocomplete="name" required' }), { forId: 'forms-register-name' })}
        ${field('College email', input('forms.register.email', { type: 'email', placeholder: 'you@skyline.edu', attrs: 'autocomplete="email" required' }), { forId: 'forms-register-email' })}
        ${field('Password (8+ characters)', passwordInput('forms.register.password', { autocomplete: 'new-password' }), { forId: 'forms-register-password' })}
        ${field('Confirm password', passwordInput('forms.register.confirm', { autocomplete: 'new-password' }), { forId: 'forms-register-confirm' })}
        ${error}
        ${submitBtn('register', 'Create Student Account', { block: true })}
        <p class="small muted center">Already a member? ${authLink('signin', 'Sign in')}</p>
      </form>`;
  }
  if (view === 'forgot-password') {
    return `<form class="form" data-form="forgotPassword">
        <div>${authLink('signin', '← Back to sign in')}<h2 class="mt-8">Reset your password</h2><p class="muted">Confirm it's you with your membership code or your full name, then choose a new password.</p></div>
        ${field('Account email', input('forms.forgotPassword.email', { type: 'email', placeholder: 'you@skyline.edu', attrs: 'autocomplete="username" required' }), { forId: 'forms-forgotPassword-email' })}
        ${field('Membership code or full name', input('forms.forgotPassword.verification', { placeholder: 'SKY-2026-XXX or your full name', attrs: 'required' }), { forId: 'forms-forgotPassword-verification' })}
        ${field('New password (6+ characters)', passwordInput('forms.forgotPassword.new_password', { autocomplete: 'new-password' }), { forId: 'forms-forgotPassword-new_password' })}
        ${error}
        ${submitBtn('forgotPassword', 'Reset Password & Sign In', { block: true })}
        <p class="small muted center">Don't remember your email? ${authLink('forgot-email', 'Find your account')}</p>
      </form>`;
  }
  if (view === 'forgot-email') {
    const found = state.ui.recoveredAccount;
    return `<form class="form" data-form="forgotEmail">
        <div>${authLink('signin', '← Back to sign in')}<h2 class="mt-8">Find your account</h2><p class="muted">Enter your full name or your membership ID to see the email you registered with.</p></div>
        ${field('Full name or membership ID', input('forms.forgotEmail.query', { placeholder: 'e.g. Rohan Verma or SKY-2026-004', attrs: 'required' }), { forId: 'forms-forgotEmail-query' })}
        ${error}
        ${submitBtn('forgotEmail', 'Find My Account', { block: true })}
        ${found ? `<div class="found-account">
            ${avatar(found.name, found.role)}
            <div><b>${esc(found.name)}</b><div class="mono">${esc(found.email)}</div><div class="row mt-8">${badge(roleLabel(found.role), ROLE_TONE[found.role])}${found.membership_code ? codeChip(found.membership_code) : ''}</div></div>
            <button type="button" class="btn btn-primary btn-block mt-8" data-action="useRecoveredEmail">Use this email to Sign In</button>
          </div>` : ''}
      </form>`;
  }
  return `<form class="form" data-form="login">
      <div><h2>Sign in to Skyline</h2><p class="muted">Welcome back! Use your college email and password.</p></div>
      ${field('Email', input('forms.login.email', { type: 'email', placeholder: 'you@skyline.edu', attrs: 'autocomplete="username" required' }), { forId: 'forms-login-email' })}
      <div class="field">
        <div class="row-between"><label for="forms-login-password">Password</label>${authLink('forgot-password', 'Forgot password?')}</div>
        ${passwordInput('forms.login.password')}
      </div>
      ${error}
      ${submitBtn('login', 'Sign In', { block: true })}
      <p class="small muted center">${authLink('forgot-email', 'Forgot email?')} · New here? ${authLink('register', 'Create a student account')}</p>
    </form>`;
}

function viewAuth() {
  const view = state.ui.authView;
  const tabs = view === 'signin' || view === 'register'
    ? `<div class="auth-tabs" role="tablist">
        <button type="button" role="tab" class="${view === 'signin' ? 'active' : ''}" data-action="authView" data-view="signin" aria-selected="${view === 'signin'}">Sign In</button>
        <button type="button" role="tab" class="${view === 'register' ? 'active' : ''}" data-action="authView" data-view="register" aria-selected="${view === 'register'}">Create Account</button>
      </div>`
    : '';
  const highlight = (icon, title, text) => `<li><span class="hl-icon" aria-hidden="true">${icon}</span><div><b>${title}</b><span>${text}</span></div></li>`;
  return `<div class="auth-page">
      <section class="auth-brand">
        <div class="auth-logo"><span class="brand-mark brand-emblem" aria-hidden="true">${brandLogo('hero-logo')}</span>
          <span><b>Skyline</b><small>Student Association ERP</small></span></div>
        <h1>Run the whole club from one place.</h1>
        <p class="lead">Memberships, Spring Gala tickets and door check-in, announcements, merch, the bake-sale planner and the treasurer's books, in one secure system.</p>
        <ul class="auth-highlights">
          ${highlight('🎟️', 'Member pricing, done right', 'Members pay less for events and merch, decided securely on the server.')}
          ${highlight('🚪', 'Instant door check-in', 'Volunteers scan a ticket code; a second scan is always refused.')}
          ${highlight('🧾', 'Honest books', 'Every rupee in and out is recorded, and only the Treasurer or Admin approves payouts.')}
          ${highlight('🧁', 'Fundraisers on track', 'A live task board shows the bake sale’s progress at a glance.')}
        </ul>
        ${quickFillCard()}
      </section>
      <section class="auth-panel">
        <div class="auth-top">${themeToggle()}</div>
        <div class="auth-card">${tabs}${authForm()}</div>
        <p class="small muted center">Odoo × LDCE Hackathon 2026 · Skyline Student Association</p>
      </section>
    </div>`;
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
    <div class="card-head"><h2>🚪 Door Member Lookup ${badge('Staff', 'teal')}</h2><span class="sub">GET /api/memberships/lookup</span></div>
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
      <h2>🛂 Door Ticket Scanner & Check-In Desk ${badge('Staff', 'teal')}</h2>
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
  const head = pageHead('Scene 3 · Announcements', 'Club Announcements',
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
    <div class="card-head"><h2>📰 Club Announcements Feed <span class="sub">${plural(data.count, 'post')}</span></h2><span class="sub">${viewerLine}</span></div>
    ${list}
  </section>`;

  return `${head}${hiddenBanner}<div class="stack">${filters}${isStaff() ? `<div class="split">${listCard}${postForm()}</div>` : listCard}</div>`;
}

function postForm() {
  const f = state.forms.announcement;
  const audience = ['ALL', 'MEMBERS_ONLY'].map((value) => `<label><input type="radio" name="audience" value="${value}" data-model="forms.announcement.target_audience"${f.target_audience === value ? ' checked' : ''}>${value === 'ALL' ? 'Everyone' : '🔒 Members only'}</label>`).join('');
  const last = state.ui.lastBroadcast;
  return `<section class="card">
    <div class="card-head"><h2>📣 Post Official Announcement</h2>${badge('Staff', 'teal')}</div>
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
    <div class="card-head"><h2>📦 Desk Pickup Queue ${badge('Staff', 'teal')}</h2><span class="sub">PATCH /api/merch/orders/:code/pickup records who handed it over and when</span></div>
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

// Staff assign or reassign right on the card; everyone else sees the name.
function assigneePicker(t) {
  const people = state.data.assignees || [];
  const options = people.map((u) => `<option value="${u.id}"${u.id === t.assigned_to ? ' selected' : ''}>${esc(u.name)} · ${roleLabel(u.role)}</option>`).join('');
  return `<label class="assign-row${t.assigned_to ? '' : ' unassigned'}">
      ${t.assigned_to ? avatar(t.assignee_name, t.assignee_role) : '<span class="avatar avatar-none" aria-hidden="true">?</span>'}
      <select class="select select-sm" data-assign-task="${t.id}" aria-label="Assigned to: ${esc(t.title)}"${state.isLoading ? ' disabled' : ''}>
        <option value=""${t.assigned_to ? '' : ' selected'}>Unassigned: pick someone</option>${options}
      </select>
    </label>`;
}

function taskCard(t) {
  const mine = t.assigned_to === state.user.id;
  const canMove = isStaff() || mine;
  const assignee = t.assigned_to
    ? `<span class="assignee">${avatar(t.assignee_name, t.assignee_role)}${esc(t.assignee_name)}${mine ? ' (you)' : ''}</span>`
    : '<span class="assignee unassigned">Unassigned</span>';
  const picker = isStaff() && state.data.assignees ? assigneePicker(t) : '';
  const hint = !t.assigned_to && t.status === 'TODO'
    ? `<div class="task-hint">${isStaff() ? 'Assign someone above before starting this task.' : 'Waiting for a volunteer to be assigned.'}</div>`
    : '';
  const due = t.due_date
    ? `<span class="due${t.is_overdue ? ' overdue' : ''}">${t.is_overdue ? '⚠ Overdue · ' : 'Due '}${fmtDay(t.due_date)}</span>`
    : '<span class="due">No due date</span>';
  const actions = TASK_MOVES[t.status].map(([label, next, variant]) => (canMove
    ? btn(label, 'taskStatus', { data: { id: t.id, status: next }, variant, size: 'sm' })
    : btn(`🔒 ${label}`, 'taskStatus', {
      data: { id: t.id, status: next },
      variant: 'locked',
      size: 'sm',
      title: 'Only the assignee or a staff member can move this task. Click to watch the server refuse it.',
    }))).join('');

  const remove = isAdmin()
    ? btn('🗑 Delete', 'deleteTask', { data: { id: t.id, title: t.title }, variant: 'danger', size: 'sm', title: 'Admin only: permanently remove this task' })
    : '';

  return `<div class="task${t.is_overdue ? ' overdue' : ''}${t.status === 'DONE' ? ' done' : ''}">
    <div class="task-title">${esc(t.title)}</div>
    ${picker}
    <div class="task-meta">${picker ? '' : assignee}${due}</div>
    ${hint}
    <div class="task-actions">${actions}${remove ? `<span class="task-actions-end">${remove}</span>` : ''}</div>
  </div>`;
}

function addTaskForm(campaigns) {
  const people = [['', 'Unassigned'], ...(state.data.assignees || []).map((u) => [u.id, `${u.name} (${roleLabel(u.role)})`])];
  return `<section class="card">
    <div class="card-head"><h2>➕ Add Task ${badge('Staff', 'teal')}</h2><span class="sub">POST /api/tasks · new tasks start in To do</span></div>
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
    'Everyone in the club can see where the money went. Only the Treasurer or Admin can approve a payout, and the payout and its ledger row commit together or not at all.');
  if (!state.user) return head + signInPrompt('see reimbursements and the club books');
  return `${head}<div class="stack">
    ${glancePanel()}
    ${reimbursementsSection()}
    ${ledgerSection()}
  </div>`;
}

const MERCH_AND_FUNDRAISERS = 'MERCH_SALE,FUNDRAISER_INCOME';

// Scene 6 at a glance: the treasurer's four questions (dues, tickets, merch and
// fundraisers, reimbursed expenses) and In − Out = Left, from semester_story.
function glancePanel() {
  const L = state.data.ledger;
  if (!L) return `<section class="card"><div class="card-body">${loadingBlock('Adding up the semester…')}</div></section>`;
  const g = L.semester_story;
  const sources = [
    ['Dues', g.dues_collected.amount, 'plum'],
    ['Tickets', g.tickets_sold.amount, 'blue'],
    ['Merch', g.merch_sold.amount, 'teal'],
    ['Fundraisers', g.fundraiser_income.amount, 'amber'],
  ];
  const share = (amount, whole) => (whole ? (amount / whole) * 100 : 0);
  const sourceBar = sources.filter(([, amount]) => amount > 0)
    .map(([label, amount, tone]) => `<span class="seg tone-${tone}" style="width:${share(amount, g.came_in).toFixed(2)}%" title="${label}: ${inr(amount)}"></span>`).join('');
  const legend = sources.map(([label, amount, tone]) => `<span class="legend"><i class="dot tone-${tone}"></i>${label} ${inr(amount)}</span>`).join('');
  const spent = Math.min(100, share(g.went_out, g.came_in));

  const card = (icon, title, amount, sub, filter, tone, out = false) => {
    const active = state.ui.ledgerCategory === filter && !state.ui.ledgerType;
    return `<div class="glance-card tone-${tone}${active ? ' active' : ''}">
        <div class="gc-head"><span class="gc-icon" aria-hidden="true">${icon}</span><span class="gc-title">${title}</span></div>
        <div class="gc-amount ${out ? 'amount-out' : 'amount-in'}">${out ? signedInr(-amount) : inr(amount)}</div>
        <div class="gc-sub">${sub}</div>
        ${btn(active ? '✓ Showing these rows · show all' : 'Filter ledger rows →', 'ledgerFocus', { data: { category: filter }, variant: 'ghost', size: 'sm', mutation: false })}
      </div>`;
  };
  const e = g.expenses_reimbursed;
  const fundraising = g.merch_sold.amount + g.fundraiser_income.amount;
  return `<section class="card glance">
    <div class="card-head"><h2>📖 Semester Money At-a-Glance: What Came In, What Went Out &amp; What's Left</h2><span class="sub">live from the ledger · ${fmtDateTime(L.generated_at)}</span></div>
    <div class="card-body stack">
      <div class="glance-eq" role="group" aria-label="Money in minus money out equals balance">
        <div class="eq-term in"><span class="eq-label">💰 What Came In</span><b class="eq-value">${inr(g.came_in)}</b></div>
        <span class="eq-op" aria-hidden="true">−</span>
        <div class="eq-term out"><span class="eq-label">🧾 What Went Out</span><b class="eq-value">${inr(g.went_out)}</b></div>
        <span class="eq-op" aria-hidden="true">=</span>
        <div class="eq-term left"><span class="eq-label">🏦 How Much Is Left</span><b class="eq-value">${inr(g.left)}</b></div>
      </div>
      <div class="glance-bars">
        <div class="bar-caption"><b>Where the money came from</b><span class="legends">${legend}</span></div>
        <div class="stack-bar" aria-hidden="true">${sourceBar}</div>
        <div class="bar-caption"><b>What happened to it</b><span>${spent.toFixed(0)}% paid out to volunteers · ${(100 - spent).toFixed(0)}% still in the club account</span></div>
        <div class="stack-bar" aria-hidden="true"><span class="seg tone-red" style="width:${spent.toFixed(2)}%"></span><span class="seg tone-green" style="width:${(100 - spent).toFixed(2)}%"></span></div>
      </div>
      <div class="glance-cards">
        ${card('🪪', 'Dues Collected', g.dues_collected.amount, `${plural(g.dues_collected.count, 'membership payment')} from members joining or renewing`, 'MEMBERSHIP_DUES', 'plum')}
        ${card('🎟️', 'Tickets Sold', g.tickets_sold.amount, `${plural(g.tickets_sold.count, 'ticket')} sold for the Spring Gala and club events`, 'TICKET_SALE', 'blue')}
        ${card('👕', 'Merchandise & Fundraisers', fundraising, `${inr(g.merch_sold.amount)} from ${plural(g.merch_sold.count, 'merch order')} · ${inr(g.fundraiser_income.amount)} from ${plural(g.fundraiser_income.count, 'bake-sale collection')}`, MERCH_AND_FUNDRAISERS, 'teal')}
        ${card('🧾', 'Volunteer Expenses Reimbursed', e.amount, `${plural(e.count, 'approved receipt')} paid back${e.pending_count ? ` · ${plural(e.pending_count, 'claim')} (${inr(e.pending_amount)}) awaiting review` : ' · no claims waiting'}`, 'EXPENSE_REIMBURSEMENT', 'red', true)}
      </div>
    </div>
  </section>`;
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
    return `${table}<div class="note mt-8">Only staff (volunteers, the Treasurer and the Admin) can submit expense claims for club purchases.</div>`;
  }
  return `${table}${expenseForm()}`;
}

function reimbursementRow(r) {
  const [label, tone] = REIMBURSEMENT[r.status];
  const category = EXPENSE_CATEGORIES.find(([value]) => value === r.category)?.[1] || r.category;
  let action = '<span class="small muted">—</span>';
  if (r.status === 'PENDING') {
    if (isFinance() && r.volunteer_id === state.user.id) {
      action = `<div class="note note-amber small" style="max-width:240px"><b>Separation of duties:</b> you submitted this claim, so another Treasurer or Admin must review it.</div>
        <div class="mt-8">${btn('🔒 Approve anyway', 'review', { data: { id: r.id, decision: 'APPROVED_PAID' }, variant: 'locked', size: 'sm', title: 'The server refuses to let anyone approve their own claim.' })}</div>`;
    } else if (isFinance()) {
      action = `<div class="row">${btn('Approve & Reimburse', 'review', { data: { id: r.id, decision: 'APPROVED_PAID' }, variant: 'success', size: 'sm' })}${btn('Reject', 'review', { data: { id: r.id, decision: 'REJECTED' }, variant: 'danger', size: 'sm' })}</div>`;
    } else if (isStaff()) {
      action = `<div class="small muted">Awaiting the treasurer</div><div class="mt-8">${btn('🔒 Approve', 'review', { data: { id: r.id, decision: 'APPROVED_PAID' }, variant: 'locked', size: 'sm', title: 'Only the Treasurer or Admin can approve. Click to see the server refuse it.' })}</div>`;
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
    <div class="card-head"><h2>➕ Submit Expense Receipt ${badge('Staff', 'teal')}</h2><span class="sub">Nothing is written to the ledger yet: money leaves the club only when the Treasurer or Admin approves the claim</span></div>
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
  const categoryOptions = [['', 'All categories'], ...LEDGER_CATEGORIES.map((c) => [c, LEDGER_LABEL[c]]), [MERCH_AND_FUNDRAISERS, 'Merch + fundraisers']];
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
    <div class="row-between">
      <div class="integrity">
        <span class="${balanced ? 'ok' : 'bad'}">${balanced ? '✓' : '✗'} In − Out = Net (${inr(s.total_in)} − ${inr(s.total_out)} = ${inr(s.net_balance)})</span>
        <span class="${categoriesMatch ? 'ok' : 'bad'}">${categoriesMatch ? '✓' : '✗'} Categories add up to the totals</span>
      </div>
      ${isFinance() ? btn('⬇ Export Semester Books (CSV)', 'exportLedger', { title: 'Download the full ledger with totals as a CSV file' }) : ''}
    </div>
    <div class="${isFinance() ? 'split' : ''}">
      <section class="card">
        <div class="card-head"><h2>📊 Where every rupee came from and went</h2><span class="sub">all 5 ledger categories</span></div>
        <div class="card-body">${breakdown}</div>
      </section>
      ${isFinance() ? incomeForm() : ''}
    </div>
    <section class="card" id="ledger-table">
      <div class="card-head">
        <h2>📒 Immutable Ledger <span class="sub">${plural(L.count, 'row')}${L.filters.type || L.filters.category ? ' (filtered)' : ''}</span></h2>
        <div class="row">
          ${L.filters.type || L.filters.category ? btn('Show all rows', 'ledgerClear', { variant: 'ghost', size: 'sm', mutation: false }) : ''}
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
    <div class="card-head"><h2>💰 Record Fundraiser Income</h2>${badge('Treasurer · Admin', 'amber')}</div>
    <form class="card-body form" data-form="income">
      ${field('Amount (₹)', input('forms.income.amount', { type: 'number', attrs: 'min="1" step="1"' }), { forId: 'forms-income-amount' })}
      ${field('Description', input('forms.income.description', { placeholder: 'Spring Bake Sale — Saturday stall takings' }), { forId: 'forms-income-description' })}
      ${field('Reference (optional)', input('forms.income.reference_id', { placeholder: 'BAKESALE-DAY1', cls: 'input-mono' }), { forId: 'forms-income-reference_id' })}
      ${submitBtn('income', 'Record Income', { block: true })}
      <div class="note">A reference can only be recorded once, so the same collection can't be counted twice.</div>
    </form>
  </section>`;
}

// ============================================================================ view: profile & settings

function viewProfile() {
  const u = state.user;
  const dark = state.ui.theme === 'dark';
  const themeOption = (value, label, icon) => `<button type="button" class="theme-option${state.ui.theme === value ? ' active' : ''}" data-action="setTheme" data-theme="${value}" aria-pressed="${state.ui.theme === value}">${icon}<span>${label}</span></button>`;
  return `${pageHead('Account', 'My Profile & Settings', 'Your membership card, account details, password and appearance.')}
    <div class="grid grid-2 profile-page">
      <div class="stack">${membershipCard(u)}</div>
      <div class="stack">
        <section class="card">
          <div class="card-head"><h2>👤 Account</h2>${badge(roleLabel(u.role), ROLE_TONE[u.role])}</div>
          <div class="card-body">
            <div class="profile-head">${avatar(u.name, u.role)}<div><b>${esc(u.name)}</b><div class="small muted">${esc(u.email)} · member since ${fmtDate(u.created_at)}</div></div></div>
          </div>
          <form class="card-body form" data-form="profileName" style="padding-top:0">
            ${field('Full name', input('forms.profile.name', { placeholder: u.name, attrs: 'autocomplete="name" required' }), { forId: 'forms-profile-name' })}
            <div>${submitBtn('profileName', 'Save Name')}</div>
          </form>
        </section>
        <section class="card">
          <div class="card-head"><h2>🔒 Change Password</h2></div>
          <form class="card-body form" data-form="profilePassword">
            ${field('Current password', input('forms.password.current', { type: 'password', attrs: 'autocomplete="current-password" required' }), { forId: 'forms-password-current' })}
            <div class="form-grid">
              ${field('New password (6+ characters)', input('forms.password.next', { type: 'password', attrs: 'autocomplete="new-password" required' }), { forId: 'forms-password-next' })}
              ${field('Confirm new password', input('forms.password.confirm', { type: 'password', attrs: 'autocomplete="new-password" required' }), { forId: 'forms-password-confirm' })}
            </div>
            <div>${submitBtn('profilePassword', 'Update Password')}</div>
          </form>
        </section>
        <section class="card">
          <div class="card-head"><h2>🎨 Appearance</h2><span class="sub">Saved on this device</span></div>
          <div class="card-body"><div class="theme-options">${themeOption('light', 'Light', ICONS.sun)}${themeOption('dark', 'Dark', ICONS.moon)}</div>
            <p class="small muted mt-8">Currently using the ${dark ? 'dark' : 'light'} theme.</p></div>
        </section>
        <section class="card">
          <div class="card-body row-between"><div><b>Sign out</b><div class="small muted">End your session on this device.</div></div>${btn('Sign Out', 'logout', { variant: 'danger', mutation: false })}</div>
        </section>
      </div>
    </div>`;
}

// ============================================================================ chrome: header, sidebar, toasts

function renderTopbar() {
  const u = state.user;
  const founder = u?.id === FOUNDING_ADMIN_ID && u.role === 'ADMIN';
  const session = u
    ? `${themeToggle('on-dark')}
       <a class="user-chip" href="#profile" title="My Profile & Settings" aria-label="${esc(u.name)}, ${founder ? 'Founding Admin' : roleLabel(u.role)}: open My Profile & Settings">
         <span class="uc-avatar">${avatar(u.name, u.role)}<span class="uc-status" title="Signed in"></span></span>
         <span class="who"><b>${esc(u.name)}</b><span class="role-pill role-${esc(u.role)}">${founder ? 'Founding Admin' : roleLabel(u.role)}</span></span>
         <svg class="uc-chevron" ${SVG_ATTRS}><path d="m6 9 6 6 6-6"/></svg>
       </a>`
    : '';
  patch(document.getElementById('session'), session);
}

function renderNav() {
  const item = (t) => `<a class="nav-item${state.activeTab === t.id ? ' active' : ''}" href="#${t.id}" title="${esc(t.label)}"${state.activeTab === t.id ? ' aria-current="page"' : ''}>
      ${ICONS[t.id]}<span class="nav-text"><b>${t.label}</b><small>${t.scene}</small></span></a>`;
  const scenes = TABS.filter((t) => t.id !== 'profile').map(item).join('');
  const account = TABS.filter((t) => t.id === 'profile').map(item).join('');
  patch(document.getElementById('nav'), `<div class="nav-heading">Club</div>${scenes}
    <div class="nav-heading">Account</div>${account}`);
}

const VIEWS = {
  overview: viewOverview,
  events: viewEvents,
  announcements: viewAnnouncements,
  merch: viewMerch,
  tasks: viewTasks,
  finance: viewFinance,
  profile: viewProfile,
};

function renderMain() {
  let html;
  try {
    html = state.user ? VIEWS[state.activeTab]() : viewAuth();
  } catch (err) {
    console.error(err);
    html = banner('danger', '⚠️', 'This view failed to render', esc(err.message));
  }
  patch(document.getElementById('main'), html);
}

const TOAST_ICON = { ok: '✓', err: '!', info: 'i' };

function renderToasts() {
  patch(document.getElementById('toasts'), state.toasts.map((t) => `<div class="toast ${t.kind}" data-action="dismissToast" data-id="${t.id}" role="status">
      <span class="toast-icon" aria-hidden="true">${TOAST_ICON[t.kind]}</span>
      <div class="toast-body"><div class="toast-title">${esc(t.title)}</div><div class="toast-msg">${esc(t.message)}</div></div>
    </div>`).join(''));
}

// Hands a downloaded Blob to the browser as a file.
function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
  document.body.classList.toggle('logged-out', !state.user);
  document.body.classList.toggle('nav-collapsed', state.ui.navCollapsed);
  document.body.classList.toggle('nav-open', state.ui.navOpen);
  renderTopbar();
  renderNav();
  renderMain();
  renderToasts();
}

// Light/dark theme on <html data-theme>, remembered on this device.
function applyTheme(theme) {
  state.ui.theme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = state.ui.theme;
  try {
    localStorage.setItem(THEME_KEY, state.ui.theme);
  } catch {
    // storage blocked: the theme just won't be remembered
  }
  render();
}

function isNarrowScreen() {
  return window.matchMedia('(max-width: 900px)').matches;
}

// ============================================================================ event handlers

const ACTIONS = {
  logout: () => {
    clearSession();
    state.ui.authView = 'signin';
    state.ui.navOpen = false;
    history.replaceState(null, '', '#overview');
    state.activeTab = 'overview';
    infoToast('You have been signed out of this device.', 'Signed Out');
    render();
  },
  openAuth: ({ mode }) => {
    state.ui.authView = mode === 'register' ? 'register' : 'signin';
    render();
  },
  toggleNav: () => {
    if (isNarrowScreen()) state.ui.navOpen = !state.ui.navOpen;
    else state.ui.navCollapsed = !state.ui.navCollapsed;
    render();
  },
  closeNav: () => {
    state.ui.navOpen = false;
    render();
  },
  toggleTheme: () => applyTheme(state.ui.theme === 'dark' ? 'light' : 'dark'),
  setTheme: ({ theme }) => applyTheme(theme),
  authView: ({ view }) => {
    state.ui.authView = view;
    state.ui.authError = null;
    state.ui.showPassword = false;
    renderMain();
  },
  togglePassword: () => {
    state.ui.showPassword = !state.ui.showPassword;
    renderMain();
  },
  toggleQuickFill: () => {
    state.ui.quickFillOpen = !state.ui.quickFillOpen;
    renderMain();
  },
  // Fills the sign-in form only; the user still presses Sign In.
  quickFill: ({ email }) => {
    state.forms.login = { email, password: state.demo.password || '' };
    state.ui.authView = 'signin';
    state.ui.authError = null;
    renderMain();
    document.querySelector('form[data-form="login"] button[type="submit"]')?.focus();
  },
  useRecoveredEmail: () => {
    state.forms.login = { email: state.ui.recoveredAccount.email, password: '' };
    state.ui.authView = 'signin';
    state.ui.recoveredAccount = null;
    renderMain();
    document.getElementById('forms-login-password')?.focus();
  },
  joinOrRenew: () => joinOrRenew(),
  toggleEventForm: () => {
    state.ui.showEventForm = !state.ui.showEventForm;
    renderMain();
  },
  buyTicket: ({ id }) => mutate(`buyTicket:${id}`, 'POST', `/api/events/${id}/tickets`, undefined, {
    success: (d) => ({ title: 'Ticket Booked', message: `Your ticket for ${d.event.title} is ${d.ticket.ticket_code} (${d.tier.toLowerCase()} price ${inr(d.price_paid)}).` }),
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
    success: (d) => ({ title: TASK_TOAST[d.task.status], message: `“${d.task.title}” is now ${TASK_STATUS[d.task.status][0].toLowerCase()} · campaign ${d.campaign.completion_percentage}% done.` }),
    refresh: () => loadTasks(),
  }),
  assignTask: ({ id, value }) => mutate(`assign:${id}`, 'PATCH', `/api/tasks/${id}/status`, { assigned_to: value ? Number(value) : null }, {
    success: (d) => ({
      title: d.task.assigned_to ? 'Task Assigned' : 'Task Unassigned',
      message: d.task.assigned_to ? `“${d.task.title}” is now with ${d.task.assignee_name}.` : `“${d.task.title}” has nobody assigned.`,
    }),
    refresh: () => loadTasks(),
  }),
  deleteTask: ({ id, title }) => {
    if (!window.confirm(`Delete the task “${title}”? This can't be undone.`)) return null;
    return mutate(`deleteTask:${id}:${title}`, 'DELETE', `/api/tasks/${id}`, undefined, {
      success: (d) => ({ title: 'Task Deleted', message: `“${d.deleted.title}” was removed from ${d.deleted.campaign_name}.` }),
      refresh: () => loadTasks(),
    });
  },
  updateRole: ({ id }) => {
    const user = state.data.users?.users.find((u) => u.id === Number(id));
    const role = state.ui.roleDraft[id];
    if (!user || !role || role === user.role) return null;
    return mutate(`updateRole:${id}`, 'PATCH', `/api/users/${id}/role`, { role }, {
      success: (d) => ({ title: 'Access Updated', message: `${d.user.name} is now ${roleLabel(d.user.role)} (was ${roleLabel(d.previous_role)}). It applies on their next click.` }),
      onError: () => { state.ui.roleDraft[id] = user.role; },
      refresh: () => loadUsers(),
    });
  },
  ledgerFocus: async ({ category }) => {
    const same = state.ui.ledgerCategory === category && !state.ui.ledgerType;
    state.ui.ledgerCategory = same ? '' : category;
    state.ui.ledgerType = '';
    await loadLedger();
    renderMain();
    if (!same) document.getElementById('ledger-table')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  },
  ledgerClear: async () => {
    state.ui.ledgerCategory = '';
    state.ui.ledgerType = '';
    await loadLedger();
    renderMain();
  },
  reimbStatus: async ({ status }) => {
    state.ui.reimbStatus = status;
    renderMain();
    await loadReimbursements();
    renderMain();
  },
  review: ({ id, decision }) => mutate(`review:${id}:${decision}`, 'PATCH', `/api/finance/reimbursements/${id}/review`, { decision }, {
    success: (d) => (d.transaction
      ? { title: 'Claim Approved', message: `${inr(d.transaction.amount)} paid to ${d.reimbursement.volunteer_name} (ledger ${signedInr(-d.transaction.amount)}).` }
      : { title: 'Claim Rejected', message: `Claim #${d.reimbursement.id} was rejected. No money moved.` }),
    refresh: () => Promise.all([loadReimbursements(), loadLedger()]),
  }),
  dismissToast: ({ id }) => dismissToast(Number(id)),
  exportLedger: () => mutate('exportLedger', 'GET', '/api/finance/ledger/export.csv', undefined, {
    raw: true,
    success: (d) => ({ title: 'Books Exported', message: `skyline-semester-ledger.csv downloaded (${(d.bytes / 1024).toFixed(1)} KB).` }),
    onSuccess: (_data, res) => saveBlob(res.blob, 'skyline-semester-ledger.csv'),
    refresh: () => null, // a download changes nothing on the server
  }),
};

const FORMS = {
  login: () => signIn('form:login', state.forms.login.email, state.forms.login.password),
  register: () => {
    const f = state.forms.register;
    if (f.password !== f.confirm) {
      state.ui.authError = 'The two passwords don’t match.';
      return renderMain();
    }
    return mutate('form:register', 'POST', '/api/auth/register', { name: f.name, email: f.email, password: f.password }, {
      onSuccess: startSession,
      onError: (res) => {
        state.ui.authError = errorText(res);
      },
      success: (d) => ({ title: 'Account Created', message: `Welcome to Skyline, ${firstName(d.user.name)}! Join the club from your dashboard to unlock member prices.` }),
      refresh: () => LOADERS[state.activeTab]?.(),
    });
  },
  forgotPassword: () => {
    const f = state.forms.forgotPassword;
    return mutate('form:forgotPassword', 'POST', '/api/auth/forgot-password', { ...f }, {
      onSuccess: startSession,
      onError: (res) => {
        state.ui.authError = errorText(res);
      },
      success: (d) => ({ title: 'Password Updated', message: `You're signed in as ${d.user.name}. Use your new password next time.` }),
      refresh: () => LOADERS[state.activeTab]?.(),
    });
  },
  forgotEmail: () => mutate('form:forgotEmail', 'POST', '/api/auth/forgot-email', { query: state.forms.forgotEmail.query }, {
    onSuccess: (d) => {
      state.ui.recoveredAccount = d.account;
      state.ui.authError = null;
    },
    onError: (res) => {
      state.ui.recoveredAccount = null;
      state.ui.authError = errorText(res);
    },
    success: (d) => ({ title: 'Account Found', message: `${d.account.name} signs in with ${d.account.email}.` }),
    refresh: () => null,
  }),
  profileName: () => mutate('form:profileName', 'PATCH', '/api/auth/profile', { name: state.forms.profile.name }, {
    success: (d) => ({ title: 'Profile Updated', message: `Your name is now ${d.user.name}.` }),
    refresh: async () => {
      await refreshSession();
      state.forms.profile.name = state.user.name;
    },
  }),
  profilePassword: () => {
    const f = state.forms.password;
    if (f.next !== f.confirm) {
      infoToast('The new password and its confirmation don’t match.', 'Check Your Password');
      return null;
    }
    return mutate('form:profilePassword', 'PATCH', '/api/auth/profile', { current_password: f.current, new_password: f.next }, {
      success: { title: 'Password Changed', message: 'Use your new password the next time you sign in.' },
      onSuccess: () => {
        state.forms.password = blankForms().password;
      },
      refresh: () => null,
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
  if (el.dataset?.assignTask) await ACTIONS.assignTask({ id: el.dataset.assignTask, value: el.value });
  if (el.dataset?.rerender) renderMain();
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
  if (event.key !== 'Escape') return;
  if (state.ui.navOpen) ACTIONS.closeNav();
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
  state.ui.navOpen = false;
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

  await Promise.all([loadDemoAccounts(), refreshSession()]);
  if (state.token && !state.user) clearSession();
  state.booting = false;

  if (state.user) await loadTab();
  else render();
}

boot();
