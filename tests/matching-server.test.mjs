/**
 * Comprehensive tests for the Human-in-the-Loop Matching Server API.
 *
 * Uses Node.js built-in test runner (node:test) and node:assert/strict.
 * Spawns the real server as a child process against a temporary data directory,
 * exercises every API endpoint, and tears everything down afterwards.
 *
 * Run:
 *   node --test tests/matching-server.test.mjs
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SERVER_SCRIPT = path.join(PROJECT_ROOT, 'server-deploy', 'matching-server.js');

const COMPOUND = 'alphaville-1';
const C = `/api/compounds/${COMPOUND}`;

// ---------------------------------------------------------------------------
// Mock data factories
// ---------------------------------------------------------------------------

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
    price: 'R$ 1.050.000,00',
    address: `Rua Coelho ${code}`,
    url: `https://coelho.com/${code}`,
    beds: 3,
    suites: 1,
    built: 105,
    park: 2,
    features: 'P',
    ...overrides,
  };
}

function makeDeterministicMatches(vivaListings, coelhoListings) {
  return {
    candidate_pairs: vivaListings.map(v => ({
      viva: v,
      candidates: coelhoListings.map(c => ({
        ...c,
        score: 0.85,
      })),
    })),
  };
}

// ---------------------------------------------------------------------------
// Temp data directory helpers
// ---------------------------------------------------------------------------

function createTempDataDir() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'matching-server-test-'));
  const compoundDir = path.join(tmpDir, COMPOUND);
  const listingsDir = path.join(compoundDir, 'listings');
  fs.mkdirSync(listingsDir, { recursive: true });
  fs.mkdirSync(path.join(compoundDir, 'mosaics', 'viva'), { recursive: true });
  fs.mkdirSync(path.join(compoundDir, 'mosaics', 'coelho'), { recursive: true });
  return tmpDir;
}

function writeMockData(dataRoot, { vivaListings, coelhoListings, deterministicMatches } = {}) {
  const viva = vivaListings || [
    makeVivaListing('VIVA001'),
    makeVivaListing('VIVA002'),
    makeVivaListing('VIVA003'),
    makeVivaListing('VIVA004'),
    makeVivaListing('VIVA005'),
  ];
  const coelho = coelhoListings || [
    makeCoelhoListing('COELHO001'),
    makeCoelhoListing('COELHO002'),
    makeCoelhoListing('COELHO003'),
    makeCoelhoListing('COELHO004'),
    makeCoelhoListing('COELHO005'),
  ];
  const detMatches = deterministicMatches || makeDeterministicMatches(viva, coelho);

  const compoundDir = path.join(dataRoot, COMPOUND);

  fs.writeFileSync(
    path.join(compoundDir, 'listings', 'vivaprimeimoveis_listings.json'),
    JSON.stringify({ listings: viva }),
  );
  fs.writeFileSync(
    path.join(compoundDir, 'listings', 'coelhodafonseca_listings.json'),
    JSON.stringify({ listings: coelho }),
  );
  fs.writeFileSync(
    path.join(compoundDir, 'deterministic-matches.json'),
    JSON.stringify(detMatches),
  );

  // Remove any leftover files from a prior run
  const notifPath = path.join(compoundDir, 'notifications.json');
  if (fs.existsSync(notifPath)) fs.unlinkSync(notifPath);
  const auditPath = path.join(compoundDir, 'manual-matches.log.jsonl');
  if (fs.existsSync(auditPath)) fs.unlinkSync(auditPath);

  return { viva, coelho, detMatches };
}

function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

// ---------------------------------------------------------------------------
// Server lifecycle helpers
// ---------------------------------------------------------------------------

/**
 * Starts the matching server as a child process.
 * Resolves with { proc, port, baseUrl, kill } once the server is listening.
 */
function startServer(dataRoot, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    // Pick a random high port (express does not support port 0).
    const port = 10000 + Math.floor(Math.random() * 50000);
    const env = {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_ROOT: dataRoot,
      SESSION_NAME: 'test',
      READ_ONLY: extraEnv.READ_ONLY || 'false',
      GCS_BUCKET: '__test_nonexistent_bucket__',
      ...extraEnv,
    };

    const proc = spawn('node', [SERVER_SCRIPT], {
      env,
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    let stdout = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill('SIGKILL');
        reject(new Error(`Server did not start within 10s.\nstdout: ${stdout}\nstderr: ${stderr}`));
      }
    }, 10_000);

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (!settled && stdout.includes('Server running on')) {
        settled = true;
        clearTimeout(timeout);
        const baseUrl = `http://127.0.0.1:${port}`;
        resolve({
          proc,
          port,
          baseUrl,
          kill: () => new Promise((res) => {
            proc.on('exit', res);
            proc.kill('SIGTERM');
            setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 3000);
          }),
        });
      }
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(err);
      }
    });

    proc.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`Server exited with code ${code} before ready.\nstdout: ${stdout}\nstderr: ${stderr}`));
      }
    });
  });
}

