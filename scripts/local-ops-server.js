#!/usr/bin/env node
'use strict';

/**
 * local-ops-server.js
 *
 * Local Mac operations console for heavy matching workflows.
 * It intentionally runs only local scripts; Cloud Run remains review-only.
 */

const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { Storage } = require('@google-cloud/storage');

const REPO_ROOT = path.resolve(__dirname, '..');
const DATA_ROOT = path.join(REPO_ROOT, 'data');
const PORT = Number(process.env.OPS_PORT || 3030);
const HOST = process.env.OPS_HOST || '127.0.0.1';
const GCS_BUCKET = normalizeBucket(process.env.GCS_BUCKET || 'realestate-475615-data');
const CLOUD_REVIEW_URL = process.env.REVIEW_UI_URL || 'https://match-review-n3z7pwcwsa-ue.a.run.app';
const DINO_URL = process.env.DINO_URL || 'http://127.0.0.1:8000/health';
const MAX_LOG_LINES = 900;

const app = express();
const storage = new Storage();
const bucket = storage.bucket(GCS_BUCKET);
const jobs = new Map();
const longJobs = new Map();
let nextJobId = 1;
let trialSummaryCache = { loadedAt: 0, summaries: [] };

const COMMUNITY_NAMES = {
  'alphaville-1': 'Alphaville 1',
  'tambore-xi': 'Tamboré XI',
};

app.use(express.json({ limit: '64kb' }));

function normalizeBucket(value) {
  return String(value || '').replace(/^gs:\/\//, '').replace(/\/+$/, '');
}

function rel(file) {
  return path.relative(REPO_ROOT, file).split(path.sep).join('/');
}

function communityName(slug) {
  return COMMUNITY_NAMES[slug] || slug;
}

function readJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function fileStamp(file) {
  try {
    const stat = fs.statSync(file);
    return stat.mtime.toISOString();
  } catch (_) {
    return null;
  }
}

function listCompounds() {
  if (!fs.existsSync(DATA_ROOT)) return [];
  const ignored = new Set(['vivaprimeimoveis', 'coelhodafonseca', 'review-rounds', 'legacy', 'raw', 'processed']);
  return fs.readdirSync(DATA_ROOT)
    .filter((name) => {
      const dir = path.join(DATA_ROOT, name);
      if (!fs.statSync(dir).isDirectory() || ignored.has(name)) return false;
      return fs.existsSync(path.join(dir, 'fresh-listings'))
        || fs.existsSync(path.join(dir, 'live-listing-inventory'))
        || fs.existsSync(path.join(dir, 'pipeline-state.json'))
        || fs.existsSync(path.join(dir, 'listings'));
    })
    .sort((a, b) => a.localeCompare(b));
}

function siteListingCount(compound, group, site) {
  const file = path.join(DATA_ROOT, compound, group, `${site}.json`);
  const json = readJson(file, {});
  return Array.isArray(json.listings) ? json.listings.length : null;
}

function compoundSummary(compound) {
  const manifest = readJson(path.join(DATA_ROOT, compound, 'fresh-gcs-sync-manifest.json'), {});
  return {
    slug: compound,
    viva: {
      fresh_listings: siteListingCount(compound, 'fresh-listings', 'vivaprimeimoveis'),
      live_inventory: siteListingCount(compound, 'live-listing-inventory', 'vivaprimeimoveis'),
    },
    coelho: {
      fresh_listings: siteListingCount(compound, 'fresh-listings', 'coelhodafonseca'),
      live_inventory: siteListingCount(compound, 'live-listing-inventory', 'coelhodafonseca'),
    },
    gcs_files: typeof manifest.files === 'number' ? manifest.files : null,
    gcs_prefix: manifest.prefix || `compounds/${compound}`,
    last_sync: manifest.generated_at || null,
  };
}

function execFileText(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, {
      cwd: REPO_ROOT,
      timeout: options.timeout || 5000,
      maxBuffer: options.maxBuffer || 1024 * 1024,
    }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err && typeof err.code === 'number' ? err.code : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error: err ? err.message : null,
      });
    });
  });
}

async function gitSummary() {
  const status = await execFileText('git', ['status', '--short', '--branch'], { timeout: 3000 });
  const lines = status.stdout.trim().split('\n').filter(Boolean);
  const branchLine = lines[0] || '';
  const branch = branchLine.replace(/^##\s*/, '') || 'unknown';
  return {
    branch,
    dirty_count: Math.max(0, lines.length - 1),
    has_uncommitted: lines.length > 1,
  };
}

function httpJson(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: JSON.parse(body) });
        } catch (_) {
          resolve({ ok: false, status: res.statusCode, data: null });
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: 0, data: null });
    });
    req.on('error', () => resolve({ ok: false, status: 0, data: null }));
  });
}

async function dinoStatus() {
  const health = await httpJson(DINO_URL);
  const job = longJobs.get('dino');
  return {
    running: health.ok,
    source: job ? 'console' : (health.ok ? 'external' : 'offline'),
    job_id: job ? job.id : null,
    health: health.data,
  };
}

async function externalProcesses() {
  const result = await execFileText('pgrep', ['-af', 'scripts/mac-round-worker.js|uvicorn main:app|local-ops-server.js'], { timeout: 2000 });
  const lines = result.stdout.trim().split('\n').filter(Boolean);
  return lines
    .filter(line => !line.includes(` ${process.pid} `))
    .slice(0, 12);
}

async function queuedRoundJobs() {
  try {
    const [files] = await bucket.getFiles({ prefix: 'review-sessions/round-jobs/' });
    const jobs = [];
    for (const file of files.slice(-80)) {
      if (!file.name.endsWith('.json')) continue;
      try {
        const [contents] = await file.download();
        const status = JSON.parse(contents.toString());
        if (['queued', 'running', 'failed', 'ready'].includes(status.state)) {
          jobs.push({
            path: file.name,
            state: status.state,
            round: status.round || null,
            updated_at: status.updated_at || status.requested_at || null,
            message: status.message || '',
          });
        }
      } catch (_) {
        // Ignore unreadable job state files.
      }
    }
    return { ok: true, jobs: jobs.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || ''))).slice(0, 12) };
  } catch (err) {
    return { ok: false, error: err.message, jobs: [] };
  }
}

