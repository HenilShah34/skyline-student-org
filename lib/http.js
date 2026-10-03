'use strict';

// Thrown from route handlers, including from inside withTransaction (which rolls
// back first). The error middleware renders it as { error: message, ...extra }.
class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.extra = extra;
  }
}

function validationFailed(details) {
  return new HttpError(400, 'Validation failed', { details });
}

// Route params: plain positive decimal integers only ("1", not "1.0" or "1e3").
function parsePositiveInt(value) {
  return typeof value === 'string' && /^[1-9]\d{0,14}$/.test(value) ? Number(value) : null;
}

// JSON bodies may carry numbers or numeric strings (from HTML form fields).
function parseInteger(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null;
  if (typeof value === 'string' && /^-?\d{1,15}$/.test(value.trim())) return Number(value.trim());
  return null;
}

// Optional ?q= search term. Express parses repeated params into an array.
function parseSearchQuery(value, maxLength = 100) {
  if (value === undefined) return '';
  if (typeof value !== 'string') throw validationFailed({ q: 'q must be a single string' });
  const q = value.trim();
  if (q.length > maxLength) throw validationFailed({ q: `q must be at most ${maxLength} characters` });
  return q;
}

// Escapes LIKE wildcards so user input matches literally. Pair with ESCAPE '\'.
function escapeLike(value) {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

module.exports = { HttpError, validationFailed, parsePositiveInt, parseInteger, parseSearchQuery, escapeLike };
