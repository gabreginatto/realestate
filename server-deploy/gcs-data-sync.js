/**
 * GCS Data Sync for the matching server.
 *
 * Handles downloading pipeline data from GCS on startup,
 * polling for new pipeline runs, and uploading user decisions.
 *
 * Multi-compound aware: syncs data per compound based on compounds.json.
 *
 * On Cloud Run, `new Storage()` auto-authenticates via the service account.
 */

const { Storage } = require('@google-cloud/storage');
const fs = require('fs');
const path = require('path');

const BUCKET_NAME = process.env.GCS_BUCKET || 'realestate-images-475615';
const PREFIX = 'pipeline-data';
const SERVER_DATA_PREFIX = `${PREFIX}/server-deploy-data`;

const COMPOUNDS_CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'compounds.json'), 'utf-8'));
const compoundIds = Object.keys(COMPOUNDS_CONFIG.compounds);

let storage;
let bucket;

function initStorage() {
  if (!storage) {
    storage = new Storage();
    bucket = storage.bucket(BUCKET_NAME);
  }
}

// Per-compound GCS path -> local path generators

function pipelineFiles(compoundId) {
  return {
    [`${SERVER_DATA_PREFIX}/compounds/${compoundId}/deterministic-matches.json`]: `./data/${compoundId}/deterministic-matches.json`,
    [`${PREFIX}/${compoundId}/vivaprimeimoveis/listings/all-listings.json`]: `./data/${compoundId}/listings/vivaprimeimoveis_listings.json`,
    [`${PREFIX}/${compoundId}/coelhodafonseca/listings/all-listings.json`]: `./data/${compoundId}/listings/coelhodafonseca_listings.json`,
  };
}

function userFiles(compoundId) {
  return {
    [`${SERVER_DATA_PREFIX}/compounds/${compoundId}/manual-matches.json`]: `./data/${compoundId}/manual-matches.json`,
    [`${SERVER_DATA_PREFIX}/compounds/${compoundId}/manual-matches.log.jsonl`]: `./data/${compoundId}/manual-matches.log.jsonl`,
  };
}

function mosaicDirs(compoundId) {
  return [
    { gcsPrefix: `${SERVER_DATA_PREFIX}/compounds/${compoundId}/mosaics/viva`, localDir: `./data/${compoundId}/mosaics/viva` },
    { gcsPrefix: `${SERVER_DATA_PREFIX}/compounds/${compoundId}/mosaics/coelho`, localDir: `./data/${compoundId}/mosaics/coelho` },
  ];
}

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
 * Downloads pipeline data, user decisions, and mosaics for all compounds.
 */
async function syncAllFromGCS() {
  initStorage();
  console.log(`[GCS] Syncing all data from gs://${BUCKET_NAME}...`);
  let totalFiles = 0;

  for (const compoundId of compoundIds) {
    console.log(`  --- ${compoundId} ---`);
    for (const [gcsPath, localPath] of Object.entries(pipelineFiles(compoundId))) {
      if (await downloadFile(gcsPath, localPath)) {
        console.log(`  Downloaded: ${path.basename(localPath)}`);
        totalFiles++;
      }
    }
    for (const [gcsPath, localPath] of Object.entries(userFiles(compoundId))) {
      if (await downloadFile(gcsPath, localPath)) {
        console.log(`  Downloaded: ${path.basename(localPath)}`);
        totalFiles++;
      }
    }
    for (const { gcsPrefix, localDir } of mosaicDirs(compoundId)) {
      const count = await downloadDir(gcsPrefix, localDir);
      if (count > 0) {
        console.log(`  Downloaded ${count} mosaics from ${gcsPrefix.split('/').pop()}/`);
        totalFiles += count;
      }
    }
  }

  console.log(`[GCS] Sync complete — ${totalFiles} files downloaded`);
  return totalFiles;
}

/**
 * Check which compounds have newer pipeline data in GCS.
 * Returns an array of compound IDs that have updates.
 */
async function checkForNewPipelineData() {
  initStorage();
  const updated = [];

  for (const compoundId of compoundIds) {
    const gcsPath = `${SERVER_DATA_PREFIX}/compounds/${compoundId}/deterministic-matches.json`;
    const localPath = `./data/${compoundId}/deterministic-matches.json`;
    try {
      const [metadata] = await bucket.file(gcsPath).getMetadata();
      const gcsUpdated = new Date(metadata.updated).getTime();
      if (!fs.existsSync(localPath) || gcsUpdated > fs.statSync(localPath).mtimeMs) {
        updated.push(compoundId);
      }
    } catch (err) {
      if (err.code !== 404) console.warn(`[GCS] Error checking ${compoundId}: ${err.message}`);
    }
  }

  return updated;
}

/**
 * Download only pipeline-generated files (matches + mosaics + listings) for a specific compound.
 * Does NOT download user decisions — those are owned by the backend.
 */
async function syncPipelineData(compoundId) {
  initStorage();
  console.log(`[GCS] Downloading pipeline data for ${compoundId}...`);
  let totalFiles = 0;

  for (const [gcsPath, localPath] of Object.entries(pipelineFiles(compoundId))) {
    if (await downloadFile(gcsPath, localPath)) {
      console.log(`  Updated: ${path.basename(localPath)}`);
      totalFiles++;
    }
  }

  for (const { gcsPrefix, localDir } of mosaicDirs(compoundId)) {
    const count = await downloadDir(gcsPrefix, localDir);
    if (count > 0) {
      console.log(`  Updated ${count} mosaics from ${gcsPrefix.split('/').pop()}/`);
      totalFiles += count;
    }
  }

  console.log(`[GCS] Pipeline sync for ${compoundId} — ${totalFiles} files`);
  return totalFiles;
}

/**
 * Upload user decisions (manual-matches.json + audit log) to GCS.
 * Debounced per compound — call freely, actual upload happens at most once per interval.
 */
let _uploadTimers = {};
const UPLOAD_DEBOUNCE_MS = 30_000; // 30 seconds

function uploadUserDecisions(compoundId) {
  const key = compoundId || '_all';
  if (_uploadTimers[key]) return; // already scheduled

  _uploadTimers[key] = setTimeout(async () => {
    delete _uploadTimers[key];
    try {
      initStorage();
      const ids = compoundId ? [compoundId] : compoundIds;
      let uploaded = 0;
      for (const id of ids) {
        for (const [gcsPath, localPath] of Object.entries(userFiles(id))) {
          if (await uploadFile(localPath, gcsPath)) uploaded++;
        }
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
  if (_uploadTimers) {
    for (const key of Object.keys(_uploadTimers)) {
      clearTimeout(_uploadTimers[key]);
    }
    _uploadTimers = {};
  }
  try {
    initStorage();
    for (const compoundId of compoundIds) {
      for (const [gcsPath, localPath] of Object.entries(userFiles(compoundId))) {
        await uploadFile(localPath, gcsPath);
      }
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