// Convenience: JSON fetch helpers
async function get(baseUrl, urlPath) {
  const res = await fetch(`${baseUrl}${urlPath}`);
  const body = await res.json();
  return { status: res.status, body };
}

async function post(baseUrl, urlPath, data = {}) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const body = await res.json();
  return { status: res.status, body };
}

// ===========================================================================
// TEST SUITES
// ===========================================================================

describe('Matching Server API', () => {
  let dataRoot;
  let server;
  let baseUrl;

  // Use a single reviewer for the whole suite to avoid in_progress conflicts
  const REVIEWER = 'suite_reviewer';

  before(async () => {
    dataRoot = createTempDataDir();
    writeMockData(dataRoot);
    server = await startServer(dataRoot);
    baseUrl = server.baseUrl;
  });

  after(async () => {
    if (server) await server.kill();
    cleanupDir(dataRoot);
  });

  // =========================================================================
  // GET /api/compounds/:compoundId/session
  // =========================================================================
  describe(`GET ${C}/session`, () => {
    it('returns session metadata and stats', async () => {
      const { status, body } = await get(baseUrl, `${C}/session`);
      assert.equal(status, 200);
      assert.equal(body.session_name, 'test');
      assert.equal(typeof body.version, 'number');
      assert.ok(body.stats);
      assert.equal(typeof body.stats.total_viva_listings, 'number');
      assert.equal(typeof body.stats.matched, 'number');
      assert.equal(typeof body.stats.skipped, 'number');
      assert.equal(typeof body.stats.pending, 'number');
      assert.equal(body.read_only, false);
      assert.equal(body.current_pass, 1);
      assert.equal(body.max_passes, 5);
      assert.ok(body.pass_criteria);
      assert.equal(typeof body.pass_criteria.name, 'string');
      assert.equal(typeof body.has_new_properties, 'boolean');
      assert.equal(body.has_new_properties, false);
    });
  });

  // =========================================================================
  // GET /api/compounds/:compoundId/next
  // =========================================================================
  describe(`GET ${C}/next`, () => {
    it('returns the next listing to review with reviewer param', async () => {
      const { status, body } = await get(baseUrl, `${C}/next?reviewer=${REVIEWER}`);
      assert.equal(status, 200);
      assert.ok(body.viva_code);
      assert.ok(body.viva);
      assert.equal(typeof body.remaining_candidates, 'number');
      assert.ok(body.mosaic_path);
      assert.equal(body.current_pass, 1);
      assert.equal(typeof body.pending_in_pass, 'number');
    });

    it('defaults to anonymous reviewer when param is missing', async () => {
      const { status, body } = await get(baseUrl, `${C}/next`);
      assert.equal(status, 200);
      assert.ok(body.viva_code || body.done || body.pass_complete);
    });

    it('includes transformed specs in viva data', async () => {
      const { body } = await get(baseUrl, `${C}/next?reviewer=${REVIEWER}`);
      if (body.viva) {
        assert.ok(body.viva.specs, 'viva should have specs object');
        assert.equal(typeof body.viva.specs.area_construida, 'number');
        assert.equal(typeof body.viva.specs.dormitorios, 'number');
      }
    });
  });

  // =========================================================================
  // GET /api/compounds/:compoundId/candidates/:vivaCode
  // =========================================================================
  describe(`GET ${C}/candidates/:vivaCode`, () => {
    it('returns candidates for a valid viva listing', async () => {
      const { body: nextBody } = await get(baseUrl, `${C}/next?reviewer=${REVIEWER}`);
      const vivaCode = nextBody.viva_code;
      assert.ok(vivaCode, 'should have a viva_code from next');

      const { status, body } = await get(baseUrl, `${C}/candidates/${vivaCode}`);
      assert.equal(status, 200);
      assert.equal(body.viva_code, vivaCode);
      assert.ok(Array.isArray(body.candidates));
      assert.equal(typeof body.total_candidates, 'number');
      assert.ok(body.total_candidates > 0, 'should have at least one candidate');

      // Verify candidate structure
      const cand = body.candidates[0];
      assert.ok(cand.code);
      assert.ok(cand.candidate);
      assert.ok(cand.deltas);
      assert.ok(cand.mosaic_path);
      assert.equal(typeof cand.candidate.features, 'string');
    });

    it('returns 404 for non-existent viva code', async () => {
      const { status, body } = await get(baseUrl, `${C}/candidates/NONEXISTENT`);
      assert.equal(status, 404);
      assert.ok(body.error);
    });
  });

  // =========================================================================
  // POST /api/compounds/:compoundId/match
  // =========================================================================
  describe(`POST ${C}/match`, () => {
    it('rejects request without viva_code or coelho_code', async () => {
      const { status, body } = await post(baseUrl, `${C}/match`, {});
      assert.equal(status, 400);
      assert.ok(body.error.includes('Missing'));
    });

    it('returns 404 for non-existent listing', async () => {
      const { status, body } = await post(baseUrl, `${C}/match`, {
        viva_code: 'NONEXISTENT',
        coelho_code: 'COELHO001',
        reviewer: REVIEWER,
      });
      assert.equal(status, 404);
      assert.ok(body.error);
    });

    it('records a valid match', async () => {
      // Get a listing to match using the same reviewer
      const { body: nextBody } = await get(baseUrl, `${C}/next?reviewer=${REVIEWER}`);
      const vivaCode = nextBody.viva_code;
      assert.ok(vivaCode, 'should get a listing to match');

      // Get its candidates
      const { body: candBody } = await get(baseUrl, `${C}/candidates/${vivaCode}`);
      assert.ok(candBody.candidates.length > 0);
      const coelhoCode = candBody.candidates[0].code;

      // Confirm match
      const { status, body } = await post(baseUrl, `${C}/match`, {
        viva_code: vivaCode,
        coelho_code: coelhoCode,
        reviewer: REVIEWER,
        time_spent_sec: 15,
        notes: 'test match',
      });

      assert.equal(status, 200);
      assert.equal(body.success, true);
      assert.ok(body.match);
      assert.equal(body.match.viva_code, vivaCode);
      assert.equal(body.match.coelho_code, coelhoCode);
      assert.equal(body.match.reviewer, REVIEWER);
      assert.equal(body.match.confidence, 'manual_confirmed');
      assert.equal(typeof body.remaining, 'number');
    });
  });

  // =========================================================================
  // POST /api/compounds/:compoundId/skip
  // =========================================================================
  describe(`POST ${C}/skip`, () => {
    it('rejects request without viva_code', async () => {
      const { status, body } = await post(baseUrl, `${C}/skip`, {});
      assert.equal(status, 400);
      assert.ok(body.error.includes('Missing'));
    });

    it('skips a valid listing', async () => {
      const { body: nextBody } = await get(baseUrl, `${C}/next?reviewer=${REVIEWER}`);
      if (nextBody.done || nextBody.pass_complete) {
        return;
      }
      const vivaCode = nextBody.viva_code;
      assert.ok(vivaCode);

      const { status, body } = await post(baseUrl, `${C}/skip`, {
        viva_code: vivaCode,
        reviewer: REVIEWER,
        reason: 'no_good_candidates',
      });

      assert.equal(status, 200);
      assert.equal(body.success, true);
      assert.ok(body.skip);
      assert.equal(body.skip.viva_code, vivaCode);
      assert.equal(body.skip.reviewer, REVIEWER);
      assert.equal(typeof body.remaining, 'number');
    });
  });

  // =========================================================================
  // POST /api/compounds/:compoundId/undo
  // =========================================================================
  describe(`POST ${C}/undo`, () => {
    it('returns 404 when there is nothing to undo for a reviewer', async () => {
      const { status, body } = await post(baseUrl, `${C}/undo`, {
        reviewer: 'nobody_ever',
      });
      assert.equal(status, 404);
      assert.ok(body.error);
    });

    it('undoes the most recent match for the reviewer first', async () => {
      // The undo logic checks matches before skips, so the match is undone first
      const { status, body } = await post(baseUrl, `${C}/undo`, {
        reviewer: REVIEWER,
      });
      assert.equal(status, 200);
      assert.equal(body.success, true);
      assert.ok(body.undone);
      assert.equal(body.undone.type, 'match');
      assert.equal(body.undone.reviewer, REVIEWER);
      assert.equal(typeof body.remaining, 'number');
    });

    it('undoes the skip after the match has been undone', async () => {
      // With the match already undone, the next undo targets the skip
      const { status, body } = await post(baseUrl, `${C}/undo`, {
        reviewer: REVIEWER,
      });
      assert.equal(status, 200);
      assert.equal(body.success, true);
      assert.ok(body.undone);
      assert.equal(body.undone.type, 'skip');
      assert.equal(body.undone.reviewer, REVIEWER);
      assert.equal(typeof body.remaining, 'number');
    });
  });

  // =========================================================================
  // GET /api/compounds/:compoundId/progress
  // =========================================================================
  describe(`GET ${C}/progress`, () => {
    it('returns progress stats', async () => {
      const { status, body } = await get(baseUrl, `${C}/progress`);
      assert.equal(status, 200);
      assert.equal(typeof body.total_viva_listings, 'number');
      assert.equal(typeof body.matched, 'number');
      assert.equal(typeof body.skipped, 'number');
      assert.equal(typeof body.pending, 'number');
      assert.equal(typeof body.completed, 'number');
      assert.equal(typeof body.progress_pct, 'number');
      assert.equal(body.current_pass, 1);
      assert.equal(body.max_passes, 5);
      assert.ok(body.pass_name);
      assert.ok(body.pass_criteria);
    });
  });

  // =========================================================================
  // GET /api/compounds/:compoundId/audit
  // =========================================================================
  describe(`GET ${C}/audit`, () => {
    it('returns audit log entries from prior actions', async () => {
      const { status, body } = await get(baseUrl, `${C}/audit`);
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.entries));
      // We performed match, skip, and undo actions earlier so there should be entries
      assert.ok(body.entries.length > 0, 'should have audit entries from prior actions');
      assert.equal(typeof body.total, 'number');
      assert.ok(body.total > 0);

      // Verify entry structure
      const entry = body.entries[0];
      assert.ok(entry.id);
      assert.ok(entry.timestamp);
      assert.ok(entry.action);
      assert.ok(entry.payload);
      assert.ok(entry.hash);
    });
  });

  // =========================================================================
  // POST /api/compounds/:compoundId/pass/advance
  // =========================================================================
  describe(`POST ${C}/pass/advance`, () => {
    it('advances pass or reports inability', async () => {
      // First, skip all remaining listings so the pass is exhausted
      let listing;
      do {
        const { body } = await get(baseUrl, `${C}/next?reviewer=${REVIEWER}`);
        listing = body;
        if (listing.viva_code) {
          await post(baseUrl, `${C}/skip`, {
            viva_code: listing.viva_code,
            reviewer: REVIEWER,
          });
        }
      } while (listing.viva_code);

      // Now advance
      const { status, body } = await post(baseUrl, `${C}/pass/advance`, {});
      assert.equal(status, 200);

      if (body.success) {
        assert.ok(body.current_pass >= 2);
        assert.ok(body.pass_name);
        assert.equal(typeof body.pending, 'number');
      } else {
        assert.equal(body.success, false);
        assert.ok(body.message);
      }
    });
  });

  // =========================================================================
  // GET /api/compounds/:compoundId/next -- pass_complete response
  // =========================================================================
  describe(`GET ${C}/next (pass_complete / done)`, () => {
    it('returns pass_complete or done when no tasks remain', async () => {
      // Skip everything remaining in the current pass
      let listing;
      do {
        const { body } = await get(baseUrl, `${C}/next?reviewer=${REVIEWER}`);
        listing = body;
        if (listing.viva_code) {
          await post(baseUrl, `${C}/skip`, {
            viva_code: listing.viva_code,
            reviewer: REVIEWER,
          });
        }
      } while (listing.viva_code);

      const { status, body } = await get(baseUrl, `${C}/next?reviewer=${REVIEWER}`);
      assert.equal(status, 200);
      assert.ok(body.pass_complete || body.done, 'should indicate pass_complete or done');
    });
  });

  // =========================================================================
  // POST /api/compounds/:compoundId/pass/finish
  // =========================================================================
  describe(`POST ${C}/pass/finish`, () => {
    it('marks the session as finished and returns summary', async () => {
      const { status, body } = await post(baseUrl, `${C}/pass/finish`, {
        reviewer: REVIEWER,
      });
      assert.equal(status, 200);
      assert.equal(body.success, true);
      assert.ok(body.summary);
      assert.equal(typeof body.summary.total_matches, 'number');
      assert.equal(typeof body.summary.total_skipped, 'number');
      assert.equal(typeof body.summary.passes_completed, 'number');
    });

    it('causes next to return done after finishing', async () => {
      const { status, body } = await get(baseUrl, `${C}/next?reviewer=${REVIEWER}`);
      assert.equal(status, 200);
      assert.equal(body.done, true);
      assert.ok(body.message);
      assert.ok(body.final_stats);
    });
  });

  // =========================================================================
  // GET /api/compounds/:compoundId/matches/validate
  // =========================================================================
  describe(`GET ${C}/matches/validate`, () => {
    it('returns validation results', async () => {
      const { status, body } = await get(baseUrl, `${C}/matches/validate`);
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.valid));
      assert.ok(Array.isArray(body.invalid));
      assert.ok(Array.isArray(body.duplicates));
      assert.ok(body.summary);
      assert.equal(typeof body.summary.total, 'number');
      assert.equal(typeof body.summary.valid_count, 'number');
      assert.equal(typeof body.summary.invalid_count, 'number');
      assert.equal(typeof body.summary.duplicate_count, 'number');
    });
  });

  // =========================================================================
  // GET /api/compounds/:compoundId/matches/export
  // =========================================================================
  describe(`GET ${C}/matches/export`, () => {
    it('returns enriched export data', async () => {
      const { status, body } = await get(baseUrl, `${C}/matches/export`);
      assert.equal(status, 200);
      assert.ok(body.exported_at);
      assert.equal(typeof body.total_matches, 'number');
      assert.ok(Array.isArray(body.matches));
    });
  });

  // =========================================================================
  // Pipeline & Notification endpoints
  // =========================================================================
  describe(`POST ${C}/pipeline/trigger`, () => {
    it('records a pipeline trigger notification', async () => {
      const { status, body } = await post(baseUrl, `${C}/pipeline/trigger`, {});
      assert.equal(status, 200);
      assert.equal(body.triggered, true);
      assert.ok(body.message);
    });
  });

  describe(`POST ${C}/pipeline/complete`, () => {
    it('records a pipeline completion notification', async () => {
      const { status, body } = await post(baseUrl, `${C}/pipeline/complete`, {
        new_viva: 5,
        new_coelho: 3,
      });
      assert.equal(status, 200);
      assert.equal(body.success, true);
      assert.ok(body.notification_id);
    });
  });

  describe(`GET ${C}/notifications`, () => {
    it('returns unread notifications including pipeline events', async () => {
      const { status, body } = await get(baseUrl, `${C}/notifications`);
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.notifications));
      assert.equal(typeof body.unread_count, 'number');
      assert.ok(body.unread_count >= 2, 'should have trigger + complete notifications');

      // Verify notification structure
      const notif = body.notifications[0];
      assert.ok(notif.id);
      assert.ok(notif.type);
      assert.ok(notif.message);
      assert.ok(notif.created_at);
      assert.equal(notif.read, false);
    });
  });

  describe(`POST ${C}/notifications/dismiss`, () => {
    it('returns 400 when neither id nor all provided', async () => {
      const { status, body } = await post(baseUrl, `${C}/notifications/dismiss`, {});
      assert.equal(status, 400);
      assert.ok(body.error);
    });

    it('returns 404 for non-existent notification id', async () => {
      const { status, body } = await post(baseUrl, `${C}/notifications/dismiss`, {
        id: 'nonexistent-id',
      });
      assert.equal(status, 404);
      assert.ok(body.error);
    });

    it('dismisses a single notification by id', async () => {
      const { body: notifsBody } = await get(baseUrl, `${C}/notifications`);
      assert.ok(notifsBody.notifications.length > 0);
      const targetId = notifsBody.notifications[0].id;

      const { status, body } = await post(baseUrl, `${C}/notifications/dismiss`, {
        id: targetId,
      });
      assert.equal(status, 200);
      assert.equal(body.success, true);

      // Verify it was dismissed
      const { body: afterBody } = await get(baseUrl, `${C}/notifications`);
      const dismissed = afterBody.notifications.find(n => n.id === targetId);
      assert.equal(dismissed, undefined, 'dismissed notification should not appear in unread');
    });

    it('dismisses all notifications', async () => {
      const { status, body } = await post(baseUrl, `${C}/notifications/dismiss`, { all: true });
      assert.equal(status, 200);
      assert.equal(body.success, true);

      const { body: afterBody } = await get(baseUrl, `${C}/notifications`);
      assert.equal(afterBody.unread_count, 0);
    });
  });

  // =========================================================================
  // GET /api/compounds/:compoundId/session -- has_new_properties after pipeline_complete
  // =========================================================================
  describe(`GET ${C}/session (has_new_properties)`, () => {
    it('reflects has_new_properties when unread pipeline_complete exists', async () => {
      // Create a new pipeline_complete notification
      await post(baseUrl, `${C}/pipeline/complete`, { new_viva: 1, new_coelho: 1 });

      const { body } = await get(baseUrl, `${C}/session`);
      assert.equal(body.has_new_properties, true);

      // Dismiss all and verify
      await post(baseUrl, `${C}/notifications/dismiss`, { all: true });
      const { body: afterBody } = await get(baseUrl, `${C}/session`);
      assert.equal(afterBody.has_new_properties, false);
    });
  });

  // =========================================================================
  // GET /api/compounds/:compoundId/report/unmatched
  // =========================================================================
  describe(`GET ${C}/report/unmatched`, () => {
    it('returns unmatched viva listings', async () => {
      const { status, body } = await get(baseUrl, `${C}/report/unmatched`);
      assert.equal(status, 200);
      assert.equal(typeof body.total_viva, 'number');
      assert.equal(typeof body.total_matched, 'number');
      assert.equal(typeof body.total_unmatched, 'number');
      assert.ok(Array.isArray(body.listings));
    });
  });

  // =========================================================================
  // POST /api/compounds/:compoundId/report/send-email
  // =========================================================================
  describe(`POST ${C}/report/send-email`, () => {
    it('rejects invalid email', async () => {
      const { status, body } = await post(baseUrl, `${C}/report/send-email`, {
        to: 'not-an-email',
      });
      assert.equal(status, 400);
      assert.ok(body.error);
    });

    it('gracefully fails without SMTP/nodemailer config', async () => {
      const { status, body } = await post(baseUrl, `${C}/report/send-email`, {
        to: 'test@example.com',
      });
      // Should return 500 because nodemailer is likely not installed or SMTP is not configured
      assert.equal(status, 500);
      assert.ok(body.error);
    });
  });
});

