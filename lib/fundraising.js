'use strict';

const { db } = require('../db');

const DEFAULT_CAMPAIGN = 'Spring Bake Sale';
const TASK_STATUSES = ['TODO', 'IN_PROGRESS', 'DONE'];

// YYYY-MM-DD in server local time: due dates are calendar days, not instants.
function localDate(ms = Date.now()) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Progress for each campaign across all of its tasks (ignoring list filters such
// as ?status=). A campaign is on track when no unfinished task is past due.
function campaignSummaries(campaignName = null) {
  const today = localDate();
  const rows = db
    .prepare(`
      SELECT campaign_name,
             COUNT(*) AS total_tasks,
             COALESCE(SUM(status = 'TODO'), 0) AS todo_count,
             COALESCE(SUM(status = 'IN_PROGRESS'), 0) AS in_progress_count,
             COALESCE(SUM(status = 'DONE'), 0) AS done_count,
             COALESCE(SUM(status != 'DONE' AND due_date < ?), 0) AS overdue_count
      FROM fundraiser_tasks
      ${campaignName === null ? '' : 'WHERE campaign_name = ?'}
      GROUP BY campaign_name
      ORDER BY campaign_name`)
    .all(...(campaignName === null ? [today] : [today, campaignName]));

  const summaries = {};
  for (const r of rows) {
    summaries[r.campaign_name] = {
      total_tasks: r.total_tasks,
      todo_count: r.todo_count,
      in_progress_count: r.in_progress_count,
      done_count: r.done_count,
      overdue_count: r.overdue_count,
      completion_percentage: Math.round((r.done_count * 100) / r.total_tasks),
      on_track: r.overdue_count === 0,
    };
  }
  return summaries;
}

module.exports = { DEFAULT_CAMPAIGN, TASK_STATUSES, localDate, campaignSummaries };
