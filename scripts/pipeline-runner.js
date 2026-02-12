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
 *   node scripts/pipeline-runner.js                          # default compound
 *   node scripts/pipeline-runner.js --compound=tambore-xi    # specific compound
 *   node scripts/pipeline-runner.js --all                    # all compounds
 *   COMPOUND=alphaville-1 node scripts/pipeline-runner.js    # via env var
 *   SERVER_URL=http://localhost:8080 node scripts/pipeline-runner.js
 */
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const DATA_ROOT = path.join(PROJECT_ROOT, 'data');
const SERVER_DEPLOY = path.join(PROJECT_ROOT, 'server-deploy');
const PIPELINE_LOG = path.join(DATA_ROOT, 'pipeline-runs.json');
const SERVER_URL = process.env.SERVER_URL || 'https://property-matcher-376125120681.us-central1.run.app';

const COMPOUNDS = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'config', 'compounds.json'), 'utf-8'));

function compoundDataRoot(compoundId) { return path.join(DATA_ROOT, compoundId); }
function pipelineStatePath(compoundId) { return path.join(compoundDataRoot(compoundId), 'pipeline-state.json'); }
function pipelineDeltaPath(compoundId) { return path.join(compoundDataRoot(compoundId), 'pipeline-delta.json'); }
function vivaListingsPath(compoundId) { return path.join(compoundDataRoot(compoundId), 'vivaprimeimoveis', 'listings', 'all-listings.json'); }
function coelhoListingsPath(compoundId) { return path.join(compoundDataRoot(compoundId), 'coelhodafonseca', 'listings', 'all-listings.json'); }

// ============================================================================
// Helpers
// ============================================================================

function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

function progress(step, total, detail) {
  const pct = Math.round((step / total) * 100);
  log(`[PROGRESS] Step ${step}/${total} (${pct}%) — ${detail}`);
}

const TOTAL_STEPS = 12;

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

function loadPipelineState(compoundId) {
  try {
    const statePath = pipelineStatePath(compoundId);
    if (!fs.existsSync(statePath)) {
      return { viva_codes: [], coelho_codes: [] };
    }
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    return {
      viva_codes: Array.isArray(state.viva_codes) ? state.viva_codes : [],
      coelho_codes: Array.isArray(state.coelho_codes) ? state.coelho_codes : [],
    };
  } catch {
    return { viva_codes: [], coelho_codes: [] };
  }
}

function savePipelineState(compoundId, vivaCodes, coelhoCodes) {
  const state = {
    updated_at: new Date().toISOString(),
    viva_codes: [...vivaCodes],
    coelho_codes: [...coelhoCodes],
  };
  fs.mkdirSync(compoundDataRoot(compoundId), { recursive: true });
  fs.writeFileSync(pipelineStatePath(compoundId), JSON.stringify(state, null, 2));
}

function computeNewCodes(previousCodes, currentCodes) {
  const previous = new Set(previousCodes);
  return [...currentCodes].filter((code) => !previous.has(code));
}