// ===========================================================================
// READ-ONLY MODE TESTS
// ===========================================================================

describe('Matching Server API -- Read-only mode', () => {
  let dataRoot;
  let server;
  let baseUrl;

  before(async () => {
    dataRoot = createTempDataDir();
    writeMockData(dataRoot);
    server = await startServer(dataRoot, { READ_ONLY: 'true' });
    baseUrl = server.baseUrl;
  });

  after(async () => {
    if (server) await server.kill();
    cleanupDir(dataRoot);
  });

  it('GET endpoints still work in read-only mode', async () => {
    const { status } = await get(baseUrl, `${C}/session`);
    assert.equal(status, 200);
  });

  for (const endpoint of [`${C}/match`, `${C}/skip`, `${C}/undo`, `${C}/pass/advance`, `${C}/pass/finish`]) {
    it(`POST ${endpoint} returns 403 in read-only mode`, async () => {
      const { status, body } = await post(baseUrl, endpoint, {
        viva_code: 'VIVA001',
        coelho_code: 'COELHO001',
        reviewer: 'tester',
      });
      assert.equal(status, 403);
      assert.ok(body.error.includes('Read-only'));
    });
  }
});

// ===========================================================================
// FRESH SESSION WITH MATCHES AND EXPORT VALIDATION
// ===========================================================================

