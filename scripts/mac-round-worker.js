#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Storage } = require('@google-cloud/storage');

const REPO_ROOT = path.resolve(__dirname, '..');

function argValue(args, name, fallback = null) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}

function hasFlag(args, name) {
  return args.includes(name);
}

function normalizeBucketName(value) {
  return String(value || '').replace(/^gs:\/\//, '').replace(/\/+$/, '');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function run(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      env: { ...process.env, ...env },
    });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}

async function readStatus(bucket, gcsPath) {
  const [contents] = await bucket.file(gcsPath).download();
  return JSON.parse(contents.toString());
}

async function writeStatus(bucket, gcsPath, patch) {
  let previous = {};
  try { previous = await readStatus(bucket, gcsPath); }
  catch (_) { previous = {}; }
  await bucket.file(gcsPath).save(JSON.stringify({
    ...previous,
    ...patch,
    updated_at: new Date().toISOString(),
  }, null, 2), { contentType: 'application/json' });
}

async function listQueuedJobs(bucket, { statusPath, round, trialRunId }) {
  if (statusPath) {
    try {
      const status = await readStatus(bucket, statusPath);
      return status.state === 'queued' ? [{ path: statusPath, status }] : [];
    } catch (e) {
      throw new Error(`Could not read ${statusPath}: ${e.message}`);
    }
  }

  const [files] = await bucket.getFiles({ prefix: 'review-sessions/round-jobs/' });
  const jobs = [];
  for (const file of files) {
    if (!file.name.endsWith('.json')) continue;
    try {
      const status = await readStatus(bucket, file.name);
      if (status.state !== 'queued') continue;
      if (round && Number(status.round) !== Number(round)) continue;
      if (trialRunId && status.trial_run_id !== trialRunId) continue;
      jobs.push({ path: file.name, status });
    } catch (e) {
      console.warn(`Skipping unreadable status ${file.name}: ${e.message}`);
    }
  }
  return jobs.sort((a, b) => {
    const at = a.status.requested_at || a.status.updated_at || '';
    const bt = b.status.requested_at || b.status.updated_at || '';
    return at.localeCompare(bt);
  });
}

async function claimJob(bucket, job) {
  const fresh = await readStatus(bucket, job.path);
  if (fresh.state !== 'queued') return null;
  const worker = {
    kind: 'mac',
    host: os.hostname(),
    pid: process.pid,
    cwd: REPO_ROOT,
  };
  await writeStatus(bucket, job.path, {
    state: 'running',
    compute_target: 'mac',
    worker,
    started_at: new Date().toISOString(),
    message: `Running round ${fresh.round} on Mac worker ${worker.host}`,
  });
  return { path: job.path, status: { ...fresh, worker } };
}

async function syncInputs(bucketName, options) {
  if (options.skipInputSync) return;
  const bucketArg = bucketName.startsWith('gs://') ? bucketName : `gs://${bucketName}`;
  const args = ['./scripts/sync-gcs-to-local.sh', '--bucket', bucketArg];
  if (options.withRawImages) args.push('--with-raw-images');
  if (options.skipSelected) args.push('--skip-selected');
  if (options.skipMosaics) args.push('--skip-mosaics');
  await run(args[0], args.slice(1));
}

async function summaryInput(bucket, status) {
  if (!status.summary_path) return ['--summary-url', status.summary_url];
  const localPath = path.join(
    REPO_ROOT,
    'data',
    'review-rounds',
    `pass-${status.round}`,
    'trial-summary.json'
  );
  await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
  await bucket.file(status.summary_path).download({ destination: localPath });
  return ['--summary', localPath];
}

async function runJob(bucket, bucketName, job, options) {
  const claimed = await claimJob(bucket, job);
  if (!claimed) return false;

  const status = claimed.status;
  if (!status.summary_url && !status.summary_path) {
    throw new Error(`Queued job ${claimed.path} is missing summary_url or summary_path`);
  }

  try {
    await syncInputs(bucketName, options);
    const summaryArgs = await summaryInput(bucket, status);
    await run('./scripts/run-next-review-round.sh', [
      ...summaryArgs,
      '--round', String(status.round),
    ], {
      GCS_BUCKET: bucketName,
      ROUND: String(status.round),
      ROUND_STATUS_PATH: claimed.path,
      ROUND_ARTIFACT_PREFIX: status.artifact_prefix || '',
      SUMMARY_URL: status.summary_url,
      TRIAL_RUN_ID: status.trial_run_id || '',
      ROUND_GENERATED_BY: 'mac-round-worker',
      SYNC_TO_GCS_NODE: 'true',
      ...(process.env.MEGALOC_DEVICE ? { MEGALOC_DEVICE: process.env.MEGALOC_DEVICE } : {}),
    });
    const after = await readStatus(bucket, claimed.path);
    if (after.state !== 'ready') {
      await writeStatus(bucket, claimed.path, {
        state: 'ready',
        round: status.round,
        trial_run_id: status.trial_run_id || null,
        message: `Round ${status.round} completed on Mac worker`,
      });
    }
    return true;
  } catch (err) {
    await writeStatus(bucket, claimed.path, {
      state: 'failed',
      round: status.round,
      trial_run_id: status.trial_run_id || null,
      message: err.message,
      failed_at: new Date().toISOString(),
    });
    throw err;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const bucketName = normalizeBucketName(argValue(args, '--bucket', process.env.GCS_BUCKET || 'realestate-475615-data'));
  const statusPath = argValue(args, '--status', '');
  const round = argValue(args, '--round', '');
  const trialRunId = argValue(args, '--trial-run-id', '');
  const once = hasFlag(args, '--once');
  const pollMs = Number(argValue(args, '--poll-ms', '15000'));
  const options = {
    skipInputSync: hasFlag(args, '--skip-input-sync'),
    withRawImages: hasFlag(args, '--with-raw-images'),
    skipSelected: hasFlag(args, '--skip-selected'),
    skipMosaics: hasFlag(args, '--skip-mosaics'),
  };

  const storage = new Storage();
  const bucket = storage.bucket(bucketName);

  console.log(`Mac round worker watching gs://${bucketName}/review-sessions/round-jobs/`);
  console.log('Press Ctrl-C to stop.');

  do {
    const jobs = await listQueuedJobs(bucket, { statusPath, round, trialRunId });
    if (!jobs.length) {
      if (once) {
        console.log('No queued round jobs found.');
        return;
      }
      await sleep(pollMs);
      continue;
    }

    for (const job of jobs) {
      console.log(`Starting queued round ${job.status.round} from ${job.path}`);
      await runJob(bucket, bucketName, job, options);
    }
    if (!once) await sleep(pollMs);
  } while (!once);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
