'use strict';

const express = require('express');
const { db, withTransaction } = require('../db');
const { HttpError, validationFailed, parsePositiveInt, parseInteger, parseEnumParam } = require('../lib/http');
const { DEFAULT_CAMPAIGN, TASK_STATUSES, localDate, campaignSummaries } = require('../lib/fundraising');
const { requireAuth, requireRole, requireScope, SCOPE_LABEL } = require('../middleware/requireAuth');
const { membershipSnapshot } = require('../lib/users');

// Task managers create, edit, assign and delete tasks. Volunteers and students don't.
const MANAGER_ROLES = new Set(['TREASURER', 'ADMIN']);
const REQUEST_DECISIONS = ['APPROVE', 'REJECT'];
const MAX_NOTE = 200;

function inBakeSaleScope(user) {
  const scope = user.access_scope || 'ALL';
  return scope === 'ALL' || scope === 'BAKE_SALE_ONLY';
}

function scopeError(user) {
  return new HttpError(403, 'Forbidden', { reason: `Your admin access is scoped strictly to: ${SCOPE_LABEL[user.access_scope] || user.access_scope}` });
}

const REQUEST_SQL = `
  SELECT r.id, r.task_id, r.user_id, r.note, r.status, r.created_at,
         t.title AS task_title, t.status AS task_status, t.assigned_to AS task_assigned_to,
         u.name AS user_name, u.role AS user_role, u.membership_code, u.membership_status, u.membership_expires_at
  FROM task_requests r
  JOIN fundraiser_tasks t ON t.id = r.task_id
  JOIN users u ON u.id = r.user_id`;

function toRequestView(row) {
  return {
    id: row.id,
    task_id: row.task_id,
    task_title: row.task_title,
    task_status: row.task_status,
    note: row.note,
    status: row.status,
    created_at: row.created_at,
    user: { id: row.user_id, name: row.user_name, role: row.user_role, membership_status: membershipSnapshot(row).status },
  };
}
const MAX_CAMPAIGN = 80;
const MAX_TITLE = 150;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const router = express.Router();

const TASK_SQL = `
  SELECT t.id, t.campaign_name, t.title, t.status, t.due_date, t.created_at,
         t.assigned_to, u.name AS assignee_name, u.role AS assignee_role
  FROM fundraiser_tasks t
  -- LEFT JOIN, not JOIN: unassigned tasks (assigned_to IS NULL) have no users
  -- row to match, and an inner join would silently drop them from the board.
  LEFT JOIN users u ON u.id = t.assigned_to`;

function toTaskView(row, today = localDate()) {
  return {
    id: row.id,
    campaign_name: row.campaign_name,
    title: row.title,
    status: row.status,
    due_date: row.due_date,
    is_overdue: row.status !== 'DONE' && row.due_date !== null && row.due_date < today,
    created_at: row.created_at,
    assigned_to: row.assigned_to,
    assignee_name: row.assignee_name,
    assignee_role: row.assignee_role,
  };
}

// assigned_to in a JSON body: null (unassigned) or a positive integer user id.
function parseAssignee(value) {
  if (value === null) return { value: null };
  const id = parseInteger(value);
  return id !== null && id > 0 ? { value: id } : { error: 'assigned_to must be a positive integer user id or null' };
}

// due_date: null, or a real calendar date as YYYY-MM-DD.
function parseDueDate(value) {
  if (value === undefined || value === null || value === '') return { value: null };
  const valid = typeof value === 'string' && DATE_RE.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString().slice(0, 10) === value;
  return valid ? { value } : { error: 'due_date must be a valid date in YYYY-MM-DD format' };
}

function assertUserExists(userId) {
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) throw new HttpError(404, `User ${userId} not found`);
}