describe('Matching Server API -- Match & Export workflow', () => {
  let dataRoot;
  let server;
  let baseUrl;

  before(async () => {
    dataRoot = createTempDataDir();
    writeMockData(dataRoot);
    server = await startServer(dataRoot);
    baseUrl = server.baseUrl;
  });

  after(async () => {
    if (server) await server.kill();
    cleanupDir(dataRoot);
  });

  it('full workflow: match, validate, export, unmatched report', async () => {
    const REVIEWER = 'workflow_tester';

    // 1. Get first listing
    const { body: nextBody } = await get(baseUrl, `${C}/next?reviewer=${REVIEWER}`);
    assert.ok(nextBody.viva_code);

    // 2. Get candidates
    const { body: candBody } = await get(baseUrl, `${C}/candidates/${nextBody.viva_code}`);
    assert.ok(candBody.candidates.length > 0);

    // 3. Match it
    const coelhoCode = candBody.candidates[0].code;
    const { body: matchBody } = await post(baseUrl, `${C}/match`, {
      viva_code: nextBody.viva_code,
      coelho_code: coelhoCode,
      reviewer: REVIEWER,
    });
    assert.equal(matchBody.success, true);

    // 4. Validate matches
    const { body: validateBody } = await get(baseUrl, `${C}/matches/validate`);
    assert.ok(validateBody.summary.valid_count >= 1);

    // 5. Export matches
    const { body: exportBody } = await get(baseUrl, `${C}/matches/export`);
    assert.ok(exportBody.total_matches >= 1);
    const exportedMatch = exportBody.matches.find(
      m => m.viva.code === nextBody.viva_code,
    );
    assert.ok(exportedMatch);
    assert.ok(exportedMatch.viva.price);
    assert.ok(exportedMatch.coelho.price);

    // 6. Check unmatched report
    const { body: unmatchedBody } = await get(baseUrl, `${C}/report/unmatched`);
    assert.ok(unmatchedBody.total_matched >= 1);
    assert.ok(unmatchedBody.total_unmatched < unmatchedBody.total_viva);

    // 7. Progress should reflect the match
    const { body: progressBody } = await get(baseUrl, `${C}/progress`);
    assert.ok(progressBody.matched >= 1);
  });

  it('matched coelho code is excluded from other listings candidates', async () => {
    const REVIEWER = 'exclusion_tester';
    const { body: nextBody } = await get(baseUrl, `${C}/next?reviewer=${REVIEWER}`);
    if (nextBody.done || nextBody.pass_complete) return;

    const vivaCode = nextBody.viva_code;
    const { body: candBody } = await get(baseUrl, `${C}/candidates/${vivaCode}`);

    const { body: exportBody } = await get(baseUrl, `${C}/matches/export`);
    const matchedCoelhoCodes = new Set(exportBody.matches.map(m => m.coelho.code));

    for (const cand of candBody.candidates) {
      assert.equal(
        matchedCoelhoCodes.has(cand.code),
        false,
        `Candidate ${cand.code} should not appear because it is already matched`,
      );
    }
  });
});

