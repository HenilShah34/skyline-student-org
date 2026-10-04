'use strict';

// Runs every phase's verification script under both SQLite drivers
// (better-sqlite3 and the built-in node:sqlite fallback) and prints a summary.
// Usage: node verify-all.js [--driver=better-sqlite3|node]

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const PHASES = ['verify-phase1.js', 'verify-phase2.js', 'verify-phase3.js', 'verify-phase4.js', 'verify-phase5.js', 'verify-phase6.js', 'verify-phase7.js', 'verify-phase8.js'];
const DRIVERS = ['better-sqlite3', 'node'];

const only = process.argv.find((arg) => arg.startsWith('--driver='))?.split('=')[1];
const drivers = only ? DRIVERS.filter((d) => d === only) : DRIVERS;
if (!drivers.length) {
  console.error(`Unknown driver "${only}". Use one of: ${DRIVERS.join(', ')}`);
  process.exit(2);
}

const runs = [];
for (const driver of drivers) {
  for (const phase of PHASES) {
    console.log(`\n=== ${phase} [${driver}] ${'='.repeat(40)}`);
    const started = Date.now();
    const { status } = spawnSync(process.execPath, [path.join(__dirname, phase)], {
      stdio: 'inherit',
      env: { ...process.env, SQLITE_DRIVER: driver },
    });
    runs.push({ phase, driver, ok: status === 0, seconds: ((Date.now() - started) / 1000).toFixed(1) });
  }
}

console.log('\n=== Summary ===');
for (const r of runs) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.phase.padEnd(18)} ${r.driver.padEnd(15)} ${r.seconds}s`);
const failed = runs.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} run(s) failed` : `\nAll ${runs.length} runs passed`);
process.exitCode = failed ? 1 : 0;
