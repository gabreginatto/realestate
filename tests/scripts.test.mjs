import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);

const SCRIPTS_DIR = path.join(import.meta.dirname, '..', 'scripts');
const VALIDATE_SCRIPT = path.join(SCRIPTS_DIR, 'validate-matches.js');
const UNMATCHED_SCRIPT = path.join(SCRIPTS_DIR, 'generate-unmatched-report.js');
const PIPELINE_SCRIPT = path.join(SCRIPTS_DIR, 'pipeline-runner.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temporary directory and return its path. */
function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scripts-test-'));
}

/** Recursively remove a directory. */
function removeTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Build a minimal project tree inside `root` that the scripts expect.
 *
 * Layout:
 *   root/
 *     data/
 *       listings/
 *         vivaprimeimoveis_listings.json
 *         coelhodafonseca_listings.json
 *       manual-matches.json   (optional)
 *       deterministic-matches.json  (optional)
 *     scripts/
 *       validate-matches.js   (copy)
 *       generate-unmatched-report.js  (copy)
 *       pipeline-runner.js    (copy)
 *       human-loop/
 *         data/     (empty, so findDataRoot resolves to root/data)
 */
function scaffoldProject(root, {
  vivaListings = [],
  coelhoListings = [],
  manualMatches = null,
  deterministicMatches = null,
} = {}) {
  const dataDir = path.join(root, 'data');
  const listingsDir = path.join(dataDir, 'listings');
  const scriptsDir = path.join(root, 'scripts');
  const hlDir = path.join(scriptsDir, 'human-loop', 'data');

  fs.mkdirSync(listingsDir, { recursive: true });
  fs.mkdirSync(hlDir, { recursive: true });

  // Write listing files
  fs.writeFileSync(
    path.join(listingsDir, 'vivaprimeimoveis_listings.json'),
    JSON.stringify({ listings: vivaListings }),
  );
  fs.writeFileSync(
    path.join(listingsDir, 'coelhodafonseca_listings.json'),
    JSON.stringify({ listings: coelhoListings }),
  );

  // Write manual matches
  if (manualMatches !== null) {
    fs.writeFileSync(
      path.join(dataDir, 'manual-matches.json'),
      JSON.stringify(manualMatches),
    );
  }

  // Write deterministic matches
  if (deterministicMatches !== null) {
    fs.writeFileSync(
      path.join(dataDir, 'deterministic-matches.json'),
      JSON.stringify(deterministicMatches),
    );
  }

  // Copy the scripts into the temp project so __dirname resolves correctly
  fs.copyFileSync(VALIDATE_SCRIPT, path.join(scriptsDir, 'validate-matches.js'));
  fs.copyFileSync(UNMATCHED_SCRIPT, path.join(scriptsDir, 'generate-unmatched-report.js'));
  fs.copyFileSync(PIPELINE_SCRIPT, path.join(scriptsDir, 'pipeline-runner.js'));

  return { dataDir, listingsDir, scriptsDir };
}

/**
 * Run a script inside the scaffolded project.
 * Returns { stdout, stderr, exitCode }.
 */
