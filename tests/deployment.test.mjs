/**
 * Deployment Smoke Tests
 *
 * Hits the live Cloud Run server to verify all key endpoints work after deployment.
 * Default URL: https://property-matcher-376125120681.us-central1.run.app
 * Override with TEST_BASE_URL env var.
 *
 * Run:
 *   npm run test:deploy
 *   TEST_BASE_URL=http://localhost:8080 npm run test:deploy
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const BASE_URL =
  process.env.TEST_BASE_URL ||
  'https://property-matcher-376125120681.us-central1.run.app';

// ============================================================================
// HTTP Helpers
// ============================================================================

async function fetchJson(urlPath) {
  const res = await fetch(`${BASE_URL}${urlPath}`);
  if (res.headers.get('content-type')?.includes('application/json')) {
    const data = await res.json();
    return { status: res.status, data };
  }
  return { status: res.status, data: null, res };
}

async function fetchRaw(urlPath) {
  return fetch(`${BASE_URL}${urlPath}`);
}

// ============================================================================
// Compound Listing
// ============================================================================

describe('Deployment: GET /api/compounds', () => {
  it('returns array with both compounds and correct shape', async () => {
    const { status, data } = await fetchJson('/api/compounds');
    assert.equal(status, 200);
    assert.ok(Array.isArray(data.compounds), 'compounds should be an array');
    assert.ok(data.compounds.length >= 2, 'should have at least 2 compounds');
    assert.ok(
      typeof data.defaultCompound === 'string',
      'defaultCompound should be a string'
    );

    const ids = data.compounds.map((c) => c.id);
    assert.ok(ids.includes('alphaville-1'), 'should include alphaville-1');
    assert.ok(ids.includes('tambore-xi'), 'should include tambore-xi');

    for (const compound of data.compounds) {
      assert.ok(compound.id, 'compound should have id');
      assert.ok(compound.displayName, 'compound should have displayName');
      // stats may be null if compound hasn't been initialized yet
      if (compound.stats) {
        assert.ok('matched' in compound.stats, 'stats should have matched');
        assert.ok('pending' in compound.stats, 'stats should have pending');
        assert.ok('total' in compound.stats, 'stats should have total');
      }
    }
  });
});

// ============================================================================
// Compound-Scoped: Alphaville-1
// ============================================================================

describe('Deployment: Alphaville-1 compound routes', () => {
  it('GET /api/compounds/alphaville-1/session — returns session with stats', async () => {
    const { status, data } = await fetchJson(
      '/api/compounds/alphaville-1/session'
    );
    assert.equal(status, 200);
    assert.ok(data.stats, 'should have stats');
    assert.ok('total_viva_listings' in data.stats);
    assert.ok('matched' in data.stats);
    assert.ok('pending' in data.stats);
    assert.ok('version' in data, 'should have version');
    assert.ok('current_pass' in data, 'should have current_pass');
    assert.ok('max_passes' in data, 'should have max_passes');
    assert.ok('pass_criteria' in data, 'should have pass_criteria');
    assert.ok('has_new_properties' in data, 'should have has_new_properties');
  });

  it('GET /api/compounds/alphaville-1/next — returns listing or pass_complete or done', async () => {
    const { status, data } = await fetchJson(
      '/api/compounds/alphaville-1/next'
    );
    assert.equal(status, 200);

    // Could be a normal listing, pass_complete, or done — all are valid
    const isListing = 'viva_code' in data;
    const isPassComplete = data.pass_complete === true;
    const isDone = data.done === true;
    assert.ok(
      isListing || isPassComplete || isDone,
      `response should be a listing, pass_complete, or done. Got: ${JSON.stringify(Object.keys(data))}`
    );

    if (isListing) {
      assert.ok(data.viva_code, 'listing should have viva_code');
      assert.ok(data.mosaic_path, 'listing should have mosaic_path');
      assert.ok(
        data.mosaic_path.includes('alphaville-1'),
        'mosaic_path should include compound id'
      );
      assert.ok(
        'remaining_candidates' in data,
        'should have remaining_candidates'
      );
    }
  });

  it('GET /api/compounds/alphaville-1/candidates/:vivaCode — returns candidates', async () => {
    // First get a valid viva code from /next
    const { data: nextData } = await fetchJson(
      '/api/compounds/alphaville-1/next'
    );

    if (nextData.viva_code) {
      const { status, data } = await fetchJson(
        `/api/compounds/alphaville-1/candidates/${nextData.viva_code}`
      );
      assert.equal(status, 200);
      assert.ok(Array.isArray(data.candidates), 'candidates should be array');
      assert.ok('total_candidates' in data, 'should have total_candidates');
      assert.equal(data.viva_code, nextData.viva_code);

      if (data.candidates.length > 0) {
        const c = data.candidates[0];
        assert.ok(c.code, 'candidate should have code');
        assert.ok(c.candidate, 'candidate should have candidate details');
        assert.ok('ai_score' in c, 'candidate should have ai_score');
        assert.ok(c.mosaic_path, 'candidate should have mosaic_path');
      }
    }
  });

  it('GET /api/compounds/alphaville-1/progress — returns progress data', async () => {
    const { status, data } = await fetchJson(
      '/api/compounds/alphaville-1/progress'
    );
    assert.equal(status, 200);
    assert.ok('total_viva_listings' in data);
    assert.ok('matched' in data);
    assert.ok('pending' in data);
    assert.ok('progress_pct' in data);
    assert.ok('current_pass' in data);
  });
});

// ============================================================================
// Compound-Scoped: Tamboré XI
// ============================================================================

describe('Deployment: Tamboré XI compound routes', () => {
  it('GET /api/compounds/tambore-xi/session — returns valid session', async () => {
    const { status, data } = await fetchJson(
      '/api/compounds/tambore-xi/session'
    );
    assert.equal(status, 200);
    assert.ok(data.stats, 'should have stats');
    assert.ok('total_viva_listings' in data.stats);
  });
});

// ============================================================================
// Unknown Compound
// ============================================================================

describe('Deployment: Unknown compound', () => {
  it('GET /api/compounds/nonexistent/session — returns 404', async () => {
    const { status, data } = await fetchJson(
      '/api/compounds/nonexistent/session'
    );
    assert.equal(status, 404);
    assert.ok(data.error, 'should have error message');
    assert.ok(
      data.error.includes('nonexistent'),
      'error should mention the compound name'
    );
  });
});

// ============================================================================
// Legacy Routes (backward compatibility)
// ============================================================================

describe('Deployment: Legacy routes', () => {
  it('GET /api/session — same response as alphaville-1 session', async () => {
    const { status, data } = await fetchJson('/api/session');
    assert.equal(status, 200);
    assert.ok(data.stats, 'should have stats');
    assert.ok('version' in data);
    assert.ok('current_pass' in data);
  });

  it('GET /api/next — same response as alphaville-1 next', async () => {
    const { status, data } = await fetchJson('/api/next');
    assert.equal(status, 200);
    const isListing = 'viva_code' in data;
    const isPassComplete = data.pass_complete === true;
    const isDone = data.done === true;
    assert.ok(isListing || isPassComplete || isDone);
  });

  it('GET /api/progress — backward compat works', async () => {
    const { status, data } = await fetchJson('/api/progress');
    assert.equal(status, 200);
    assert.ok('total_viva_listings' in data);
    assert.ok('progress_pct' in data);
  });
});

// ============================================================================
// Static Assets
// ============================================================================

describe('Deployment: Static assets', () => {
  it('GET /matcher.html — 200 with HTML content-type', async () => {
    const res = await fetchRaw('/matcher.html');
    assert.equal(res.status, 200);
    const ct = res.headers.get('content-type');
    assert.ok(ct.includes('text/html'), `expected HTML, got: ${ct}`);
  });

  it('GET /mosaics/alphaville-1/viva/<code>.png — returns image if exists', async () => {
    // Get a viva code to test mosaic
    const { data: nextData } = await fetchJson(
      '/api/compounds/alphaville-1/next'
    );

    if (nextData.viva_code) {
      const res = await fetchRaw(
        `/mosaics/alphaville-1/viva/${nextData.viva_code}.png`
      );
      // Mosaic might not exist for every listing, so 200 or 404 are both acceptable
      if (res.status === 200) {
        const ct = res.headers.get('content-type');
        assert.ok(
          ct.includes('image'),
          `expected image content-type, got: ${ct}`
        );
      } else {
        assert.equal(res.status, 404, 'non-200 should be 404');
      }
    }
  });
});
