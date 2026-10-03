'use strict';

const express = require('express');
const { db, withTransaction } = require('../db');
const { HttpError, validationFailed, parsePositiveInt, parseInteger, parseEnumParam } = require('../lib/http');
const { DEFAULT_CAMPAIGN, TASK_STATUSES, localDate, campaignSummaries } = require('../lib/fundraising');
const { requireAuth, requireRole } = require('../middleware/requireAuth');

const STAFF_ROLES = new Set(['VOLUNTEER', 'TREASURER', 'ADMIN']);
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

  res.json({
    filters: { campaign, status, assigned_to: assignedTo },
    count: tasks.length,
    tasks,
    campaigns_summary: campaignSummaries(campaign),
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

router.post('/', requireAuth, requireRole('VOLUNTEER', 'TREASURER', 'ADMIN'), (req, res) => {
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

router.patch('/:id/status', requireAuth, (req, res) => {
  const id = parsePositiveInt(req.params.id);
  if (!id) throw validationFailed({ id: 'Task id must be a positive integer' });

  const body = req.body || {};
  const status = typeof body.status === 'string' ? body.status.trim().toUpperCase() : '';
  const reassign = body.assigned_to !== undefined;
  const assignee = reassign ? parseAssignee(body.assigned_to) : null;

  const details = {};
  if (!TASK_STATUSES.includes(status)) details.status = `status must be one of ${TASK_STATUSES.join(', ')}`;
  if (assignee?.error) details.assigned_to = assignee.error;
  if (Object.keys(details).length) throw validationFailed(details);

  const isStaff = STAFF_ROLES.has(req.user.role);
  if (reassign && !isStaff) {
    throw new HttpError(403, 'Forbidden', { reason: 'only volunteers and admins can reassign tasks' });
  }

  const task = withTransaction(() => {
    const current = db.prepare('SELECT id, assigned_to FROM fundraiser_tasks WHERE id = ?').get(id);
    if (!current) throw new HttpError(404, 'Task not found');
    if (!isStaff && current.assigned_to !== req.user.id) {
      throw new HttpError(403, 'Forbidden', { reason: 'students can only update tasks assigned to them' });
    }

    if (reassign) {
      if (assignee.value !== null) assertUserExists(assignee.value);
      db.prepare('UPDATE fundraiser_tasks SET status = ?, assigned_to = ? WHERE id = ?').run(status, assignee.value, id);
    } else {
      db.prepare('UPDATE fundraiser_tasks SET status = ? WHERE id = ?').run(status, id);
    }
    return db.prepare(`${TASK_SQL} WHERE t.id = ?`).get(id);
  });

  res.json({ task: toTaskView(task), campaign: campaignSummaries(task.campaign_name)[task.campaign_name] });
});

module.exports = router;