router.get('/', requireAuth, (req, res) => {
  const status = parseEnumParam(req.query.status, TASK_STATUSES, 'status');
  let campaign = null;
  if (req.query.campaign !== undefined) {
    campaign = typeof req.query.campaign === 'string' ? req.query.campaign.trim() : '';
    if (!campaign) throw validationFailed({ campaign: 'campaign must be a non-empty string' });
  }
  let assignedTo = null;
  if (req.query.assigned_to !== undefined) {
    assignedTo = parsePositiveInt(req.query.assigned_to);
    if (!assignedTo) throw validationFailed({ assigned_to: 'assigned_to must be a positive integer user id' });
  }

  const where = [];
  const params = [];
  if (campaign) {
    where.push('t.campaign_name = ?');
    params.push(campaign);
  }
  if (status) {
    where.push('t.status = ?');
    params.push(status);
  }
  if (assignedTo) {
    where.push('t.assigned_to = ?');
    params.push(assignedTo);
  }

  const today = localDate();
  const tasks = db
    .prepare(`${TASK_SQL}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
      ORDER BY CASE t.status WHEN 'TODO' THEN 0 WHEN 'IN_PROGRESS' THEN 1 ELSE 2 END,
               t.due_date IS NULL, t.due_date ASC, t.id ASC`)
    .all(...params)
    .map((row) => toTaskView(row, today));

  const isManager = MANAGER_ROLES.has(req.user.role);
  const requests = (isManager
    ? db.prepare(`${REQUEST_SQL} WHERE r.status = 'PENDING' ORDER BY r.created_at ASC, r.id ASC`).all()
    : db.prepare(`${REQUEST_SQL} WHERE r.user_id = ? ORDER BY r.created_at DESC`).all(req.user.id)
  ).map(toRequestView);

  res.json({
    filters: { campaign, status, assigned_to: assignedTo },
    count: tasks.length,
    tasks,
    campaigns_summary: campaignSummaries(campaign),
    requests,
  });
});

// People a task can be assigned to, for the "Add Task" picker. Staff only.
router.get('/assignees', requireAuth, requireRole('VOLUNTEER', 'TREASURER', 'ADMIN'), (req, res) => {
  const users = db
    .prepare(`
      SELECT id, name, role FROM users
      ORDER BY CASE role WHEN 'VOLUNTEER' THEN 0 WHEN 'ADMIN' THEN 1 ELSE 2 END, name`)
    .all();
  res.json({ users });
});

router.post('/', requireAuth, requireRole('TREASURER', 'ADMIN'), requireScope('BAKE_SALE'), (req, res) => {
  const body = req.body || {};
  const campaign = body.campaign_name === undefined
    ? DEFAULT_CAMPAIGN
    : typeof body.campaign_name === 'string' ? body.campaign_name.trim() : '';
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const assignee = body.assigned_to === undefined ? { value: null } : parseAssignee(body.assigned_to);
  const dueDate = parseDueDate(body.due_date);

  const details = {};
  if (!campaign || campaign.length > MAX_CAMPAIGN) details.campaign_name = `campaign_name must be 1-${MAX_CAMPAIGN} characters`;
  if (!title || title.length > MAX_TITLE) details.title = `Title is required (at most ${MAX_TITLE} characters)`;
  if (assignee.error) details.assigned_to = assignee.error;
  if (dueDate.error) details.due_date = dueDate.error;
  if (Object.keys(details).length) throw validationFailed(details);

  const task = withTransaction(() => {
    if (assignee.value !== null) assertUserExists(assignee.value);
    const { lastInsertRowid } = db
      .prepare(`
        INSERT INTO fundraiser_tasks (campaign_name, title, assigned_to, status, due_date, created_at)
        VALUES (?, ?, ?, 'TODO', ?, ?)`)
      .run(campaign, title, assignee.value, dueDate.value, new Date().toISOString());
    return db.prepare(`${TASK_SQL} WHERE t.id = ?`).get(lastInsertRowid);
  });

  res.status(201).json({ task: toTaskView(task), campaign: campaignSummaries(task.campaign_name)[task.campaign_name] });
});

