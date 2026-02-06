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
const PIPELINE_STATE = path.join(DATA_ROOT, 'pipeline-state.json');
const PIPELINE_DELTA = path.join(DATA_ROOT, 'pipeline-delta.json');
const VIVA_LISTINGS = path.join(DATA_ROOT, 'vivaprimeimoveis', 'listings', 'all-listings.json');
const COELHO_LISTINGS = path.join(DATA_ROOT, 'coelhodafonseca', 'listings', 'all-listings.json');
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

function countMatcherCandidates(filePath) {
  try {
    if (!fs.existsSync(filePath)) return 0;
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const pairs = Array.isArray(data.candidate_pairs) ? data.candidate_pairs : [];
    return pairs.reduce((sum, pair) => sum + ((pair.candidates || []).length), 0);
  } catch {
    return 0;
  }
}

function loadListingCodes(filePath) {
  try {
    if (!fs.existsSync(filePath)) return new Set();
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const listings = Array.isArray(data.listings) ? data.listings : [];
    return new Set(
      listings
        .map((listing) => String(listing.propertyCode || listing.code || '').trim())
        .filter(Boolean)
    );
  } catch {
    return new Set();
  }
}

function loadPipelineState() {
  try {
    if (!fs.existsSync(PIPELINE_STATE)) {
      return { viva_codes: [], coelho_codes: [] };
    }
    const state = JSON.parse(fs.readFileSync(PIPELINE_STATE, 'utf-8'));
    return {
      viva_codes: Array.isArray(state.viva_codes) ? state.viva_codes : [],
      coelho_codes: Array.isArray(state.coelho_codes) ? state.coelho_codes : [],
    };
  } catch {
    return { viva_codes: [], coelho_codes: [] };
  }
}

function savePipelineState(vivaCodes, coelhoCodes) {
  const state = {
    updated_at: new Date().toISOString(),
    viva_codes: [...vivaCodes],
    coelho_codes: [...coelhoCodes],
  };
  fs.writeFileSync(PIPELINE_STATE, JSON.stringify(state, null, 2));
}

function computeNewCodes(previousCodes, currentCodes) {
  const previous = new Set(previousCodes);
  return [...currentCodes].filter((code) => !previous.has(code));
}

function savePipelineDelta(newVivaCodes, newCoelhoCodes) {
  const delta = {
    generated_at: new Date().toISOString(),
    new_viva_codes: newVivaCodes,
    new_coelho_codes: newCoelhoCodes,
  };
  fs.writeFileSync(PIPELINE_DELTA, JSON.stringify(delta, null, 2));
}

function recordSkippedStep(runRecord, name, reason) {
  log(`Skipping: ${name} - ${reason}`);
  runRecord.steps.push({
    name,
    status: 'success',
    elapsed_sec: 0,
    error: null,
    skipped: true,
    reason,
  });
}

function runIncrementalSitePostProcessing(runRecord, site) {
  const siteInfo = site === 'viva'
    ? {
      name: 'Viva',
      siteArg: 'vivaprimeimoveis',
      mosaicArg: 'viva',
      codesKey: 'new_viva_codes',
    }
    : {
      name: 'Coelho',
      siteArg: 'coelhodafonseca',
      mosaicArg: 'coelho',
      codesKey: 'new_coelho_codes',
    };

  const delta = JSON.parse(fs.readFileSync(PIPELINE_DELTA, 'utf-8'));
  const codes = Array.isArray(delta[siteInfo.codesKey]) ? delta[siteInfo.codesKey] : [];

  if (codes.length === 0) {
    recordSkippedStep(runRecord, `${siteInfo.name} Fastdup`, 'No new listing codes');
    recordSkippedStep(runRecord, `${siteInfo.name} Exterior Selection`, 'No new listing codes');
    recordSkippedStep(runRecord, `${siteInfo.name} Mosaic Generation`, 'No new listing codes');
    return;
  }

  const fastdupCmd = [
    'python3 scripts/process-images-fastdup.py',
    `--site ${siteInfo.siteArg}`,
    '--only-codes-file data/pipeline-delta.json',
    `--codes-key ${siteInfo.codesKey}`,
  ].join(' ');
  runRecord.steps.push(runStep(`${siteInfo.name} Fastdup`, fastdupCmd));

  const selectCmd = [
    `python3 scripts/select_exteriors.py ${siteInfo.siteArg}`,
    '--cache-root data',
    '--work-root work_fastdup',
    '--out-root selected_exteriors',
    '--images-subdir images',
    '--only-codes-file data/pipeline-delta.json',
    `--codes-key ${siteInfo.codesKey}`,
  ].join(' ');
  runRecord.steps.push(runStep(`${siteInfo.name} Exterior Selection`, selectCmd));

  const mosaicCmd = [
    `node scripts/mosaic-module.js ${siteInfo.mosaicArg}`,
    '--onlyCodesFile=data/pipeline-delta.json',
    `--codesKey=${siteInfo.codesKey}`,
  ].join(' ');
  runRecord.steps.push(runStep(`${siteInfo.name} Mosaic Generation`, mosaicCmd));
}