function reportsSummary() {
  const verificationFile = path.join(DATA_ROOT, 'compound-fresh-assets-verification.json');
  const syncFile = path.join(DATA_ROOT, 'compound-fresh-gcs-sync-report.json');
  const auditFile = path.join(DATA_ROOT, 'live-listing-count-audit.json');
  const detailFile = path.join(DATA_ROOT, 'live-listing-detail-scrape-report.json');
  const imageFile = path.join(DATA_ROOT, 'fresh-image-download-report.json');
  const verification = readJson(verificationFile, {});
  const sync = readJson(syncFile, {});
  return {
    verification: {
      path: rel(verificationFile),
      updated_at: fileStamp(verificationFile),
      totals: verification.totals || null,
      require_gcs: Boolean(verification.require_gcs),
    },
    sync: {
      path: rel(syncFile),
      updated_at: fileStamp(syncFile),
      bucket: sync.bucket || GCS_BUCKET,
      compounds: sync.compounds || {},
    },
    audit: {
      path: rel(auditFile),
      updated_at: fileStamp(auditFile),
      totals: readJson(auditFile, {}).totals || null,
    },
    detail_scrape: {
      path: rel(detailFile),
      updated_at: fileStamp(detailFile),
      totals: readJson(detailFile, {}).totals || null,
    },
    images: {
      path: rel(imageFile),
      updated_at: fileStamp(imageFile),
      totals: readJson(imageFile, {}).totals || null,
    },
  };
}

function countManualMatches(compound) {
  const file = path.join(DATA_ROOT, compound, 'manual-matches.json');
  const json = readJson(file, {});
  const matches = Array.isArray(json.matches) ? json.matches : [];
  return new Set(matches.map(match => String(match.viva_code || '')).filter(Boolean)).size;
}

function countCandidatePairs(compound) {
  const file = path.join(DATA_ROOT, compound, 'deterministic-matches.json');
  const json = readJson(file, {});
  if (Array.isArray(json.candidate_pairs)) return json.candidate_pairs.length;
  return 0;
}

function latestVerificationByCompound(compound) {
  const report = readJson(path.join(DATA_ROOT, 'compound-fresh-assets-verification.json'), {});
  const sites = report.compounds?.[compound] || {};
  let issues = 0;
  let missing = 0;
  for (const siteReport of Object.values(sites)) {
    issues += Array.isArray(siteReport.issues) ? siteReport.issues.length : 0;
    missing += Array.isArray(siteReport.missing_gcs_files) ? siteReport.missing_gcs_files.length : 0;
  }
  return {
    ready: issues === 0 && missing === 0,
    issues,
    missing,
    updated_at: report.generated_at || fileStamp(path.join(DATA_ROOT, 'compound-fresh-assets-verification.json')),
  };
}

async function trialSummaries() {
  const now = Date.now();
  if (now - trialSummaryCache.loadedAt < 30000) return trialSummaryCache.summaries;
  try {
    const [files] = await bucket.getFiles({ prefix: 'review-sessions/trial-summaries/' });
    const summaries = [];
    for (const file of files) {
      if (!file.name.endsWith('.json')) continue;
      try {
        const [[metadata], [contents]] = await Promise.all([file.getMetadata(), file.download()]);
        const json = JSON.parse(contents.toString());
        if (!json || typeof json !== 'object' || !json.total_viva_listings) continue;
        summaries.push({
          path: file.name,
          updated_at: metadata.updated || json.generated_at || null,
          trial_run_id: json.trial_run_id || null,
          pass: json.pass || null,
          total_viva_listings: Number(json.total_viva_listings) || 0,
          total_coelho_listings: Number(json.total_coelho_listings) || 0,
          total_confirmed: Number(json.total_confirmed) || 0,
          confirmed_viva_count: Number(json.confirmed_viva_count || json.total_confirmed) || 0,
          pending_viva_count: Number(json.pending_viva_count) || 0,
          reviewed_unmatched_viva_count: Number(json.reviewed_unmatched_viva_count) || 0,
        });
      } catch (_) {
        // Ignore malformed historical summaries.
      }
    }
    summaries.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
    trialSummaryCache = { loadedAt: now, summaries };
    return summaries;
  } catch (_) {
    trialSummaryCache = { loadedAt: now, summaries: [] };
    return [];
  }
}

async function matchingStatus() {
  const compounds = listCompounds();
  const summaries = await trialSummaries();
  const queue = await queuedRoundJobs();
  const communities = compounds.map((compound) => {
    const total = siteListingCount(compound, 'fresh-listings', 'vivaprimeimoveis')
      || siteListingCount(compound, 'live-listing-inventory', 'vivaprimeimoveis')
      || 0;
    const summary = summaries.find(item => item.total_viva_listings === total);
    const matched = Math.min(total, summary ? summary.confirmed_viva_count : countManualMatches(compound));
    const remaining = Math.max(0, total - matched);
    const verification = latestVerificationByCompound(compound);
    return {
      slug: compound,
      name: communityName(compound),
      total_properties: total,
      matched_properties: matched,
      remaining_properties: remaining,
      candidate_groups: countCandidatePairs(compound),
      latest_round: summary?.pass || null,
      latest_trial_run_id: summary?.trial_run_id || null,
      latest_updated_at: summary?.updated_at || null,
      storage_ready: verification.ready,
      storage_missing: verification.missing,
      storage_issues: verification.issues,
      storage_checked_at: verification.updated_at,
    };
  });
  return {
    generated_at: new Date().toISOString(),
    bucket: GCS_BUCKET,
    review_url: CLOUD_REVIEW_URL,
    communities,
    queue,
    worker_running: longJobs.has('worker'),
    jobs: Array.from(jobs.values()).slice(-8).reverse().map(publicJob),
  };
}

function publicJob(job) {
  return {
    id: job.id,
    kind: job.kind,
    label: job.label,
    command: [job.command, ...job.args].join(' '),
    status: job.status,
    started_at: job.started_at,
    ended_at: job.ended_at,
    exit_code: job.exit_code,
    signal: job.signal,
    log: job.log,
  };
}

function appendLog(job, chunk) {
  const lines = String(chunk)
    .replace(/\r/g, '')
    .split('\n')
    .filter(line => line.length);
  for (const line of lines) {
    job.log.push({ at: new Date().toISOString(), text: line });
  }
  if (job.log.length > MAX_LOG_LINES) {
    job.log.splice(0, job.log.length - MAX_LOG_LINES);
  }
}

function spawnJob({ kind, label, command, args, cwd = REPO_ROOT, env = {}, singleton = null }) {
  if (singleton && longJobs.has(singleton)) {
    const existing = longJobs.get(singleton);
    return existing;
  }

  const job = {
    id: String(nextJobId++),
    kind,
    label,
    command,
    args,
    cwd,
    status: 'running',
    started_at: new Date().toISOString(),
    ended_at: null,
    exit_code: null,
    signal: null,
    log: [],
    child: null,
    singleton,
  };
  appendLog(job, `$ ${[command, ...args].join(' ')}`);

  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, GCS_BUCKET, ...env },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  job.child = child;
  jobs.set(job.id, job);
  if (singleton) longJobs.set(singleton, job);

  child.stdout.on('data', data => appendLog(job, data));
  child.stderr.on('data', data => appendLog(job, data));
  child.on('error', err => {
    appendLog(job, err.message);
    job.status = 'failed';
    job.ended_at = new Date().toISOString();
    if (singleton && longJobs.get(singleton)?.id === job.id) longJobs.delete(singleton);
  });
  child.on('exit', (code, signal) => {
    job.exit_code = code;
    job.signal = signal;
    job.ended_at = new Date().toISOString();
    if (job.status === 'stopping') job.status = 'stopped';
    else job.status = code === 0 ? 'succeeded' : 'failed';
    appendLog(job, `Process exited with ${signal || code}`);
    if (singleton && longJobs.get(singleton)?.id === job.id) longJobs.delete(singleton);
  });

  return job;
}

