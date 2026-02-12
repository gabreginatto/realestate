#!/usr/bin/env node
/**
 * Lightweight GCS sync — replaces gsutil/gcloud CLI (~400MB savings)
 *
 * Usage:
 *   node gcs-sync.js download   — pull state from GCS before pipeline
 *   node gcs-sync.js upload     — push results to GCS after pipeline
 */
const { Storage } = require('@google-cloud/storage');
const fs = require('fs');
const path = require('path');

const BUCKET = process.env.GCS_BUCKET || 'realestate-images-475615';
const PREFIX = 'pipeline-data';
const storage = new Storage();
const bucket = storage.bucket(BUCKET);

async function downloadFile(gcsPath, localPath) {
  try {
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    await bucket.file(gcsPath).download({ destination: localPath });
    console.log(`  Downloaded: ${gcsPath}`);
    return true;
  } catch (err) {
    if (err.code === 404) return false;
    console.log(`  Skip (${err.message}): ${gcsPath}`);
    return false;
  }
}

async function uploadFile(localPath, gcsPath) {
  if (!fs.existsSync(localPath)) return false;
  await bucket.upload(localPath, { destination: gcsPath });
  console.log(`  Uploaded: ${gcsPath}`);
  return true;
}

async function uploadDir(localDir, gcsPrefix) {
  if (!fs.existsSync(localDir)) return 0;
  let count = 0;
  const entries = fs.readdirSync(localDir, { withFileTypes: true });
  for (const entry of entries) {
    const localPath = path.join(localDir, entry.name);
    const remotePath = `${gcsPrefix}/${entry.name}`;
    if (entry.isDirectory()) {
      count += await uploadDir(localPath, remotePath);
    } else {
      await uploadFile(localPath, remotePath);
      count++;
    }
  }
  return count;
}

async function downloadDir(gcsPrefix, localDir) {
  const [files] = await bucket.getFiles({ prefix: gcsPrefix });
  let count = 0;
  for (const file of files) {
    const relativePath = file.name.slice(gcsPrefix.length + 1);
    if (!relativePath) continue;
    const localPath = path.join(localDir, relativePath);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    await file.download({ destination: localPath });
    count++;
  }
  if (count > 0) console.log(`  Downloaded ${count} files from ${gcsPrefix}/`);
  return count;
}

async function download() {
  console.log('[GCS] Downloading state from GCS...');

  // Pipeline state files
  const stateFiles = ['pipeline-state.json', 'manual-matches.json'];
  let found = false;
  for (const f of stateFiles) {
    if (await downloadFile(`${PREFIX}/${f}`, `data/${f}`)) found = true;
  }
  if (!found) {
    console.log('  No existing data in GCS (first run)');
  }

  // Listings JSON (small, needed for incremental delta)
  await downloadFile(
    `${PREFIX}/vivaprimeimoveis/listings/all-listings.json`,
    'data/vivaprimeimoveis/listings/all-listings.json'
  );
  await downloadFile(
    `${PREFIX}/coelhodafonseca/listings/all-listings.json`,
    'data/coelhodafonseca/listings/all-listings.json'
  );

  // Existing mosaics (avoid regenerating unchanged)
  await downloadDir(`${PREFIX}/mosaics`, 'data/mosaics');

  console.log('[GCS] Download complete');
}

async function upload() {
  console.log('[GCS] Uploading results to GCS...');

  // Mosaics
  const mosaicCount = await uploadDir('data/mosaics', `${PREFIX}/mosaics`);
  console.log(`  Mosaics: ${mosaicCount} files`);

  // Listings JSON
  await uploadFile('data/vivaprimeimoveis/listings/all-listings.json', `${PREFIX}/vivaprimeimoveis/listings/all-listings.json`);
  await uploadFile('data/coelhodafonseca/listings/all-listings.json', `${PREFIX}/coelhodafonseca/listings/all-listings.json`);

  // Pipeline state files
  // NOTE: manual-matches.json is owned by the backend server — don't overwrite
  const stateFiles = [
    'pipeline-state.json', 'pipeline-delta.json', 'pipeline-runs.json',
    'deterministic-matches.json',
  ];
  for (const f of stateFiles) {
    await uploadFile(`data/${f}`, `${PREFIX}/${f}`);
  }

  // Server-deploy ready data
  const serverCount = await uploadDir('server-deploy/data', `${PREFIX}/server-deploy-data`);
  console.log(`  Server-deploy: ${serverCount} files`);

  console.log('[GCS] Upload complete');
}

const command = process.argv[2];
if (command === 'download') {
  download().catch(err => { console.error('GCS download failed:', err.message); process.exit(1); });
} else if (command === 'upload') {
  upload().catch(err => { console.error('GCS upload failed:', err.message); process.exit(1); });
} else {
  console.error('Usage: node gcs-sync.js <download|upload>');
  process.exit(1);
}