// Moves a task between columns (any direction: To do <-> In progress <-> Done)
// and/or reassigns it. Body: { status?, assigned_to? }; at least one is needed.
// Staff may reassign; a student may only move a task assigned to them.
router.patch('/:id/status', requireAuth, (req, res) => {
  const id = parsePositiveInt(req.params.id);
  if (!id) throw validationFailed({ id: 'Task id must be a positive integer' });

  const body = req.body || {};
  const hasStatus = body.status !== undefined;
  const status = hasStatus && typeof body.status === 'string' ? body.status.trim().toUpperCase() : '';
  const reassign = body.assigned_to !== undefined;
  const assignee = reassign ? parseAssignee(body.assigned_to) : null;

  const details = {};
  if (!hasStatus && !reassign) details.status = `Send a status (${TASK_STATUSES.join(', ')}) and/or assigned_to`;
  else if (hasStatus && !TASK_STATUSES.includes(status)) details.status = `status must be one of ${TASK_STATUSES.join(', ')}`;
  if (assignee?.error) details.assigned_to = assignee.error;
  if (Object.keys(details).length) throw validationFailed(details);

  const isManager = MANAGER_ROLES.has(req.user.role);
  if (reassign && !isManager) {
    throw new HttpError(403, 'Forbidden', { reason: 'only the Admin or the Treasurer can reassign tasks' });
  }
  if (reassign && !inBakeSaleScope(req.user)) throw scopeError(req.user);

  const task = withTransaction(() => {
    const current = db.prepare('SELECT id, status, assigned_to FROM fundraiser_tasks WHERE id = ?').get(id);
    if (!current) throw new HttpError(404, 'Task not found');
    // Only the person the task is assigned to, or the Admin, may move it.
    const isAssignee = current.assigned_to === req.user.id;
    if (hasStatus && !isAssignee && req.user.role !== 'ADMIN') {
      throw new HttpError(403, 'Forbidden', { reason: 'only the assigned person or the Admin can update this task' });
    }
    if (hasStatus && !isAssignee && !inBakeSaleScope(req.user)) throw scopeError(req.user);

    const nextStatus = hasStatus ? status : current.status;
    const effectiveAssignee = reassign ? assignee.value : current.assigned_to;
    // Nobody owns an unassigned task, so it can't be started or finished.
    if (nextStatus !== 'TODO' && effectiveAssignee === null) {
      throw new HttpError(409, 'Please assign a volunteer or member to this task before starting or completing it', {
        task_id: id,
        status: nextStatus,
      });
    }
    if (reassign && effectiveAssignee !== null) assertUserExists(effectiveAssignee);

    db.prepare('UPDATE fundraiser_tasks SET status = ?, assigned_to = ? WHERE id = ?').run(nextStatus, effectiveAssignee, id);
    return db.prepare(`${TASK_SQL} WHERE t.id = ?`).get(id);
  });

  res.json({ task: toTaskView(task), campaign: campaignSummaries(task.campaign_name)[task.campaign_name] });
});

router.delete('/:id', requireAuth, requireRole('TREASURER', 'ADMIN'), requireScope('BAKE_SALE'), (req, res) => {
  const id = parsePositiveInt(req.params.id);
  if (!id) throw validationFailed({ id: 'Task id must be a positive integer' });

  const deleted = withTransaction(() => {
    const task = db.prepare('SELECT id, campaign_name, title, status FROM fundraiser_tasks WHERE id = ?').get(id);
    if (!task) throw new HttpError(404, 'Task not found');
    db.prepare('DELETE FROM fundraiser_tasks WHERE id = ?').run(id);
    return task;
  });

  res.json({ deleted, campaigns_summary: campaignSummaries() });
});

// Edit a task's title, due date or campaign (managers only).
router.patch('/:id', requireAuth, requireRole('TREASURER', 'ADMIN'), requireScope('BAKE_SALE'), (req, res) => {
  const id = parsePositiveInt(req.params.id);
  if (!id) throw validationFailed({ id: 'Task id must be a positive integer' });
  const body = req.body || {};
  const details = {};
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const campaign = typeof body.campaign_name === 'string' ? body.campaign_name.trim() : '';
  const dueDate = parseDueDate(body.due_date);
  if (body.title !== undefined && (!title || title.length > MAX_TITLE)) details.title = `Title must be 1-${MAX_TITLE} characters`;
  if (body.campaign_name !== undefined && (!campaign || campaign.length > MAX_CAMPAIGN)) details.campaign_name = `campaign_name must be 1-${MAX_CAMPAIGN} characters`;
  if (body.due_date !== undefined && dueDate.error) details.due_date = dueDate.error;
  if (![body.title, body.campaign_name, body.due_date].some((v) => v !== undefined)) details.task = 'Send a title, campaign_name and/or due_date';
  if (Object.keys(details).length) throw validationFailed(details);

  const task = withTransaction(() => {
    const current = db.prepare('SELECT * FROM fundraiser_tasks WHERE id = ?').get(id);
    if (!current) throw new HttpError(404, 'Task not found');
    db.prepare('UPDATE fundraiser_tasks SET title = ?, campaign_name = ?, due_date = ? WHERE id = ?').run(
      body.title !== undefined ? title : current.title,
      body.campaign_name !== undefined ? campaign : current.campaign_name,
      body.due_date !== undefined ? dueDate.value : current.due_date,
      id,
    );
    return db.prepare(`${TASK_SQL} WHERE t.id = ?`).get(id);
  });
  res.json({ task: toTaskView(task), campaign: campaignSummaries(task.campaign_name)[task.campaign_name] });
});

