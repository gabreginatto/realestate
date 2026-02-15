/**
 * Integration tests for the Mobile API contract
 *
 * Tests the matching server API endpoints against the TypeScript types
 * defined in matcher-mobile/types/index.ts and the API client functions
 * in matcher-mobile/lib/api.ts.
 *
 * Uses Node's built-in test runner (node:test) and starts a real server
 * instance with mock data in a temp directory.
 *
 * Run:
 *   node --test tests/mobile-api.test.mjs
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

// ============================================================================
// Test Configuration
// ============================================================================

const TEST_PORT = 19876;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const REVIEWER = 'test-reviewer';
const SERVER_SCRIPT = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  'server-deploy',
  'matching-server.js'
);

// ============================================================================
// Mock Data Generators
// ============================================================================

function createMockDeterministicMatches() {
  return {
    generated_at: new Date().toISOString(),
    approach: 'Test data',
    total_viva_listings: 3,
    listings_with_candidates: 3,
    total_candidate_pairs: 6,
    skip_reasons: { noArea: 0, noAreaMatches: 0, noStrongCandidates: 0, queued: 3 },
    candidate_pairs: [
      {
        viva: {
          code: 'VIVA001',
          url: 'https://example.com/viva/001',
          price: 'R$ 1.000.000,00',
          built: 200,
          beds: 3,
          suites: 2,
          park: 2,
          features: 'PG',
          address: 'Rua Test 1, Sao Paulo',
        },
        candidates: [
          {
            code: 'COELHO001',
            url: 'https://example.com/coelho/001',
            price: 'R$1.050.000',
            built: 195,
            beds: 3,
            suites: 2,
            park: 2,
            features: 'P',
            score: 0.92,
          },
          {
            code: 'COELHO002',
            url: 'https://example.com/coelho/002',
            price: 'R$980.000',
            built: 210,
            beds: 3,
            suites: 1,
            park: 2,
            features: 'NONE',
            score: 0.75,
          },
        ],
      },
      {
        viva: {
          code: 'VIVA002',
          url: 'https://example.com/viva/002',
          price: 'R$ 2.500.000,00',
          built: 350,
          beds: 4,
          suites: 4,
          park: 4,
          features: 'PG',
          address: 'Av Test 2, Sao Paulo',
        },
        candidates: [
          {
            code: 'COELHO003',
            url: 'https://example.com/coelho/003',
            price: 'R$2.600.000',
            built: 340,
            beds: 4,
            suites: 4,
            park: 4,
            features: 'P',
            score: 0.88,
          },
          {
            code: 'COELHO004',
            url: 'https://example.com/coelho/004',
            price: 'R$2.400.000',
            built: 360,
            beds: 4,
            suites: 3,
            park: 3,
            features: 'NONE',
            score: 0.65,
          },
        ],
      },
      {
        viva: {
          code: 'VIVA003',
          url: 'https://example.com/viva/003',
          price: 'R$ 800.000,00',
          built: 120,
          beds: 2,
          suites: 1,
          park: 1,
          features: 'NONE',
          address: 'Rua Test 3, Sao Paulo',
        },
        candidates: [
          {
            code: 'COELHO005',
            url: 'https://example.com/coelho/005',
            price: 'R$850.000',
            built: 115,
            beds: 2,
            suites: 1,
            park: 1,
            features: 'NONE',
            score: 0.81,
          },
          {
            code: 'COELHO006',
            url: 'https://example.com/coelho/006',
            price: 'R$750.000',
            built: 130,
            beds: 2,
            suites: 0,
            park: 1,
            features: 'P',
            score: 0.55,
          },
        ],
      },
    ],
  };
}

// ============================================================================
// Server Lifecycle Helpers
// ============================================================================

let serverProcess = null;
let tempDir = null;

/**
 * Creates a temp data directory with mock data and starts the server.
 * Returns a promise that resolves when the server is ready.
 */
async function startServer() {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'matcher-test-'));

  // Create data subdirectories
  const mosaicsVivaDir = path.join(tempDir, 'mosaics', 'viva');
  const mosaicsCoelhoDir = path.join(tempDir, 'mosaics', 'coelho');
  fs.mkdirSync(mosaicsVivaDir, { recursive: true });
  fs.mkdirSync(mosaicsCoelhoDir, { recursive: true });

  // Write mock deterministic matches
  const matchesData = createMockDeterministicMatches();
  fs.writeFileSync(
    path.join(tempDir, 'deterministic-matches.json'),
    JSON.stringify(matchesData, null, 2)
  );

  // Create placeholder mosaic images (1x1 PNG)
  const tinyPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  );
  for (const code of ['VIVA001', 'VIVA002', 'VIVA003']) {
    fs.writeFileSync(path.join(mosaicsVivaDir, `${code}.png`), tinyPng);
  }
  for (const code of ['COELHO001', 'COELHO002', 'COELHO003', 'COELHO004', 'COELHO005', 'COELHO006']) {
    fs.writeFileSync(path.join(mosaicsCoelhoDir, `${code}.png`), tinyPng);
  }

  return new Promise((resolve, reject) => {
    serverProcess = spawn('node', [SERVER_SCRIPT], {
      env: {
        ...process.env,
        PORT: String(TEST_PORT),
        HOST: '127.0.0.1',
        DATA_ROOT: tempDir,
        SESSION_NAME: 'test-session',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    serverProcess.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      // Server prints "Server running on:" when ready
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
        reject(new Error(`Server exited with code ${code}.\nStdout: ${stdout}\nStderr: ${stderr}`));
      }
    });

    // Timeout after 15s
    setTimeout(() => {
      reject(new Error(`Server startup timed out.\nStdout: ${stdout}\nStderr: ${stderr}`));
    }, 15000);
  });
}

function stopServer() {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
}

function cleanupTempDir() {
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
}

/**
 * Reset server state by removing manual-matches.json, audit log,
 * and notifications, then restarting.
 */