async function runScript(scriptName, root, { args = [], env = {} } = {}) {
  const scriptPath = path.join(root, 'scripts', scriptName);
  try {
    const { stdout, stderr } = await execFileAsync('node', [scriptPath, ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      timeout: 15_000,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: err.code ?? 1,
    };
  }
}

// ---------------------------------------------------------------------------
// Sample data factories
// ---------------------------------------------------------------------------

function makeVivaListing(code, overrides = {}) {
  return {
    code,
    price: 'R$ 1.000.000',
    address: 'Rua Teste 123',
    url: `https://viva.com/${code}`,
    beds: 3,
    suites: 1,
    built: 120,
    park: 2,
    neighbourhood: 'Centro',
    ...overrides,
  };
}

function makeCoelhoListing(code, overrides = {}) {
  return {
    code,
    price: 'R$ 900.000',
    address: 'Av Coelho 456',
    url: `https://coelho.com/${code}`,
    beds: 3,
    suites: 1,
    built: 115,
    park: 2,
    ...overrides,
  };
}

function makeMatch(vivaCode, coelhoCode, overrides = {}) {
  return {
    viva_code: vivaCode,
    coelho_code: coelhoCode,
    matched_at: '2024-01-15T10:00:00Z',
    reviewer: 'tester',
    ai_score: 0.95,
    confidence: 'high',
    ...overrides,
  };
}

// ===========================================================================
// Tests for validate-matches.js
// ===========================================================================

describe('validate-matches.js', () => {
  let root;

  afterEach(() => {
    if (root) removeTempDir(root);
  });

  it('should validate all matches when every code exists in listings', async () => {
    root = createTempDir();
    scaffoldProject(root, {
      vivaListings: [makeVivaListing('V001'), makeVivaListing('V002')],
      coelhoListings: [makeCoelhoListing('C001'), makeCoelhoListing('C002')],
      manualMatches: {
        matches: [
          makeMatch('V001', 'C001'),
          makeMatch('V002', 'C002'),
        ],
      },
    });

    const { stdout, exitCode } = await runScript('validate-matches.js', root);

    assert.equal(exitCode, 0, `Expected exit code 0, got ${exitCode}`);
    assert.match(stdout, /Valid:\s*2/);
    assert.match(stdout, /Invalid:\s*0/);
    assert.match(stdout, /Duplicates:\s*0/);

    // Verify final-matches.json was written
    const finalPath = path.join(root, 'data', 'final-matches.json');
    assert.ok(fs.existsSync(finalPath), 'final-matches.json should be created');

    const finalData = JSON.parse(fs.readFileSync(finalPath, 'utf-8'));
    assert.equal(finalData.total_matches, 2);
    assert.equal(finalData.matches.length, 2);
    assert.ok(finalData.exported_at, 'exported_at timestamp should exist');

    // Verify enriched data contains listing details
    const first = finalData.matches[0];
    assert.equal(first.viva.code, 'V001');
    assert.equal(first.coelho.code, 'C001');
    assert.ok(first.viva.price, 'viva listing should have price');
    assert.ok(first.coelho.address, 'coelho listing should have address');
    assert.equal(first.reviewer, 'tester');
  });

  it('should flag matches with invalid viva codes', async () => {
    root = createTempDir();
    scaffoldProject(root, {
      vivaListings: [makeVivaListing('V001')],
      coelhoListings: [makeCoelhoListing('C001'), makeCoelhoListing('C002')],
      manualMatches: {
        matches: [
          makeMatch('V001', 'C001'),
          makeMatch('V_MISSING', 'C002'),
        ],
      },
    });

    const { stdout, exitCode } = await runScript('validate-matches.js', root);

    assert.equal(exitCode, 0);
    assert.match(stdout, /Valid:\s*1/);
    assert.match(stdout, /Invalid:\s*1/);
    assert.match(stdout, /INVALID MATCHES/);
    assert.match(stdout, /V_MISSING/);
    assert.match(stdout, /viva_code.*not found/);

    // Only the valid match should appear in final-matches.json
    const finalData = JSON.parse(
      fs.readFileSync(path.join(root, 'data', 'final-matches.json'), 'utf-8'),
    );
    assert.equal(finalData.total_matches, 1);
    assert.equal(finalData.matches[0].viva.code, 'V001');
  });

  it('should flag matches with invalid coelho codes', async () => {
    root = createTempDir();
    scaffoldProject(root, {
      vivaListings: [makeVivaListing('V001'), makeVivaListing('V002')],
      coelhoListings: [makeCoelhoListing('C001')],
      manualMatches: {
        matches: [
          makeMatch('V001', 'C001'),
          makeMatch('V002', 'C_MISSING'),
        ],
      },
    });

    const { stdout, exitCode } = await runScript('validate-matches.js', root);

    assert.equal(exitCode, 0);
    assert.match(stdout, /Valid:\s*1/);
    assert.match(stdout, /Invalid:\s*1/);
    assert.match(stdout, /INVALID MATCHES/);
    assert.match(stdout, /C_MISSING/);
    assert.match(stdout, /coelho_code.*not found/);

    const finalData = JSON.parse(
      fs.readFileSync(path.join(root, 'data', 'final-matches.json'), 'utf-8'),
    );
    assert.equal(finalData.total_matches, 1);
  });

  it('should detect duplicate viva matches', async () => {
    root = createTempDir();
    scaffoldProject(root, {
      vivaListings: [makeVivaListing('V001')],
      coelhoListings: [makeCoelhoListing('C001'), makeCoelhoListing('C002')],
      manualMatches: {
        matches: [
          makeMatch('V001', 'C001'),
          makeMatch('V001', 'C002'),
        ],
      },
    });

    const { stdout, exitCode } = await runScript('validate-matches.js', root);

    assert.equal(exitCode, 0);
    assert.match(stdout, /Duplicates:\s*1/);
    assert.match(stdout, /DUPLICATE MATCHES/);
    assert.match(stdout, /VIVA V001 matched 2 times/);
  });

  it('should detect duplicate coelho matches', async () => {
    root = createTempDir();
    scaffoldProject(root, {
      vivaListings: [makeVivaListing('V001'), makeVivaListing('V002')],
      coelhoListings: [makeCoelhoListing('C001')],
      manualMatches: {
        matches: [
          makeMatch('V001', 'C001'),
          makeMatch('V002', 'C001'),
        ],
      },
    });

    const { stdout, exitCode } = await runScript('validate-matches.js', root);

    assert.equal(exitCode, 0);
    assert.match(stdout, /Duplicates:\s*1/);
    assert.match(stdout, /DUPLICATE MATCHES/);
    assert.match(stdout, /COELHO C001 matched 2 times/);
  });

  it('should handle empty matches list', async () => {
    root = createTempDir();
    scaffoldProject(root, {
      vivaListings: [makeVivaListing('V001')],
      coelhoListings: [makeCoelhoListing('C001')],
      manualMatches: { matches: [] },
    });

    const { stdout, exitCode } = await runScript('validate-matches.js', root);

    assert.equal(exitCode, 0);
    assert.match(stdout, /Valid:\s*0/);
    assert.match(stdout, /Invalid:\s*0/);
    assert.match(stdout, /Duplicates:\s*0/);

    const finalData = JSON.parse(
      fs.readFileSync(path.join(root, 'data', 'final-matches.json'), 'utf-8'),
    );
    assert.equal(finalData.total_matches, 0);
    assert.deepEqual(finalData.matches, []);
  });

  it('should exit with error when manual-matches.json is missing', async () => {
    root = createTempDir();
    scaffoldProject(root, {
      vivaListings: [makeVivaListing('V001')],
      coelhoListings: [makeCoelhoListing('C001')],
      manualMatches: null, // do not create the file
    });

    const { stderr, exitCode } = await runScript('validate-matches.js', root);

    assert.notEqual(exitCode, 0, 'Should exit with non-zero when manual-matches.json is missing');
    assert.match(stderr, /Manual matches file not found/i);
  });

  it('should handle listings that use propertyCode instead of code', async () => {
    root = createTempDir();
    scaffoldProject(root, {
      vivaListings: [{ propertyCode: 'V001', price: 'R$ 500.000', address: 'Rua A' }],
      coelhoListings: [{ propertyCode: 'C001', price: 'R$ 600.000', address: 'Rua B' }],
      manualMatches: {
        matches: [makeMatch('V001', 'C001')],
      },
    });

    const { stdout, exitCode } = await runScript('validate-matches.js', root);

    assert.equal(exitCode, 0);
    assert.match(stdout, /Valid:\s*1/);
    assert.match(stdout, /Invalid:\s*0/);
  });

  it('should handle both invalid and duplicate matches simultaneously', async () => {
    root = createTempDir();
    scaffoldProject(root, {
      vivaListings: [makeVivaListing('V001')],
      coelhoListings: [makeCoelhoListing('C001'), makeCoelhoListing('C002')],
      manualMatches: {
        matches: [
          makeMatch('V001', 'C001'),
          makeMatch('V001', 'C002'),      // duplicate viva V001
          makeMatch('V_BAD', 'C001'),      // invalid viva code
        ],
      },
    });

    const { stdout, exitCode } = await runScript('validate-matches.js', root);

    assert.equal(exitCode, 0);
    assert.match(stdout, /Valid:\s*2/);
    assert.match(stdout, /Invalid:\s*1/);
    // V001 appears twice => viva duplicate; C001 appears twice (once valid + once invalid but count tracks all) => coelho duplicate
    assert.match(stdout, /DUPLICATE MATCHES/);
    assert.match(stdout, /INVALID MATCHES/);
  });

  it('should handle empty listings files gracefully', async () => {
    root = createTempDir();
    scaffoldProject(root, {
      vivaListings: [],
      coelhoListings: [],
      manualMatches: {
        matches: [makeMatch('V001', 'C001')],
      },
    });

    const { stdout, exitCode } = await runScript('validate-matches.js', root);

    assert.equal(exitCode, 0);
    assert.match(stdout, /Loaded 0 Viva listings/);
    assert.match(stdout, /Loaded 0 Coelho listings/);
    assert.match(stdout, /Invalid:\s*1/);
  });
});

// ===========================================================================
// Tests for generate-unmatched-report.js
// ===========================================================================

describe('generate-unmatched-report.js', () => {
  let root;

  afterEach(() => {
    if (root) removeTempDir(root);
  });

  it('should generate report with unmatched listings', async () => {
    root = createTempDir();
    scaffoldProject(root, {
      vivaListings: [
        makeVivaListing('V001'),
        makeVivaListing('V002', { address: 'Rua Unmatched 99', price: 'R$ 2.000.000' }),
        makeVivaListing('V003', { address: 'Av Nao Casou 10' }),
      ],
      coelhoListings: [makeCoelhoListing('C001')],
      manualMatches: {
        matches: [makeMatch('V001', 'C001')],
        skipped: [
          { viva_code: 'V002', reason: 'no match' },
        ],
        skipped_previous_passes: [],
      },
      deterministicMatches: {
        candidate_pairs: [
          { viva: { code: 'V001' }, coelho: { code: 'C001' } },
          { viva: { code: 'V002' }, coelho: { code: 'C001' } },
          { viva: { code: 'V003' }, coelho: { code: 'C001' } },
        ],
      },
    });

    const { stdout, exitCode } = await runScript('generate-unmatched-report.js', root);

    assert.equal(exitCode, 0);
    assert.match(stdout, /Matched:\s*1/);
    assert.match(stdout, /Unmatched:\s*2/);
    assert.match(stdout, /UNMATCHED LISTINGS/);
    assert.match(stdout, /V002/);
    assert.match(stdout, /V003/);

    // Verify the HTML report was written
    const reportPath = path.join(root, 'data', 'unmatched-report.html');
    assert.ok(fs.existsSync(reportPath), 'unmatched-report.html should be created');

    const html = fs.readFileSync(reportPath, 'utf-8');
    assert.match(html, /<!DOCTYPE html>/i);
    assert.match(html, /Unmatched Properties Report/);
    assert.match(html, /V002/);
    assert.match(html, /Rua Unmatched 99/);
    assert.match(html, /V003/);
    // Matched count in the summary card
    assert.match(html, />1</); // matched count
    assert.match(html, />2</); // unmatched count
  });

  it('should produce report with zero unmatched when all are matched', async () => {
    root = createTempDir();
    scaffoldProject(root, {
      vivaListings: [makeVivaListing('V001')],
      coelhoListings: [makeCoelhoListing('C001')],
      manualMatches: {
        matches: [makeMatch('V001', 'C001')],
        skipped: [],
        skipped_previous_passes: [],
      },
      deterministicMatches: {
        candidate_pairs: [
          { viva: { code: 'V001' }, coelho: { code: 'C001' } },
        ],
      },
    });

    const { stdout, exitCode } = await runScript('generate-unmatched-report.js', root);

    assert.equal(exitCode, 0);
    assert.match(stdout, /Matched:\s*1/);
    assert.match(stdout, /Unmatched:\s*0/);
    // Should NOT contain the UNMATCHED LISTINGS header in stdout (no unmatched to list)
    assert.doesNotMatch(stdout, /UNMATCHED LISTINGS/);

    // HTML report should still be generated
    const reportPath = path.join(root, 'data', 'unmatched-report.html');
    assert.ok(fs.existsSync(reportPath));

    const html = fs.readFileSync(reportPath, 'utf-8');
    assert.match(html, /<!DOCTYPE html>/i);
    assert.match(html, />0</); // 0 unmatched in card
  });

  it('should report all listings as unmatched when no matches exist', async () => {
    root = createTempDir();
    scaffoldProject(root, {
      vivaListings: [makeVivaListing('V001'), makeVivaListing('V002')],
      coelhoListings: [makeCoelhoListing('C001')],
      manualMatches: {
        matches: [],
        skipped: [
          { viva_code: 'V001', reason: 'skip' },
          { viva_code: 'V002', reason: 'skip' },
        ],
        skipped_previous_passes: [],
      },
      deterministicMatches: {
        candidate_pairs: [
          { viva: { code: 'V001' }, coelho: { code: 'C001' } },
          { viva: { code: 'V002' }, coelho: { code: 'C001' } },
        ],
      },
    });

    const { stdout, exitCode } = await runScript('generate-unmatched-report.js', root);

    assert.equal(exitCode, 0);
    assert.match(stdout, /Matched:\s*0/);
    assert.match(stdout, /Unmatched:\s*2/);
    assert.match(stdout, /V001/);
    assert.match(stdout, /V002/);

    const html = fs.readFileSync(
      path.join(root, 'data', 'unmatched-report.html'),
      'utf-8',
    );
    assert.match(html, /V001/);
    assert.match(html, /V002/);
  });

  it('should handle missing manual-matches.json gracefully', async () => {
    root = createTempDir();
    scaffoldProject(root, {
      vivaListings: [makeVivaListing('V001')],
      coelhoListings: [makeCoelhoListing('C001')],
      manualMatches: null,
      deterministicMatches: {
        candidate_pairs: [
          { viva: { code: 'V001' }, coelho: { code: 'C001' } },
        ],
      },
    });

    const { stdout, stderr, exitCode } = await runScript('generate-unmatched-report.js', root);

    // generate-unmatched-report.js warns but does not exit(1) when manual-matches.json is missing
    assert.equal(exitCode, 0);
    assert.match(stderr, /No manual-matches\.json found/);
    // V001 is in the candidate pool but not matched => unmatched
    assert.match(stdout, /Unmatched:\s*1/);
  });

  it('should handle missing deterministic-matches.json gracefully', async () => {
    root = createTempDir();
    scaffoldProject(root, {
      vivaListings: [makeVivaListing('V001')],
      coelhoListings: [makeCoelhoListing('C001')],
      manualMatches: {
        matches: [makeMatch('V001', 'C001')],
        skipped: [],
        skipped_previous_passes: [],
      },
      deterministicMatches: null,
    });

    const { stdout, stderr, exitCode } = await runScript('generate-unmatched-report.js', root);

    assert.equal(exitCode, 0);
    assert.match(stderr, /No deterministic-matches\.json found/);
    // No candidate pairs and no skipped => pool is empty except for matched codes
    // Since pool is empty, nothing to be "unmatched"
    assert.match(stdout, /Unmatched:\s*0/);
  });

  it('should include listings from skipped_previous_passes in unmatched count', async () => {
    root = createTempDir();
    scaffoldProject(root, {
      vivaListings: [makeVivaListing('V001'), makeVivaListing('V002'), makeVivaListing('V003')],
      coelhoListings: [makeCoelhoListing('C001')],
      manualMatches: {
        matches: [makeMatch('V001', 'C001')],
        skipped: [],
        skipped_previous_passes: [
          {
            pass: 1,
            skipped: [
              { viva_code: 'V002' },
              { viva_code: 'V003' },
            ],
          },
        ],
      },
      deterministicMatches: {
        candidate_pairs: [
          { viva: { code: 'V001' }, coelho: { code: 'C001' } },
        ],
      },
    });

    const { stdout, exitCode } = await runScript('generate-unmatched-report.js', root);

    assert.equal(exitCode, 0);
    assert.match(stdout, /Matched:\s*1/);
    assert.match(stdout, /Unmatched:\s*2/);
    assert.match(stdout, /V002/);
    assert.match(stdout, /V003/);
  });

  it('should show listing details in the HTML table rows', async () => {
    root = createTempDir();
    scaffoldProject(root, {
      vivaListings: [
        makeVivaListing('V001', {
          address: 'Rua Bonita 42',
          price: 'R$ 3.500.000',
          beds: 5,
          built: 250,
          url: 'https://viva.com/V001-detail',
        }),
      ],
      coelhoListings: [makeCoelhoListing('C001')],
      manualMatches: {
        matches: [],
        skipped: [{ viva_code: 'V001', reason: 'no match' }],
        skipped_previous_passes: [],
      },
      deterministicMatches: {
        candidate_pairs: [
          { viva: { code: 'V001' }, coelho: { code: 'C001' } },
        ],
      },
    });

    const { exitCode } = await runScript('generate-unmatched-report.js', root);
    assert.equal(exitCode, 0);

    const html = fs.readFileSync(
      path.join(root, 'data', 'unmatched-report.html'),
      'utf-8',
    );
    assert.match(html, /Rua Bonita 42/);
    assert.match(html, /R\$ 3\.500\.000/);
    assert.match(html, /250m/);   // built area
    assert.match(html, /https:\/\/viva\.com\/V001-detail/);
  });
});

// ===========================================================================
// Tests for pipeline-runner.js
// ===========================================================================

describe('pipeline-runner.js', () => {
  let root;

  afterEach(() => {
    if (root) removeTempDir(root);
  });

  it('should be valid Node.js (syntax check)', async () => {
    // Use --check flag to verify syntax without executing
    const { exitCode } = await execFileAsync('node', ['--check', PIPELINE_SCRIPT])
      .then(() => ({ exitCode: 0 }))
      .catch((err) => ({ exitCode: err.code ?? 1 }));

    assert.equal(exitCode, 0, 'pipeline-runner.js should have valid syntax');
  });

  it('should fail gracefully when child scraper scripts do not exist', async () => {
    root = createTempDir();
    const { dataDir, scriptsDir } = scaffoldProject(root, {
      vivaListings: [],
      coelhoListings: [],
      manualMatches: { matches: [], skipped: [], skipped_previous_passes: [] },
      deterministicMatches: { candidate_pairs: [] },
    });

    // The pipeline script references master-scraper-viva.js, master-scraper-coelho.js,
    // and deterministic-matcher.cjs which won't exist in the temp project.
    // It should handle failures from execSync and continue.

    // Also need server-deploy dir to exist for the copy step
    fs.mkdirSync(path.join(root, 'server-deploy', 'data'), { recursive: true });

    const { stdout, exitCode } = await runScript('pipeline-runner.js', root, {
      env: { SERVER_URL: 'http://localhost:99999' }, // unreachable server
    });

    // Both scrapers fail => exit code should be 1
    assert.equal(exitCode, 1, 'Should exit with error when both scrapers fail');
    assert.match(stdout, /Pipeline Runner - Starting/);
    assert.match(stdout, /Failed:/);

    // Should still write pipeline-runs.json
    const logPath = path.join(dataDir, 'pipeline-runs.json');
    assert.ok(fs.existsSync(logPath), 'pipeline-runs.json should be created');

    const runs = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
    assert.ok(Array.isArray(runs));
    assert.equal(runs.length, 1);
    assert.ok(runs[0].timestamp);
    assert.ok(runs[0].steps.length > 0);

    // All scraper/matcher steps should be failed
    const scraperSteps = runs[0].steps.filter(
      (s) => s.name === 'Viva Scraper' || s.name === 'Coelho Scraper' || s.name === 'Deterministic Matcher',
    );
    for (const step of scraperSteps) {
      assert.equal(step.status, 'failed', `Step "${step.name}" should have failed`);
      assert.ok(step.error, `Step "${step.name}" should have an error message`);
    }
  });

  it('should record pipeline log with correct structure', async () => {
    root = createTempDir();
    const { dataDir } = scaffoldProject(root, {
      vivaListings: [],
      coelhoListings: [],
      manualMatches: { matches: [], skipped: [], skipped_previous_passes: [] },
    });
    fs.mkdirSync(path.join(root, 'server-deploy', 'data'), { recursive: true });

    await runScript('pipeline-runner.js', root, {
      env: { SERVER_URL: 'http://localhost:99999' },
    });

    const logPath = path.join(dataDir, 'pipeline-runs.json');
    const runs = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
    const run = runs[0];

    // Verify structure
    assert.ok(run.timestamp, 'should have timestamp');
    assert.ok(['success', 'failed', 'partial'].includes(run.status), `status should be valid, got: ${run.status}`);
    assert.ok(Array.isArray(run.steps), 'steps should be an array');
    assert.ok(typeof run.counts === 'object', 'counts should be an object');
    assert.ok(typeof run.total_elapsed_sec === 'number', 'total_elapsed_sec should be a number');

    // Verify step structure
    for (const step of run.steps) {
      assert.ok(step.name, 'step should have a name');
      assert.ok(['success', 'failed'].includes(step.status), `step status should be valid, got: ${step.status}`);
      assert.ok(typeof step.elapsed_sec === 'number', 'step elapsed_sec should be a number');
    }
  });

  it('should succeed when scraper scripts exist and succeed', async () => {
    root = createTempDir();
    const { dataDir, scriptsDir } = scaffoldProject(root, {
      vivaListings: [],
      coelhoListings: [],
      manualMatches: { matches: [], skipped: [], skipped_previous_passes: [] },
      deterministicMatches: { candidate_pairs: [] },
    });
    fs.mkdirSync(path.join(root, 'server-deploy', 'data'), { recursive: true });

    // Create dummy scraper scripts that succeed
    fs.writeFileSync(
      path.join(scriptsDir, 'master-scraper-viva.js'),
      'console.log("Viva scraper ran"); process.exit(0);',
    );
    fs.writeFileSync(
      path.join(scriptsDir, 'master-scraper-coelho.js'),
      'console.log("Coelho scraper ran"); process.exit(0);',
    );
    fs.writeFileSync(
      path.join(scriptsDir, 'deterministic-matcher.cjs'),
      'console.log("Matcher ran"); process.exit(0);',
    );

    const { stdout, exitCode } = await runScript('pipeline-runner.js', root, {
      env: { SERVER_URL: 'http://localhost:99999' }, // notification will fail but that is OK
    });

    // Scrapers succeeded so pipeline should not exit(1)
    assert.equal(exitCode, 0, 'Should exit with 0 when scrapers succeed');
    assert.match(stdout, /Pipeline Runner - Starting/);
    // At least partial success since scrapers worked
    const logPath = path.join(dataDir, 'pipeline-runs.json');
    const runs = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
    const run = runs[0];

    const scraperSteps = run.steps.filter(
      (s) => s.name === 'Viva Scraper' || s.name === 'Coelho Scraper' || s.name === 'Deterministic Matcher',
    );
    for (const step of scraperSteps) {
      assert.equal(step.status, 'success', `Step "${step.name}" should have succeeded`);
    }
  });

  it('should copy data files to server-deploy when they exist', async () => {
    root = createTempDir();
    const { dataDir, scriptsDir } = scaffoldProject(root, {
      vivaListings: [],
      coelhoListings: [],
      manualMatches: { matches: [makeMatch('V1', 'C1')], skipped: [], skipped_previous_passes: [] },
      deterministicMatches: { candidate_pairs: [{ viva: { code: 'V1' }, coelho: { code: 'C1' } }] },
    });
    fs.mkdirSync(path.join(root, 'server-deploy', 'data'), { recursive: true });

    // Create dummy scraper scripts
    fs.writeFileSync(path.join(scriptsDir, 'master-scraper-viva.js'), 'process.exit(0);');
    fs.writeFileSync(path.join(scriptsDir, 'master-scraper-coelho.js'), 'process.exit(0);');
    fs.writeFileSync(path.join(scriptsDir, 'deterministic-matcher.cjs'), 'process.exit(0);');

    await runScript('pipeline-runner.js', root, {
      env: { SERVER_URL: 'http://localhost:99999' },
    });

    // Verify that data files were copied
    const copiedManual = path.join(root, 'server-deploy', 'data', 'manual-matches.json');
    const copiedDet = path.join(root, 'server-deploy', 'data', 'deterministic-matches.json');
    assert.ok(fs.existsSync(copiedManual), 'manual-matches.json should be copied to server-deploy');
    assert.ok(fs.existsSync(copiedDet), 'deterministic-matches.json should be copied to server-deploy');

    const copiedContent = JSON.parse(fs.readFileSync(copiedManual, 'utf-8'));
    assert.equal(copiedContent.matches.length, 1);
  });

  it('should sync mosaic files to server-deploy and remove stale files', async () => {
    root = createTempDir();
    const { scriptsDir } = scaffoldProject(root, {
      vivaListings: [],
      coelhoListings: [],
      manualMatches: { matches: [], skipped: [], skipped_previous_passes: [] },
      deterministicMatches: { candidate_pairs: [] },
    });
    fs.mkdirSync(path.join(root, 'server-deploy', 'data'), { recursive: true });

    // Create dummy scraper scripts
    fs.writeFileSync(path.join(scriptsDir, 'master-scraper-viva.js'), 'process.exit(0);');
    fs.writeFileSync(path.join(scriptsDir, 'master-scraper-coelho.js'), 'process.exit(0);');
    fs.writeFileSync(path.join(scriptsDir, 'deterministic-matcher.cjs'), 'process.exit(0);');

    // Source mosaics produced by scraping pipeline
    const srcMosaicsDir = path.join(root, 'data', 'mosaics');
    const srcVivaDir = path.join(srcMosaicsDir, 'viva');
    const srcCoelhoDir = path.join(srcMosaicsDir, 'coelho');
    fs.mkdirSync(srcVivaDir, { recursive: true });
    fs.mkdirSync(srcCoelhoDir, { recursive: true });
    fs.writeFileSync(path.join(srcVivaDir, 'viva-001.png'), 'viva-mosaic-content');
    fs.writeFileSync(path.join(srcCoelhoDir, 'coelho-001.png'), 'coelho-mosaic-content');

    // Seed stale backend file; sync with --delete should remove it
    const destVivaDir = path.join(root, 'server-deploy', 'data', 'mosaics', 'viva');
    fs.mkdirSync(destVivaDir, { recursive: true });
    fs.writeFileSync(path.join(destVivaDir, 'stale.png'), 'stale-content');

    // Provide a local rsync shim so this test is deterministic across environments
    const binDir = path.join(root, 'bin');
    const rsyncShim = path.join(binDir, 'rsync');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      rsyncShim,
      `#!/usr/bin/env bash
set -euo pipefail
src="\${@: -2:1}"
dest="\${@: -1}"
src="\${src%/}"
dest="\${dest%/}"
mkdir -p "$dest"
find "$dest" -mindepth 1 -exec rm -rf {} +
cp -R "$src"/. "$dest"/
`,
      { mode: 0o755 },
    );

    const existingPath = process.env.PATH || '';
    await runScript('pipeline-runner.js', root, {
      env: {
        SERVER_URL: 'http://localhost:99999',
        PATH: `${binDir}:${existingPath}`,
      },
    });

    const copiedViva = path.join(root, 'server-deploy', 'data', 'mosaics', 'viva', 'viva-001.png');
    const copiedCoelho = path.join(root, 'server-deploy', 'data', 'mosaics', 'coelho', 'coelho-001.png');
    const staleFile = path.join(root, 'server-deploy', 'data', 'mosaics', 'viva', 'stale.png');

    assert.ok(fs.existsSync(copiedViva), 'viva mosaic should be synced to server-deploy');
    assert.ok(fs.existsSync(copiedCoelho), 'coelho mosaic should be synced to server-deploy');
    assert.equal(
      fs.readFileSync(copiedViva, 'utf-8'),
      'viva-mosaic-content',
      'viva mosaic content should match source',
    );
    assert.equal(
      fs.readFileSync(copiedCoelho, 'utf-8'),
      'coelho-mosaic-content',
      'coelho mosaic content should match source',
    );
    assert.equal(fs.existsSync(staleFile), false, 'stale backend mosaic should be deleted by sync');
  });

  it('should handle partial failure (one scraper fails, one succeeds)', async () => {
    root = createTempDir();
    const { dataDir, scriptsDir } = scaffoldProject(root, {
      vivaListings: [],
      coelhoListings: [],
      manualMatches: { matches: [], skipped: [], skipped_previous_passes: [] },
    });
    fs.mkdirSync(path.join(root, 'server-deploy', 'data'), { recursive: true });

    // Viva scraper succeeds, Coelho fails
    fs.writeFileSync(path.join(scriptsDir, 'master-scraper-viva.js'), 'process.exit(0);');
    fs.writeFileSync(
      path.join(scriptsDir, 'master-scraper-coelho.js'),
      'process.exit(1);',
    );
    fs.writeFileSync(path.join(scriptsDir, 'deterministic-matcher.cjs'), 'process.exit(0);');

    const { exitCode } = await runScript('pipeline-runner.js', root, {
      env: { SERVER_URL: 'http://localhost:99999' },
    });

    // Only exits 1 if BOTH scrapers fail
    assert.equal(exitCode, 0, 'Should exit 0 when only one scraper fails');

    const logPath = path.join(dataDir, 'pipeline-runs.json');
    const runs = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
    assert.equal(runs[0].status, 'partial', 'Should be partial when some steps fail');
  });

  it('should append to existing pipeline-runs.json', async () => {
    root = createTempDir();
    const { dataDir, scriptsDir } = scaffoldProject(root, {
      vivaListings: [],
      coelhoListings: [],
      manualMatches: { matches: [], skipped: [], skipped_previous_passes: [] },
    });
    fs.mkdirSync(path.join(root, 'server-deploy', 'data'), { recursive: true });

    // Pre-populate pipeline-runs.json with an existing entry
    const existingRun = { timestamp: '2024-01-01T00:00:00Z', status: 'success', steps: [] };
    fs.writeFileSync(
      path.join(dataDir, 'pipeline-runs.json'),
      JSON.stringify([existingRun]),
    );

    fs.writeFileSync(path.join(scriptsDir, 'master-scraper-viva.js'), 'process.exit(0);');
    fs.writeFileSync(path.join(scriptsDir, 'master-scraper-coelho.js'), 'process.exit(0);');
    fs.writeFileSync(path.join(scriptsDir, 'deterministic-matcher.cjs'), 'process.exit(0);');

    await runScript('pipeline-runner.js', root, {
      env: { SERVER_URL: 'http://localhost:99999' },
    });

    const runs = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'pipeline-runs.json'), 'utf-8'),
    );
    assert.equal(runs.length, 2, 'Should have appended to existing runs');
    assert.equal(runs[0].timestamp, '2024-01-01T00:00:00Z', 'Original entry should be preserved');
  });
});