function filterDeterministicMatchesForIncremental(newVivaCodes, newCoelhoCodes) {
  const matchesFile = path.join(DATA_ROOT, 'deterministic-matches.json');
  if (!fs.existsSync(matchesFile)) {
    return { filtered: false, reason: 'deterministic-matches.json missing' };
  }

  const data = JSON.parse(fs.readFileSync(matchesFile, 'utf-8'));
  const pairs = Array.isArray(data.candidate_pairs) ? data.candidate_pairs : [];
  const vivaSet = new Set(newVivaCodes);
  const coelhoSet = new Set(newCoelhoCodes);
  const originalListingsWithCandidates = pairs.length;
  const originalTotalPairs = pairs.reduce((sum, pair) => sum + ((pair.candidates || []).length), 0);

  const filteredPairs = pairs.filter((pair) => {
    const vivaCode = String(pair?.viva?.code || '');
    if (vivaSet.has(vivaCode)) return true;
    if (coelhoSet.size === 0) return false;
    return (pair.candidates || []).some((candidate) => coelhoSet.has(String(candidate.code || '')));
  });

  data.candidate_pairs = filteredPairs;
  data.listings_with_candidates = filteredPairs.length;
  data.total_candidate_pairs = filteredPairs.reduce((sum, pair) => sum + ((pair.candidates || []).length), 0);
  data.incremental = {
    enabled: true,
    filtered_at: new Date().toISOString(),
    new_viva_codes: newVivaCodes,
    new_coelho_codes: newCoelhoCodes,
    original_listings_with_candidates: originalListingsWithCandidates,
    original_total_candidate_pairs: originalTotalPairs,
  };

  fs.writeFileSync(matchesFile, JSON.stringify(data, null, 2));

  return {
    filtered: true,
    original_listings_with_candidates: originalListingsWithCandidates,
    filtered_listings_with_candidates: filteredPairs.length,
    original_total_candidate_pairs: originalTotalPairs,
    filtered_total_candidate_pairs: data.total_candidate_pairs,
  };
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

  const previousState = loadPipelineState();

  // Step 1: Run Viva scraper (skip full post-processing; pipeline handles incremental)
  const vivaResult = runStep('Viva Scraper', 'SKIP_POST_PROCESSING=true node scripts/master-scraper-viva.js');
  runRecord.steps.push(vivaResult);

  // Step 2: Run Coelho scraper (skip full post-processing; pipeline handles incremental)
  const coelhoResult = runStep('Coelho Scraper', 'SKIP_POST_PROCESSING=true node scripts/master-scraper-coelho.js');
  runRecord.steps.push(coelhoResult);

  // Detect incremental deltas from listing snapshots
  const currentVivaCodes = loadListingCodes(VIVA_LISTINGS);
  const currentCoelhoCodes = loadListingCodes(COELHO_LISTINGS);

  const newVivaCodes = currentVivaCodes.size > 0
    ? computeNewCodes(previousState.viva_codes, currentVivaCodes)
    : [];
  const newCoelhoCodes = currentCoelhoCodes.size > 0
    ? computeNewCodes(previousState.coelho_codes, currentCoelhoCodes)
    : [];

  if (currentVivaCodes.size === 0 && vivaResult.status === 'failed') {
    log('Warning: Viva listings snapshot missing after failed scraper; preserving previous state');
  }
  if (currentCoelhoCodes.size === 0 && coelhoResult.status === 'failed') {
    log('Warning: Coelho listings snapshot missing after failed scraper; preserving previous state');
  }

  const stateVivaCodes = currentVivaCodes.size > 0 ? currentVivaCodes : new Set(previousState.viva_codes);
  const stateCoelhoCodes = currentCoelhoCodes.size > 0 ? currentCoelhoCodes : new Set(previousState.coelho_codes);
  savePipelineState(stateVivaCodes, stateCoelhoCodes);
  savePipelineDelta(newVivaCodes, newCoelhoCodes);

  log(`Detected ${newVivaCodes.length} new Viva listings, ${newCoelhoCodes.length} new Coelho listings`);
  runRecord.counts.new_viva = newVivaCodes.length;
  runRecord.counts.new_coelho = newCoelhoCodes.length;

  // Step 3: Incremental post-processing (fastdup -> select exteriors -> mosaics)
  runIncrementalSitePostProcessing(runRecord, 'viva');
  runIncrementalSitePostProcessing(runRecord, 'coelho');

  // Step 4: Run deterministic matcher
  const matcherResult = runStep('Deterministic Matcher', 'node scripts/deterministic-matcher.cjs');
  runRecord.steps.push(matcherResult);

  // Step 5: Filter matcher output to only new/affected properties
  const filterStart = Date.now();
  log('Starting: Filter deterministic matches (incremental)');
  try {
    const filterResult = filterDeterministicMatchesForIncremental(newVivaCodes, newCoelhoCodes);
    const elapsed = ((Date.now() - filterStart) / 1000).toFixed(1);
    log(
      `Completed: Filter deterministic matches (incremental) (${elapsed}s) ` +
      `pairs ${filterResult.filtered_total_candidate_pairs || 0}/${filterResult.original_total_candidate_pairs || 0}`
    );
    runRecord.steps.push({
      name: 'Filter Matches Incremental',
      status: 'success',
      elapsed_sec: parseFloat(elapsed),
      error: null,
      ...filterResult,
    });
  } catch (err) {
    const elapsed = ((Date.now() - filterStart) / 1000).toFixed(1);
    log(`Failed: Filter deterministic matches (incremental) - ${err.message}`);
    runRecord.steps.push({
      name: 'Filter Matches Incremental',
      status: 'failed',
      elapsed_sec: parseFloat(elapsed),
      error: err.message,
    });
  }

  // Step 6: Copy updated data files to server-deploy/data/
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
  const matchesFile = path.join(DATA_ROOT, 'deterministic-matches.json');

  runRecord.counts.total_matches = countMatcherCandidates(matchesFile);

  // Step 7: POST to /api/pipeline/complete
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