// Club members and volunteers ask to take a task; an admin approves one.
router.post('/:id/request', requireAuth, (req, res) => {
  const id = parsePositiveInt(req.params.id);
  if (!id) throw validationFailed({ id: 'Task id must be a positive integer' });
  const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
  if (note.length > MAX_NOTE) throw validationFailed({ note: `note must be at most ${MAX_NOTE} characters` });

  const request = withTransaction(() => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const isMember = user && user.role === 'STUDENT' && membershipSnapshot(user).status === 'ACTIVE';
    if (!user || !(isMember || user.role === 'VOLUNTEER' || user.role === 'TREASURER')) {
      throw new HttpError(403, 'Forbidden', { reason: 'only club members and volunteers can request tasks' });
    }
    const task = db.prepare('SELECT * FROM fundraiser_tasks WHERE id = ?').get(id);
    if (!task) throw new HttpError(404, 'Task not found');
    if (task.status === 'DONE') throw new HttpError(409, 'This task is already done');
    if (task.assigned_to === user.id) throw new HttpError(409, 'This task is already assigned to you');
    const existing = db.prepare('SELECT id, status FROM task_requests WHERE task_id = ? AND user_id = ?').get(id, user.id);
    if (existing) throw new HttpError(409, `You already requested this task (${existing.status.toLowerCase()})`, { request_id: existing.id });
    const { lastInsertRowid } = db
      .prepare("INSERT INTO task_requests (task_id, user_id, note, status, created_at) VALUES (?, ?, ?, 'PENDING', ?)")
      .run(id, user.id, note || null, new Date().toISOString());
    return db.prepare(`${REQUEST_SQL} WHERE r.id = ?`).get(lastInsertRowid);
  });
  res.status(201).json({ request: toRequestView(request) });
});

// Approve (assigns the task and closes the other pending requests) or reject.
router.patch('/requests/:requestId/review', requireAuth, requireRole('ADMIN'), requireScope('BAKE_SALE'), (req, res) => {
  const requestId = parsePositiveInt(req.params.requestId);
  const decision = typeof req.body?.decision === 'string' ? req.body.decision.trim().toUpperCase() : '';
  const details = {};
  if (!requestId) details.requestId = 'Request id must be a positive integer';
  if (!REQUEST_DECISIONS.includes(decision)) details.decision = `decision must be one of ${REQUEST_DECISIONS.join(', ')}`;
  if (Object.keys(details).length) throw validationFailed(details);

  const result = withTransaction(() => {
    const request = db.prepare('SELECT * FROM task_requests WHERE id = ?').get(requestId);
    if (!request) throw new HttpError(404, 'Request not found');
    if (request.status !== 'PENDING') throw new HttpError(409, `Request already ${request.status}`);
    if (decision === 'REJECT') {
      db.prepare("UPDATE task_requests SET status = 'REJECTED' WHERE id = ? AND status = 'PENDING'").run(requestId);
      return { closed: 0 };
    }
    db.prepare("UPDATE task_requests SET status = 'APPROVED' WHERE id = ? AND status = 'PENDING'").run(requestId);
    db.prepare('UPDATE fundraiser_tasks SET assigned_to = ? WHERE id = ?').run(request.user_id, request.task_id);
    const closed = db
      .prepare("UPDATE task_requests SET status = 'REJECTED' WHERE task_id = ? AND id != ? AND status = 'PENDING'")
      .run(request.task_id, requestId).changes;
    return { closed };
  });
  const request = toRequestView(db.prepare(`${REQUEST_SQL} WHERE r.id = ?`).get(requestId));
  const task = toTaskView(db.prepare(`${TASK_SQL} WHERE t.id = ?`).get(request.task_id));
  res.json({ request, task, other_requests_rejected: result.closed });
});

module.exports = router;