function savePipelineDelta(compoundId, newVivaCodes, newCoelhoCodes) {
  const delta = {
    generated_at: new Date().toISOString(),
    new_viva_codes: newVivaCodes,
    new_coelho_codes: newCoelhoCodes,
  };
  fs.mkdirSync(compoundDataRoot(compoundId), { recursive: true });
  fs.writeFileSync(pipelineDeltaPath(compoundId), JSON.stringify(delta, null, 2));
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

function runIncrementalSitePostProcessing(runRecord, site, codes, compoundId) {
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

  if (!codes || codes.length === 0) {
    recordSkippedStep(runRecord, `${siteInfo.name} Fastdup (${compoundId})`, 'No new listing codes');
    recordSkippedStep(runRecord, `${siteInfo.name} Exterior Selection (${compoundId})`, 'No new listing codes');
    recordSkippedStep(runRecord, `${siteInfo.name} Mosaic Generation (${compoundId})`, 'No new listing codes');
    return;
  }

  const deltaFile = `data/${compoundId}/pipeline-delta.json`;
  const stepBase = site === 'viva' ? 4 : 7;

  log(`[PROGRESS] Step ${stepBase}/${TOTAL_STEPS} — ${siteInfo.name} Fastdup (${compoundId}, ${codes.length} listings)`);
  const fastdupCmd = [
    'python3 scripts/process-images-fastdup.py',
    `--site ${siteInfo.siteArg}`,
    `--data-root data/${compoundId}`,
    `--work-root work_fastdup/${compoundId}`,
    `--only-codes-file ${deltaFile}`,
    `--codes-key ${siteInfo.codesKey}`,
  ].join(' ');
  runRecord.steps.push(runStep(`${siteInfo.name} Fastdup (${compoundId})`, fastdupCmd));

  log(`[PROGRESS] Step ${stepBase + 1}/${TOTAL_STEPS} — ${siteInfo.name} Exterior Selection (${compoundId})`);
  const selectCmd = [
    `python3 scripts/select_exteriors.py ${siteInfo.siteArg}`,
    `--cache-root data/${compoundId}`,
    `--work-root work_fastdup/${compoundId}`,
    `--out-root selected_exteriors/${compoundId}`,
    '--images-subdir images',
    `--only-codes-file ${deltaFile}`,
    `--codes-key ${siteInfo.codesKey}`,
  ].join(' ');
  runRecord.steps.push(runStep(`${siteInfo.name} Exterior Selection (${compoundId})`, selectCmd));

  log(`[PROGRESS] Step ${stepBase + 2}/${TOTAL_STEPS} — ${siteInfo.name} Mosaic Generation (${compoundId})`);
  const mosaicCmd = [
    `node scripts/mosaic-module.js ${siteInfo.mosaicArg}`,
    `--compound=${compoundId}`,
    `--onlyCodesFile=${deltaFile}`,
    `--codesKey=${siteInfo.codesKey}`,
  ].join(' ');
  runRecord.steps.push(runStep(`${siteInfo.name} Mosaic Generation (${compoundId})`, mosaicCmd));
}

async function runIncrementalSitePostProcessingAsync(site, codes, compoundId) {
  const siteInfo = site === 'viva'
    ? { name: 'Viva', siteArg: 'vivaprimeimoveis', mosaicArg: 'viva', codesKey: 'new_viva_codes' }
    : { name: 'Coelho', siteArg: 'coelhodafonseca', mosaicArg: 'coelho', codesKey: 'new_coelho_codes' };

  const results = [];
  const deltaFile = `data/${compoundId}/pipeline-delta.json`;

  if (!codes || codes.length === 0) {
    results.push({ name: `${siteInfo.name} Fastdup (${compoundId})`, status: 'skipped', elapsed_sec: 0, error: null, reason: 'No new listing codes' });
    results.push({ name: `${siteInfo.name} Exterior Selection (${compoundId})`, status: 'skipped', elapsed_sec: 0, error: null, reason: 'No new listing codes' });
    results.push({ name: `${siteInfo.name} Mosaic Generation (${compoundId})`, status: 'skipped', elapsed_sec: 0, error: null, reason: 'No new listing codes' });
    log(`[PROGRESS] ${siteInfo.name} post-processing skipped for ${compoundId} (no new codes)`);
    return results;
  }

  log(`[PROGRESS] ${siteInfo.name} Fastdup (${compoundId}, ${codes.length} listings)`);
  const fastdupCmd = `python3 scripts/process-images-fastdup.py --site ${siteInfo.siteArg} --data-root data/${compoundId} --work-root work_fastdup/${compoundId} --only-codes-file ${deltaFile} --codes-key ${siteInfo.codesKey}`;
  results.push(await runStepAsync(`${siteInfo.name} Fastdup (${compoundId})`, fastdupCmd));

  log(`[PROGRESS] ${siteInfo.name} Exterior Selection (${compoundId})`);
  const selectCmd = `python3 scripts/select_exteriors.py ${siteInfo.siteArg} --cache-root data/${compoundId} --work-root work_fastdup/${compoundId} --out-root selected_exteriors/${compoundId} --images-subdir images --only-codes-file ${deltaFile} --codes-key ${siteInfo.codesKey}`;
  results.push(await runStepAsync(`${siteInfo.name} Exterior Selection (${compoundId})`, selectCmd));

  log(`[PROGRESS] ${siteInfo.name} Mosaic Generation (${compoundId})`);
  const mosaicCmd = `node scripts/mosaic-module.js ${siteInfo.mosaicArg} --compound=${compoundId} --onlyCodesFile=${deltaFile} --codesKey=${siteInfo.codesKey}`;
  results.push(await runStepAsync(`${siteInfo.name} Mosaic Generation (${compoundId})`, mosaicCmd));

  return results;
}

function filterDeterministicMatchesForIncremental(compoundId, newVivaCodes, newCoelhoCodes) {
  const matchesFile = path.join(compoundDataRoot(compoundId), 'deterministic-matches.json');
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

function runStep(name, command, { timeoutMs = 600000 } = {}) {
  const start = Date.now();
  log(`Starting: ${name}`);

  try {
    execSync(command, {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
      timeout: timeoutMs,
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

function runStepAsync(name, command, { timeoutMs = 600000 } = {}) {
  return new Promise((resolve) => {
    const start = Date.now();
    log(`Starting: ${name}`);

    const child = spawn('/bin/sh', ['-c', command], {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
      timeout: timeoutMs,
    });

    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      if (code === 0) {
        log(`Completed: ${name} (${elapsed}s)`);
        resolve({ name, status: 'success', elapsed_sec: parseFloat(elapsed), error: null });
      } else {
        const errorMsg = killed ? `Timed out after ${timeoutMs / 1000}s` : `Exit code ${code}`;
        log(`Failed: ${name} (${elapsed}s) - ${errorMsg}`);
        resolve({ name, status: 'failed', elapsed_sec: parseFloat(elapsed), error: errorMsg });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      log(`Failed: ${name} (${elapsed}s) - ${err.message}`);
      resolve({ name, status: 'failed', elapsed_sec: parseFloat(elapsed), error: err.message });
    });
  });
}

// ============================================================================
// Compound Selection
// ============================================================================

function getCompoundsToRun() {
  const allFlag = process.argv.includes('--all');
  const compoundArg = process.argv.find(a => a.startsWith('--compound='));

  if (allFlag) {
    return Object.keys(COMPOUNDS.compounds);
  }

  if (compoundArg) {
    const id = compoundArg.split('=')[1];
    if (!COMPOUNDS.compounds[id]) {
      console.error(`Unknown compound: ${id}. Available: ${Object.keys(COMPOUNDS.compounds).join(', ')}`);
      process.exit(1);
    }
    return [id];
  }

  const envCompound = process.env.COMPOUND;
  if (envCompound) {
    return [envCompound];
  }

  return [COMPOUNDS.defaultCompound];
}

// ============================================================================
// Pipeline Steps
// ============================================================================

async function runPipeline() {
  const compoundsToRun = getCompoundsToRun();
  log(`Compounds to process: ${compoundsToRun.join(', ')}`);

  const pipelineStart = Date.now();
  const runRecord = {
    timestamp: new Date().toISOString(),
    status: 'running',
    compounds: {},
    steps: [],
    counts: {},
    total_elapsed_sec: 0,
  };

  log('========================================');
  log('Pipeline Runner - Starting');
  log('========================================');

  let anyScraperFailed = true;

  for (const compoundId of compoundsToRun) {
    log(`\n${'='.repeat(40)}`);
    log(`Processing compound: ${compoundId}`);
    log(`${'='.repeat(40)}`);

    const compoundRecord = { steps: [], counts: {} };

    // Ensure compound data directory exists
    fs.mkdirSync(compoundDataRoot(compoundId), { recursive: true });

    const previousState = loadPipelineState(compoundId);

    // Steps 1-2: Run both scrapers IN PARALLEL
    progress(1, TOTAL_STEPS, `Scrapers (${compoundId}) — Viva + Coelho running in parallel`);
    log(`Launching Viva and Coelho scrapers in parallel for ${compoundId}...`);
    const [vivaResult, coelhoResult] = await Promise.all([
      runStepAsync(`Viva Scraper (${compoundId})`, `COMPOUND=${compoundId} SKIP_POST_PROCESSING=true node scripts/master-scraper-viva.js`, { timeoutMs: 5400000 }),
      runStepAsync(`Coelho Scraper (${compoundId})`, `COMPOUND=${compoundId} SKIP_POST_PROCESSING=true node scripts/master-scraper-coelho.js`, { timeoutMs: 5400000 }),
    ]);
    runRecord.steps.push(vivaResult);
    runRecord.steps.push(coelhoResult);
    compoundRecord.steps.push(vivaResult);
    compoundRecord.steps.push(coelhoResult);
    log(`Scrapers done (${compoundId}) — Viva: ${vivaResult.status} (${vivaResult.elapsed_sec}s), Coelho: ${coelhoResult.status} (${coelhoResult.elapsed_sec}s)`);

    if (vivaResult.status !== 'failed' || coelhoResult.status !== 'failed') {
      anyScraperFailed = false;
    }

    // Detect incremental deltas from listing snapshots
    const forceFull = process.env.FORCE_FULL === 'true';
    const currentVivaCodes = loadListingCodes(vivaListingsPath(compoundId));
    const currentCoelhoCodes = loadListingCodes(coelhoListingsPath(compoundId));

    let newVivaCodes, newCoelhoCodes;

    if (forceFull) {
      log(`FORCE_FULL=true — treating ALL listing codes as new for ${compoundId} (skipping incremental delta)`);
      newVivaCodes = [...currentVivaCodes];
      newCoelhoCodes = [...currentCoelhoCodes];
    } else {
      newVivaCodes = currentVivaCodes.size > 0
        ? computeNewCodes(previousState.viva_codes, currentVivaCodes)
        : [];
      newCoelhoCodes = currentCoelhoCodes.size > 0
        ? computeNewCodes(previousState.coelho_codes, currentCoelhoCodes)
        : [];
    }

    if (currentVivaCodes.size === 0 && vivaResult.status === 'failed') {
      log(`Warning: Viva listings snapshot missing for ${compoundId} after failed scraper; preserving previous state`);
    }
    if (currentCoelhoCodes.size === 0 && coelhoResult.status === 'failed') {
      log(`Warning: Coelho listings snapshot missing for ${compoundId} after failed scraper; preserving previous state`);
    }

    const stateVivaCodes = currentVivaCodes.size > 0 ? currentVivaCodes : new Set(previousState.viva_codes);
    const stateCoelhoCodes = currentCoelhoCodes.size > 0 ? currentCoelhoCodes : new Set(previousState.coelho_codes);
    savePipelineState(compoundId, stateVivaCodes, stateCoelhoCodes);
    savePipelineDelta(compoundId, newVivaCodes, newCoelhoCodes);

    progress(3, TOTAL_STEPS, `Delta detection (${compoundId}) — ${newVivaCodes.length} new Viva, ${newCoelhoCodes.length} new Coelho (forceFull=${forceFull})`);
    log(`Detected ${newVivaCodes.length} new Viva listings, ${newCoelhoCodes.length} new Coelho listings for ${compoundId}`);
    compoundRecord.counts.new_viva = newVivaCodes.length;
    compoundRecord.counts.new_coelho = newCoelhoCodes.length;

    // Steps 4-9: Post-processing for both sites SEQUENTIALLY
    // (fastdup is memory-hungry; running in parallel causes OOM on Cloud Run)
    progress(4, TOTAL_STEPS, `Post-processing (${compoundId}) — Viva fastdup/exteriors/mosaics`);
    log(`Launching post-processing for ${compoundId}: ${newVivaCodes.length} Viva codes, ${newCoelhoCodes.length} Coelho codes`);
    const vivaPostResults = await runIncrementalSitePostProcessingAsync('viva', newVivaCodes, compoundId);
    runRecord.steps.push(...vivaPostResults);
    compoundRecord.steps.push(...vivaPostResults);

    progress(7, TOTAL_STEPS, `Post-processing (${compoundId}) — Coelho fastdup/exteriors/mosaics`);
    const coelhoPostResults = await runIncrementalSitePostProcessingAsync('coelho', newCoelhoCodes, compoundId);
    runRecord.steps.push(...coelhoPostResults);
    compoundRecord.steps.push(...coelhoPostResults);

    // Step 10: Run deterministic matcher
    progress(10, TOTAL_STEPS, `Deterministic Matcher (${compoundId}) — finding candidate pairs`);
    const matcherResult = runStep(`Deterministic Matcher (${compoundId})`, `COMPOUND=${compoundId} node scripts/deterministic-matcher.cjs`);
    runRecord.steps.push(matcherResult);
    compoundRecord.steps.push(matcherResult);

    // Step 11: Filter matcher output to only new/affected properties
    progress(11, TOTAL_STEPS, `Filtering matches for incremental (${compoundId})`);
    const filterStart = Date.now();
    log(`Starting: Filter deterministic matches (incremental) for ${compoundId}`);
    try {
      const filterResult = filterDeterministicMatchesForIncremental(compoundId, newVivaCodes, newCoelhoCodes);
      const elapsed = ((Date.now() - filterStart) / 1000).toFixed(1);
      log(
        `Completed: Filter deterministic matches (incremental) for ${compoundId} (${elapsed}s) ` +
        `pairs ${filterResult.filtered_total_candidate_pairs || 0}/${filterResult.original_total_candidate_pairs || 0}`
      );
      const filterStep = {
        name: `Filter Matches Incremental (${compoundId})`,
        status: 'success',
        elapsed_sec: parseFloat(elapsed),
        error: null,
        ...filterResult,
      };
      runRecord.steps.push(filterStep);
      compoundRecord.steps.push(filterStep);
    } catch (err) {
      const elapsed = ((Date.now() - filterStart) / 1000).toFixed(1);
      log(`Failed: Filter deterministic matches (incremental) for ${compoundId} - ${err.message}`);
      const filterStep = {
        name: `Filter Matches Incremental (${compoundId})`,
        status: 'failed',
        elapsed_sec: parseFloat(elapsed),
        error: err.message,
      };
      runRecord.steps.push(filterStep);
      compoundRecord.steps.push(filterStep);
    }

    // Step 12: Copy updated data files to server-deploy/data/<compoundId>/
    progress(12, TOTAL_STEPS, `Copying data to server-deploy (${compoundId})`);
    log(`Starting: Copy data to server-deploy for ${compoundId}`);
    const copyStart = Date.now();

    try {
      const serverDataDir = path.join(SERVER_DEPLOY, 'data', compoundId);
      fs.mkdirSync(path.join(serverDataDir, 'mosaics'), { recursive: true });
      fs.mkdirSync(path.join(serverDataDir, 'listings'), { recursive: true });

      let copiedCount = 0;

      // Copy deterministic-matches.json
      const matchesSrc = path.join(compoundDataRoot(compoundId), 'deterministic-matches.json');
      if (fs.existsSync(matchesSrc)) {
        fs.copyFileSync(matchesSrc, path.join(serverDataDir, 'deterministic-matches.json'));
        copiedCount++;
        log(`  Copied: deterministic-matches.json`);
      }

      // Copy manual-matches.json if it exists
      const manualSrc = path.join(compoundDataRoot(compoundId), 'manual-matches.json');
      if (fs.existsSync(manualSrc)) {
        fs.copyFileSync(manualSrc, path.join(serverDataDir, 'manual-matches.json'));
        copiedCount++;
        log(`  Copied: manual-matches.json`);
      }

      // Copy mosaics directory using rsync for efficiency
      const mosaicsSource = path.join(compoundDataRoot(compoundId), 'mosaics');
      const mosaicsDest = path.join(serverDataDir, 'mosaics');
      if (fs.existsSync(mosaicsSource)) {
        try {
          execSync(`rsync -a --delete "${mosaicsSource}/" "${mosaicsDest}/"`, {
            cwd: PROJECT_ROOT,
            stdio: 'pipe',
          });
          log(`  Synced mosaics directory for ${compoundId}`);
        } catch {
          log(`  Warning: mosaics sync skipped for ${compoundId} (rsync failed)`);
        }
      }

      // Copy listings
      const vivaListingSrc = vivaListingsPath(compoundId);
      if (fs.existsSync(vivaListingSrc)) {
        fs.copyFileSync(vivaListingSrc, path.join(serverDataDir, 'listings', 'vivaprimeimoveis_listings.json'));
        copiedCount++;
        log(`  Copied: vivaprimeimoveis_listings.json`);
      }
      const coelhoListingSrc = coelhoListingsPath(compoundId);
      if (fs.existsSync(coelhoListingSrc)) {
        fs.copyFileSync(coelhoListingSrc, path.join(serverDataDir, 'listings', 'coelhodafonseca_listings.json'));
        copiedCount++;
        log(`  Copied: coelhodafonseca_listings.json`);
      }

      const copyElapsed = ((Date.now() - copyStart) / 1000).toFixed(1);
      log(`Completed: Copy data to server-deploy for ${compoundId} (${copyElapsed}s)`);
      const copyStep = {
        name: `Copy Data (${compoundId})`,
        status: 'success',
        elapsed_sec: parseFloat(copyElapsed),
        error: null,
        files_copied: copiedCount,
      };
      runRecord.steps.push(copyStep);
      compoundRecord.steps.push(copyStep);
    } catch (err) {
      const copyElapsed = ((Date.now() - copyStart) / 1000).toFixed(1);
      log(`Failed: Copy data to server-deploy for ${compoundId} - ${err.message}`);
      const copyStep = {
        name: `Copy Data (${compoundId})`,
        status: 'failed',
        elapsed_sec: parseFloat(copyElapsed),
        error: err.message,
      };
      runRecord.steps.push(copyStep);
      compoundRecord.steps.push(copyStep);
    }

    // Gather counts for this compound
    const matchesFile = path.join(compoundDataRoot(compoundId), 'deterministic-matches.json');
    compoundRecord.counts.total_matches = countMatcherCandidates(matchesFile);

    runRecord.compounds[compoundId] = compoundRecord;
  }

  // Aggregate counts across all compounds
  runRecord.counts.new_viva = 0;
  runRecord.counts.new_coelho = 0;
  runRecord.counts.total_matches = 0;
  for (const cid of Object.keys(runRecord.compounds)) {
    runRecord.counts.new_viva += runRecord.compounds[cid].counts.new_viva || 0;
    runRecord.counts.new_coelho += runRecord.compounds[cid].counts.new_coelho || 0;
    runRecord.counts.total_matches += runRecord.compounds[cid].counts.total_matches || 0;
  }

  // POST to /api/pipeline/complete
  log('Starting: Notify server');

  try {
    const payload = JSON.stringify({
      compounds: Object.keys(runRecord.compounds),
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

  // Record pipeline run
  const totalElapsed = ((Date.now() - pipelineStart) / 1000).toFixed(1);
  runRecord.total_elapsed_sec = parseFloat(totalElapsed);

  const failedSteps = runRecord.steps.filter(s => s.status === 'failed');
  runRecord.status = failedSteps.length === 0 ? 'success' : failedSteps.length === runRecord.steps.length ? 'failed' : 'partial';

  const runs = loadPipelineLog();
  runs.push(runRecord);
  savePipelineLog(runs);

  log('========================================');
  log(`Pipeline ${runRecord.status} in ${totalElapsed}s`);
  log(`  Compounds: ${compoundsToRun.join(', ')}`);
  log(`  Viva listings: ${runRecord.counts.new_viva}`);
  log(`  Coelho listings: ${runRecord.counts.new_coelho}`);
  log(`  Matches: ${runRecord.counts.total_matches}`);
  if (failedSteps.length > 0) {
    log(`  Failed steps: ${failedSteps.map(s => s.name).join(', ')}`);
  }
  log('========================================');

  // Exit with non-zero if all scrapers failed across all compounds
  if (anyScraperFailed) {
    process.exit(1);
  }
}

// Run the pipeline
runPipeline().catch((err) => {
  log(`Pipeline crashed: ${err.message}`);
  process.exit(1);
});
