/**
 * GCS Data Structure Verification Tests
 *
 * Shells out to `gcloud storage ls` to verify the GCS bucket has the expected
 * file structure for compound-scoped data after migration/pipeline runs.
 *
 * Prerequisites:
 *   - gcloud CLI installed and authenticated
 *   - Access to the realestate-475615 project GCS buckets
 *
 * Run:
 *   npm run test:gcs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const BUCKET = process.env.GCS_BUCKET || 'gs://realestate-images-475615';
const DEPLOY_PREFIX = `${BUCKET}/pipeline-data/server-deploy-data`;
const PIPELINE_PREFIX = `${BUCKET}/pipeline-data`;

// ============================================================================
// Helper
// ============================================================================

/**
 * Lists files at a GCS path. Returns array of paths, or empty array on error.
 */
async function gcsLs(gcsPath) {
  try {
    const { stdout } = await exec('gcloud', ['storage', 'ls', gcsPath], {
      timeout: 30000,
    });
    return stdout
      .trim()
      .split('\n')
      .filter((l) => l.length > 0);
  } catch (err) {
    // If path doesn't exist, gcloud returns non-zero
    if (err.stderr?.includes('matched no objects')) {
      return [];
    }
    throw err;
  }
}

async function gcsExists(gcsPath) {
  const files = await gcsLs(gcsPath);
  return files.length > 0;
}

// ============================================================================
// Deploy Bucket: Compound-scoped server data
// ============================================================================

describe('GCS: Server deploy data (compound-scoped)', () => {
  it('alphaville-1/deterministic-matches.json exists', async () => {
    const exists = await gcsExists(
      `${DEPLOY_PREFIX}/compounds/alphaville-1/deterministic-matches.json`
    );
    assert.ok(exists, 'deterministic-matches.json should exist for alphaville-1');
  });

  it('alphaville-1/manual-matches.json exists', async () => {
    const exists = await gcsExists(
      `${DEPLOY_PREFIX}/compounds/alphaville-1/manual-matches.json`
    );
    assert.ok(exists, 'manual-matches.json should exist for alphaville-1');
  });

  it('alphaville-1/mosaics/viva/ has files', async () => {
    const files = await gcsLs(
      `${DEPLOY_PREFIX}/compounds/alphaville-1/mosaics/viva/`
    );
    assert.ok(
      files.length > 0,
      `viva mosaics should have files, found ${files.length}`
    );
  });

  it('alphaville-1/mosaics/coelho/ has files', async () => {
    const files = await gcsLs(
      `${DEPLOY_PREFIX}/compounds/alphaville-1/mosaics/coelho/`
    );
    assert.ok(
      files.length > 0,
      `coelho mosaics should have files, found ${files.length}`
    );
  });
});

// ============================================================================
// Pipeline Bucket: Scraped listings
// ============================================================================

describe('GCS: Pipeline data (scraped listings)', () => {
  it('alphaville-1 viva listings exist', async () => {
    const exists = await gcsExists(
      `${PIPELINE_PREFIX}/alphaville-1/vivaprimeimoveis/listings/all-listings.json`
    );
    assert.ok(exists, 'viva all-listings.json should exist for alphaville-1');
  });

  it('alphaville-1 coelho listings exist', async () => {
    const exists = await gcsExists(
      `${PIPELINE_PREFIX}/alphaville-1/coelhodafonseca/listings/all-listings.json`
    );
    assert.ok(exists, 'coelho all-listings.json should exist for alphaville-1');
  });
});
