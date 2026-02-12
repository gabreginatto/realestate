/**
 * GCS Data Sync for the matching server.
 *
 * Handles downloading pipeline data from GCS on startup,
 * polling for new pipeline runs, and uploading user decisions.
 *
 * On Cloud Run, `new Storage()` auto-authenticates via the service account.
 */

const { Storage } = require('@google-cloud/storage');
const fs = require('fs');
const path = require('path');

const BUCKET_NAME = process.env.GCS_BUCKET || 'realestate-images-475615';
const PREFIX = 'pipeline-data';
const SERVER_DATA_PREFIX = `${PREFIX}/server-deploy-data`;

let storage;
let bucket;

function initStorage() {
  if (!storage) {
    storage = new Storage();
    bucket = storage.bucket(BUCKET_NAME);
  }
}

// GCS path -> local path mapping for pipeline-generated data
const PIPELINE_FILES = {
  [`${SERVER_DATA_PREFIX}/deterministic-matches.json`]: './data/deterministic-matches.json',
  [`${PREFIX}/vivaprimeimoveis/listings/all-listings.json`]: './data/listings/vivaprimeimoveis_listings.json',
  [`${PREFIX}/coelhodafonseca/listings/all-listings.json`]: './data/listings/coelhodafonseca_listings.json',
};

// GCS path -> local path for user-owned data
const USER_FILES = {
  [`${SERVER_DATA_PREFIX}/manual-matches.json`]: './data/manual-matches.json',
  [`${SERVER_DATA_PREFIX}/manual-matches.log.jsonl`]: './data/manual-matches.log.jsonl',
};

// Mosaic directories to sync
const MOSAIC_DIRS = [
  { gcsPrefix: `${SERVER_DATA_PREFIX}/mosaics/viva`, localDir: './data/mosaics/viva' },
  { gcsPrefix: `${SERVER_DATA_PREFIX}/mosaics/coelho`, localDir: './data/mosaics/coelho' },
];

async function downloadFile(gcsPath, localPath) {
  try {
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    await bucket.file(gcsPath).download({ destination: localPath });
    return true;
  } catch (err) {
    if (err.code === 404) return false;
    console.warn(`  GCS skip (${err.message}): ${gcsPath}`);
    return false;
  }
}

async function uploadFile(localPath, gcsPath) {
  if (!fs.existsSync(localPath)) return false;
  await bucket.upload(localPath, { destination: gcsPath });
  return true;
}

async function downloadDir(gcsPrefix, localDir) {
  const [files] = await bucket.getFiles({ prefix: gcsPrefix });
  let count = 0;
  for (const file of files) {
    const relativePath = file.name.slice(gcsPrefix.length + 1);
    if (!relativePath || relativePath.endsWith('/')) continue;
    const localPath = path.join(localDir, relativePath);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    await file.download({ destination: localPath });
    count++;
  }
  return count;
}

/**
 * Full download of all data from GCS (used on startup).
 * Downloads pipeline data, user decisions, and mosaics.
 */
async function syncAllFromGCS() {
  initStorage();
  console.log(`[GCS] Syncing all data from gs://${BUCKET_NAME}...`);

  let totalFiles = 0;

  // Download pipeline-generated files
  for (const [gcsPath, localPath] of Object.entries(PIPELINE_FILES)) {
    if (await downloadFile(gcsPath, localPath)) {
      console.log(`  Downloaded: ${path.basename(localPath)}`);
      totalFiles++;
    }
  }

  // Download user-owned files
  for (const [gcsPath, localPath] of Object.entries(USER_FILES)) {
    if (await downloadFile(gcsPath, localPath)) {
      console.log(`  Downloaded: ${path.basename(localPath)}`);
      totalFiles++;
    }
  }

  // Download mosaics
  for (const { gcsPrefix, localDir } of MOSAIC_DIRS) {
    const count = await downloadDir(gcsPrefix, localDir);
    if (count > 0) {
      console.log(`  Downloaded ${count} mosaics from ${gcsPrefix.split('/').pop()}/`);
      totalFiles += count;
    }
  }

  console.log(`[GCS] Sync complete — ${totalFiles} files downloaded`);
  return totalFiles;
}

/**
 * Check if deterministic-matches.json in GCS is newer than our local copy.
 * Compares the GCS object's `updated` metadata against local file mtime.
 */
async function checkForNewPipelineData() {
  initStorage();

  const gcsPath = `${SERVER_DATA_PREFIX}/deterministic-matches.json`;
  const localPath = './data/deterministic-matches.json';

  try {
    const [metadata] = await bucket.file(gcsPath).getMetadata();
    const gcsUpdated = new Date(metadata.updated).getTime();

    if (!fs.existsSync(localPath)) return true;

    const localMtime = fs.statSync(localPath).mtimeMs;
    return gcsUpdated > localMtime;
  } catch (err) {
    if (err.code === 404) return false;
    console.warn(`[GCS] Error checking for new data: ${err.message}`);
    return false;
  }
}

/**
 * Download only pipeline-generated files (matches + mosaics + listings).
 * Does NOT download user decisions — those are owned by the backend.
 */
async function syncPipelineData() {
  initStorage();
  console.log('[GCS] Downloading new pipeline data...');

  let totalFiles = 0;

  for (const [gcsPath, localPath] of Object.entries(PIPELINE_FILES)) {
    if (await downloadFile(gcsPath, localPath)) {
      console.log(`  Updated: ${path.basename(localPath)}`);
      totalFiles++;
    }
  }

  for (const { gcsPrefix, localDir } of MOSAIC_DIRS) {
    const count = await downloadDir(gcsPrefix, localDir);
    if (count > 0) {
      console.log(`  Updated ${count} mosaics from ${gcsPrefix.split('/').pop()}/`);
      totalFiles += count;
    }
  }

  console.log(`[GCS] Pipeline sync complete — ${totalFiles} files updated`);
  return totalFiles;
}

/**
 * Upload user decisions (manual-matches.json + audit log) to GCS.
 * Debounced — call freely, actual upload happens at most once per interval.
 */
let _uploadTimer = null;
const UPLOAD_DEBOUNCE_MS = 30_000; // 30 seconds

function uploadUserDecisions() {
  if (_uploadTimer) return; // already scheduled

  _uploadTimer = setTimeout(async () => {
    _uploadTimer = null;
    try {
      initStorage();
      let uploaded = 0;
      for (const [gcsPath, localPath] of Object.entries(USER_FILES)) {
        if (await uploadFile(localPath, gcsPath)) uploaded++;
      }
      if (uploaded > 0) {
        console.log(`[GCS] Uploaded ${uploaded} user decision file(s)`);
      }
    } catch (err) {
      console.error(`[GCS] Error uploading user decisions: ${err.message}`);
    }
  }, UPLOAD_DEBOUNCE_MS);
}

/**
 * Force an immediate upload (used on graceful shutdown).
 */
async function flushUserDecisions() {
  if (_uploadTimer) {
    clearTimeout(_uploadTimer);
    _uploadTimer = null;
  }
  try {
    initStorage();
    for (const [gcsPath, localPath] of Object.entries(USER_FILES)) {
      await uploadFile(localPath, gcsPath);
    }
    console.log('[GCS] Flushed user decisions to GCS');
  } catch (err) {
    console.error(`[GCS] Error flushing user decisions: ${err.message}`);
  }
}

module.exports = {
  syncAllFromGCS,
  checkForNewPipelineData,
  syncPipelineData,
  uploadUserDecisions,
  flushUserDecisions,
};
