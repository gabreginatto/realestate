#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const { Storage } = require('@google-cloud/storage');

const storage = new Storage();
const bucketName = process.env.GCS_BUCKET || 'realestate-475615-data';
const bucket = storage.bucket(bucketName);

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function writeStatus(status) {
  const statusPath = requiredEnv('ROUND_STATUS_PATH');
  await bucket.file(statusPath).save(JSON.stringify({
    ...status,
    updated_at: new Date().toISOString(),
  }, null, 2), { contentType: 'application/json' });
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
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

async function main() {
  const round = requiredEnv('ROUND');
  const summaryUrl = requiredEnv('SUMMARY_URL');
  const trialRunId = process.env.TRIAL_RUN_ID || null;
  await writeStatus({
    state: 'running',
    round: Number(round),
    trial_run_id: trialRunId,
    message: `Generating round ${round}`,
  });

  try {
    await run('./scripts/run-next-review-round.sh', [
      '--summary-url', summaryUrl,
      '--round', round,
    ], {
      SYNC_TO_GCS_NODE: 'true',
      MEGALOC_DEVICE: process.env.MEGALOC_DEVICE || 'cpu',
    });
    await writeStatus({
      state: 'ready',
      round: Number(round),
      trial_run_id: trialRunId,
      matches_path: `matches/auto-matches-round-${round}.json`,
      message: `Round ${round} is ready`,
    });
  } catch (err) {
    await writeStatus({
      state: 'failed',
      round: Number(round),
      trial_run_id: trialRunId,
      message: err.message,
    });
    throw err;
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