// ===========================================================================
// RESUMED SESSION TESTS
// ===========================================================================

describe('Matching Server API -- Session resumption', () => {
  let dataRoot;
  let server;
  let baseUrl;

  before(async () => {
    dataRoot = createTempDataDir();
    writeMockData(dataRoot);

    // Pre-seed a manual-matches.json with one existing match
    const manualMatches = {
      session_started: '2025-01-01T00:00:00.000Z',
      last_updated: '2025-01-01T00:00:00.000Z',
      session_name: 'test',
      version: 5,
      current_pass: 1,
      passes_completed: 0,
      stats: {
        total_viva_listings: 5,
        matched: 1,
        rejected: 0,
        skipped: 0,
        pending: 4,
        in_progress: 0,
      },
      matches: [
        {
          viva_code: 'VIVA001',
          coelho_code: 'COELHO001',
          matched_at: '2025-01-01T00:00:00.000Z',
          reviewer: 'previous_user',
          confidence: 'manual_confirmed',
        },
      ],
      rejected: [],
      skipped: [],
      in_progress: [],
    };

    fs.writeFileSync(
      path.join(dataRoot, COMPOUND, 'manual-matches.json'),
      JSON.stringify(manualMatches),
    );

    server = await startServer(dataRoot);
    baseUrl = server.baseUrl;
  });

  after(async () => {
    if (server) await server.kill();
    cleanupDir(dataRoot);
  });

  it('resumes session with pre-existing matches', async () => {
    const { body } = await get(baseUrl, `${C}/session`);
    assert.ok(body.version >= 5, 'version should be at least the pre-seeded value');
  });

  it('skips already-matched listings in next', async () => {
    const REVIEWER = 'resume_tester';
    const seen = new Set();
    for (let i = 0; i < 10; i++) {
      const { body } = await get(baseUrl, `${C}/next?reviewer=${REVIEWER}`);
      if (body.done || body.pass_complete) break;
      assert.notEqual(body.viva_code, 'VIVA001', 'VIVA001 should be skipped (already matched)');
      seen.add(body.viva_code);
      await post(baseUrl, `${C}/skip`, {
        viva_code: body.viva_code,
        reviewer: REVIEWER,
      });
    }
  });

  it('export includes pre-existing matches', async () => {
    const { body } = await get(baseUrl, `${C}/matches/export`);
    assert.ok(body.total_matches >= 1);
    const preExisting = body.matches.find(m => m.viva.code === 'VIVA001');
    assert.ok(preExisting, 'pre-existing VIVA001 match should appear in export');
  });

  it('validate detects matches against listings', async () => {
    const { body } = await get(baseUrl, `${C}/matches/validate`);
    const vivaMatch = body.valid.find(m => m.viva_code === 'VIVA001');
    assert.ok(vivaMatch, 'VIVA001 match should be valid');
  });
});

