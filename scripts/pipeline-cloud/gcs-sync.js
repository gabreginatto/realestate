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

const COMPOUNDS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'config', 'compounds.json'), 'utf-8'));
const compoundIds = Object.keys(COMPOUNDS.compounds);

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

  for (const compoundId of compoundIds) {
    console.log(`  --- ${compoundId} ---`);

    // Pipeline state files per compound
    const stateFiles = ['pipeline-state.json', 'manual-matches.json'];
    for (const f of stateFiles) {
      await downloadFile(`${PREFIX}/${compoundId}/${f}`, `data/${compoundId}/${f}`);
    }

    // Listings JSON per compound
    await downloadFile(
      `${PREFIX}/${compoundId}/vivaprimeimoveis/listings/all-listings.json`,
      `data/${compoundId}/vivaprimeimoveis/listings/all-listings.json`
    );
    await downloadFile(
      `${PREFIX}/${compoundId}/coelhodafonseca/listings/all-listings.json`,
      `data/${compoundId}/coelhodafonseca/listings/all-listings.json`
    );

    // Existing mosaics per compound
    await downloadDir(`${PREFIX}/${compoundId}/mosaics`, `data/${compoundId}/mosaics`);
  }

  console.log('[GCS] Download complete');
}

async function upload() {
  console.log('[GCS] Uploading results to GCS...');

  for (const compoundId of compoundIds) {
    console.log(`  --- ${compoundId} ---`);

    // Mosaics per compound
    const mosaicCount = await uploadDir(`data/${compoundId}/mosaics`, `${PREFIX}/${compoundId}/mosaics`);
    console.log(`  Mosaics: ${mosaicCount} files`);

    // Listings JSON per compound
    await uploadFile(
      `data/${compoundId}/vivaprimeimoveis/listings/all-listings.json`,
      `${PREFIX}/${compoundId}/vivaprimeimoveis/listings/all-listings.json`
    );
    await uploadFile(
      `data/${compoundId}/coelhodafonseca/listings/all-listings.json`,
      `${PREFIX}/${compoundId}/coelhodafonseca/listings/all-listings.json`
    );

    // Pipeline state files per compound (not manual-matches.json which is owned by backend)
    const stateFiles = ['pipeline-state.json', 'pipeline-delta.json', 'pipeline-runs.json', 'deterministic-matches.json'];
    for (const f of stateFiles) {
      await uploadFile(`data/${compoundId}/${f}`, `${PREFIX}/${compoundId}/${f}`);
    }
  }

  // Server-deploy ready data (per compound)
  for (const compoundId of compoundIds) {
    const serverCount = await uploadDir(`server-deploy/data/${compoundId}`, `${PREFIX}/server-deploy-data/compounds/${compoundId}`);
    if (serverCount > 0) console.log(`  Server-deploy (${compoundId}): ${serverCount} files`);
  }

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
