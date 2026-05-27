#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { Storage } = require('@google-cloud/storage');

const REPO_ROOT = path.resolve(__dirname, '..');

function argValue(args, name, fallback = null) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}

function safeGcsSegment(value, fallback = 'no-session') {
  return String(value || fallback).replace(/[^A-Za-z0-9._-]/g, '_');
}

function inferRound(matchesPath, explicitRound) {
  const round = explicitRound
    ? Number(explicitRound)
    : Number((path.basename(matchesPath).match(/round-(\d+)\.json$/) || [])[1]);
  if (Number.isFinite(round) && round > 0) return round;
  const match = path.basename(matchesPath).match(/round-(\d+)\.json$/);
  if (match) return Number(match[1]);
  throw new Error('Could not infer round. Pass --round <N>.');
}

function normalizeBucketName(value) {
  return String(value || '').replace(/^gs:\/\//, '').replace(/\/+$/, '');
}

function walkFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const p = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else if (entry.isFile()) out.push(p);
    }
  }
  return out.sort();
}

async function readGcsJson(bucket, gcsPath) {
  try {
    const [contents] = await bucket.file(gcsPath).download();
    return JSON.parse(contents.toString());
  } catch (_) {
    return null;
  }
}

async function writeStatus(bucket, gcsPath, patch) {
  if (!gcsPath) return;
  const previous = await readGcsJson(bucket, gcsPath);
  await bucket.file(gcsPath).save(JSON.stringify({
    ...(previous || {}),
    ...patch,
    updated_at: new Date().toISOString(),
  }, null, 2), { contentType: 'application/json' });
}

async function uploadIfExists(bucket, localPath, destination, uploaded) {
  if (!localPath || !fs.existsSync(localPath)) return;
  await bucket.upload(localPath, { destination });
  uploaded.push(destination);
}

async function uploadDirectory(bucket, localDir, destinationPrefix, uploaded) {
  for (const file of walkFiles(localDir)) {
    const rel = path.relative(localDir, file).split(path.sep).join('/');
    const dest = `${destinationPrefix}/${rel}`;
    await bucket.upload(file, { destination: dest });
    uploaded.push(dest);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const matchesArg = argValue(args, '--matches');
  const bucketName = normalizeBucketName(argValue(args, '--bucket', process.env.GCS_BUCKET || 'realestate-475615-data'));
  const statusPath = argValue(args, '--status-path', process.env.ROUND_STATUS_PATH || '');
  const trialRunId = argValue(args, '--trial-run-id', process.env.TRIAL_RUN_ID || '');
  const summaryUrl = argValue(args, '--summary-url', process.env.SUMMARY_URL || '');

  if (!matchesArg) throw new Error('Provide --matches <file>');
  const round = inferRound(matchesArg, argValue(args, '--round', process.env.ROUND || ''));
  const matches = path.resolve(matchesArg);
  if (!fs.existsSync(matches)) throw new Error(`Match file not found: ${matches}`);

  const storage = new Storage();
  const bucket = storage.bucket(bucketName);
  const basename = path.basename(matches);
  const trialSegment = safeGcsSegment(trialRunId);
  const artifactPrefix = argValue(
    args,
    '--artifact-prefix',
    process.env.ROUND_ARTIFACT_PREFIX || `review-rounds/${trialSegment}/pass-${round}`
  );

  const legacyLatestPath = 'matches/auto-matches.json';
  const legacyRoundPath = `matches/${basename}`;
  const roundMatchesPath = `${artifactPrefix}/${basename}`;
  const manifestPath = `${artifactPrefix}/manifest.json`;
  const uploaded = [];

  await uploadIfExists(bucket, matches, legacyLatestPath, uploaded);
  await uploadIfExists(bucket, matches, legacyRoundPath, uploaded);
  await uploadIfExists(bucket, matches, roundMatchesPath, uploaded);

  const roundDir = path.join(REPO_ROOT, 'data', 'review-rounds', `pass-${round}`);
  await uploadDirectory(bucket, roundDir, `${artifactPrefix}/artifacts`, uploaded);
  await uploadIfExists(
    bucket,
    path.join(REPO_ROOT, 'data', `review-round-${round}-plan.json`),
    `${artifactPrefix}/review-round-${round}-plan.json`,
    uploaded
  );

  const manifest = {
    generated_at: new Date().toISOString(),
    generated_by: process.env.ROUND_GENERATED_BY || 'manual-sync-round',
    round,
    trial_run_id: trialRunId || null,
    summary_url: summaryUrl || null,
    matches_path: roundMatchesPath,
    legacy_matches_path: legacyRoundPath,
    latest_matches_path: legacyLatestPath,
    artifact_prefix: artifactPrefix,
    uploaded_paths: uploaded,
    local: {
      matches,
      round_dir: fs.existsSync(roundDir) ? roundDir : null,
      repo_root: REPO_ROOT,
    },
    environment: {
      megaloc_device: process.env.MEGALOC_DEVICE || null,
    },
  };
  await bucket.file(manifestPath).save(JSON.stringify(manifest, null, 2), {
    contentType: 'application/json',
  });
  uploaded.push(manifestPath);

  await writeStatus(bucket, statusPath, {
    state: 'ready',
    round,
    trial_run_id: trialRunId || null,
    matches_path: roundMatchesPath,
    legacy_matches_path: legacyRoundPath,
    latest_matches_path: legacyLatestPath,
    artifact_prefix: artifactPrefix,
    manifest_path: manifestPath,
    message: `Round ${round} is ready in GCS`,
  });

  console.log(`Uploaded round ${round} to gs://${bucketName}/${artifactPrefix}/`);
  console.log(`Latest review file: gs://${bucketName}/${legacyLatestPath}`);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