// ===========================================================================
// EDGE CASE: Server without listings files
// ===========================================================================

describe('Matching Server API -- Missing listings files', () => {
  let dataRoot;
  let server;
  let baseUrl;

  before(async () => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'matching-server-test-'));
    const compoundDir = path.join(dataRoot, COMPOUND);
    // Only write deterministic-matches but NO listing files
    const viva = [makeVivaListing('VIVA001')];
    const coelho = [makeCoelhoListing('COELHO001')];
    fs.mkdirSync(compoundDir, { recursive: true });
    fs.writeFileSync(
      path.join(compoundDir, 'deterministic-matches.json'),
      JSON.stringify(makeDeterministicMatches(viva, coelho)),
    );
    fs.mkdirSync(path.join(compoundDir, 'mosaics', 'viva'), { recursive: true });
    fs.mkdirSync(path.join(compoundDir, 'mosaics', 'coelho'), { recursive: true });

    server = await startServer(dataRoot);
    baseUrl = server.baseUrl;
  });

  after(async () => {
    if (server) await server.kill();
    cleanupDir(dataRoot);
  });

  it('server starts even without listing files', async () => {
    const { status, body } = await get(baseUrl, `${C}/session`);
    assert.equal(status, 200);
    assert.ok(body.session_name);
  });

  it('validate works when listings are missing', async () => {
    const REVIEWER = 'edge_tester';
    // First match something
    const { body: nextBody } = await get(baseUrl, `${C}/next?reviewer=${REVIEWER}`);
    if (nextBody.viva_code) {
      const { body: candBody } = await get(baseUrl, `${C}/candidates/${nextBody.viva_code}`);
      if (candBody.candidates.length > 0) {
        await post(baseUrl, `${C}/match`, {
          viva_code: nextBody.viva_code,
          coelho_code: candBody.candidates[0].code,
          reviewer: REVIEWER,
        });
      }
    }

    const { status, body } = await get(baseUrl, `${C}/matches/validate`);
    assert.equal(status, 200);
    // Without listings loaded, all matches are "invalid" (codes not in empty sets)
    assert.ok(body.summary);
    assert.equal(typeof body.summary.total, 'number');
  });

  it('pass advance fails gracefully without raw listings', async () => {
    const REVIEWER = 'edge_tester';
    // Skip remaining
    let listing;
    do {
      const { body } = await get(baseUrl, `${C}/next?reviewer=${REVIEWER}`);
      listing = body;
      if (listing.viva_code) {
        await post(baseUrl, `${C}/skip`, {
          viva_code: listing.viva_code,
          reviewer: REVIEWER,
        });
      }
    } while (listing.viva_code);

    const { status, body } = await post(baseUrl, `${C}/pass/advance`, {});
    assert.equal(status, 200);
    assert.equal(body.success, false);
    assert.ok(body.message);
  });
});

