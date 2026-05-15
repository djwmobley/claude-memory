'use strict';

const { execFileSync, spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

// ── Project root resolution ───────────────────────────────────────────────────

function findProjectRoot() {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(__dirname, '..');
}

const PROJECT_ROOT = findProjectRoot();
const HANDOFF_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'handoff.js');
const CSV_PATH = path.join(PROJECT_ROOT, 'scripts', 'bench-results.csv');
const CSV_HEADER = 'timestamp,commit,command,iteration,wall_clock_ms,internal_ms,tokens_used\n';

// ── Git commit SHA ────────────────────────────────────────────────────────────

function getCommitSha() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
  } catch (_) {
    return 'unknown';
  }
}

// ── Quantile (linear interpolation) ──────────────────────────────────────────

function quantile(sorted, q) {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const pos = q * (sorted.length - 1);
  const lo  = Math.floor(pos);
  const hi  = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// ── Run one invocation ────────────────────────────────────────────────────────

function runCommand(cmd) {
  const start = process.hrtime.bigint();
  const result = spawnSync(process.execPath, [HANDOFF_SCRIPT, cmd], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    timeout: 60000,
  });
  const end = process.hrtime.bigint();
  const wallMs = Number(end - start) / 1e6;

  if (result.status !== 0) {
    const msg = (result.stderr || result.error?.message || 'non-zero exit').trim();
    throw new Error(msg);
  }

  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const tokMatch = stdout.match(/tokens used:\s*~?(\d+)/);
  const tokens = tokMatch ? parseInt(tokMatch[1], 10) : null;
  const intMatch = stderr.match(/internal_ms=([0-9.]+)/);
  const internalMs = intMatch ? parseFloat(intMatch[1]) : null;

  return { wallMs, internalMs, tokens };
}

// ── CSV append ────────────────────────────────────────────────────────────────

function appendCsvRow(timestamp, commit, cmd, iteration, wallMs, internalMs, tokens) {
  const needsHeader = !fs.existsSync(CSV_PATH);
  const row = [
    timestamp,
    commit,
    cmd,
    iteration,
    wallMs.toFixed(1),
    internalMs !== null ? internalMs.toFixed(1) : '',
    tokens !== null ? String(tokens) : '',
  ].join(',') + '\n';
  if (needsHeader) {
    fs.writeFileSync(CSV_PATH, CSV_HEADER + row, 'utf8');
  } else {
    fs.appendFileSync(CSV_PATH, row, 'utf8');
  }
}

// ── Summary stats ─────────────────────────────────────────────────────────────

function printSummary(cmd, latencies, internalSamples, tokenSamples) {
  const sorted = [...latencies].sort((a, b) => a - b);
  const mean   = latencies.reduce((s, v) => s + v, 0) / latencies.length;
  console.log(`\n--- ${cmd} summary (n=${latencies.length}) ---`);
  console.log(`  latency  min=${sorted[0].toFixed(1)}ms  p50=${quantile(sorted, 0.5).toFixed(1)}ms  p95=${quantile(sorted, 0.95).toFixed(1)}ms  max=${sorted[sorted.length - 1].toFixed(1)}ms  mean=${mean.toFixed(1)}ms`);

  const ints = internalSamples.filter((v) => v !== null);
  if (ints.length > 0) {
    const is = [...ints].sort((a, b) => a - b);
    const imean = ints.reduce((s, v) => s + v, 0) / ints.length;
    const wallP50 = quantile(sorted, 0.5);
    const intP50  = quantile(is, 0.5);
    const ratio   = wallP50 > 0 ? (wallP50 / intP50).toFixed(1) : 'N/A';
    console.log(`  internal min=${is[0].toFixed(1)}ms  p50=${intP50.toFixed(1)}ms  p95=${quantile(is, 0.95).toFixed(1)}ms  max=${is[is.length - 1].toFixed(1)}ms  mean=${imean.toFixed(1)}ms  (wall/internal p50 ratio=${ratio}x)`);
  }

  const toks = tokenSamples.filter((t) => t !== null);
  if (toks.length > 0) {
    const ts = [...toks].sort((a, b) => a - b);
    const tmean = toks.reduce((s, v) => s + v, 0) / toks.length;
    console.log(`  tokens   min=${ts[0]}  p50=${Math.round(quantile(ts, 0.5))}  p95=${Math.round(quantile(ts, 0.95))}  max=${ts[ts.length - 1]}  mean=${tmean.toFixed(1)}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  const iterArg = args.find((a) => a.startsWith('--iterations='));
  const iterations = iterArg ? parseInt(iterArg.split('=')[1], 10) : 10;

  const cmdArg = args.find((a) => a.startsWith('--commands='));
  const commands = cmdArg ? cmdArg.split('=')[1].split(',') : ['resume', 'status'];

  const commit    = getCommitSha();
  const timestamp = new Date().toISOString();

  console.log(`bench-handoff: commands=[${commands.join(',')}]  iterations=${iterations}  commit=${commit}`);

  for (const cmd of commands) {
    // Warmup — timed but not recorded
    process.stdout.write(`${cmd}: warmup ... `);
    try {
      const { wallMs: wMs } = runCommand(cmd);
      process.stdout.write(`${wMs.toFixed(0)}ms (discarded)\n`);
    } catch (err) {
      process.stdout.write(`ERROR (${err.message.split('\n')[0]})\n`);
    }

    const latencies      = [];
    const internalSamples = [];
    const tokenSamples   = [];

    for (let i = 1; i <= iterations; i++) {
      try {
        const { wallMs, internalMs, tokens } = runCommand(cmd);
        latencies.push(wallMs);
        internalSamples.push(internalMs);
        tokenSamples.push(tokens);
        const intStr = internalMs !== null ? ` internal=${internalMs.toFixed(1)}ms` : '';
        const tokStr = tokens !== null ? ` ~${tokens} tok` : '';
        console.log(`${cmd}: iter ${i}/${iterations} ... wall=${wallMs.toFixed(0)}ms${intStr}${tokStr}`);
        appendCsvRow(timestamp, commit, cmd, i, wallMs, internalMs, tokens);
      } catch (err) {
        console.log(`${cmd}: iter ${i}/${iterations} ... ERROR: ${err.message.split('\n')[0]}`);
      }
    }

    if (latencies.length > 0) {
      printSummary(cmd, latencies, internalSamples, tokenSamples);
    } else {
      console.log(`\n--- ${cmd}: all iterations failed ---`);
    }
  }

  console.log('\nDone. Results appended to: ' + CSV_PATH);
}

main().catch((err) => {
  console.error('bench-handoff fatal:', err.message);
  process.exit(1);
});
