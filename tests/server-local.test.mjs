/**
 * Local Server Integration Tests — Multi-Compound
 *
 * Spawns matching-server.js locally with a temp data directory containing
 * mock data for TWO compounds. Tests compound isolation, legacy route
 * forwarding, and per-compound operations.
 *
 * Uses Node's built-in test runner (node:test) and native fetch.
 *
 * Run:
 *   npm run test:local
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

// ============================================================================
// Configuration
// ============================================================================

const TEST_PORT = 19877;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const REVIEWER = 'test-reviewer';
const SERVER_SCRIPT = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  'server-deploy',
  'matching-server.js'
);

const COMPOUND_A = 'alphaville-1';
const COMPOUND_B = 'tambore-xi';

// ============================================================================
// Mock Data Generators
// ============================================================================

function makeVivaListing(code, overrides = {}) {
  return {
    code,
    price: 'R$ 1.000.000,00',
    address: `Rua Test ${code}`,
    url: `https://viva.com/${code}`,
    beds: 3,
    suites: 1,
    built: 100,
    park: 2,
    neighbourhood: 'Jardins',
    features: 'PG',
    ...overrides,
  };
}

function makeCoelhoListing(code, overrides = {}) {
  return {
    code,
    price: 'R$1.050.000',
    address: `Rua Coelho ${code}`,
    url: `https://coelho.com/${code}`,
    beds: 3,
    suites: 1,
    built: 105,
    park: 2,
    features: 'P',
    score: 0.85,
    ...overrides,
  };
}

function makeDeterministicMatches(vivaListings, coelhoListings) {
  return {
    generated_at: new Date().toISOString(),
    approach: 'Test data',
    total_viva_listings: vivaListings.length,
    listings_with_candidates: vivaListings.length,
    total_candidate_pairs: vivaListings.length * coelhoListings.length,
    skip_reasons: { noArea: 0, noAreaMatches: 0, noStrongCandidates: 0, queued: vivaListings.length },
    candidate_pairs: vivaListings.map((v) => ({
      viva: v,
      candidates: coelhoListings.map((c) => ({ ...c })),
    })),
  };
}

// 1x1 transparent PNG for mosaic placeholders
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

// ============================================================================
// Server Lifecycle
// ============================================================================

let serverProcess = null;
let tempDir = null;

function createTestData() {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'matcher-local-test-'));

  // Compound A: 3 viva listings, 2 coelho candidates
  const vivaA = [
    makeVivaListing('VA001'),
    makeVivaListing('VA002', { price: 'R$ 2.000.000,00', built: 200 }),
    makeVivaListing('VA003', { price: 'R$ 800.000,00', built: 80 }),
  ];
  const coelhoA = [
    makeCoelhoListing('CA001'),
    makeCoelhoListing('CA002', { price: 'R$2.100.000', built: 210 }),
  ];

  // Compound B: 2 viva listings, 1 coelho candidate
  const vivaB = [
    makeVivaListing('VB001', { price: 'R$ 1.500.000,00', built: 150 }),
    makeVivaListing('VB002', { price: 'R$ 3.000.000,00', built: 300 }),
  ];
  const coelhoB = [makeCoelhoListing('CB001', { price: 'R$1.600.000', built: 160 })];

  for (const [compoundId, vivaList, coelhoList] of [
    [COMPOUND_A, vivaA, coelhoA],
    [COMPOUND_B, vivaB, coelhoB],
  ]) {
    const compoundDir = path.join(tempDir, compoundId);
    const mosaicsViva = path.join(compoundDir, 'mosaics', 'viva');
    const mosaicsCoelho = path.join(compoundDir, 'mosaics', 'coelho');
    const listingsDir = path.join(compoundDir, 'listings');
    fs.mkdirSync(mosaicsViva, { recursive: true });
    fs.mkdirSync(mosaicsCoelho, { recursive: true });
    fs.mkdirSync(listingsDir, { recursive: true });

    fs.writeFileSync(
      path.join(compoundDir, 'deterministic-matches.json'),
      JSON.stringify(makeDeterministicMatches(vivaList, coelhoList), null, 2)
    );

    // Raw listing files (needed for pass advancement / dynamic re-matching)
    fs.writeFileSync(
      path.join(listingsDir, 'vivaprimeimoveis_listings.json'),
      JSON.stringify({ listings: vivaList }, null, 2)
    );
    fs.writeFileSync(
      path.join(listingsDir, 'coelhodafonseca_listings.json'),
      JSON.stringify({ listings: coelhoList }, null, 2)
    );

    for (const v of vivaList) {
      fs.writeFileSync(path.join(mosaicsViva, `${v.code}.png`), TINY_PNG);
    }
    for (const c of coelhoList) {
      fs.writeFileSync(path.join(mosaicsCoelho, `${c.code}.png`), TINY_PNG);
    }
  }
}

async function startServer() {
  return new Promise((resolve, reject) => {
    serverProcess = spawn('node', [SERVER_SCRIPT], {
      env: {
        ...process.env,
        PORT: String(TEST_PORT),
        HOST: '127.0.0.1',
        DATA_ROOT: tempDir,
        SESSION_NAME: 'test-session',
        // Point to a nonexistent bucket so GCS sync fails fast and server uses local data
        GCS_BUCKET: '__test_nonexistent_bucket__',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    serverProcess.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.includes('Server running on:')) {
        resolve();
      }
    });

    serverProcess.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    serverProcess.on('error', (err) => {
      reject(new Error(`Server failed to start: ${err.message}`));
    });

    serverProcess.on('exit', (code) => {
      if (code !== null && code !== 0) {
        reject(
          new Error(
            `Server exited with code ${code}.\nStdout: ${stdout}\nStderr: ${stderr}`
          )
        );
      }
    });

    setTimeout(() => {
      reject(
        new Error(
          `Server startup timed out.\nStdout: ${stdout}\nStderr: ${stderr}`
        )
      );
    }, 15000);
  });
}

function stopServer() {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
}

function cleanup() {
  stopServer();
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
}

// ============================================================================
// HTTP Helpers
// ============================================================================

async function apiJson(endpoint, options = {}) {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  const data = await res.json();
  return { status: res.status, data };
}

async function apiPost(endpoint, body = {}) {
  return apiJson(endpoint, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('Local Server: Multi-Compound Integration', () => {
  before(async () => {
    createTestData();
    await startServer();
  });

  after(() => {
    cleanup();
  });

  // --------------------------------------------------------------------------
  // Compound listing
  // --------------------------------------------------------------------------

  describe('GET /api/compounds', () => {
    it('returns both test compounds with correct stats', async () => {
      const { status, data } = await apiJson('/api/compounds');
      assert.equal(status, 200);
      assert.ok(Array.isArray(data.compounds));

      const compA = data.compounds.find((c) => c.id === COMPOUND_A);
      const compB = data.compounds.find((c) => c.id === COMPOUND_B);

      assert.ok(compA, 'should include alphaville-1');
      assert.ok(compB, 'should include tambore-xi');

      // After server init, stats should reflect loaded data
      assert.ok(compA.stats, 'compound A should have stats');
      assert.equal(compA.stats.total, 3, 'compound A: 3 viva listings');
      assert.equal(compA.stats.pending, 3, 'compound A: 3 pending');

      assert.ok(compB.stats, 'compound B should have stats');
      assert.equal(compB.stats.total, 2, 'compound B: 2 viva listings');
      assert.equal(compB.stats.pending, 2, 'compound B: 2 pending');
    });
  });

  // --------------------------------------------------------------------------
  // Compound isolation: match on A doesn't affect B
  // --------------------------------------------------------------------------

  describe('Compound isolation', () => {
    it('match on compound A does not affect compound B', async () => {
      // Get first listing from compound A
      const { data: nextA } = await apiJson(
        `/api/compounds/${COMPOUND_A}/next`
      );
      assert.ok(nextA.viva_code, 'should get a listing from compound A');

      // Get candidates for this listing
      const { data: candsA } = await apiJson(
        `/api/compounds/${COMPOUND_A}/candidates/${nextA.viva_code}`
      );
      assert.ok(candsA.candidates.length > 0, 'should have candidates');
      const firstCandidate = candsA.candidates[0].code;

      // Match it
      const { status: matchStatus, data: matchData } = await apiPost(
        `/api/compounds/${COMPOUND_A}/match`,
        {
          viva_code: nextA.viva_code,
          coelho_code: firstCandidate,
          reviewer: REVIEWER,
        }
      );
      assert.equal(matchStatus, 200);
      assert.ok(matchData.success);

      // Verify compound A progress changed
      const { data: progressA } = await apiJson(
        `/api/compounds/${COMPOUND_A}/progress`
      );
      assert.equal(progressA.matched, 1, 'compound A should have 1 match');

      // Verify compound B progress unchanged
      const { data: progressB } = await apiJson(
        `/api/compounds/${COMPOUND_B}/progress`
      );
      assert.equal(progressB.matched, 0, 'compound B should still have 0 matches');
      assert.equal(progressB.pending, 2, 'compound B should still have 2 pending');
    });
  });

  // --------------------------------------------------------------------------
  // Skip works per-compound
  // --------------------------------------------------------------------------

  describe('Skip per-compound', () => {
    it('skip on compound B does not affect compound A', async () => {
      const { data: nextB } = await apiJson(
        `/api/compounds/${COMPOUND_B}/next`
      );
      assert.ok(nextB.viva_code, 'should get a listing from compound B');

      const { status, data } = await apiPost(
        `/api/compounds/${COMPOUND_B}/skip`,
        {
          viva_code: nextB.viva_code,
          reviewer: REVIEWER,
          reason: 'test-skip',
        }
      );
      assert.equal(status, 200);
      assert.ok(data.success);

      // Check B has 1 skip
      const { data: progressB } = await apiJson(
        `/api/compounds/${COMPOUND_B}/progress`
      );
      assert.equal(progressB.skipped, 1, 'compound B should have 1 skip');

      // Check A is unaffected (still has 1 match from earlier, 0 skips)
      const { data: progressA } = await apiJson(
        `/api/compounds/${COMPOUND_A}/progress`
      );
      assert.equal(progressA.skipped, 0, 'compound A should have 0 skips');
    });
  });

  // --------------------------------------------------------------------------
  // Undo works per-compound
  // --------------------------------------------------------------------------

  describe('Undo per-compound', () => {
    it('undo on compound B reverts skip on B only', async () => {
      const { status, data } = await apiPost(
        `/api/compounds/${COMPOUND_B}/undo`,
        { reviewer: REVIEWER }
      );
      assert.equal(status, 200);
      assert.ok(data.success);
      assert.equal(data.undone.type, 'skip');

      // B should be back to 0 skips
      const { data: progressB } = await apiJson(
        `/api/compounds/${COMPOUND_B}/progress`
      );
      assert.equal(progressB.skipped, 0, 'compound B skip should be undone');

      // A unchanged
      const { data: progressA } = await apiJson(
        `/api/compounds/${COMPOUND_A}/progress`
      );
      assert.equal(progressA.matched, 1, 'compound A match still intact');
    });
  });

  // --------------------------------------------------------------------------
  // Reject works per-compound
  // --------------------------------------------------------------------------

  describe('Reject per-compound', () => {
    it('reject on compound B removes candidate from B only', async () => {
      const { data: nextB } = await apiJson(
        `/api/compounds/${COMPOUND_B}/next`
      );
      assert.ok(nextB.viva_code);

      const { data: candsB } = await apiJson(
        `/api/compounds/${COMPOUND_B}/candidates/${nextB.viva_code}`
      );
      const candidateCode = candsB.candidates[0].code;
      const candidatesBefore = candsB.total_candidates;

      const { status, data } = await apiPost(
        `/api/compounds/${COMPOUND_B}/reject`,
        {
          viva_code: nextB.viva_code,
          coelho_code: candidateCode,
          reviewer: REVIEWER,
          reason: 'visual_mismatch',
        }
      );
      assert.equal(status, 200);
      assert.ok(data.success);

      // After rejection, listing may have been removed from queue if 0 candidates remain
      const { status: candsStatus, data: candsB2 } = await apiJson(
        `/api/compounds/${COMPOUND_B}/candidates/${nextB.viva_code}`
      );

      if (candsStatus === 200) {
        // Listing still in queue — verify candidate was removed
        const codes = candsB2.candidates.map((c) => c.code);
        assert.ok(!codes.includes(candidateCode), 'rejected candidate should be removed');
        assert.ok(candsB2.total_candidates < candidatesBefore, 'should have fewer candidates');
      } else {
        // Listing removed from queue (had only 1 candidate) — 404 is expected
        assert.equal(candsStatus, 404, 'listing with 0 candidates should be removed from queue');
      }
    });
  });

  // --------------------------------------------------------------------------
  // Pass advancement per-compound
  // --------------------------------------------------------------------------

  describe('Pass advancement per-compound', () => {
    it('advancing pass on compound A does not affect compound B', async () => {
      // Skip remaining listings in compound A to exhaust the pass queue
      let next = await apiJson(`/api/compounds/${COMPOUND_A}/next`);
      while (next.data.viva_code) {
        await apiPost(`/api/compounds/${COMPOUND_A}/skip`, {
          viva_code: next.data.viva_code,
          reviewer: REVIEWER,
        });
        next = await apiJson(`/api/compounds/${COMPOUND_A}/next`);
      }

      // Pass should now be complete
      assert.ok(next.data.pass_complete, 'compound A pass should be complete');

      if (next.data.has_next_pass) {
        // Advance pass
        const { status, data } = await apiPost(
          `/api/compounds/${COMPOUND_A}/pass/advance`
        );
        assert.equal(status, 200);
        assert.ok(data.success);
        assert.equal(data.current_pass, 2);

        // Compound B should still be on pass 1
        const { data: sessionB } = await apiJson(
          `/api/compounds/${COMPOUND_B}/session`
        );
        assert.equal(sessionB.current_pass, 1, 'compound B should still be on pass 1');
      }
    });
  });

  // --------------------------------------------------------------------------
  // Legacy routes forward to default compound
  // --------------------------------------------------------------------------

  describe('Legacy routes', () => {
    it('GET /api/session forwards to default compound (alphaville-1)', async () => {
      const { data: legacy } = await apiJson('/api/session');
      const { data: compound } = await apiJson(
        `/api/compounds/${COMPOUND_A}/session`
      );

      assert.equal(legacy.stats.matched, compound.stats.matched);
      assert.equal(
        legacy.stats.total_viva_listings,
        compound.stats.total_viva_listings
      );
      assert.equal(legacy.current_pass, compound.current_pass);
    });

    it('GET /api/progress forwards to default compound', async () => {
      const { data: legacy } = await apiJson('/api/progress');
      const { data: compound } = await apiJson(
        `/api/compounds/${COMPOUND_A}/progress`
      );

      assert.equal(legacy.matched, compound.matched);
      assert.equal(legacy.total_viva_listings, compound.total_viva_listings);
    });
  });

  // --------------------------------------------------------------------------
  // Unknown compound returns 404
  // --------------------------------------------------------------------------

  describe('Unknown compound', () => {
    it('GET /api/compounds/nonexistent/session returns 404', async () => {
      const { status, data } = await apiJson(
        '/api/compounds/nonexistent/session'
      );
      assert.equal(status, 404);
      assert.ok(data.error);
      assert.ok(data.error.includes('nonexistent'));
    });

    it('POST /api/compounds/nonexistent/match returns 404', async () => {
      const { status } = await apiPost('/api/compounds/nonexistent/match', {
        viva_code: 'X',
        coelho_code: 'Y',
        reviewer: REVIEWER,
      });
      assert.equal(status, 404);
    });
  });
});