// ===========================================================================
// REJECT ENDPOINT TESTS
// ===========================================================================

describe('Matching Server API -- Reject endpoint', () => {
  let dataRoot;
  let server;
  let baseUrl;

  before(async () => {
    dataRoot = createTempDataDir();
    writeMockData(dataRoot);
    server = await startServer(dataRoot);
    baseUrl = server.baseUrl;
  });

  after(async () => {
    if (server) await server.kill();
    cleanupDir(dataRoot);
  });

  it('rejects a specific candidate and removes it from candidates list', async () => {
    const REVIEWER = 'reject_tester';
    const { body: nextBody } = await get(baseUrl, `${C}/next?reviewer=${REVIEWER}`);
    assert.ok(nextBody.viva_code);
    const vivaCode = nextBody.viva_code;

    // Get candidates
    const { body: candBefore } = await get(baseUrl, `${C}/candidates/${vivaCode}`);
    assert.ok(candBefore.candidates.length > 0);
    const coelhoCode = candBefore.candidates[0].code;
    const countBefore = candBefore.total_candidates;

    // Reject the first candidate
    const { status, body } = await post(baseUrl, `${C}/reject`, {
      viva_code: vivaCode,
      coelho_code: coelhoCode,
      reviewer: REVIEWER,
      reason: 'visual_mismatch',
    });

    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.ok(body.rejection);
    assert.equal(body.rejection.viva_code, vivaCode);
    assert.equal(body.rejection.coelho_code, coelhoCode);

    // Verify candidate is removed
    const { body: candAfter } = await get(baseUrl, `${C}/candidates/${vivaCode}`);
    const rejected = candAfter.candidates.find(c => c.code === coelhoCode);
    assert.equal(rejected, undefined, 'rejected candidate should not appear');
    assert.ok(candAfter.total_candidates < countBefore, 'candidate count should decrease');
  });

  it('rejects request without required fields', async () => {
    const { status, body } = await post(baseUrl, `${C}/reject`, {});
    assert.equal(status, 400);
    assert.ok(body.error.includes('Missing'));
  });
});