function stopJob(job) {
  if (!job || !job.child || job.status !== 'running') return false;
  job.status = 'stopping';
  appendLog(job, 'Stopping process ...');
  try {
    if (process.platform !== 'win32') process.kill(-job.child.pid, 'SIGINT');
    else job.child.kill('SIGINT');
  } catch (_) {
    try { job.child.kill('SIGTERM'); } catch (__) {}
  }
  setTimeout(() => {
    if (job.status === 'stopping') {
      try {
        if (process.platform !== 'win32') process.kill(-job.child.pid, 'SIGTERM');
        else job.child.kill('SIGTERM');
      } catch (_) {}
    }
  }, 3500).unref();
  return true;
}

function actionCommand(action, body = {}) {
  const compound = body.compound && body.compound !== 'all' ? String(body.compound) : 'all';
  if (action === 'start-dino') {
    return {
      singleton: 'dino',
      kind: 'service',
      label: 'AI image engine',
      command: process.env.DINO_PYTHON || 'python3.11',
      args: ['-m', 'uvicorn', 'main:app', '--host', '0.0.0.0', '--port', '8000', '--workers', '1'],
      cwd: path.join(REPO_ROOT, 'dino-server'),
    };
  }
  if (action === 'scrape-sync') {
    const args = ['./scripts/scrape-all-compounds-to-gcs.sh', '--compound', compound, '--bucket', GCS_BUCKET];
    if (body.skipDino) args.push('--skip-dino');
    if (body.skipMosaics) args.push('--skip-mosaics');
    return { kind: 'pipeline', label: `Update property data (${compound})`, command: args[0], args: args.slice(1) };
  }
  if (action === 'verify-gcs') {
    return {
      kind: 'check',
      label: `Check cloud storage (${compound})`,
      command: 'node',
      args: [
        'scripts/verify-compound-fresh-assets.js',
        '--compound', compound,
        '--bucket', GCS_BUCKET,
        '--require-gcs',
        '--require-selected',
        '--require-mosaics',
      ],
    };
  }
  if (action === 'dry-run') {
    return {
      kind: 'check',
      label: `Test update flow (${compound})`,
      command: './scripts/scrape-all-compounds-to-gcs.sh',
      args: ['--compound', compound, '--dry-run', '--skip-dino', '--skip-mosaics', '--skip-gcs', '--skip-verify'],
    };
  }
  if (action === 'worker-once') {
    return {
      kind: 'worker',
      label: 'Process next review round',
      command: 'node',
      args: ['scripts/mac-round-worker.js', '--bucket', GCS_BUCKET, '--once'],
    };
  }
  if (action === 'worker-watch') {
    return {
      singleton: 'worker',
      kind: 'worker',
      label: 'Auto-process review queue',
      command: 'node',
      args: ['scripts/mac-round-worker.js', '--bucket', GCS_BUCKET],
    };
  }
  throw new Error(`Unknown action: ${action}`);
}

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/status', async (_req, res) => {
  const compounds = listCompounds();
  const [git, dino, processes, queue] = await Promise.all([
    gitSummary(),
    dinoStatus(),
    externalProcesses(),
    queuedRoundJobs(),
  ]);
  res.json({
    generated_at: new Date().toISOString(),
    host: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    repo: REPO_ROOT,
    bucket: GCS_BUCKET,
    review_url: CLOUD_REVIEW_URL,
    git,
    dino,
    worker: {
      running: longJobs.has('worker'),
      job_id: longJobs.get('worker')?.id || null,
    },
    queue,
    processes,
    compounds: compounds.map(compoundSummary),
    reports: reportsSummary(),
    jobs: Array.from(jobs.values()).slice(-12).reverse().map(publicJob),
  });
});

app.get('/api/matching-status', async (_req, res) => {
  res.json(await matchingStatus());
});

app.get('/api/jobs', (_req, res) => {
  res.json({ jobs: Array.from(jobs.values()).slice(-30).reverse().map(publicJob) });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  res.json({ job: publicJob(job) });
});

app.post('/api/jobs/:id/stop', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  res.json({ stopped: stopJob(job), job: publicJob(job) });
});

