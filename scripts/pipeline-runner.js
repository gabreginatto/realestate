#!/usr/bin/env node
/**
 * Pipeline Runner - Orchestrates the scraping and matching pipeline
 *
 * Steps:
 *   1. Run Viva scraper
 *   2. Run Coelho scraper
 *   3. Run deterministic matcher
 *   4. Copy updated data files to server-deploy/data/
 *   5. POST to /api/pipeline/complete with counts
 *   6. Log to pipeline-runs.json
 *
 * Usage:
 *   node scripts/pipeline-runner.js
 *   SERVER_URL=http://localhost:8080 node scripts/pipeline-runner.js
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const DATA_ROOT = path.join(PROJECT_ROOT, 'data');
const SERVER_DEPLOY = path.join(PROJECT_ROOT, 'server-deploy');
const PIPELINE_LOG = path.join(DATA_ROOT, 'pipeline-runs.json');
const SERVER_URL = process.env.SERVER_URL || 'https://property-matcher-376125120681.us-central1.run.app';

// ============================================================================
// Helpers
// ============================================================================

function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

function loadPipelineLog() {
  try {
    if (fs.existsSync(PIPELINE_LOG)) {
      return JSON.parse(fs.readFileSync(PIPELINE_LOG, 'utf-8'));
    }
  } catch {
    // Corrupted file, start fresh
  }
  return [];
}

function savePipelineLog(runs) {
  fs.writeFileSync(PIPELINE_LOG, JSON.stringify(runs, null, 2));
}

function countListings(filePath) {
  try {
    if (!fs.existsSync(filePath)) return 0;
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (Array.isArray(data)) return data.length;
    if (data && typeof data === 'object') return Object.keys(data).length;
    return 0;
  } catch {
    return 0;
  }
}

function runStep(name, command) {
  const start = Date.now();
  log(`Starting: ${name}`);

  try {
    execSync(command, {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
      timeout: 600000, // 10 minute timeout per step
    });

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    log(`Completed: ${name} (${elapsed}s)`);

    return { name, status: 'success', elapsed_sec: parseFloat(elapsed), error: null };
  } catch (err) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const errorMsg = err.message || String(err);
    log(`Failed: ${name} (${elapsed}s) - ${errorMsg}`);

    return { name, status: 'failed', elapsed_sec: parseFloat(elapsed), error: errorMsg };
  }
}

// ============================================================================
// Pipeline Steps
// ============================================================================

async function runPipeline() {
  const pipelineStart = Date.now();
  const runRecord = {
    timestamp: new Date().toISOString(),
    status: 'running',
    steps: [],
    counts: {},
    total_elapsed_sec: 0,
  };

  log('========================================');
  log('Pipeline Runner - Starting');
  log('========================================');

  // Step 1: Run Viva scraper
  const vivaResult = runStep('Viva Scraper', 'node scripts/master-scraper-viva.js');
  runRecord.steps.push(vivaResult);

  // Step 2: Run Coelho scraper
  const coelhoResult = runStep('Coelho Scraper', 'node scripts/master-scraper-coelho.js');
  runRecord.steps.push(coelhoResult);

  // Step 3: Run deterministic matcher
  const matcherResult = runStep('Deterministic Matcher', 'node scripts/deterministic-matcher.cjs');
  runRecord.steps.push(matcherResult);

  // Step 4: Copy updated data files to server-deploy/data/
  log('Starting: Copy data to server-deploy');
  const copyStart = Date.now();

  try {
    const serverDataDir = path.join(SERVER_DEPLOY, 'data');
    if (!fs.existsSync(serverDataDir)) {
      fs.mkdirSync(serverDataDir, { recursive: true });
    }

    // Copy key data files
    const filesToCopy = [
      'deterministic-matches.json',
      'manual-matches.json',
    ];

    // Also copy mosaic directories if they exist
    const mosaicsSource = path.join(DATA_ROOT, 'mosaics');
    const mosaicsDest = path.join(serverDataDir, 'mosaics');

    let copiedCount = 0;
    for (const file of filesToCopy) {
      const src = path.join(DATA_ROOT, file);
      const dest = path.join(serverDataDir, file);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dest);
        copiedCount++;
        log(`  Copied: ${file}`);
      }
    }

    // Copy mosaics directory using rsync for efficiency
    if (fs.existsSync(mosaicsSource)) {
      try {
        execSync(`rsync -a --delete "${mosaicsSource}/" "${mosaicsDest}/"`, {
          cwd: PROJECT_ROOT,
          stdio: 'pipe',
        });
        log('  Synced mosaics directory');
      } catch {
        // Fallback: skip mosaics sync if rsync fails
        log('  Warning: mosaics sync skipped (rsync failed)');
      }
    }

    const copyElapsed = ((Date.now() - copyStart) / 1000).toFixed(1);
    log(`Completed: Copy data to server-deploy (${copyElapsed}s)`);
    runRecord.steps.push({
      name: 'Copy Data',
      status: 'success',
      elapsed_sec: parseFloat(copyElapsed),
      error: null,
      files_copied: copiedCount,
    });
  } catch (err) {
    const copyElapsed = ((Date.now() - copyStart) / 1000).toFixed(1);
    log(`Failed: Copy data to server-deploy - ${err.message}`);
    runRecord.steps.push({
      name: 'Copy Data',
      status: 'failed',
      elapsed_sec: parseFloat(copyElapsed),
      error: err.message,
    });
  }

  // Gather counts
  const vivaListingsFile = path.join(DATA_ROOT, 'viva-listings.json');
  const coelhoListingsFile = path.join(DATA_ROOT, 'coelho-listings.json');
  const matchesFile = path.join(DATA_ROOT, 'deterministic-matches.json');

  runRecord.counts = {
    new_viva: countListings(vivaListingsFile),
    new_coelho: countListings(coelhoListingsFile),
    total_matches: countListings(matchesFile),
  };

  // Step 5: POST to /api/pipeline/complete
  log('Starting: Notify server');

  try {
    const payload = JSON.stringify({
      new_viva: runRecord.counts.new_viva,
      new_coelho: runRecord.counts.new_coelho,
      total_matches: runRecord.counts.total_matches,
      timestamp: runRecord.timestamp,
    });

    execSync(`curl -s -X POST "${SERVER_URL}/api/pipeline/complete" -H "Content-Type: application/json" -d '${payload}'`, {
      cwd: PROJECT_ROOT,
      stdio: 'pipe',
      timeout: 30000,
    });

    log('Completed: Server notified');
    runRecord.steps.push({ name: 'Notify Server', status: 'success', elapsed_sec: 0, error: null });
  } catch (err) {
    log(`Failed: Server notification - ${err.message}`);
    runRecord.steps.push({ name: 'Notify Server', status: 'failed', elapsed_sec: 0, error: err.message });
  }

  // Step 6: Record pipeline run
  const totalElapsed = ((Date.now() - pipelineStart) / 1000).toFixed(1);
  runRecord.total_elapsed_sec = parseFloat(totalElapsed);

  const failedSteps = runRecord.steps.filter(s => s.status === 'failed');
  runRecord.status = failedSteps.length === 0 ? 'success' : failedSteps.length === runRecord.steps.length ? 'failed' : 'partial';

  const runs = loadPipelineLog();
  runs.push(runRecord);
  savePipelineLog(runs);

  log('========================================');
  log(`Pipeline ${runRecord.status} in ${totalElapsed}s`);
  log(`  Viva listings: ${runRecord.counts.new_viva}`);
  log(`  Coelho listings: ${runRecord.counts.new_coelho}`);
  log(`  Matches: ${runRecord.counts.total_matches}`);
  if (failedSteps.length > 0) {
    log(`  Failed steps: ${failedSteps.map(s => s.name).join(', ')}`);
  }
  log('========================================');

  // Exit with non-zero if any critical step failed
  if (vivaResult.status === 'failed' && coelhoResult.status === 'failed') {
    process.exit(1);
  }
}

// Run the pipeline
runPipeline().catch((err) => {
  log(`Pipeline crashed: ${err.message}`);
  process.exit(1);
});
