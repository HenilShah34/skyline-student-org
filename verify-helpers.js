'use strict';

// Test servers seed the compact profile (the 5 named demo accounts), so every
// suite's exact counts stay stable. verify-phase8.js checks the full profile.
process.env.SEED_PROFILE = process.env.SEED_PROFILE || 'compact';

// Shared harness for verify-phase*.js: result reporting, throwaway databases and
// real `node server.js` child processes on ephemeral ports (never port 3000).

const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const results = [];

function check(name, pass, detail) {
  results.push({ name, pass: Boolean(pass) });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n          ${detail}` : ''}`);
}

function section(title) {
  console.log(`\n${title}`);
}

function summarize() {
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log(`Failed: ${failed.map((r) => r.name).join('; ')}`);
    process.exitCode = 1;
  }
}

function tempDbPath(label) {
  return path.join(os.tmpdir(), `skyline-${label}-${process.pid}-${Date.now()}.db`);
}

function removeDb(file) {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
}

function makeClient(port) {
  return async function api(method, route, { body, token, rawBody } = {}) {
    const headers = {};
    if (body !== undefined || rawBody !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers,
      body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

// Spawns `node server.js` against dbFile on an OS-assigned port.
function startServer(dbFile, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      env: { ...process.env, ...env, PORT: '0', DB_PATH: dbFile },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => reject(new Error(`server did not start within 20s:\n${output}`)), 20000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = /listening on http:\/\/localhost:(\d+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        const port = Number(match[1]);
        resolve({ child, port, api: makeClient(port) });
      }
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (code ${code}):\n${output}`));
    });
  });
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  await exited;
}

module.exports = { check, section, summarize, tempDbPath, removeDb, makeClient, startServer, stopServer };