// ===========================================================================
// AUDIT LOG EMPTY STATE
// ===========================================================================

describe(`GET ${C}/audit -- empty state`, () => {
  let dataRoot;
  let server;
  let baseUrl;

  before(async () => {
    dataRoot = createTempDataDir();
    writeMockData(dataRoot);
    server = await startServer(dataRoot);
    baseUrl = server.baseUrl;
  });

  after(async () => {
    if (server) await server.kill();
    cleanupDir(dataRoot);
  });

  it('returns empty entries when no actions have been taken', async () => {
    const { status, body } = await get(baseUrl, `${C}/audit`);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.entries));
    // When audit log file does not exist, server returns { entries: [] } without total
    assert.equal(body.entries.length, 0);
  });
});

// ===========================================================================
// LISTING ENDPOINT TEST
// ===========================================================================

describe(`GET ${C}/listing/:id`, () => {
  let dataRoot;
  let server;
  let baseUrl;

  before(async () => {
    dataRoot = createTempDataDir();
    writeMockData(dataRoot);
    server = await startServer(dataRoot);
    baseUrl = server.baseUrl;
  });

  after(async () => {
    if (server) await server.kill();
    cleanupDir(dataRoot);
  });

  it('returns listing details for a valid viva code', async () => {
    const REVIEWER = 'listing_tester';
    const { body: nextBody } = await get(baseUrl, `${C}/next?reviewer=${REVIEWER}`);
    assert.ok(nextBody.viva_code);

    const { status, body } = await get(baseUrl, `${C}/listing/${nextBody.viva_code}`);
    assert.equal(status, 200);
    assert.equal(body.viva_code, nextBody.viva_code);
    assert.ok(body.viva);
    assert.equal(typeof body.remaining_candidates, 'number');
    assert.ok(body.mosaic_path);
  });

  it('returns 404 for non-existent listing', async () => {
    const { status, body } = await get(baseUrl, `${C}/listing/NONEXISTENT`);
    assert.equal(status, 404);
    assert.ok(body.error);
  });
});

// ===========================================================================
// DELTAS CALCULATION TEST
// ===========================================================================

describe('Matching Server API -- Delta calculations', () => {
  let dataRoot;
  let server;
  let baseUrl;

  before(async () => {
    dataRoot = createTempDataDir();
    // Use specific prices to verify delta calculation
    const viva = [makeVivaListing('VIVA001', { price: 'R$ 1.000.000,00', built: 100 })];
    const coelho = [makeCoelhoListing('COELHO001', { price: 'R$ 1.100.000,00', built: 110 })];
    writeMockData(dataRoot, { vivaListings: viva, coelhoListings: coelho });
    server = await startServer(dataRoot);
    baseUrl = server.baseUrl;
  });

  after(async () => {
    if (server) await server.kill();
    cleanupDir(dataRoot);
  });

  it('returns correct price and area deltas in candidates', async () => {
    const REVIEWER = 'delta_tester';
    const { body: nextBody } = await get(baseUrl, `${C}/next?reviewer=${REVIEWER}`);
    assert.ok(nextBody.viva_code);

    const { body } = await get(baseUrl, `${C}/candidates/${nextBody.viva_code}`);
    assert.ok(body.candidates.length > 0);

    const cand = body.candidates[0];
    assert.ok(cand.deltas);

    // Viva price = 1,000,000; Coelho price = 1,100,000
    // Price delta = (1,100,000 - 1,000,000) / 1,000,000 * 100 = 10%
    assert.equal(cand.deltas.price_viva, 1000000);
    assert.equal(cand.deltas.price_coelho, 1100000);
    assert.equal(cand.deltas.price_delta_pct, 10);

    // Viva area = 100; Coelho area = 110
    // Area delta = (110 - 100) / 100 * 100 = 10%
    assert.equal(cand.deltas.area_viva, 100);
    assert.equal(cand.deltas.area_coelho, 110);
    assert.equal(cand.deltas.area_delta_pct, 10);
  });
});
