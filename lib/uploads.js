'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Uploaded product photos live on disk (not in the database) and are served at
// /uploads/merch/<random>.<ext>. Tests point UPLOAD_DIR at a temporary folder.
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
const MERCH_DIR = path.join(UPLOAD_DIR, 'merch');
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_PHOTOS = 4;
const URL_RE = /^\/uploads\/merch\/([a-f0-9]{24}\.(?:png|jpg|webp))$/;

// Only raster formats, and only when the bytes really are that format: the
// declared type must match the file's magic number (no SVG, no HTML posing as PNG).
const FORMATS = {
  'image/png': { ext: 'png', ok: (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47 },
  'image/jpeg': { ext: 'jpg', ok: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/webp': { ext: 'webp', ok: (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
};

// data:image/...;base64,... -> { buffer, ext } or { error }.
function decodeImage(dataUrl) {
  const match = typeof dataUrl === 'string' ? /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl) : null;
  if (!match) return { error: 'must be a PNG, JPEG or WebP image sent as a base64 data URL' };
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) return { error: `must be between 1 byte and ${MAX_IMAGE_BYTES / 1024 / 1024} MB` };
  const format = FORMATS[match[1]];
  if (!format.ok(buffer)) return { error: `is not a valid ${match[1]} file` };
  return { buffer, ext: format.ext };
}

function saveImage({ buffer, ext }) {
  fs.mkdirSync(MERCH_DIR, { recursive: true });
  const name = `${crypto.randomBytes(12).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(MERCH_DIR, name), buffer);
  return `/uploads/merch/${name}`;
}

// Deletes a previously saved photo; anything that isn't one of ours is ignored.
function removeImage(url) {
  const match = URL_RE.exec(url || '');
  if (match) fs.rmSync(path.join(MERCH_DIR, match[1]), { force: true });
}

function isUploadUrl(url) {
  return URL_RE.test(url || '');
}

module.exports = { UPLOAD_DIR, MERCH_DIR, MAX_PHOTOS, decodeImage, saveImage, removeImage, isUploadUrl };