app.post('/api/actions/:action', async (req, res) => {
  try {
    if (req.params.action === 'stop-dino') {
      const job = longJobs.get('dino');
      res.json({ stopped: stopJob(job), job: job ? publicJob(job) : null });
      return;
    }
    if (req.params.action === 'stop-worker') {
      const job = longJobs.get('worker');
      res.json({ stopped: stopJob(job), job: job ? publicJob(job) : null });
      return;
    }
    if (req.params.action === 'start-dino') {
      const health = await dinoStatus();
      if (health.running && !longJobs.has('dino')) {
        res.status(409).json({ error: 'DINO already answers on port 8000 outside this console.' });
        return;
      }
    }
    const config = actionCommand(req.params.action, req.body || {});
    const job = spawnJob(config);
    res.json({ job: publicJob(job) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/matching/run', async (_req, res) => {
  try {
    const status = await matchingStatus();
    const waiting = (status.queue.jobs || []).filter(job => job.state === 'queued').length;
    const job = spawnJob(actionCommand('worker-once', {}));
    res.json({
      job: publicJob(job),
      queued_rounds: waiting,
      message: waiting
        ? 'This Mac is processing the next matching round.'
        : 'No waiting round was found. The run will finish quickly unless a new round appears.',
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/', (_req, res) => {
  res.type('html').send(renderHtml());
});

app.get('/match', (_req, res) => {
  res.type('html').send(renderMatchHtml());
});

function renderMatchHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Property Matching</title>
  <style>
    :root {
      --bg: #f5f7fa;
      --panel: #ffffff;
      --line: #d8dee8;
      --line-strong: #b8c2d0;
      --text: #111827;
      --muted: #5b6575;
      --blue: #2563eb;
      --green: #15803d;
      --amber: #b45309;
      --red: #b91c1c;
      --soft: #eef2f7;
      --shadow: 0 14px 40px rgba(15, 23, 42, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    button, select { font: inherit; letter-spacing: 0; }
    .app {
      max-width: 980px;
      margin: 0 auto;
      padding: 22px;
    }
    .top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      padding-bottom: 18px;
      border-bottom: 1px solid var(--line);
      margin-bottom: 18px;
    }
    h1 {
      margin: 0;
      font-size: 24px;
      line-height: 1.15;
    }
    .sub {
      margin-top: 6px;
      color: var(--muted);
      font-size: 14px;
    }
    .admin-link {
      color: var(--blue);
      text-decoration: none;
      font-weight: 700;
      white-space: nowrap;
      font-size: 14px;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
      overflow: hidden;
      margin-bottom: 16px;
    }
    .panel-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
      padding: 15px 16px;
      border-bottom: 1px solid var(--line);
      background: #fbfcfe;
    }
    .panel-head h2 {
      margin: 0;
      font-size: 16px;
    }
    .body { padding: 16px; }
    label {
      display: grid;
      gap: 6px;
      color: var(--muted);
      font-size: 13px;
      font-weight: 650;
      margin-bottom: 14px;
    }
    select {
      width: 100%;
      height: 46px;
      border: 1px solid var(--line-strong);
      border-radius: 7px;
      padding: 0 12px;
      background: #fff;
      color: var(--text);
    }
    .hero {
      display: grid;
      gap: 16px;
      grid-template-columns: minmax(0, 1fr) 220px;
      align-items: center;
    }
    .progress-card {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 15px;
      background: #fbfcfe;
    }
    .progress-title {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 10px;
      color: var(--muted);
      font-size: 13px;
    }
    .bar {
      height: 14px;
      border-radius: 999px;
      background: #dbe4ef;
      overflow: hidden;
    }
    .bar > div {
      height: 100%;
      width: 0%;
      border-radius: 999px;
      background: var(--blue);
      transition: width 180ms ease;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
      margin-top: 12px;
    }
    .stat {
      min-height: 82px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      background: #fff;
    }
    .stat span {
      display: block;
      color: var(--muted);
      font-size: 12px;
    }
    .stat strong {
      display: block;
      margin-top: 8px;
      font-size: 28px;
      line-height: 1;
    }
    .status-box {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
      background: #fff;
    }
    .status-box strong {
      display: block;
      font-size: 15px;
      margin-bottom: 5px;
    }
    .status-box p {
      margin: 0;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.4;
    }
    .actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-top: 14px;
    }
    .btn, .link-btn {
      min-height: 48px;
      border: 1px solid var(--line-strong);
      border-radius: 7px;
      padding: 0 14px;
      background: var(--soft);
      color: var(--text);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      text-align: center;
      text-decoration: none;
      font-weight: 760;
    }
    .btn.primary, .link-btn.primary {
      background: var(--blue);
      border-color: var(--blue);
      color: #fff;
    }
    .btn:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
    .steps {
      display: grid;
      gap: 10px;
    }
    .step {
      display: grid;
      grid-template-columns: 32px minmax(0, 1fr);
      gap: 10px;
      align-items: start;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      background: #fbfcfe;
    }
    .num {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: #dbeafe;
      color: #1d4ed8;
      font-weight: 800;
      font-size: 13px;
    }
    .step strong { display: block; margin-bottom: 4px; }
    .step span { color: var(--muted); font-size: 13px; line-height: 1.4; }
    .runs {
      display: grid;
      gap: 8px;
    }
    .run {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fbfcfe;
      padding: 10px;
      display: flex;
      justify-content: space-between;
      gap: 12px;
      color: var(--muted);
      font-size: 13px;
    }
    .tag {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 3px 8px;
      background: #fff;
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }
    .tag.running { color: var(--blue); background: #eff6ff; border-color: #bfdbfe; }
    .tag.succeeded { color: var(--green); background: #f0fdf4; border-color: #bbf7d0; }
    .tag.failed { color: var(--red); background: #fff5f5; border-color: #fecaca; }
    .toast {
      position: fixed;
      left: 16px;
      right: 16px;
      bottom: 16px;
      max-width: 560px;
      margin: 0 auto;
      border: 1px solid var(--line-strong);
      border-radius: 8px;
      background: #fff;
      box-shadow: var(--shadow);
      padding: 12px 14px;
      display: none;
      z-index: 10;
    }
    .toast.show { display: block; }
    @media (max-width: 760px) {
      .app { padding: 12px; }
      .top { display: block; }
      .admin-link { display: inline-block; margin-top: 10px; }
      .hero { grid-template-columns: 1fr; }
      .stats { grid-template-columns: 1fr; }
      .actions { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="app">
    <header class="top">
      <div>
        <h1>Property Matching</h1>
        <div class="sub">Choose a community, review what is already matched, then run the next matching round when needed.</div>
      </div>
      <a class="admin-link" href="/">Admin console</a>
    </header>

    <section class="panel">
      <div class="panel-head">
        <h2>Community</h2>
        <span class="tag" id="roundTag">Loading</span>
      </div>
      <div class="body">
        <label>Choose community
          <select id="communitySelect"></select>
        </label>
        <div class="hero">
          <div class="progress-card">
            <div class="progress-title">
              <span id="progressLabel">Matched properties</span>
              <strong id="progressPct">0%</strong>
            </div>
            <div class="bar"><div id="progressBar"></div></div>
            <div class="stats">
              <div class="stat"><span>Matched</span><strong id="matchedCount">0</strong></div>
              <div class="stat"><span>Still to match</span><strong id="remainingCount">0</strong></div>
              <div class="stat"><span>Total</span><strong id="totalCount">0</strong></div>
            </div>
          </div>
          <div class="status-box">
            <strong id="statusTitle">Loading</strong>
            <p id="statusText">Reading matching status from this Mac and cloud storage.</p>
          </div>
        </div>
        <div class="actions">
          <button class="btn primary" id="runButton">Run next matching round</button>
          <a class="link-btn" id="reviewButton" href="${CLOUD_REVIEW_URL}" target="_blank" rel="noreferrer">Review matches</a>
        </div>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>How It Works</h2></div>
      <div class="body">
        <div class="steps">
          <div class="step"><span class="num">1</span><div><strong>Review current matches</strong><span>Open the review screen and confirm the suggested pairs.</span></div></div>
          <div class="step"><span class="num">2</span><div><strong>Run the next round</strong><span>When the current round is done, this Mac searches again using the remaining properties.</span></div></div>
          <div class="step"><span class="num">3</span><div><strong>Repeat until complete</strong><span>The remaining count goes down as properties are confirmed.</span></div></div>
        </div>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>Recent Runs</h2><span class="tag" id="queueTag">No queue</span></div>
      <div class="body">
        <div class="runs" id="runs"></div>
      </div>
    </section>
  </div>
  <div class="toast" id="toast"></div>
  <script>
    const state = { data: null, selected: null };
    const $ = (id) => document.getElementById(id);
    function fmt(value) { return Number(value || 0).toLocaleString(); }
    function pct(matched, total) { return total ? Math.round((matched / total) * 100) : 0; }
    function toast(message) {
      const el = $('toast');
      el.textContent = message;
      el.classList.add('show');
      clearTimeout(toast.timer);
      toast.timer = setTimeout(() => el.classList.remove('show'), 4200);
    }
    async function api(path, options) {
      const res = await fetch(path, options);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Request failed');
      return data;
    }
    async function refresh() {
      try {
        state.data = await api('/api/matching-status');
        if (!state.selected && state.data.communities[0]) state.selected = state.data.communities[0].slug;
        render();
      } catch (err) {
        toast(err.message);
      }
    }
    function currentCommunity() {
      return (state.data?.communities || []).find(c => c.slug === state.selected) || (state.data?.communities || [])[0] || null;
    }
    function render() {
      const data = state.data;
      if (!data) return;
      const select = $('communitySelect');
      const current = currentCommunity();
      select.innerHTML = data.communities.map(c => '<option value="' + c.slug + '">' + c.name + '</option>').join('');
      if (current) select.value = current.slug;
      $('reviewButton').href = data.review_url;
      const queued = (data.queue.jobs || []).filter(job => job.state === 'queued').length;
      $('queueTag').textContent = queued ? queued + ' waiting' : 'No waiting round';

      if (!current) {
        $('statusTitle').textContent = 'No communities found';
        $('statusText').textContent = 'Ask the admin to configure communities first.';
        return;
      }
      const percent = pct(current.matched_properties, current.total_properties);
      $('matchedCount').textContent = fmt(current.matched_properties);
      $('remainingCount').textContent = fmt(current.remaining_properties);
      $('totalCount').textContent = fmt(current.total_properties);
      $('progressPct').textContent = percent + '%';
      $('progressBar').style.width = percent + '%';
      $('progressLabel').textContent = current.name + ' matching progress';
      $('roundTag').textContent = current.latest_round ? 'Round ' + current.latest_round : 'Not started';

      if (current.remaining_properties === 0 && current.total_properties > 0) {
        $('statusTitle').textContent = 'This community is complete';
        $('statusText').textContent = 'All properties have confirmed matches.';
        $('runButton').disabled = true;
      } else if (!current.storage_ready) {
        $('statusTitle').textContent = 'Admin refresh needed';
        $('statusText').textContent = 'Some cloud assets need to be refreshed before matching is fully reliable.';
        $('runButton').disabled = false;
      } else if (queued > 0) {
        $('statusTitle').textContent = 'Next round is ready to run';
        $('statusText').textContent = 'Use this Mac to process the queued matching round, then continue reviewing.';
        $('runButton').disabled = false;
      } else {
        $('statusTitle').textContent = current.matched_properties ? 'Continue reviewing' : 'Ready to start matching';
        $('statusText').textContent = 'Open the review screen to confirm suggested matches. Run the next round after the current review is finished.';
        $('runButton').disabled = false;
      }

      $('runs').innerHTML = (data.jobs || []).map(job => {
        return '<div class="run"><span><strong>' + job.label + '</strong><br>' + new Date(job.started_at).toLocaleString() + '</span><span class="tag ' + job.status + '">' + job.status + '</span></div>';
      }).join('') || '<div class="run"><span>No local matching runs started from this page.</span><span class="tag">Idle</span></div>';
    }
    $('communitySelect').addEventListener('change', () => {
      state.selected = $('communitySelect').value;
      render();
    });
    $('runButton').addEventListener('click', async () => {
      $('runButton').disabled = true;
      try {
        const result = await api('/api/matching/run', { method: 'POST' });
        toast(result.message || 'Matching round started.');
        await refresh();
      } catch (err) {
        toast(err.message);
      } finally {
        $('runButton').disabled = false;
      }
    });
    refresh();
    setInterval(refresh, 5000);
  </script>
</body>
</html>`;
}

function renderHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mac Operations Console</title>
  <style>
    :root {
      --bg: #f5f7fa;
      --panel: #ffffff;
      --line: #d8dee8;
      --line-strong: #b8c2d0;
      --text: #111827;
      --muted: #5b6575;
      --soft: #eef2f7;
      --blue: #2563eb;
      --teal: #0f766e;
      --amber: #b45309;
      --red: #b91c1c;
      --green: #15803d;
      --shadow: 0 14px 40px rgba(15, 23, 42, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 15px;
      letter-spacing: 0;
    }
    button, select, input {
      font: inherit;
      letter-spacing: 0;
    }
    .app {
      max-width: 1440px;
      margin: 0 auto;
      padding: 20px;
    }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      min-height: 72px;
      border-bottom: 1px solid var(--line);
      margin-bottom: 18px;
    }
    .title h1 {
      margin: 0;
      font-size: 22px;
      line-height: 1.2;
      font-weight: 750;
    }
    .title p {
      margin: 5px 0 0;
      color: var(--muted);
      font-size: 13px;
    }
    .status-strip {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: flex-end;
    }
    .pill {
      min-height: 30px;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 5px 10px;
      background: var(--panel);
      color: var(--muted);
      white-space: nowrap;
      font-size: 13px;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--line-strong);
      flex: 0 0 auto;
    }
    .ok .dot { background: var(--green); }
    .warn .dot { background: var(--amber); }
    .bad .dot { background: var(--red); }
    .grid {
      display: grid;
      grid-template-columns: minmax(0, 1.1fr) minmax(360px, 0.9fr);
      gap: 16px;
      align-items: start;
    }
    .grid > section,
    .grid > aside {
      min-width: 0;
    }
    .panel {
      min-width: 0;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
      overflow: hidden;
    }
    .panel + .panel { margin-top: 16px; }
    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 16px;
      border-bottom: 1px solid var(--line);
      background: #fbfcfe;
    }
    .panel-header h2 {
      margin: 0;
      font-size: 15px;
      line-height: 1.2;
    }
    .panel-body { padding: 16px; }
    .actions {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
    }
    .workflow {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .task-btn,
    .task-link {
      min-height: 96px;
      border: 1px solid var(--line-strong);
      border-radius: 8px;
      background: #fbfcfe;
      color: var(--text);
      padding: 13px;
      cursor: pointer;
      display: grid;
      align-content: start;
      gap: 8px;
      text-align: left;
      text-decoration: none;
    }
    .task-btn:hover,
    .task-link:hover {
      border-color: #94a3b8;
      background: #f3f6fb;
    }
    .task-btn.primary {
      background: var(--blue);
      border-color: var(--blue);
      color: #fff;
    }
    .task-btn.primary:hover {
      background: #1d4ed8;
      border-color: #1d4ed8;
    }
    .task-kicker {
      font-size: 12px;
      font-weight: 700;
      color: var(--muted);
    }
    .task-btn.primary .task-kicker,
    .task-btn.primary .task-meta {
      color: rgba(255, 255, 255, 0.78);
    }
    .task-title {
      font-size: 17px;
      line-height: 1.2;
      font-weight: 760;
    }
    .task-meta {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.35;
    }
    .recommendation {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      align-items: center;
      margin-bottom: 14px;
      padding: 12px;
      border: 1px solid #bfdbfe;
      border-radius: 8px;
      background: #eff6ff;
    }
    .recommendation strong {
      display: block;
      font-size: 14px;
      margin-bottom: 3px;
    }
    .recommendation span {
      color: #375a8c;
      font-size: 13px;
    }
    .control-row {
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
      margin-bottom: 14px;
    }
    .control-row label {
      display: grid;
      gap: 5px;
      color: var(--muted);
      font-size: 12px;
      min-width: 180px;
    }
    select {
      height: 38px;
      border: 1px solid var(--line-strong);
      border-radius: 6px;
      padding: 0 10px;
      background: #fff;
      color: var(--text);
    }
    .checks {
      display: flex;
      gap: 12px;
      align-items: center;
      color: var(--muted);
      font-size: 13px;
    }
    .checks label {
      min-width: auto;
      display: inline-flex;
      grid-template-columns: none;
      align-items: center;
      gap: 5px;
      color: var(--muted);
      font-size: 13px;
    }
    .checks input { margin: 0; }
    .btn {
      min-height: 42px;
      border: 1px solid var(--line-strong);
      border-radius: 6px;
      background: var(--soft);
      color: var(--text);
      padding: 0 12px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      font-weight: 650;
    }
    .btn:hover { border-color: #94a3b8; background: #e8eef6; }
    .btn:disabled { opacity: 0.55; cursor: not-allowed; }
    .primary { background: var(--blue); border-color: var(--blue); color: #fff; }
    .primary:hover { background: #1d4ed8; border-color: #1d4ed8; }
    .success { background: var(--teal); border-color: var(--teal); color: #fff; }
    .success:hover { background: #0d665f; border-color: #0d665f; }
    .danger { background: #fff5f5; color: var(--red); border-color: #fecaca; }
    .danger:hover { background: #fee2e2; border-color: #fca5a5; }
    .advanced {
      margin-top: 16px;
      border-top: 1px solid var(--line);
      padding-top: 14px;
    }
    .advanced summary {
      cursor: pointer;
      color: var(--muted);
      font-weight: 700;
      font-size: 13px;
      margin-bottom: 12px;
    }
    .service-actions {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      margin-top: 10px;
    }
    .metrics {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
    }
    .metric {
      min-height: 84px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      background: #fbfcfe;
    }
    .metric span {
      display: block;
      color: var(--muted);
      font-size: 12px;
    }
    .metric strong {
      display: block;
      margin-top: 8px;
      font-size: 24px;
      line-height: 1;
    }
    .table-wrap {
      overflow-x: auto;
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 640px;
      font-size: 13px;
    }
    th, td {
      text-align: left;
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
      white-space: nowrap;
    }
    th {
      color: var(--muted);
      background: #f8fafc;
      font-weight: 700;
    }
    tr:last-child td { border-bottom: 0; }
    .muted { color: var(--muted); }
    .jobs {
      display: grid;
      gap: 8px;
    }
    .job-row {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
      background: #fbfcfe;
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
      cursor: pointer;
      text-align: left;
    }
    .job-row.active { border-color: var(--blue); box-shadow: inset 3px 0 0 var(--blue); }
    .job-row strong { display: block; font-size: 13px; }
    .job-row span { color: var(--muted); font-size: 12px; }
    .tag {
      height: 24px;
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      border: 1px solid var(--line);
      padding: 0 8px;
      font-size: 12px;
      color: var(--muted);
      background: #fff;
    }
    .tag.running { color: var(--blue); border-color: #bfdbfe; background: #eff6ff; }
    .tag.succeeded { color: var(--green); border-color: #bbf7d0; background: #f0fdf4; }
    .tag.failed { color: var(--red); border-color: #fecaca; background: #fff5f5; }
    .tag.stopping, .tag.stopped { color: var(--amber); border-color: #fde68a; background: #fffbeb; }
    .logbox {
      height: 390px;
      overflow: auto;
      border: 1px solid #0f172a;
      border-radius: 8px;
      background: #101828;
      color: #d9e3f0;
      padding: 12px;
      font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      white-space: pre-wrap;
    }
    .small-list {
      display: grid;
      gap: 9px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .small-list li {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      border-bottom: 1px solid var(--line);
      padding-bottom: 9px;
      color: var(--muted);
      font-size: 13px;
    }
    .small-list li:last-child { border-bottom: 0; padding-bottom: 0; }
    .link {
      color: var(--blue);
      text-decoration: none;
      font-weight: 650;
    }
    .link:hover { text-decoration: underline; }
    .toast {
      position: fixed;
      right: 16px;
      bottom: 16px;
      max-width: 420px;
      border: 1px solid var(--line-strong);
      border-radius: 8px;
      background: #fff;
      box-shadow: var(--shadow);
      padding: 12px 14px;
      display: none;
      color: var(--text);
      z-index: 20;
    }
    .toast.show { display: block; }
    @media (max-width: 980px) {
      .grid { grid-template-columns: 1fr; }
      .workflow { grid-template-columns: 1fr; }
      .actions { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .topbar { align-items: flex-start; flex-direction: column; }
      .status-strip { justify-content: flex-start; }
    }
    @media (max-width: 620px) {
      .app { padding: 12px; }
      .actions, .metrics, .service-actions { grid-template-columns: 1fr; }
      .recommendation { grid-template-columns: 1fr; }
      .control-row label { min-width: 100%; }
      .checks { width: 100%; justify-content: flex-start; flex-wrap: wrap; }
      .checks label { min-width: auto; }
      .btn { width: 100%; }
      .panel-body { padding: 12px; }
      .logbox { height: 300px; }
    }
  </style>
</head>
<body>
  <div class="app">
    <header class="topbar">
      <div class="title">
        <h1>Mac Operations Console</h1>
        <p id="subtitle">Loading local status</p>
      </div>
      <div class="status-strip">
        <span class="pill" id="repoPill"><span class="dot"></span><span>Repo</span></span>
        <span class="pill" id="dinoPill"><span class="dot"></span><span>DINO</span></span>
        <span class="pill" id="workerPill"><span class="dot"></span><span>Worker</span></span>
        <span class="pill" id="gcsPill"><span class="dot"></span><span>GCS</span></span>
      </div>
    </header>

    <main class="grid">
      <section>
        <div class="panel">
          <div class="panel-header">
            <h2>What To Do</h2>
            <a class="link" id="reviewLink" href="${CLOUD_REVIEW_URL}" target="_blank" rel="noreferrer">Open review screen</a>
          </div>
          <div class="panel-body">
            <div class="recommendation">
              <div>
                <strong id="nextActionTitle">Checking current state</strong>
                <span id="nextActionMeta">The console is reading local reports and cloud queue state.</span>
              </div>
              <button class="btn primary" id="nextActionButton" type="button" data-next-action="verify-gcs">Run recommended action</button>
            </div>
            <div class="control-row">
              <label>Community
                <select id="compoundSelect"><option value="all">All communities</option></select>
              </label>
            </div>
            <div class="workflow">
              <button class="task-btn primary" data-action="scrape-sync">
                <span class="task-kicker">Step 1</span>
                <span class="task-title">Update property data</span>
                <span class="task-meta">Scrape the communities, refresh images, create matching assets, and save them to cloud storage.</span>
              </button>
              <button class="task-btn" data-action="verify-gcs">
                <span class="task-kicker">Step 2</span>
                <span class="task-title">Check cloud storage</span>
                <span class="task-meta">Confirm listings, images, selected assets, and mosaics are available for matching.</span>
              </button>
              <button class="task-btn" data-action="worker-once">
                <span class="task-kicker">Step 3</span>
                <span class="task-title">Process next review round</span>
                <span class="task-meta">Run one queued matching job on this Mac and publish the result.</span>
              </button>
              <a class="task-link" id="reviewTaskLink" href="${CLOUD_REVIEW_URL}" target="_blank" rel="noreferrer">
                <span class="task-kicker">Review</span>
                <span class="task-title">Open review screen</span>
                <span class="task-meta">Use the cloud review UI after a round is ready.</span>
              </a>
            </div>
            <details class="advanced">
              <summary>Advanced services</summary>
              <div class="control-row">
                <div class="checks">
                  <label><input type="checkbox" id="skipDino">Skip AI image selection</label>
                  <label><input type="checkbox" id="skipMosaics">Skip mosaic creation</label>
                </div>
              </div>
              <div class="service-actions">
                <button class="btn success" data-action="start-dino">Start AI engine</button>
                <button class="btn danger" data-action="stop-dino">Stop AI engine</button>
                <button class="btn" data-action="worker-watch">Auto-process review queue</button>
                <button class="btn danger" data-action="stop-worker">Stop auto-processing</button>
                <button class="btn" data-action="dry-run">Test update flow</button>
              </div>
            </details>
          </div>
        </div>

        <div class="panel">
          <div class="panel-header"><h2>Cloud Storage State</h2><span class="muted" id="verifiedAt"></span></div>
          <div class="panel-body">
            <div class="metrics">
              <div class="metric"><span>Communities</span><strong id="metricCompounds">0</strong></div>
              <div class="metric"><span>Listings</span><strong id="metricListings">0</strong></div>
              <div class="metric"><span>Stored assets</span><strong id="metricAssets">0</strong></div>
              <div class="metric"><span>Missing</span><strong id="metricMissing">0</strong></div>
            </div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-header"><h2>Communities</h2><span class="muted" id="bucketLabel"></span></div>
          <div class="panel-body">
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Community</th>
                    <th>Viva</th>
                    <th>Coelho</th>
                    <th>Stored files</th>
                    <th>Last sync</th>
                  </tr>
                </thead>
                <tbody id="compoundRows"></tbody>
              </table>
            </div>
          </div>
        </div>
      </section>

      <aside>
        <div class="panel">
          <div class="panel-header"><h2>Runs</h2><span class="muted" id="jobCount"></span></div>
          <div class="panel-body">
            <div class="jobs" id="jobs"></div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-header">
            <h2 id="logTitle">Run Log</h2>
            <button class="btn danger" id="stopSelected" type="button">Stop Run</button>
          </div>
          <div class="panel-body">
            <div class="logbox" id="logbox">No job selected.</div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-header"><h2>Review Rounds</h2><span class="muted" id="queueState"></span></div>
          <div class="panel-body">
            <ul class="small-list" id="queueList"></ul>
          </div>
        </div>

        <div class="panel">
          <div class="panel-header"><h2>Recent Checks</h2><span class="muted" id="hostLabel"></span></div>
          <div class="panel-body">
            <ul class="small-list" id="reportList"></ul>
          </div>
        </div>
      </aside>
    </main>
  </div>
  <div class="toast" id="toast"></div>

  <script>
    const state = { status: null, selectedJobId: null };
    const $ = (id) => document.getElementById(id);

    function fmtNumber(value) {
      return value == null ? '0' : Number(value).toLocaleString();
    }
    function fmtDate(value) {
      if (!value) return 'Never';
      try { return new Date(value).toLocaleString(); }
      catch (_) { return String(value); }
    }
    function text(value) {
      return value == null || value === '' ? '-' : String(value);
    }
    function communityName(slug) {
      const names = {
        'alphaville-1': 'Alphaville 1',
        'tambore-xi': 'Tamboré XI',
      };
      return names[slug] || slug;
    }
    function toast(message) {
      const el = $('toast');
      el.textContent = message;
      el.classList.add('show');
      window.clearTimeout(toast._timer);
      toast._timer = window.setTimeout(() => el.classList.remove('show'), 4200);
    }
    function pill(id, mode, label) {
      const el = $(id);
      el.className = 'pill ' + mode;
      el.querySelector('span:last-child').textContent = label;
    }
    async function api(path, options) {
      const res = await fetch(path, options);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Request failed');
      return data;
    }
    async function refresh() {
      try {
        state.status = await api('/api/status');
        render();
      } catch (err) {
        toast(err.message);
      }
    }
    function render() {
      const s = state.status;
      if (!s) return;
      $('subtitle').textContent = s.host + ' | ' + s.git.branch;
      $('bucketLabel').textContent = 'gs://' + s.bucket;
      $('hostLabel').textContent = s.host;
      $('reviewLink').href = s.review_url;
      $('reviewTaskLink').href = s.review_url;

      pill('repoPill', 'ok', 'Mac ready');
      pill('dinoPill', s.dino.running ? 'ok' : 'bad', s.dino.running ? 'AI engine ready' : 'AI engine off');
      pill('workerPill', s.worker.running ? 'ok' : 'warn', s.worker.running ? 'Auto-processing' : 'Manual mode');
      pill('gcsPill', s.queue.ok ? 'ok' : 'bad', s.queue.ok ? 'Cloud ready' : 'Cloud error');

      const totals = (s.reports.verification && s.reports.verification.totals) || {};
      $('metricCompounds').textContent = fmtNumber(s.compounds.length);
      $('metricListings').textContent = fmtNumber(totals.listings);
      $('metricAssets').textContent = fmtNumber(totals.gcs_expected_files || totals.local_expected_files);
      $('metricMissing').textContent = fmtNumber((totals.issues || 0) + (totals.missing_gcs_files || 0));
      $('verifiedAt').textContent = fmtDate(s.reports.verification.updated_at);

      renderRecommendation(s, totals);
      renderCompoundSelect(s.compounds);
      renderCompounds(s.compounds);
      renderJobs(s.jobs);
      renderSelectedJob(s.jobs);
      renderQueue(s.queue);
      renderReports(s.reports);
    }
    function queuedCount(status) {
      return ((status.queue && status.queue.jobs) || []).filter(job => job.state === 'queued').length;
    }
    function renderRecommendation(status, totals) {
      const missing = (totals.issues || 0) + (totals.missing_gcs_files || 0);
      const queued = queuedCount(status);
      let title = 'Review the latest data';
      let meta = 'The stored assets are complete. Open the review screen or process a queued round when one appears.';
      let action = 'verify-gcs';
      let label = 'Check storage';
      if (!status.dino.running) {
        title = 'Start the local AI engine';
        meta = 'Needed before updating property data or creating matching assets on the Mac.';
        action = 'start-dino';
        label = 'Start AI engine';
      } else if (missing > 0) {
        title = 'Fix cloud storage before matching';
        meta = missing + ' missing or invalid asset' + (missing === 1 ? '' : 's') + ' need attention.';
        action = 'verify-gcs';
        label = 'Check storage';
      } else if (queued > 0) {
        title = 'Process the next review round';
        meta = queued + ' matching job' + (queued === 1 ? ' is' : 's are') + ' waiting for this Mac.';
        action = 'worker-once';
        label = 'Process round';
      }
      $('nextActionTitle').textContent = title;
      $('nextActionMeta').textContent = meta;
      const button = $('nextActionButton');
      button.dataset.nextAction = action;
      button.textContent = label;
    }
    function renderCompoundSelect(compounds) {
      const select = $('compoundSelect');
      const current = select.value || 'all';
      select.innerHTML = '<option value="all">All communities</option>' + compounds.map(c => '<option value="' + c.slug + '">' + communityName(c.slug) + '</option>').join('');
      select.value = compounds.some(c => c.slug === current) ? current : 'all';
    }
    function renderCompounds(compounds) {
      $('compoundRows').innerHTML = compounds.map(c => {
        return '<tr>' +
          '<td><strong>' + communityName(c.slug) + '</strong></td>' +
          '<td>' + text(c.viva.fresh_listings) + '</td>' +
          '<td>' + text(c.coelho.fresh_listings) + '</td>' +
          '<td>' + text(c.gcs_files) + '</td>' +
          '<td>' + fmtDate(c.last_sync) + '</td>' +
        '</tr>';
      }).join('') || '<tr><td colspan="5">No communities found.</td></tr>';
    }
    function renderJobs(jobs) {
      $('jobCount').textContent = jobs.length ? jobs.length + ' recent' : 'No jobs';
      if (!state.selectedJobId && jobs[0]) state.selectedJobId = jobs[0].id;
      $('jobs').innerHTML = jobs.map(job => {
        const active = job.id === state.selectedJobId ? ' active' : '';
        return '<button class="job-row' + active + '" data-job="' + job.id + '">' +
          '<span><strong>' + job.label + '</strong><span>' + fmtDate(job.started_at) + '</span></span>' +
          '<span class="tag ' + job.status + '">' + job.status + '</span>' +
        '</button>';
      }).join('') || '<div class="muted">No jobs started.</div>';
      document.querySelectorAll('[data-job]').forEach(btn => {
        btn.onclick = () => { state.selectedJobId = btn.dataset.job; render(); };
      });
    }
    function renderSelectedJob(jobs) {
      const job = jobs.find(j => j.id === state.selectedJobId);
      const stop = $('stopSelected');
      if (!job) {
        $('logTitle').textContent = 'Run Log';
        $('logbox').textContent = 'No run selected.';
        stop.disabled = true;
        return;
      }
      $('logTitle').textContent = job.label;
      stop.disabled = !['running', 'stopping'].includes(job.status);
      $('logbox').textContent = (job.log || []).map(line => '[' + new Date(line.at).toLocaleTimeString() + '] ' + line.text).join('\\n') || 'Waiting for output.';
      const box = $('logbox');
      box.scrollTop = box.scrollHeight;
    }
    function renderQueue(queue) {
      $('queueState').textContent = queue.ok ? 'Latest rounds' : 'Unavailable';
      $('queueList').innerHTML = queue.jobs.map(job => {
        return '<li><span>' + text(job.path.split('/').pop()) + '<br><span class="muted">' + text(job.message) + '</span></span><strong>' + text(job.state) + '</strong></li>';
      }).join('') || '<li><span>No review rounds waiting</span><strong>-</strong></li>';
    }
    function renderReports(reports) {
      const rows = [
        ['Verification', reports.verification.updated_at],
        ['GCS sync', reports.sync.updated_at],
        ['Live audit', reports.audit.updated_at],
        ['Detail scrape', reports.detail_scrape.updated_at],
        ['Image download', reports.images.updated_at],
      ];
      $('reportList').innerHTML = rows.map(([label, stamp]) => {
        return '<li><span>' + label + '</span><strong>' + fmtDate(stamp) + '</strong></li>';
      }).join('');
    }
    function actionBody() {
      return {
        compound: $('compoundSelect').value,
        skipDino: $('skipDino').checked,
        skipMosaics: $('skipMosaics').checked,
      };
    }
    document.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const data = await api('/api/actions/' + btn.dataset.action, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(actionBody()),
          });
          if (data.job) state.selectedJobId = data.job.id;
          toast(data.stopped ? 'Stop signal sent.' : 'Job started.');
          await refresh();
        } catch (err) {
          toast(err.message);
        } finally {
          btn.disabled = false;
        }
      });
    });
    $('nextActionButton').addEventListener('click', async () => {
      const action = $('nextActionButton').dataset.nextAction;
      $('nextActionButton').disabled = true;
      try {
        const data = await api('/api/actions/' + action, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(actionBody()),
        });
        if (data.job) state.selectedJobId = data.job.id;
        toast('Run started.');
        await refresh();
      } catch (err) {
        toast(err.message);
      } finally {
        $('nextActionButton').disabled = false;
      }
    });
    $('stopSelected').addEventListener('click', async () => {
      if (!state.selectedJobId) return;
      try {
        await api('/api/jobs/' + state.selectedJobId + '/stop', { method: 'POST' });
        toast('Stop signal sent.');
        await refresh();
      } catch (err) {
        toast(err.message);
      }
    });
    refresh();
    setInterval(refresh, 3000);
  </script>
</body>
</html>`;
}

if (!Number.isFinite(PORT) || PORT < 1) {
  console.error('OPS_PORT must be a valid port.');
  process.exit(1);
}

const server = app.listen(PORT, HOST, () => {
  const lanHint = HOST === '127.0.0.1' || HOST === 'localhost'
    ? 'Set OPS_HOST=0.0.0.0 to expose it on your home network.'
    : `LAN host binding enabled on ${HOST}.`;
  console.log(`Mac Operations Console: http://${HOST}:${PORT}`);
  console.log(lanHint);
});

server.on('error', (err) => {
  console.error(err.message);
  process.exit(1);
});