async function resetServerState() {
  stopServer();

  // Remove state files but keep deterministic-matches.json and mosaics
  for (const file of ['manual-matches.json', 'manual-matches.log.jsonl', 'notifications.json']) {
    const filePath = path.join(tempDir, file);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  await startServer();
}

// ============================================================================
// HTTP Helper
// ============================================================================

async function api(endpoint, options = {}) {
  const url = `${BASE_URL}${endpoint}`;
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  return response;
}

async function apiJson(endpoint, options = {}) {
  const response = await api(endpoint, options);
  const data = await response.json();
  return { status: response.status, data };
}

async function apiPost(endpoint, body = {}) {
  return apiJson(endpoint, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// ============================================================================
// Type Shape Validators
// ============================================================================

/**
 * Validates that a value is a non-null object with the specified keys.
 * Keys map to expected types: 'string', 'number', 'boolean', 'object', 'array',
 * or an array of allowed types like ['string', 'number'].
 * A key prefixed with '?' is optional.
 */
function assertShape(value, shape, label = 'value') {
  assert.ok(value !== null && value !== undefined, `${label} should not be null/undefined`);
  assert.equal(typeof value, 'object', `${label} should be an object`);

  for (const [key, expectedType] of Object.entries(shape)) {
    const isOptional = key.startsWith('?');
    const cleanKey = isOptional ? key.slice(1) : key;

    if (isOptional && (value[cleanKey] === undefined || value[cleanKey] === null)) {
      continue;
    }

    const actual = value[cleanKey];

    if (Array.isArray(expectedType)) {
      // Union type - value must match one of the listed types
      const actualType = Array.isArray(actual) ? 'array' : typeof actual;
      const allowed = expectedType.includes('null') && actual === null
        ? true
        : expectedType.includes(actualType);
      assert.ok(allowed, `${label}.${cleanKey} should be one of [${expectedType}], got ${actualType} (${JSON.stringify(actual)})`);
    } else if (expectedType === 'array') {
      assert.ok(Array.isArray(actual), `${label}.${cleanKey} should be an array, got ${typeof actual}`);
    } else {
      assert.equal(typeof actual, expectedType, `${label}.${cleanKey} should be ${expectedType}, got ${typeof actual} (${JSON.stringify(actual)})`);
    }
  }
}

// Session shape (from types/index.ts Session)
const SESSION_SHAPE = {
  session_name: 'string',
  version: 'number',
  stats: 'object',
  read_only: 'boolean',
  '?current_pass': 'number',
  '?passes_completed': 'number',
  '?max_passes': 'number',
  '?pass_criteria': 'object',
  '?session_started': ['string', 'null'],
  '?last_updated': ['string', 'null'],
};

// SessionStats shape
const SESSION_STATS_SHAPE = {
  total_viva_listings: 'number',
  matched: 'number',
  rejected: 'number',
  skipped: 'number',
  pending: 'number',
  in_progress: 'number',
};

// NextListingResponse shape (normal listing)
const NEXT_LISTING_SHAPE = {
  viva_code: 'string',
  viva: 'object',
  remaining_candidates: 'number',
  mosaic_path: 'string',
  '?current_pass': 'number',
  '?pass_name': 'string',
  '?pending_in_pass': 'number',
};

// CandidatesResponse shape
const CANDIDATES_RESPONSE_SHAPE = {
  viva_code: 'string',
  candidates: 'array',
  total_candidates: 'number',
};

// Individual candidate shape in the candidates array
const CANDIDATE_ITEM_SHAPE = {
  code: 'string',
  candidate: 'object',
  ai_score: ['number', 'null'],
  deltas: 'object',
  mosaic_path: 'string',
};

// CandidateDeltas shape
const DELTAS_SHAPE = {
  price_viva: ['number', 'null'],
  price_coelho: ['number', 'null'],
  price_delta_pct: ['number', 'null'],
  area_viva: ['number', 'null'],
  area_coelho: ['number', 'null'],
  area_delta_pct: ['number', 'null'],
};

// MatchResult shape
const MATCH_RESULT_SHAPE = {
  success: 'boolean',
  match: 'object',
  remaining: 'number',
};

// SkipResult shape
const SKIP_RESULT_SHAPE = {
  success: 'boolean',
  skip: 'object',
  remaining: 'number',
};

// UndoResult shape
const UNDO_RESULT_SHAPE = {
  success: 'boolean',
  undone: 'object',
  remaining: 'number',
};

// Progress shape
const PROGRESS_SHAPE = {
  total_viva_listings: 'number',
  matched: 'number',
  skipped: 'number',
  pending: 'number',
  in_progress: 'number',
  completed: 'number',
  progress_pct: 'number',
  '?current_pass': 'number',
  '?max_passes': 'number',
  '?pass_name': 'string',
  '?pass_criteria': 'object',
};

// ============================================================================
// TESTS
// ============================================================================

describe('Mobile API Contract Tests', () => {
  before(async () => {
    await startServer();
  });

  after(() => {
    stopServer();
    cleanupTempDir();
  });

  // ==========================================================================
  // Session Endpoint
  // ==========================================================================
  describe('GET /api/session', () => {
    it('returns valid Session shape matching TypeScript types', async () => {
      const { status, data } = await apiJson('/api/session');

      assert.equal(status, 200);
      assertShape(data, SESSION_SHAPE, 'session');
      assertShape(data.stats, SESSION_STATS_SHAPE, 'session.stats');
    });

    it('returns correct initial session values', async () => {
      const { data } = await apiJson('/api/session');

      assert.equal(data.session_name, 'test-session');
      assert.equal(data.read_only, false);
      assert.equal(data.stats.total_viva_listings, 3);
      assert.equal(data.stats.matched, 0);
      assert.equal(data.stats.rejected, 0);
      assert.equal(data.stats.skipped, 0);
    });

    it('includes pass criteria with tolerance strings', async () => {
      const { data } = await apiJson('/api/session');

      assert.ok(data.pass_criteria, 'pass_criteria should be present');
      assert.ok(data.pass_criteria.name, 'pass_criteria.name should be present');
      assert.ok(
        data.pass_criteria.price_tolerance.includes('%'),
        'price_tolerance should contain %'
      );
      assert.ok(
        data.pass_criteria.area_tolerance.includes('%'),
        'area_tolerance should contain %'
      );
    });

    it('returns current_pass and max_passes', async () => {
      const { data } = await apiJson('/api/session');

      assert.equal(data.current_pass, 1);
      assert.equal(data.max_passes, 5);
    });
  });

  // ==========================================================================
  // Next Listing Endpoint
  // ==========================================================================
  describe('GET /api/next', () => {
    it('returns valid NextListingResponse shape for a normal listing', async () => {
      const { status, data } = await apiJson(`/api/next?reviewer=${REVIEWER}`);

      assert.equal(status, 200);
      assertShape(data, NEXT_LISTING_SHAPE, 'nextListing');
    });

    it('returns a viva object with expected listing properties', async () => {
      const { data } = await apiJson(`/api/next?reviewer=${REVIEWER}`);

      assert.ok(data.viva, 'viva should be present');
      assert.ok(data.viva_code, 'viva_code should be present');
      assert.ok(data.mosaic_path.startsWith('/mosaics/viva/'), 'mosaic_path should start with /mosaics/viva/');
    });

    it('includes pass tracking fields', async () => {
      const { data } = await apiJson(`/api/next?reviewer=${REVIEWER}`);

      assert.equal(typeof data.current_pass, 'number');
      assert.equal(typeof data.pass_name, 'string');
      assert.equal(typeof data.pending_in_pass, 'number');
    });

    it('viva object includes specs field for mobile normalization', async () => {
      const { data } = await apiJson(`/api/next?reviewer=${REVIEWER}`);

      // The server transforms viva data to include specs for the mobile app
      assert.ok(data.viva.specs, 'viva.specs should be present');
      assert.equal(typeof data.viva.specs.area_construida, 'number');
      assert.equal(typeof data.viva.specs.dormitorios, 'number');
      assert.equal(typeof data.viva.specs.suites, 'number');
    });

    it('returns default reviewer as anonymous when not specified', async () => {
      // The endpoint accepts reviewer as a query param; it does not return it
      // but it's used internally for in_progress tracking
      const { status, data } = await apiJson('/api/next');

      assert.equal(status, 200);
      assert.ok(data.viva_code, 'Should return a listing even without reviewer');
    });
  });

  // ==========================================================================
  // Candidates Endpoint
  // ==========================================================================
  describe('GET /api/candidates/:id', () => {
    let vivaCode;

    before(async () => {
      const { data } = await apiJson(`/api/next?reviewer=${REVIEWER}`);
      vivaCode = data.viva_code;
    });

    it('returns valid CandidatesResponse shape', async () => {
      const { status, data } = await apiJson(`/api/candidates/${vivaCode}`);

      assert.equal(status, 200);
      assertShape(data, CANDIDATES_RESPONSE_SHAPE, 'candidates');
      assert.equal(data.viva_code, vivaCode);
    });

    it('returns at least one candidate', async () => {
      const { data } = await apiJson(`/api/candidates/${vivaCode}`);

      assert.ok(data.candidates.length > 0, 'Should have at least one candidate');
      assert.equal(data.total_candidates, data.candidates.length);
    });

    it('each candidate matches the expected shape', async () => {
      const { data } = await apiJson(`/api/candidates/${vivaCode}`);

      for (const candidate of data.candidates) {
        assertShape(candidate, CANDIDATE_ITEM_SHAPE, 'candidate');
        assertShape(candidate.deltas, DELTAS_SHAPE, 'candidate.deltas');
      }
    });

    it('candidate mosaic_path points to coelho directory', async () => {
      const { data } = await apiJson(`/api/candidates/${vivaCode}`);

      for (const candidate of data.candidates) {
        assert.ok(
          candidate.mosaic_path.startsWith('/mosaics/coelho/'),
          `mosaic_path should start with /mosaics/coelho/, got ${candidate.mosaic_path}`
        );
      }
    });

    it('candidate includes features string for frontend display', async () => {
      const { data } = await apiJson(`/api/candidates/${vivaCode}`);

      for (const candidate of data.candidates) {
        assert.equal(typeof candidate.candidate.features, 'string');
        assert.ok(
          candidate.candidate.features.includes('m²'),
          'features should include area in m²'
        );
      }
    });

    it('deltas contain price and area comparison data', async () => {
      const { data } = await apiJson(`/api/candidates/${vivaCode}`);

      for (const candidate of data.candidates) {
        const d = candidate.deltas;
        // Prices should be parsed from R$ format
        assert.ok(d.price_viva === null || typeof d.price_viva === 'number');
        assert.ok(d.price_coelho === null || typeof d.price_coelho === 'number');
        assert.ok(d.price_delta_pct === null || typeof d.price_delta_pct === 'number');
        assert.ok(d.area_viva === null || typeof d.area_viva === 'number');
        assert.ok(d.area_coelho === null || typeof d.area_coelho === 'number');
        assert.ok(d.area_delta_pct === null || typeof d.area_delta_pct === 'number');
      }
    });

    it('returns 404 for nonexistent listing code', async () => {
      const { status, data } = await apiJson('/api/candidates/NONEXISTENT');

      assert.equal(status, 404);
      assert.ok(data.error, 'Should return error message');
    });
  });

  // ==========================================================================
  // Listing Endpoint
  // ==========================================================================
  describe('GET /api/listing/:id', () => {
    let vivaCode;

    before(async () => {
      const { data } = await apiJson(`/api/next?reviewer=${REVIEWER}`);
      vivaCode = data.viva_code;
    });

    it('returns a valid listing for an existing viva code', async () => {
      const { status, data } = await apiJson(`/api/listing/${vivaCode}`);

      assert.equal(status, 200);
      assert.equal(data.viva_code, vivaCode);
      assert.ok(data.viva, 'Should include viva object');
      assert.equal(typeof data.remaining_candidates, 'number');
      assert.ok(data.mosaic_path.startsWith('/mosaics/viva/'));
    });

    it('returns 404 for nonexistent listing', async () => {
      const { status, data } = await apiJson('/api/listing/NONEXISTENT');

      assert.equal(status, 404);
      assert.ok(data.error);
    });
  });

  // ==========================================================================
  // Match Endpoint
  // ==========================================================================
  describe('POST /api/match', () => {
    let vivaCode;
    let coelhoCode;

    before(async () => {
      // Get a fresh listing and its candidates
      const nextResult = await apiJson(`/api/next?reviewer=${REVIEWER}`);
      vivaCode = nextResult.data.viva_code;
      const candidatesResult = await apiJson(`/api/candidates/${vivaCode}`);
      coelhoCode = candidatesResult.data.candidates[0].code;
    });

    it('returns valid MatchResult shape on success', async () => {
      const { status, data } = await apiPost('/api/match', {
        viva_code: vivaCode,
        coelho_code: coelhoCode,
        time_spent_sec: 15,
        reviewer: REVIEWER,
      });

      assert.equal(status, 200);
      assertShape(data, MATCH_RESULT_SHAPE, 'matchResult');
      assert.equal(data.success, true);
    });

    it('match object has required fields', async () => {
      // We already matched above, check the match object structure
      // Do another match to verify (need a fresh listing)
      const nextResult = await apiJson(`/api/next?reviewer=${REVIEWER}`);

      // If done, that means we need to handle pass_complete or done
      if (nextResult.data.done || nextResult.data.pass_complete) {
        // Skip this test if no more listings available
        return;
      }

      const newVivaCode = nextResult.data.viva_code;
      const candidatesResult = await apiJson(`/api/candidates/${newVivaCode}`);
      const newCoelhoCode = candidatesResult.data.candidates[0].code;

      const { data } = await apiPost('/api/match', {
        viva_code: newVivaCode,
        coelho_code: newCoelhoCode,
        time_spent_sec: 10,
        reviewer: REVIEWER,
      });

      assert.ok(data.match, 'match object should be present');
      assert.equal(data.match.viva_code, newVivaCode);
      assert.equal(data.match.coelho_code, newCoelhoCode);
      assert.equal(data.match.reviewer, REVIEWER);
      assert.equal(data.match.confidence, 'manual_confirmed');
      assert.equal(typeof data.match.matched_at, 'string');
    });

    it('returns 400 when missing required parameters', async () => {
      const { status, data } = await apiPost('/api/match', {
        // Missing viva_code and coelho_code
        reviewer: REVIEWER,
      });

      assert.equal(status, 400);
      assert.ok(data.error, 'Should return error message');
    });

    it('returns 404 when listing not found in queue', async () => {
      const { status, data } = await apiPost('/api/match', {
        viva_code: 'NONEXISTENT',
        coelho_code: 'COELHO001',
        reviewer: REVIEWER,
      });

      assert.equal(status, 404);
      assert.ok(data.error);
    });
  });

  // ==========================================================================
  // Skip Endpoint
  // ==========================================================================
  describe('POST /api/skip', () => {
    it('returns valid SkipResult shape on success', async () => {
      // Get next available listing
      const nextResult = await apiJson(`/api/next?reviewer=${REVIEWER}`);

      if (nextResult.data.done || nextResult.data.pass_complete) {
        // No more listings - skip this test
        return;
      }

      const vivaCode = nextResult.data.viva_code;

      const { status, data } = await apiPost('/api/skip', {
        viva_code: vivaCode,
        time_spent_sec: 5,
        reviewer: REVIEWER,
        reason: 'no_good_candidates',
      });

      assert.equal(status, 200);
      assertShape(data, SKIP_RESULT_SHAPE, 'skipResult');
      assert.equal(data.success, true);
    });

    it('skip object has expected fields', async () => {
      const nextResult = await apiJson(`/api/next?reviewer=${REVIEWER}`);

      if (nextResult.data.done || nextResult.data.pass_complete) {
        return;
      }

      const vivaCode = nextResult.data.viva_code;

      const { data } = await apiPost('/api/skip', {
        viva_code: vivaCode,
        time_spent_sec: 3,
        reviewer: REVIEWER,
        reason: 'no_good_candidates',
      });

      assert.ok(data.skip, 'skip object should be present');
      assert.equal(data.skip.viva_code, vivaCode);
      assert.equal(data.skip.reviewer, REVIEWER);
      assert.equal(data.skip.reason, 'no_good_candidates');
      assert.equal(typeof data.skip.skipped_at, 'string');
    });

    it('returns 400 when missing viva_code', async () => {
      const { status, data } = await apiPost('/api/skip', {
        reviewer: REVIEWER,
        reason: 'no_good_candidates',
      });

      assert.equal(status, 400);
      assert.ok(data.error);
    });
  });

  // ==========================================================================
  // Reject Endpoint
  // ==========================================================================
  describe('POST /api/reject', () => {
    it('returns valid response on success', async () => {
      // Reset to get fresh listings
      await resetServerState();

      const nextResult = await apiJson(`/api/next?reviewer=${REVIEWER}`);
      const vivaCode = nextResult.data.viva_code;
      const candidatesResult = await apiJson(`/api/candidates/${vivaCode}`);
      const coelhoCode = candidatesResult.data.candidates[0].code;

      const { status, data } = await apiPost('/api/reject', {
        viva_code: vivaCode,
        coelho_code: coelhoCode,
        reviewer: REVIEWER,
        reason: 'visual_mismatch',
      });

      assert.equal(status, 200);
      assert.equal(data.success, true);
      assert.ok(data.rejection, 'rejection object should be present');
      assert.equal(data.rejection.viva_code, vivaCode);
      assert.equal(data.rejection.coelho_code, coelhoCode);
      assert.equal(data.rejection.reviewer, REVIEWER);
      assert.equal(data.rejection.reason, 'visual_mismatch');
      assert.equal(typeof data.rejection.rejected_at, 'string');
    });

    it('reduces candidate count after rejection', async () => {
      await resetServerState();

      const nextResult = await apiJson(`/api/next?reviewer=${REVIEWER}`);
      const vivaCode = nextResult.data.viva_code;

      const beforeResult = await apiJson(`/api/candidates/${vivaCode}`);
      const initialCount = beforeResult.data.total_candidates;
      const coelhoCode = beforeResult.data.candidates[0].code;

      await apiPost('/api/reject', {
        viva_code: vivaCode,
        coelho_code: coelhoCode,
        reviewer: REVIEWER,
        reason: 'visual_mismatch',
      });

      const afterResult = await apiJson(`/api/candidates/${vivaCode}`);
      assert.equal(afterResult.data.total_candidates, initialCount - 1);
    });

    it('returns 400 when missing required parameters', async () => {
      const { status, data } = await apiPost('/api/reject', {
        reviewer: REVIEWER,
      });

      assert.equal(status, 400);
      assert.ok(data.error);
    });
  });

  // ==========================================================================
  // Undo Endpoint
  // ==========================================================================
  describe('POST /api/undo', () => {
    it('returns valid UndoResult shape after undoing a match', async () => {
      await resetServerState();

      // First, make a match
      const nextResult = await apiJson(`/api/next?reviewer=${REVIEWER}`);
      const vivaCode = nextResult.data.viva_code;
      const candidatesResult = await apiJson(`/api/candidates/${vivaCode}`);
      const coelhoCode = candidatesResult.data.candidates[0].code;

      await apiPost('/api/match', {
        viva_code: vivaCode,
        coelho_code: coelhoCode,
        time_spent_sec: 10,
        reviewer: REVIEWER,
      });

      // Now undo it
      const { status, data } = await apiPost('/api/undo', {
        reviewer: REVIEWER,
      });

      assert.equal(status, 200);
      assertShape(data, UNDO_RESULT_SHAPE, 'undoResult');
      assert.equal(data.success, true);
      assert.equal(data.undone.type, 'match');
      assert.equal(data.undone.viva_code, vivaCode);
    });

    it('returns valid UndoResult shape after undoing a skip', async () => {
      await resetServerState();

      // First, skip a listing
      const nextResult = await apiJson(`/api/next?reviewer=${REVIEWER}`);
      const vivaCode = nextResult.data.viva_code;

      await apiPost('/api/skip', {
        viva_code: vivaCode,
        time_spent_sec: 5,
        reviewer: REVIEWER,
      });

      // Now undo it
      const { status, data } = await apiPost('/api/undo', {
        reviewer: REVIEWER,
      });

      assert.equal(status, 200);
      assert.equal(data.undone.type, 'skip');
      assert.equal(data.undone.viva_code, vivaCode);
    });

    it('returns 404 when nothing to undo', async () => {
      await resetServerState();

      const { status, data } = await apiPost('/api/undo', {
        reviewer: 'fresh-reviewer-with-no-actions',
      });

      assert.equal(status, 404);
      assert.ok(data.error);
    });

    it('undo restores listing back to the task queue', async () => {
      await resetServerState();

      // Get initial session stats
      const beforeSession = await apiJson('/api/session');
      const initialPending = beforeSession.data.stats.pending;

      // Match a listing
      const nextResult = await apiJson(`/api/next?reviewer=${REVIEWER}`);
      const vivaCode = nextResult.data.viva_code;
      const candidatesResult = await apiJson(`/api/candidates/${vivaCode}`);
      const coelhoCode = candidatesResult.data.candidates[0].code;

      await apiPost('/api/match', {
        viva_code: vivaCode,
        coelho_code: coelhoCode,
        time_spent_sec: 10,
        reviewer: REVIEWER,
      });

      // Verify pending decreased
      const afterMatch = await apiJson('/api/session');
      assert.equal(afterMatch.data.stats.matched, 1);

      // Undo
      await apiPost('/api/undo', { reviewer: REVIEWER });

      // Verify pending restored
      const afterUndo = await apiJson('/api/session');
      assert.equal(afterUndo.data.stats.matched, 0);
      assert.equal(afterUndo.data.stats.pending, initialPending);
    });
  });

  // ==========================================================================
  // Progress Endpoint
  // ==========================================================================
  describe('GET /api/progress', () => {
    before(async () => {
      await resetServerState();
    });

    it('returns valid Progress shape', async () => {
      const { status, data } = await apiJson('/api/progress');

      assert.equal(status, 200);
      assertShape(data, PROGRESS_SHAPE, 'progress');
    });

    it('returns initial progress values', async () => {
      const { data } = await apiJson('/api/progress');

      assert.equal(data.total_viva_listings, 3);
      assert.equal(data.matched, 0);
      assert.equal(data.skipped, 0);
      assert.equal(data.completed, 0);
      assert.equal(data.progress_pct, 0);
    });

    it('progress_pct updates after match', async () => {
      const nextResult = await apiJson(`/api/next?reviewer=${REVIEWER}`);
      const vivaCode = nextResult.data.viva_code;
      const candidatesResult = await apiJson(`/api/candidates/${vivaCode}`);
      const coelhoCode = candidatesResult.data.candidates[0].code;

      await apiPost('/api/match', {
        viva_code: vivaCode,
        coelho_code: coelhoCode,
        time_spent_sec: 5,
        reviewer: REVIEWER,
      });

      const { data } = await apiJson('/api/progress');
      assert.ok(data.progress_pct > 0, 'progress_pct should increase after match');
      assert.equal(data.matched, 1);
      assert.equal(data.completed, 1);
    });

    it('includes pass criteria information', async () => {
      const { data } = await apiJson('/api/progress');

      assert.ok(data.pass_criteria, 'Should include pass_criteria');
      assert.ok(data.pass_criteria.price_tolerance.includes('%'));
      assert.ok(data.pass_criteria.area_tolerance.includes('%'));
      assert.ok(data.pass_name, 'Should include pass_name');
    });
  });

  // ==========================================================================
  // Pass Complete / Done Responses
  // ==========================================================================
  describe('Pass Complete and Done responses', () => {
    it('returns pass_complete when all listings in current pass are processed', async () => {
      await resetServerState();

      // Process all 3 listings by skipping them
      for (let i = 0; i < 3; i++) {
        const nextResult = await apiJson(`/api/next?reviewer=${REVIEWER}`);
        if (nextResult.data.done || nextResult.data.pass_complete) break;

        await apiPost('/api/skip', {
          viva_code: nextResult.data.viva_code,
          time_spent_sec: 1,
          reviewer: REVIEWER,
        });
      }

      // Next call should return pass_complete
      const { status, data } = await apiJson(`/api/next?reviewer=${REVIEWER}`);

      assert.equal(status, 200);
      assert.equal(data.pass_complete, true);
      assert.equal(typeof data.current_pass, 'number');
      assert.equal(typeof data.pass_name, 'string');
      assert.ok(data.stats, 'Should include stats');
      assert.equal(typeof data.stats.matched, 'number');
      assert.equal(typeof data.stats.skipped, 'number');
      assert.equal(typeof data.stats.total_reviewed, 'number');
      assert.equal(typeof data.has_next_pass, 'boolean');
    });

    it('pass_complete includes next_pass info when more passes available', async () => {
      await resetServerState();

      // Skip all listings
      for (let i = 0; i < 3; i++) {
        const nextResult = await apiJson(`/api/next?reviewer=${REVIEWER}`);
        if (nextResult.data.done || nextResult.data.pass_complete) break;

        await apiPost('/api/skip', {
          viva_code: nextResult.data.viva_code,
          time_spent_sec: 1,
          reviewer: REVIEWER,
        });
      }

      const { data } = await apiJson(`/api/next?reviewer=${REVIEWER}`);

      // Since we have raw listing files needed for pass advance, but we don't
      // have those in our test setup, has_next_pass depends on whether
      // skipped > 0 and currentPass < maxPasses
      if (data.has_next_pass) {
        assert.ok(data.next_pass, 'next_pass should be present when has_next_pass is true');
        assert.equal(typeof data.next_pass.number, 'number');
        assert.equal(typeof data.next_pass.name, 'string');
        assert.ok(data.next_pass.price_tolerance.includes('%'));
        assert.ok(data.next_pass.area_tolerance.includes('%'));
      }
    });

    it('returns done=true after user finishes matching', async () => {
      await resetServerState();

      // Finish matching
      await apiPost('/api/pass/finish', { reviewer: REVIEWER });

      const { status, data } = await apiJson(`/api/next?reviewer=${REVIEWER}`);

      assert.equal(status, 200);
      assert.equal(data.done, true);
      assert.equal(typeof data.message, 'string');
    });
  });

  // ==========================================================================
  // Pass Advance / Finish Endpoints
  // ==========================================================================
  describe('POST /api/pass/advance', () => {
    it('returns a response indicating whether advance succeeded', async () => {
      await resetServerState();

      // The advance endpoint tries to regenerate candidates with broader criteria.
      // Without raw listing files, it will likely fail but should still return a
      // valid response shape.
      const { status, data } = await apiPost('/api/pass/advance');

      assert.equal(status, 200);
      assert.equal(typeof data.success, 'boolean');
      assert.equal(typeof data.current_pass, 'number');

      if (data.success) {
        assert.ok(data.pass_name, 'Should include pass_name on success');
        assert.equal(typeof data.pending, 'number');
      }
    });
  });

  describe('POST /api/pass/finish', () => {
    it('returns valid finish response shape', async () => {
      await resetServerState();

      const { status, data } = await apiPost('/api/pass/finish', {
        reviewer: REVIEWER,
      });

      assert.equal(status, 200);
      assert.equal(data.success, true);
      assert.ok(data.summary, 'Should include summary');
      assert.equal(typeof data.summary.total_matches, 'number');
      assert.equal(typeof data.summary.total_skipped, 'number');
      assert.equal(typeof data.summary.passes_completed, 'number');
    });
  });

  // ==========================================================================
  // Notification Endpoints
  // ==========================================================================
  describe('Notification API', () => {
    before(async () => {
      await resetServerState();
    });

    it('GET /api/notifications returns empty initially', async () => {
      const { status, data } = await apiJson('/api/notifications');

      assert.equal(status, 200);
      assert.ok(Array.isArray(data.notifications));
      assert.equal(typeof data.unread_count, 'number');
      assert.equal(data.unread_count, 0);
    });

    it('POST /api/pipeline/trigger creates a notification', async () => {
      const { status, data } = await apiPost('/api/pipeline/trigger');

      assert.equal(status, 200);
      assert.equal(data.triggered, true);

      // Verify notification was created
      const notifs = await apiJson('/api/notifications');
      assert.ok(notifs.data.unread_count >= 1);
    });

    it('POST /api/pipeline/complete creates a pipeline_complete notification', async () => {
      const { status, data } = await apiPost('/api/pipeline/complete', {
        new_viva: 5,
        new_coelho: 10,
      });

      assert.equal(status, 200);
      assert.equal(data.success, true);
      assert.ok(data.notification_id, 'Should return notification_id');

      // Verify notification content
      const notifs = await apiJson('/api/notifications');
      const pipelineNotif = notifs.data.notifications.find(n => n.type === 'pipeline_complete');
      assert.ok(pipelineNotif, 'Should have a pipeline_complete notification');
      assert.ok(pipelineNotif.message.includes('5'), 'Message should mention new_viva count');
      assert.ok(pipelineNotif.message.includes('10'), 'Message should mention new_coelho count');
    });

    it('notification matches Notification type shape', async () => {
      const notifs = await apiJson('/api/notifications');

      for (const notif of notifs.data.notifications) {
        assert.equal(typeof notif.id, 'string');
        assert.ok(
          ['pipeline_complete', 'pipeline_trigger'].includes(notif.type),
          `type should be pipeline_complete or pipeline_trigger, got ${notif.type}`
        );
        assert.equal(typeof notif.message, 'string');
        assert.equal(typeof notif.data, 'object');
        assert.equal(typeof notif.created_at, 'string');
        assert.equal(typeof notif.read, 'boolean');
        assert.equal(notif.read, false, 'New notifications should be unread');
      }
    });

    it('POST /api/notifications/dismiss by id marks one as read', async () => {
      const notifs = await apiJson('/api/notifications');
      const firstNotif = notifs.data.notifications[0];

      const { status, data } = await apiPost('/api/notifications/dismiss', {
        id: firstNotif.id,
      });

      assert.equal(status, 200);
      assert.equal(data.success, true);

      // Verify count decreased
      const afterNotifs = await apiJson('/api/notifications');
      assert.ok(afterNotifs.data.unread_count < notifs.data.unread_count);
    });

    it('POST /api/notifications/dismiss all=true clears all', async () => {
      const { status, data } = await apiPost('/api/notifications/dismiss', {
        all: true,
      });

      assert.equal(status, 200);
      assert.equal(data.success, true);

      const afterNotifs = await apiJson('/api/notifications');
      assert.equal(afterNotifs.data.unread_count, 0);
    });

    it('POST /api/notifications/dismiss with invalid id returns 404', async () => {
      const { status, data } = await apiPost('/api/notifications/dismiss', {
        id: 'nonexistent-id',
      });

      assert.equal(status, 404);
      assert.ok(data.error);
    });

    it('POST /api/notifications/dismiss with no params returns 400', async () => {
      const { status, data } = await apiPost('/api/notifications/dismiss', {});

      assert.equal(status, 400);
      assert.ok(data.error);
    });
  });

  // ==========================================================================
  // Report Endpoints
  // ==========================================================================
  describe('Report API', () => {
    before(async () => {
      await resetServerState();
    });

    it('GET /api/report/unmatched returns valid shape', async () => {
      const { status, data } = await apiJson('/api/report/unmatched');

      assert.equal(status, 200);
      assert.equal(typeof data.total_viva, 'number');
      assert.equal(typeof data.total_matched, 'number');
      assert.equal(typeof data.total_unmatched, 'number');
      assert.ok(Array.isArray(data.listings));
    });

    it('initially all listings are unmatched', async () => {
      const { data } = await apiJson('/api/report/unmatched');

      assert.equal(data.total_matched, 0);
      assert.equal(data.total_unmatched, data.total_viva);
    });

    it('unmatched count decreases after a match', async () => {
      const nextResult = await apiJson(`/api/next?reviewer=${REVIEWER}`);
      const vivaCode = nextResult.data.viva_code;
      const candidatesResult = await apiJson(`/api/candidates/${vivaCode}`);
      const coelhoCode = candidatesResult.data.candidates[0].code;

      await apiPost('/api/match', {
        viva_code: vivaCode,
        coelho_code: coelhoCode,
        time_spent_sec: 5,
        reviewer: REVIEWER,
      });

      const { data } = await apiJson('/api/report/unmatched');
      assert.equal(data.total_matched, 1);
      assert.ok(data.total_unmatched < data.total_viva);
    });

    it('POST /api/report/send-email validates email format', async () => {
      const { status, data } = await apiPost('/api/report/send-email', {
        to: 'invalid-email',
      });

      assert.equal(status, 400);
      assert.ok(data.error);
    });

    it('POST /api/report/send-email with missing email returns 400', async () => {
      const { status, data } = await apiPost('/api/report/send-email', {});

      assert.equal(status, 400);
      assert.ok(data.error);
    });
  });

  // ==========================================================================
  // Audit Endpoint
  // ==========================================================================
  describe('GET /api/audit', () => {
    before(async () => {
      await resetServerState();
    });

    it('returns empty entries initially', async () => {
      const { status, data } = await apiJson('/api/audit');

      assert.equal(status, 200);
      assert.ok(Array.isArray(data.entries));
    });

    it('records actions in audit log', async () => {
      // Make a match to create audit entries
      const nextResult = await apiJson(`/api/next?reviewer=${REVIEWER}`);
      const vivaCode = nextResult.data.viva_code;
      const candidatesResult = await apiJson(`/api/candidates/${vivaCode}`);
      const coelhoCode = candidatesResult.data.candidates[0].code;

      await apiPost('/api/match', {
        viva_code: vivaCode,
        coelho_code: coelhoCode,
        time_spent_sec: 5,
        reviewer: REVIEWER,
      });

      const { data } = await apiJson('/api/audit');
      assert.ok(data.entries.length > 0, 'Should have audit entries');
      assert.equal(typeof data.total, 'number');

      // Check audit entry structure
      const entry = data.entries[data.entries.length - 1];
      assert.equal(typeof entry.id, 'string');
      assert.equal(typeof entry.timestamp, 'string');
      assert.equal(typeof entry.session, 'string');
      assert.equal(typeof entry.action, 'string');
      assert.equal(typeof entry.payload, 'object');
      assert.equal(typeof entry.hash, 'string');
    });
  });

  // ==========================================================================
  // Match Validation & Export Endpoints
  // ==========================================================================
  describe('Match Validation & Export', () => {
    before(async () => {
      await resetServerState();

      // Create a match for validation testing
      const nextResult = await apiJson(`/api/next?reviewer=${REVIEWER}`);
      const vivaCode = nextResult.data.viva_code;
      const candidatesResult = await apiJson(`/api/candidates/${vivaCode}`);
      const coelhoCode = candidatesResult.data.candidates[0].code;

      await apiPost('/api/match', {
        viva_code: vivaCode,
        coelho_code: coelhoCode,
        time_spent_sec: 5,
        reviewer: REVIEWER,
      });
    });

    it('GET /api/matches/validate returns validation results', async () => {
      const { status, data } = await apiJson('/api/matches/validate');

      assert.equal(status, 200);
      assert.ok(Array.isArray(data.valid));
      assert.ok(Array.isArray(data.invalid));
      assert.ok(Array.isArray(data.duplicates));
      assert.ok(data.summary, 'Should include summary');
      assert.equal(typeof data.summary.total, 'number');
      assert.equal(typeof data.summary.valid_count, 'number');
      assert.equal(typeof data.summary.invalid_count, 'number');
      assert.equal(typeof data.summary.duplicate_count, 'number');
    });

    it('GET /api/matches/export returns enriched match data', async () => {
      const { status, data } = await apiJson('/api/matches/export');

      assert.equal(status, 200);
      assert.ok(data.exported_at, 'Should include exported_at');
      assert.equal(typeof data.total_matches, 'number');
      assert.ok(Array.isArray(data.matches));

      if (data.matches.length > 0) {
        const match = data.matches[0];
        assert.ok(match.viva, 'Should include viva info');
        assert.ok(match.coelho, 'Should include coelho info');
        assert.ok(match.matched_at, 'Should include matched_at');
        assert.ok(match.reviewer, 'Should include reviewer');
      }
    });
  });

  // ==========================================================================
  // Static Asset / Mosaic Serving
  // ==========================================================================
  describe('Static Asset Serving', () => {
    it('serves viva mosaic images at /mosaics/viva/:code.png', async () => {
      const response = await api('/mosaics/viva/VIVA001.png');

      assert.equal(response.status, 200);
      assert.ok(
        response.headers.get('content-type').includes('image/png'),
        'Should serve as image/png'
      );
    });

    it('serves coelho mosaic images at /mosaics/coelho/:code.png', async () => {
      const response = await api('/mosaics/coelho/COELHO001.png');

      assert.equal(response.status, 200);
      assert.ok(
        response.headers.get('content-type').includes('image/png'),
        'Should serve as image/png'
      );
    });

    it('returns 404 for nonexistent mosaic', async () => {
      const response = await api('/mosaics/viva/NONEXISTENT.png');

      assert.equal(response.status, 404);
    });
  });

  // ==========================================================================
  // Error Handling & Edge Cases
  // ==========================================================================
  describe('Error Handling', () => {
    it('invalid JSON body returns appropriate error', async () => {
      const response = await fetch(`${BASE_URL}/api/match`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{invalid json',
      });

      assert.equal(response.status, 400);
    });

    it('unknown API endpoint returns 404', async () => {
      const response = await api('/api/unknown-endpoint');

      assert.equal(response.status, 404);
    });
  });

  // ==========================================================================
  // Workflow Integration Test
  // ==========================================================================
  describe('Full Matching Workflow', () => {
    before(async () => {
      await resetServerState();
    });

    it('complete workflow: session -> next -> candidates -> match -> progress -> undo -> skip', async () => {
      // Step 1: Load session
      const session = await apiJson('/api/session');
      assert.equal(session.status, 200);
      assert.equal(session.data.stats.total_viva_listings, 3);
      assert.equal(session.data.stats.pending, 3);

      // Step 2: Get next listing
      const next1 = await apiJson(`/api/next?reviewer=${REVIEWER}`);
      assert.equal(next1.status, 200);
      assert.ok(next1.data.viva_code);
      const vivaCode1 = next1.data.viva_code;

      // Step 3: Get candidates
      const candidates1 = await apiJson(`/api/candidates/${vivaCode1}`);
      assert.equal(candidates1.status, 200);
      assert.ok(candidates1.data.candidates.length >= 1);

      // Step 4: Match first listing
      const coelhoCode1 = candidates1.data.candidates[0].code;
      const match1 = await apiPost('/api/match', {
        viva_code: vivaCode1,
        coelho_code: coelhoCode1,
        time_spent_sec: 12,
        reviewer: REVIEWER,
      });
      assert.equal(match1.data.success, true);

      // Step 5: Verify progress updated
      const progress1 = await apiJson('/api/progress');
      assert.equal(progress1.data.matched, 1);
      assert.ok(progress1.data.progress_pct > 0);

      // Step 6: Undo the match
      const undo1 = await apiPost('/api/undo', { reviewer: REVIEWER });
      assert.equal(undo1.data.success, true);
      assert.equal(undo1.data.undone.type, 'match');

      // Step 7: Verify match was undone
      const progress2 = await apiJson('/api/progress');
      assert.equal(progress2.data.matched, 0);

      // Step 8: Get listing again (should be available again)
      const next2 = await apiJson(`/api/next?reviewer=${REVIEWER}`);
      assert.equal(next2.status, 200);
      assert.ok(next2.data.viva_code);

      // Step 9: Skip this listing instead
      const skip1 = await apiPost('/api/skip', {
        viva_code: next2.data.viva_code,
        time_spent_sec: 3,
        reviewer: REVIEWER,
      });
      assert.equal(skip1.data.success, true);

      // Step 10: Get next listing (should be a different one)
      const next3 = await apiJson(`/api/next?reviewer=${REVIEWER}`);
      assert.equal(next3.status, 200);

      // Step 11: Verify final session stats reflect changes
      const finalSession = await apiJson('/api/session');
      assert.equal(finalSession.data.stats.skipped, 1);
      assert.equal(finalSession.data.stats.matched, 0);
    });
  });

  // ==========================================================================
  // Matched Coelho Code Exclusion
  // ==========================================================================
  describe('Matched Coelho code exclusion', () => {
    before(async () => {
      await resetServerState();
    });

    it('already-matched Coelho codes are excluded from other listings candidates', async () => {
      // Get first listing
      const next1 = await apiJson(`/api/next?reviewer=${REVIEWER}`);
      const vivaCode1 = next1.data.viva_code;
      const candidates1 = await apiJson(`/api/candidates/${vivaCode1}`);
      const matchedCoelhoCode = candidates1.data.candidates[0].code;

      // Match it
      await apiPost('/api/match', {
        viva_code: vivaCode1,
        coelho_code: matchedCoelhoCode,
        time_spent_sec: 5,
        reviewer: REVIEWER,
      });

      // Get next listing
      const next2 = await apiJson(`/api/next?reviewer=${REVIEWER}`);
      if (next2.data.done || next2.data.pass_complete) return;

      const vivaCode2 = next2.data.viva_code;
      const candidates2 = await apiJson(`/api/candidates/${vivaCode2}`);

      // Verify the matched Coelho code is not in the candidates
      const coelhoCodes = candidates2.data.candidates.map(c => c.code);
      assert.ok(
        !coelhoCodes.includes(matchedCoelhoCode),
        `Already-matched Coelho code ${matchedCoelhoCode} should not appear as candidate`
      );
    });
  });

  // ==========================================================================
  // Session State Persistence
  // ==========================================================================
  describe('State Persistence', () => {
    it('manual-matches.json is created after first action', async () => {
      await resetServerState();

      // Initially no manual-matches.json (we deleted it in reset)
      // Make an action
      const next = await apiJson(`/api/next?reviewer=${REVIEWER}`);
      const vivaCode = next.data.viva_code;

      await apiPost('/api/skip', {
        viva_code: vivaCode,
        time_spent_sec: 1,
        reviewer: REVIEWER,
      });

      // Verify file was created
      const filePath = path.join(tempDir, 'manual-matches.json');
      assert.ok(fs.existsSync(filePath), 'manual-matches.json should be created');

      const fileContent = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      assert.ok(fileContent.version > 0, 'version should be incremented');
      assert.ok(fileContent.skipped.length > 0, 'skipped array should have entries');
    });

    it('audit log is created after first action', async () => {
      const logPath = path.join(tempDir, 'manual-matches.log.jsonl');
      assert.ok(fs.existsSync(logPath), 'audit log should be created');

      const content = fs.readFileSync(logPath, 'utf-8').trim();
      const lines = content.split('\n');
      assert.ok(lines.length > 0, 'audit log should have entries');

      // Each line should be valid JSON
      for (const line of lines) {
        assert.doesNotThrow(() => JSON.parse(line), 'Each audit line should be valid JSON');
      }
    });
  });
});
