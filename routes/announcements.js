'use strict';

const express = require('express');
const { db } = require('../db');
const { validationFailed, parseSearchQuery, escapeLike } = require('../lib/http');
const { loadViewer } = require('../lib/viewer');
const { requireAuth, optionalAuth, requireRole } = require('../middleware/requireAuth');

const CATEGORIES = ['MEETING', 'DEADLINE', 'EVENT', 'GENERAL'];
const AUDIENCES = ['ALL', 'MEMBERS_ONLY'];
const STAFF_ROLES = new Set(['VOLUNTEER', 'TREASURER', 'ADMIN']);
const MAX_TITLE = 150;
const MAX_CONTENT = 5000;

const router = express.Router();

const SELECT_WITH_AUTHOR = `
  SELECT a.id, a.title, a.content, a.category, a.target_audience, a.created_at,
         a.author_id, u.name AS author_name, u.role AS author_role
  FROM announcements a
  JOIN users u ON u.id = a.author_id`;

function viewerContext(tokenUser) {
  const viewer = loadViewer(tokenUser);
  return {
    authenticated: viewer.authenticated,
    role: viewer.role,
    membership_status: viewer.membership_status,
    can_view_members_only: STAFF_ROLES.has(viewer.role) || viewer.is_member,
  };
}

function parseCategory(value) {
  if (value === undefined) return null;
  const category = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!CATEGORIES.includes(category)) throw validationFailed({ category: `category must be one of ${CATEGORIES.join(', ')}` });
  return category;
}

function whereClause(clauses) {
  return clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
}

router.get('/', optionalAuth, (req, res) => {
  const category = parseCategory(req.query.category);
  const q = parseSearchQuery(req.query.q);
  const viewer = viewerContext(req.user);

  const filters = [];
  const params = [];
  if (category) {
    filters.push('a.category = ?');
    params.push(category);
  }
  if (q) {
    const like = `%${escapeLike(q)}%`;
    filters.push(`(a.title LIKE ? ESCAPE '\\' OR a.content LIKE ? ESCAPE '\\')`);
    params.push(like, like);
  }

  const visible = viewer.can_view_members_only ? filters : [...filters, "a.target_audience = 'ALL'"];
  const announcements = db
    .prepare(`${SELECT_WITH_AUTHOR}${whereClause(visible)} ORDER BY a.created_at DESC, a.id DESC`)
    .all(...params);

  // Same filters, so a non-member searching "gala" learns that members-only
  // posts matched and can be nudged to join.
  const hiddenMembersOnly = viewer.can_view_members_only
    ? 0
    : db
      .prepare(`SELECT COUNT(*) AS n FROM announcements a${whereClause([...filters, "a.target_audience = 'MEMBERS_ONLY'"])}`)
      .get(...params).n;

  res.json({
    viewer,
    filters: { category, q },
    count: announcements.length,
    hidden_members_only_count: hiddenMembersOnly,
    announcements,
  });
});

router.post('/', requireAuth, requireRole('VOLUNTEER', 'TREASURER', 'ADMIN'), (req, res) => {
  const body = req.body || {};
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  const category = typeof body.category === 'string' ? body.category.trim().toUpperCase() : '';
  const audience = body.target_audience === undefined
    ? 'ALL'
    : typeof body.target_audience === 'string' ? body.target_audience.trim().toUpperCase() : '';

  const details = {};
  if (!title || title.length > MAX_TITLE) details.title = `Title is required (at most ${MAX_TITLE} characters)`;
  if (!content || content.length > MAX_CONTENT) details.content = `Content is required (at most ${MAX_CONTENT} characters)`;
  if (!CATEGORIES.includes(category)) details.category = `category must be one of ${CATEGORIES.join(', ')}`;
  if (!AUDIENCES.includes(audience)) details.target_audience = `target_audience must be one of ${AUDIENCES.join(', ')}`;
  if (Object.keys(details).length) throw validationFailed(details);

  const now = new Date().toISOString();
  const { lastInsertRowid } = db
    .prepare(`
      INSERT INTO announcements (title, content, category, target_audience, author_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
    .run(title, content, category, audience, req.user.id, now);
  const announcement = db.prepare(`${SELECT_WITH_AUTHOR} WHERE a.id = ?`).get(lastInsertRowid);

  // Simulated mailing list: members-only posts go to live active members,
  // everything else to every account.
  const recipients = audience === 'MEMBERS_ONLY'
    ? db.prepare(`SELECT COUNT(*) AS n FROM users WHERE membership_status = 'ACTIVE' AND membership_expires_at > ?`).get(now).n
    : db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

  res.status(201).json({ announcement, recipients_notified: recipients });
});

module.exports = router;
