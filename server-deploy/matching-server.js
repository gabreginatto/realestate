#!/usr/bin/env node
/**
 * Human-in-the-Loop Matching Server
 *
 * Backend API for manual property matching interface.
 * Loads smart-compare results and serves matching tasks to reviewers.
 *
 * Multi-compound support: state is maintained per compound.
 *
 * Features:
 * - Session management with resumable state
 * - Append-only audit log for decisions
 * - Reviewer tracking and metrics
 * - Optimistic locking with ETags
 * - Real-time progress tracking
 *
 * Usage:
 *   node scripts/human-loop/matching-server.js
 *   node scripts/human-loop/matching-server.js --port 3001 --read-only
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  syncAllFromGCS,
  checkForNewPipelineData,
  syncPipelineData,
  uploadUserDecisions,
  flushUserDecisions,
} = require('./gcs-data-sync');

// ============================================================================
// CONFIGURATION
// ============================================================================

const HOST = process.env.HOST || '0.0.0.0';  // Bind to all interfaces for network access
const PORT = process.env.PORT || process.env.MATCHING_PORT || process.argv.find(a => a.startsWith('--port='))?.split('=')[1] || 8080;
const DATA_ROOT = process.env.DATA_ROOT || (
  fs.existsSync(path.join(__dirname, 'data')) ? path.join(__dirname, 'data') : path.join(__dirname, '..', '..', 'data')
);
const PUBLIC_ROOT = process.env.PUBLIC_ROOT || (
  fs.existsSync(path.join(__dirname, 'public')) ? path.join(__dirname, 'public') : path.join(__dirname, '..', '..', 'server-deploy', 'public')
);
const READ_ONLY = process.argv.includes('--read-only') || process.env.READ_ONLY === 'true';
const SESSION_NAME = process.env.SESSION_NAME || 'default';

// Load compounds configuration
const COMPOUNDS_CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'compounds.json'), 'utf-8'));

// ============================================================================
// PER-COMPOUND STATE MANAGEMENT
// ============================================================================

const compoundStates = new Map(); // compoundId -> compound state object

function createCompoundState(compoundId) {
  return {
    compoundId,
    matchState: {
      session_started: null,
      last_updated: null,
      session_name: SESSION_NAME,
      version: 0,
      current_pass: 1,
      passes_completed: 0,
      user_finished: false,
      pass_matched: 0,
      pass_skipped: 0,
      stats: {
        total_viva_listings: 0,
        matched: 0,
        rejected: 0,
        skipped: 0,
        pending: 0,
        in_progress: 0
      },
      matches: [],
      rejected: [],
      skipped: [],
      in_progress: []
    },
    smartMatches: null,
    taskQueue: [],
    vivaListings: [],
    coelhoListings: [],
    passStartTotal: 0,
    // Compound-specific paths
    dataRoot: path.join(DATA_ROOT, compoundId),
    smartMatchesFile: path.join(DATA_ROOT, compoundId, 'deterministic-matches.json'),
    manualMatchesFile: path.join(DATA_ROOT, compoundId, 'manual-matches.json'),
    auditLogFile: path.join(DATA_ROOT, compoundId, 'manual-matches.log.jsonl'),
    mosaicsDir: path.join(DATA_ROOT, compoundId, 'mosaics'),
    notificationsFile: path.join(DATA_ROOT, compoundId, 'notifications.json'),
  };
}

function getCompoundState(compoundId) {
  if (!compoundStates.has(compoundId)) {
    compoundStates.set(compoundId, createCompoundState(compoundId));
  }
  return compoundStates.get(compoundId);
}

// ============================================================================
// PASS CRITERIA DEFINITIONS (from iterative-matcher.js)
// ============================================================================

const PASS_CRITERIA = {
  1: {
    name: 'strict',
    price_tolerance: 0.05,      // +/-5%
    area_tolerance: 0.10,       // +/-10%
    beds_tolerance: 0,          // exact match
    suites_tolerance: 0,        // exact match
    park_tolerance: 0           // exact match
  },
  2: {
    name: 'relaxed',
    price_tolerance: 0.10,      // +/-10%
    area_tolerance: 0.15,       // +/-15%
    beds_tolerance: 0,          // exact match
    suites_tolerance: 1,        // +/-1
    park_tolerance: 999         // ignore
  },
  3: {
    name: 'broader',
    price_tolerance: 0.15,      // +/-15%
    area_tolerance: 0.20,       // +/-20%
    beds_tolerance: 1,          // +/-1
    suites_tolerance: 999,      // ignore
    park_tolerance: 999         // ignore
  },
  4: {
    name: 'very_broad',
    price_tolerance: 0.25,      // +/-25%
    area_tolerance: 0.30,       // +/-30%
    beds_tolerance: 1,          // +/-1
    suites_tolerance: 999,      // ignore
    park_tolerance: 999         // ignore
  },
  5: {
    name: 'exhaustive',
    price_tolerance: 0.40,      // +/-40%
    area_tolerance: 0.50,       // +/-50%
    beds_tolerance: 2,          // +/-2
    suites_tolerance: 999,      // ignore
    park_tolerance: 999         // ignore
  }
};

const MAX_PASSES = 5;
const MAX_CANDIDATES_PER_LISTING = 5;
const LOCK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes - locks older than this are considered stale

function getPassCriteria(passNum) {
  return PASS_CRITERIA[passNum] || PASS_CRITERIA[5];
}

// ============================================================================
// MATCHING LOGIC (from iterative-matcher.js)
// ============================================================================

function parsePrice(priceStr) {
  if (!priceStr) return 0;
  // Handle Brazilian format: R$ 4.900.000,00
  return parseFloat(String(priceStr).replace(/R\$\s*/g, '').replace(/\./g, '').replace(/,/g, '.'));
}

function scoreCandidate(viva, coelho, criteria) {
  let score = 1.0;

  // Price check
  const vivaPrice = parsePrice(viva.price);
  const coelhoPrice = parsePrice(coelho.price);

  if (vivaPrice === 0 || coelhoPrice === 0) return 0;

  const priceDiff = Math.abs(vivaPrice - coelhoPrice) / vivaPrice;
  if (priceDiff > criteria.price_tolerance) return 0;  // hard cutoff
  score *= (1 - priceDiff / criteria.price_tolerance);  // closer = higher score

  // Area check
  if (viva.built && coelho.built) {
    const areaDiff = Math.abs(viva.built - coelho.built) / viva.built;
    if (areaDiff > criteria.area_tolerance) return 0;
    score *= (1 - areaDiff / criteria.area_tolerance);
  }

  // Beds check
  if (viva.beds && coelho.beds) {
    const bedsDiff = Math.abs(viva.beds - coelho.beds);
    if (bedsDiff > criteria.beds_tolerance) return 0;
    score *= bedsDiff === 0 ? 1.0 : 0.8;
  }

  // Suites check
  if (viva.suites && coelho.suites && criteria.suites_tolerance < 999) {
    const suitesDiff = Math.abs(viva.suites - coelho.suites);
    if (suitesDiff > criteria.suites_tolerance) return 0;
    score *= suitesDiff === 0 ? 1.0 : 0.9;
  }

  // Parking check
  if (viva.park && coelho.park && criteria.park_tolerance < 999) {
    const parkDiff = Math.abs(viva.park - coelho.park);
    if (parkDiff > criteria.park_tolerance) return 0;
    score *= parkDiff === 0 ? 1.0 : 0.95;
  }

  return score;
}

function findCandidatesForViva(viva, coelhoList, criteria, maxCandidates = MAX_CANDIDATES_PER_LISTING) {
  const candidates = [];

  for (const coelho of coelhoList) {
    const score = scoreCandidate(viva, coelho, criteria);

    if (score > 0) {
      candidates.push({
        ...coelho,
        score: parseFloat(score.toFixed(3))
      });
    }
  }

  // Sort by score (highest first) and take top N
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, maxCandidates);
}

// ============================================================================
// INITIALIZATION (compound-scoped)
// ============================================================================

function loadListings(site, cs) {
  const listingsFile = path.join(cs.dataRoot, 'listings', `${site}_listings.json`);

  if (!fs.existsSync(listingsFile)) {
    console.warn(`  [${cs.compoundId}] ${listingsFile} not found - dynamic matching disabled`);
    return [];
  }

  try {
    const data = JSON.parse(fs.readFileSync(listingsFile, 'utf-8'));
    return data.listings || [];
  } catch (error) {
    console.warn(`  [${cs.compoundId}] Error loading ${listingsFile}: ${error.message}`);
    return [];
  }
}

function loadSmartMatches(cs) {
  try {
    if (!fs.existsSync(cs.smartMatchesFile)) {
      console.warn(`  [${cs.compoundId}] deterministic-matches.json not found — awaiting pipeline data`);
      return { matches: [] };
    }

    const data = JSON.parse(fs.readFileSync(cs.smartMatchesFile, 'utf-8'));
    // Convert deterministic-matches format to expected format
    const matches = (data.candidate_pairs || []).map(pair => ({
      viva: pair.viva,
      coelhoCandidates: pair.candidates || [],
      _scored: (pair.candidates || []).map(c => ({ code: c.code, score: c.score }))
    }));
    console.log(`  [${cs.compoundId}] Loaded deterministic-matches.json: ${matches.length} Viva listings with candidates`);
    return { matches };
  } catch (error) {
    console.warn(`  [${cs.compoundId}] Error loading deterministic-matches.json: ${error.message}`);
    return { matches: [] };
  }
}

function loadManualMatches(cs) {
  try {
    if (fs.existsSync(cs.manualMatchesFile)) {
      const data = JSON.parse(fs.readFileSync(cs.manualMatchesFile, 'utf-8'));
      console.log(`  [${cs.compoundId}] Loaded existing manual-matches.json (${data.matches?.length || 0} matches)`);
      // Ensure pass tracking fields exist
      data.current_pass = data.current_pass || 1;
      data.passes_completed = data.passes_completed || 0;
      data.pass_matched = data.pass_matched || 0;
      data.pass_skipped = data.pass_skipped || 0;
      return data;
    }
  } catch (error) {
    console.warn(`  [${cs.compoundId}] Error loading manual-matches.json: ${error.message}`);
  }

  // Initialize new session
  return {
    session_started: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    session_name: SESSION_NAME,
    version: 0,
    current_pass: 1,
    passes_completed: 0,
    pass_matched: 0,
    pass_skipped: 0,
    stats: {
      total_viva_listings: cs.smartMatches?.matches?.length || 0,
      matched: 0,
      rejected: 0,
      skipped: 0,
      pending: cs.smartMatches?.matches?.length || 0,
      in_progress: 0
    },
    matches: [],
    rejected: [],
    skipped: [],
    in_progress: []
  };
}

function buildTaskQueue(cs) {
  const tasks = [];

  for (const item of cs.smartMatches.matches || []) {
    const vivaCode = item.viva?.code || item.viva?.propertyCode;

    // Skip if already matched (final decision)
    const alreadyMatched = cs.matchState.matches.some(m => m.viva_code === vivaCode);
    if (alreadyMatched) {
      continue;
    }

    // For current pass, also skip if already skipped (will be reconsidered in next pass)
    const alreadySkipped = cs.matchState.skipped.some(s => s.viva_code === vivaCode);
    if (alreadySkipped) {
      continue;
    }

    // Filter out already rejected candidates AND already matched Coelho codes
    const rejectedCodes = cs.matchState.rejected
      .filter(r => r.viva_code === vivaCode)
      .map(r => r.coelho_code);

    const matchedCoelhoCodes = new Set(cs.matchState.matches.map(m => m.coelho_code));

    const candidates = (item.coelhoCandidates || [])
      .map(c => c.code || c.propertyCode)
      .filter(code => !rejectedCodes.includes(code) && !matchedCoelhoCodes.has(code));

    if (candidates.length > 0) {
      // Also filter the actual candidate objects to keep in sync
      const filteredCandidates = (item.coelhoCandidates || [])
        .filter(c => {
          const code = c.code || c.propertyCode;
          return !rejectedCodes.includes(code) && !matchedCoelhoCodes.has(code);
        });

      tasks.push({
        viva_code: vivaCode,
        viva: item.viva,
        candidates: filteredCandidates,
        scored: item._scored || [],
        remaining_candidates: candidates.length
      });
    }
  }

  console.log(`  [${cs.compoundId}] Built task queue: ${tasks.length} pending Viva listings`);
  return tasks;
}

/**
 * Advance to the next pass by regenerating candidates for all unmatched
 * listings with broader criteria. This includes user-skipped listings AND
 * "orphan" listings that had zero candidates in previous passes.
 */
function advanceToNextPass(cs) {
  const currentPass = cs.matchState.current_pass;
  const nextPass = currentPass + 1;

  if (nextPass > MAX_PASSES) {
    console.log(`\n  [${cs.compoundId}] All ${MAX_PASSES} passes completed. No more passes available.`);
    return false;
  }

  // Check if we have raw listings to regenerate candidates
  if (cs.vivaListings.length === 0 || cs.coelhoListings.length === 0) {
    console.log(`\n  [${cs.compoundId}] Cannot advance to Pass ${nextPass}: Raw listings not loaded`);
    return false;
  }

  // Include ALL unmatched Viva listings: skipped + orphans (never had candidates)
  const matchedVivaCodes = new Set(cs.matchState.matches.map(m => m.viva_code));
  const allVivaCodes = cs.vivaListings.map(l => l.code || l.propertyCode);
  const remainingVivaCodes = allVivaCodes.filter(code => !matchedVivaCodes.has(code));

  if (remainingVivaCodes.length === 0) {
    console.log(`\n  [${cs.compoundId}] No remaining listings to process. All listings have been matched!`);
    return false;
  }

  const skippedCount = cs.matchState.skipped.length;
  const orphanCount = remainingVivaCodes.length - skippedCount;

  console.log(`\n  [${cs.compoundId}] Advancing to Pass ${nextPass} (${getPassCriteria(nextPass).name})`);
  console.log(`   Regenerating candidates for ${remainingVivaCodes.length} unmatched listings (${skippedCount} skipped + ${orphanCount} without previous candidates)...`);

  const criteria = getPassCriteria(nextPass);
  const remainingSet = new Set(remainingVivaCodes);
  const matchedCoelhoCodes = new Set(cs.matchState.matches.map(m => m.coelho_code));
  const newPairs = [];

  // Filter out already-matched Coelho listings so they can't appear as candidates
  const availableCoelho = cs.coelhoListings.filter(c => {
    const code = c.code || c.propertyCode;
    return !matchedCoelhoCodes.has(code);
  });

  // Find the full Viva listings for the remaining codes
  for (const viva of cs.vivaListings) {
    const vivaCode = viva.code || viva.propertyCode;
    if (!remainingSet.has(vivaCode)) continue;

    // Generate new candidates with broader criteria, excluding matched Coelho properties
    const candidates = findCandidatesForViva(viva, availableCoelho, criteria);

    if (candidates.length > 0) {
      newPairs.push({
        viva: viva,
        coelhoCandidates: candidates,
        _scored: candidates.map(c => ({ code: c.code || c.propertyCode, score: c.score }))
      });
    }
  }

  console.log(`   Found candidates for ${newPairs.length} / ${remainingVivaCodes.length} listings`);

  if (newPairs.length === 0) {
    console.log(`   No new candidates found with Pass ${nextPass} criteria.`);
    // Still advance the pass in case we want to try the next one
    cs.matchState.current_pass = nextPass;
    return advanceToNextPass(cs); // Recursively try next pass
  }

  // Clear skipped listings (they're being reconsidered with new candidates)
  // Keep track of them in a separate field for audit purposes
  cs.matchState.skipped_previous_passes = cs.matchState.skipped_previous_passes || [];
  cs.matchState.skipped_previous_passes.push({
    pass: currentPass,
    skipped: [...cs.matchState.skipped]
  });
  cs.matchState.skipped = [];

  // Update smartMatches with new pairs
  cs.smartMatches.matches = newPairs;

  // Update pass tracking
  cs.matchState.current_pass = nextPass;
  cs.matchState.passes_completed = currentPass;
  cs.matchState.pass_matched = 0;
  cs.matchState.pass_skipped = 0;

  // Rebuild task queue with new candidates
  cs.taskQueue = buildTaskQueue(cs);
  cs.passStartTotal = cs.taskQueue.length;

  appendAuditLog(cs, 'pass_advance', {
    from_pass: currentPass,
    to_pass: nextPass,
    criteria: criteria.name,
    listings_reconsidered: remainingVivaCodes.length,
    listings_with_candidates: newPairs.length
  });

  saveMatchState(cs);

  console.log(`  [${cs.compoundId}] Pass ${nextPass} ready: ${cs.taskQueue.length} listings to review\n`);
  return true;
}

/**
 * Check if current pass is complete and advance if needed.
 * Returns true if there are tasks available (either existing or from next pass).
 */
function checkAndAdvancePass(cs) {
  if (cs.taskQueue.length > 0) {
    return true; // Still have work in current pass
  }

  // Current pass complete - check if we should advance
  const skippedCount = cs.matchState.skipped.length;
  const matchedCount = cs.matchState.matches.length;
  const matchedVivaCodes = new Set(cs.matchState.matches.map(m => m.viva_code));
  const totalUnmatched = cs.vivaListings.filter(l => !matchedVivaCodes.has(l.code || l.propertyCode)).length;

  console.log(`\n  [${cs.compoundId}] Pass ${cs.matchState.current_pass} complete:`);
  console.log(`   Matched: ${matchedCount}`);
  console.log(`   Skipped: ${skippedCount}`);
  console.log(`   Total unmatched: ${totalUnmatched}`);

  if (totalUnmatched === 0) {
    console.log(`   All listings processed successfully!`);
    return false;
  }

  // Try to advance to next pass
  return advanceToNextPass(cs);
}

function saveMatchState(cs) {
  if (READ_ONLY) {
    console.log(`  [${cs.compoundId}] Read-only mode: not saving state`);
    return;
  }

  try {
    cs.matchState.last_updated = new Date().toISOString();
    cs.matchState.version++;

    // Recalculate stats -- use per-pass counters for consistent progress tracking
    const passMatched = cs.matchState.pass_matched || 0;
    const passSkipped = cs.matchState.pass_skipped || 0;
    const passCompleted = passMatched + passSkipped;
    const passTotal = passCompleted + cs.taskQueue.length;
    cs.matchState.stats = {
      total_viva_listings: passTotal,
      matched: passMatched,
      rejected: cs.matchState.rejected.length,
      skipped: passSkipped,
      pending: cs.taskQueue.length,
      in_progress: cs.matchState.in_progress.length
    };

    fs.writeFileSync(cs.manualMatchesFile, JSON.stringify(cs.matchState, null, 2));
    console.log(`  [${cs.compoundId}] Saved match state (version ${cs.matchState.version})`);

    // Debounced upload to GCS (at most once per 30s)
    uploadUserDecisions(cs.compoundId);
  } catch (error) {
    console.error(`  [${cs.compoundId}] Error saving match state: ${error.message}`);
  }
}

function appendAuditLog(cs, action, payload) {
  if (READ_ONLY) return;

  try {
    const logEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      session: SESSION_NAME,
      action,
      payload,
      hash: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').substring(0, 16)
    };

    fs.appendFileSync(cs.auditLogFile, JSON.stringify(logEntry) + '\n');
  } catch (error) {
    console.error(`  [${cs.compoundId}] Error writing audit log: ${error.message}`);
  }
}

function calculateDeltas(vivaListing, coelhoListing) {
  // Parse Brazilian price format: R$ 4.900.000,00 -> 4900000
  const parsePrice = (priceStr) => {
    if (!priceStr) return 0;
    // Remove R$, spaces, and convert comma to period, then remove periods used as thousands separators
    return parseFloat(String(priceStr).replace(/R\$\s*/g, '').replace(/\./g, '').replace(/,/g, '.'));
  };

  const vivaPrice = parsePrice(vivaListing.price);
  const coelhoPrice = parsePrice(coelhoListing.price);

  // Get area from viva listing (support multiple formats)
  const vivaArea = vivaListing.built ||
                   vivaListing.detailedData?.specs?.area_construida ||
                   vivaListing.specs?.area_construida ||
                   0;
  const coelhoArea = coelhoListing.built || 0;

  const priceDelta = vivaPrice && coelhoPrice ? ((coelhoPrice - vivaPrice) / vivaPrice * 100) : null;
  const areaDelta = vivaArea && coelhoArea ? ((coelhoArea - vivaArea) / vivaArea * 100) : null;

  return {
    price_viva: vivaPrice || null,
    price_coelho: coelhoPrice || null,
    price_delta_pct: priceDelta != null ? parseFloat(priceDelta.toFixed(2)) : null,
    area_viva: vivaArea || null,
    area_coelho: coelhoArea || null,
    area_delta_pct: areaDelta != null ? parseFloat(areaDelta.toFixed(2)) : null
  };
}

// ============================================================================
// GCS POLLING & RELOAD
// ============================================================================

const GCS_POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Reload pipeline-generated data (matches + listings) and rebuild task queue
 * for a specific compound.
 * Preserves user decisions (matchState.matches, .rejected, .skipped, etc).
 */
function reloadPipelineData(compoundId) {
  console.log(`[Reload] Reloading pipeline data for ${compoundId}...`);
  const cs = getCompoundState(compoundId);
  cs.smartMatches = loadSmartMatches(cs);
  cs.vivaListings = loadListings('vivaprimeimoveis', cs);
  cs.coelhoListings = loadListings('coelhodafonseca', cs);
  cs.taskQueue = buildTaskQueue(cs);
  cs.passStartTotal = cs.taskQueue.length;
  console.log(`[Reload] Done — ${cs.smartMatches.matches.length} match groups, ${cs.taskQueue.length} pending tasks`);
}

let _pollTimer = null;

function startPolling() {
  console.log(`[GCS] Polling for new pipeline data every ${GCS_POLL_INTERVAL_MS / 1000}s`);
  _pollTimer = setInterval(async () => {
    try {
      const updatedCompounds = await checkForNewPipelineData();
      for (const compoundId of updatedCompounds) {
        console.log(`[GCS] New pipeline data for ${compoundId} — syncing...`);
        await syncPipelineData(compoundId);
        reloadPipelineData(compoundId);
        console.log(`[GCS] New pipeline data for ${compoundId} loaded successfully`);
      }
    } catch (err) {
      console.error(`[GCS] Polling error: ${err.message}`);
    }
  }, GCS_POLL_INTERVAL_MS);
}

// ============================================================================
// NOTIFICATION HELPERS (compound-scoped)
// ============================================================================

function loadNotifications(cs) {
  try {
    if (fs.existsSync(cs.notificationsFile)) {
      return JSON.parse(fs.readFileSync(cs.notificationsFile, 'utf-8'));
    }
  } catch {
    // Corrupted file, start fresh
  }
  return { notifications: [] };
}

function saveNotifications(cs, data) {
  fs.writeFileSync(cs.notificationsFile, JSON.stringify(data, null, 2));
}

// ============================================================================
// HELPER FUNCTIONS (compound-scoped)
// ============================================================================

function getUnmatchedListings(cs) {
  const allVivaCodes = new Set();
  for (const item of cs.smartMatches.matches || []) {
    const vivaCode = item.viva?.code || item.viva?.propertyCode;
    if (vivaCode) allVivaCodes.add(vivaCode);
  }
  if (cs.matchState.skipped_previous_passes) {
    for (const passData of cs.matchState.skipped_previous_passes) {
      for (const skip of passData.skipped || []) {
        allVivaCodes.add(skip.viva_code);
      }
    }
  }
  for (const skip of cs.matchState.skipped || []) {
    allVivaCodes.add(skip.viva_code);
  }

  const matchedVivaCodes = new Set(cs.matchState.matches.map(m => m.viva_code));
  const unmatchedCodes = [...allVivaCodes].filter(code => !matchedVivaCodes.has(code));

  const vivaMap = new Map();
  for (const l of cs.vivaListings) {
    vivaMap.set(l.code || l.propertyCode, l);
  }

  return unmatchedCodes.map(code => {
    const listing = vivaMap.get(code);
    if (!listing) return { code, error: 'listing data not found' };
    return {
      code,
      price: listing.price,
      address: listing.address,
      url: listing.url,
      beds: listing.beds,
      suites: listing.suites,
      built: listing.built,
      park: listing.park,
      neighbourhood: listing.neighbourhood || listing.bairro
    };
  });
}

function generateEmailHTML(unmatchedListings, matchedCount) {
  const rows = unmatchedListings.map(listing => {
    const price = listing.price || '-';
    const address = listing.address || '-';
    const beds = listing.beds || '-';
    const built = listing.built ? `${listing.built}m\u00b2` : '-';
    const url = listing.url || '#';

    return `
      <tr style="border-bottom: 1px solid #e2e8f0;">
        <td style="padding: 12px 8px; font-size: 13px;">${listing.code}</td>
        <td style="padding: 12px 8px; font-size: 13px;">${address}</td>
        <td style="padding: 12px 8px; font-size: 13px;">${price}</td>
        <td style="padding: 12px 8px; font-size: 13px; text-align: center;">${beds}</td>
        <td style="padding: 12px 8px; font-size: 13px; text-align: center;">${built}</td>
        <td style="padding: 12px 8px; font-size: 13px;">
          <a href="${url}" style="color: #3b82f6; text-decoration: none;">View \u2192</a>
        </td>
      </tr>
    `;
  }).join('');

  return `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"></head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; background: #f8fafc;">
      <div style="background: white; border-radius: 12px; padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
        <h1 style="font-size: 24px; margin: 0 0 8px; color: #0f172a;">Property Matching Report</h1>
        <p style="color: #64748b; margin: 0 0 24px;">Generated on ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</p>

        <div style="display: flex; gap: 16px; margin-bottom: 24px;">
          <div style="flex: 1; background: #ecfdf5; padding: 16px; border-radius: 8px; text-align: center;">
            <div style="font-size: 28px; font-weight: 800; color: #059669;">${matchedCount}</div>
            <div style="font-size: 12px; color: #6b7280; text-transform: uppercase;">Matched</div>
          </div>
          <div style="flex: 1; background: #fef3c7; padding: 16px; border-radius: 8px; text-align: center;">
            <div style="font-size: 28px; font-weight: 800; color: #d97706;">${unmatchedListings.length}</div>
            <div style="font-size: 12px; color: #6b7280; text-transform: uppercase;">Unmatched</div>
          </div>
        </div>

        <h2 style="font-size: 18px; margin: 0 0 16px; color: #0f172a;">Unmatched Properties</h2>
        <table style="width: 100%; border-collapse: collapse;">
          <thead>
            <tr style="background: #f1f5f9;">
              <th style="padding: 10px 8px; text-align: left; font-size: 12px; color: #64748b; text-transform: uppercase;">Code</th>
              <th style="padding: 10px 8px; text-align: left; font-size: 12px; color: #64748b; text-transform: uppercase;">Address</th>
              <th style="padding: 10px 8px; text-align: left; font-size: 12px; color: #64748b; text-transform: uppercase;">Price</th>
              <th style="padding: 10px 8px; text-align: center; font-size: 12px; color: #64748b; text-transform: uppercase;">Beds</th>
              <th style="padding: 10px 8px; text-align: center; font-size: 12px; color: #64748b; text-transform: uppercase;">Area</th>
              <th style="padding: 10px 8px; text-align: left; font-size: 12px; color: #64748b; text-transform: uppercase;">Link</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>

        <p style="margin-top: 24px; font-size: 12px; color: #94a3b8; text-align: center;">
          Generated by Property Matcher
        </p>
      </div>
    </body>
    </html>
  `;
}

function getLocalIP() {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();

  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      // Skip internal (i.e. 127.0.0.1) and non-IPv4 addresses
      const familyV4Value = typeof net.family === 'string' ? 'IPv4' : 4;
      if (net.family === familyV4Value && !net.internal) {
        return net.address;
      }
    }
  }

  return 'localhost';
}

// ============================================================================
// EXPRESS APP
// ============================================================================

const app = express();

const defaultCompound = COMPOUNDS_CONFIG.defaultCompound;

app.use(cors());
app.use(express.json({ type: ['application/json', 'application/json; charset=utf-8', 'application/json; charset=UTF-8'] }));
app.use(express.static(PUBLIC_ROOT));

// Serve mosaics per compound
app.use('/mosaics/:compoundId', (req, res, next) => {
  const { compoundId } = req.params;
  const cs = compoundStates.get(compoundId);
  if (!cs) return res.status(404).send('Not found');
  express.static(cs.mosaicsDir)(req, res, next);
});

// Legacy mosaic serving (default compound)
app.use('/mosaics', express.static(path.join(DATA_ROOT, defaultCompound, 'mosaics')));

// Cloud Run service URL opens "/" by default; route it to the matcher UI entrypoint.
app.get('/', (req, res) => {
  res.redirect('/matcher.html');
});

// ============================================================================
// COMPOUND RESOLUTION MIDDLEWARE
// ============================================================================

function resolveCompound(req, res, next) {
  const { compoundId } = req.params;
  if (!COMPOUNDS_CONFIG.compounds[compoundId]) {
    return res.status(404).json({ error: `Unknown compound: ${compoundId}` });
  }
  req.cs = getCompoundState(compoundId);
  req.compoundId = compoundId;
  next();
}

// ============================================================================
// COMPOUND LISTING ENDPOINT
// ============================================================================

app.get('/api/compounds', (req, res) => {
  const compounds = Object.entries(COMPOUNDS_CONFIG.compounds).map(([id, config]) => {
    const cs = compoundStates.get(id);
    const stats = cs ? {
      matched: cs.matchState.matches.length,
      pending: cs.taskQueue.length,
      total: cs.matchState.stats.total_viva_listings
    } : null;
    return { id, displayName: config.displayName, stats };
  });
  res.json({ compounds, defaultCompound: COMPOUNDS_CONFIG.defaultCompound });
});

// ============================================================================
// COMPOUND-SCOPED ROUTE HANDLERS (named functions)
// ============================================================================

function handleSession(req, res) {
  const cs = req.cs;
  const criteria = getPassCriteria(cs.matchState.current_pass);

  // Check for unread pipeline_complete notifications
  let has_new_properties = false;
  try {
    const notifData = loadNotifications(cs);
    has_new_properties = notifData.notifications.some(n => n.type === 'pipeline_complete' && !n.read);
  } catch {
    // Ignore notification errors in session endpoint
  }

  res.json({
    session_name: cs.matchState.session_name,
    session_started: cs.matchState.session_started,
    last_updated: cs.matchState.last_updated,
    version: cs.matchState.version,
    stats: cs.matchState.stats,
    read_only: READ_ONLY,
    current_pass: cs.matchState.current_pass,
    passes_completed: cs.matchState.passes_completed,
    max_passes: MAX_PASSES,
    pass_criteria: {
      name: criteria.name,
      price_tolerance: `\u00b1${(criteria.price_tolerance * 100).toFixed(0)}%`,
      area_tolerance: `\u00b1${(criteria.area_tolerance * 100).toFixed(0)}%`
    },
    has_new_properties,
  });
}

function handleListing(req, res) {
  const cs = req.cs;
  const vivaCode = req.params.id;
  const task = cs.taskQueue.find(t => t.viva_code === vivaCode);

  if (!task) {
    return res.status(404).json({ error: 'Listing not found or already processed' });
  }

  res.json({
    viva_code: task.viva_code,
    viva: task.viva,
    remaining_candidates: task.remaining_candidates,
    mosaic_path: `/mosaics/${cs.compoundId}/viva/${vivaCode}.png`
  });
}

function handleCandidates(req, res) {
  const cs = req.cs;
  const vivaCode = req.params.id;
  const task = cs.taskQueue.find(t => t.viva_code === vivaCode);

  if (!task) {
    return res.status(404).json({ error: 'Listing not found' });
  }

  // Filter out already rejected candidates AND already matched Coelho codes
  const rejectedCodes = cs.matchState.rejected
    .filter(r => r.viva_code === vivaCode)
    .map(r => r.coelho_code);

  const matchedCoelhoCodes = new Set(cs.matchState.matches.map(m => m.coelho_code));

  const candidates = task.candidates
    .filter(c => {
      const code = c.code || c.propertyCode;
      return !rejectedCodes.includes(code) && !matchedCoelhoCodes.has(code);
    })
    .map((candidate, idx) => {
      const code = candidate.code || candidate.propertyCode;
      const scored = task.scored.find(s => s.code === code);

      // Transform candidate data to include features string for frontend parsing
      const transformedCandidate = {
        ...candidate,
        features: `${candidate.built || 0}m\u00b2 constru\u00edda, ${candidate.beds || 0} dorm, ${candidate.suites || 0} su\u00edte`
      };

      return {
        code,
        candidate: transformedCandidate,
        ai_score: scored?.score || null,
        deltas: calculateDeltas(task.viva, candidate),
        mosaic_path: `/mosaics/${cs.compoundId}/coelho/${code}.png`
      };
    });

  res.json({
    viva_code: vivaCode,
    candidates,
    total_candidates: candidates.length
  });
}

function handleNext(req, res) {
  const cs = req.cs;
  const reviewer = req.query.reviewer || 'anonymous';

  // If user has finished, return done
  if (cs.matchState.user_finished) {
    return res.json({
      done: true,
      message: `Matching complete! ${cs.matchState.matches.length} total matches found.`,
      final_stats: {
        total_matches: cs.matchState.matches.length,
        total_skipped: cs.matchState.skipped.length,
        passes_completed: cs.matchState.current_pass
      }
    });
  }

  // Check if current pass is exhausted
  if (cs.taskQueue.length === 0) {
    const skippedCount = cs.matchState.skipped.length;
    const currentCriteria = getPassCriteria(cs.matchState.current_pass);
    const nextPassNum = cs.matchState.current_pass + 1;

    // Count orphan Viva listings (never had candidates in any pass)
    const matchedVivaCodes = new Set(cs.matchState.matches.map(m => m.viva_code));
    const skippedVivaCodes = new Set(cs.matchState.skipped.map(s => s.viva_code));
    const orphanCount = cs.vivaListings.filter(l => {
      const code = l.code || l.propertyCode;
      return !matchedVivaCodes.has(code) && !skippedVivaCodes.has(code);
    }).length;

    const unmatchedCount = skippedCount + orphanCount;
    const hasNextPass = nextPassNum <= MAX_PASSES && unmatchedCount > 0;
    const nextCriteria = hasNextPass ? getPassCriteria(nextPassNum) : null;

    return res.json({
      pass_complete: true,
      current_pass: cs.matchState.current_pass,
      pass_name: currentCriteria.name,
      stats: {
        matched: cs.matchState.matches.length,
        skipped: skippedCount,
        orphans: orphanCount,
        total_reviewed: cs.matchState.matches.length + skippedCount
      },
      has_next_pass: hasNextPass,
      next_pass: hasNextPass ? {
        number: nextPassNum,
        name: nextCriteria.name,
        price_tolerance: `\u00b1${(nextCriteria.price_tolerance * 100).toFixed(0)}%`,
        area_tolerance: `\u00b1${(nextCriteria.area_tolerance * 100).toFixed(0)}%`,
        listings_to_review: unmatchedCount
      } : null
    });
  }

  // Clean up stale locks (older than LOCK_TIMEOUT_MS)
  const now = Date.now();
  const staleBefore = cs.matchState.in_progress.length;
  cs.matchState.in_progress = cs.matchState.in_progress.filter(ip => {
    const lockTime = new Date(ip.last_active || ip.started_at).getTime();
    return (now - lockTime) < LOCK_TIMEOUT_MS;
  });
  if (cs.matchState.in_progress.length < staleBefore) {
    console.log(`  [${cs.compoundId}] Cleaned up ${staleBefore - cs.matchState.in_progress.length} stale lock(s)`);
  }

  // Find first listing not in progress by another reviewer
  const available = cs.taskQueue.find(t => {
    const inProgress = cs.matchState.in_progress.find(ip => ip.viva_code === t.viva_code);
    return !inProgress || inProgress.reviewer === reviewer;
  });

  if (!available) {
    return res.json({ done: true, message: 'All listings reviewed!' });
  }

  // Mark as in progress
  const existingIdx = cs.matchState.in_progress.findIndex(ip => ip.viva_code === available.viva_code);
  if (existingIdx >= 0) {
    cs.matchState.in_progress[existingIdx].last_active = new Date().toISOString();
  } else {
    cs.matchState.in_progress.push({
      viva_code: available.viva_code,
      reviewer,
      started_at: new Date().toISOString(),
      last_active: new Date().toISOString()
    });
  }

  // Transform viva data to match frontend expectations
  const viva = available.viva;
  const transformedViva = {
    ...viva,
    specs: {
      area_construida: viva.built,
      dormitorios: viva.beds,
      suites: viva.suites
    }
  };

  const currentCriteria = getPassCriteria(cs.matchState.current_pass);
  res.json({
    viva_code: available.viva_code,
    viva: transformedViva,
    remaining_candidates: available.remaining_candidates,
    mosaic_path: `/mosaics/${cs.compoundId}/viva/${available.viva_code}.png`,
    current_pass: cs.matchState.current_pass,
    pass_name: currentCriteria.name,
    pending_in_pass: cs.taskQueue.length
  });
}

function handleMatch(req, res) {
  const cs = req.cs;

  if (READ_ONLY) {
    return res.status(403).json({ error: 'Read-only mode enabled' });
  }

  const { viva_code, coelho_code, reviewer, time_spent_sec, notes } = req.body;

  if (!viva_code || !coelho_code) {
    return res.status(400).json({ error: 'Missing viva_code or coelho_code' });
  }

  // Find task
  const task = cs.taskQueue.find(t => t.viva_code === viva_code);
  if (!task) {
    return res.status(404).json({ error: 'Listing not found' });
  }

  const scored = task.scored.find(s => s.code === coelho_code);

  const match = {
    viva_code,
    coelho_code,
    matched_at: new Date().toISOString(),
    reviewer: reviewer || 'anonymous',
    time_spent_sec: time_spent_sec || null,
    ai_score: scored?.score || null,
    confidence: 'manual_confirmed',
    notes: notes || null
  };

  cs.matchState.matches.push(match);
  cs.matchState.pass_matched = (cs.matchState.pass_matched || 0) + 1;

  // Remove from in_progress
  cs.matchState.in_progress = cs.matchState.in_progress.filter(ip => ip.viva_code !== viva_code);

  // Remove from task queue
  const taskIdx = cs.taskQueue.findIndex(t => t.viva_code === viva_code);
  if (taskIdx >= 0) cs.taskQueue.splice(taskIdx, 1);

  appendAuditLog(cs, 'match', match);
  saveMatchState(cs);

  res.json({ success: true, match, remaining: cs.taskQueue.length });
}

function handleReject(req, res) {
  const cs = req.cs;

  if (READ_ONLY) {
    return res.status(403).json({ error: 'Read-only mode enabled' });
  }

  const { viva_code, coelho_code, reviewer, reason } = req.body;

  if (!viva_code || !coelho_code) {
    return res.status(400).json({ error: 'Missing viva_code or coelho_code' });
  }

  const rejection = {
    viva_code,
    coelho_code,
    rejected_at: new Date().toISOString(),
    reviewer: reviewer || 'anonymous',
    reason: reason || 'visual_mismatch'
  };

  cs.matchState.rejected.push(rejection);
  appendAuditLog(cs, 'reject', rejection);
  saveMatchState(cs);

  // Rebuild task queue to update remaining candidates
  cs.taskQueue = buildTaskQueue(cs);

  res.json({ success: true, rejection, remaining: cs.taskQueue.length });
}

function handleSkip(req, res) {
  const cs = req.cs;

  if (READ_ONLY) {
    return res.status(403).json({ error: 'Read-only mode enabled' });
  }

  const { viva_code, reviewer, reason } = req.body;

  if (!viva_code) {
    return res.status(400).json({ error: 'Missing viva_code' });
  }

  const skip = {
    viva_code,
    skipped_at: new Date().toISOString(),
    reviewer: reviewer || 'anonymous',
    reason: reason || 'no_good_candidates'
  };

  cs.matchState.skipped.push(skip);
  cs.matchState.pass_skipped = (cs.matchState.pass_skipped || 0) + 1;
  cs.matchState.in_progress = cs.matchState.in_progress.filter(ip => ip.viva_code !== viva_code);

  // Remove from task queue
  const taskIdx = cs.taskQueue.findIndex(t => t.viva_code === viva_code);
  if (taskIdx >= 0) cs.taskQueue.splice(taskIdx, 1);

  appendAuditLog(cs, 'skip', skip);
  saveMatchState(cs);

  res.json({ success: true, skip, remaining: cs.taskQueue.length });
}

function handleProgress(req, res) {
  const cs = req.cs;

  // Use per-pass counters for progress so percentages are scoped to the current pass
  const passMatched = cs.matchState.pass_matched || 0;
  const passSkipped = cs.matchState.pass_skipped || 0;
  const passCompleted = passMatched + passSkipped;
  const passTotal = passCompleted + cs.taskQueue.length;
  const progress_pct = passTotal > 0 ? ((passCompleted / passTotal) * 100).toFixed(1) : 0;

  const currentCriteria = getPassCriteria(cs.matchState.current_pass);
  res.json({
    total_viva_listings: passTotal,
    matched: passMatched,
    skipped: passSkipped,
    pending: cs.taskQueue.length,
    in_progress: cs.matchState.in_progress.length,
    completed: passCompleted,
    progress_pct: parseFloat(progress_pct),
    // Cumulative stats across all passes for overall context
    cumulative_matched: cs.matchState.matches.length,
    cumulative_skipped: cs.matchState.skipped.length + (cs.matchState.skipped_previous_passes || []).reduce((sum, p) => sum + p.skipped.length, 0),
    current_pass: cs.matchState.current_pass,
    max_passes: MAX_PASSES,
    pass_name: currentCriteria.name,
    pass_criteria: {
      price_tolerance: `\u00b1${(currentCriteria.price_tolerance * 100).toFixed(0)}%`,
      area_tolerance: `\u00b1${(currentCriteria.area_tolerance * 100).toFixed(0)}%`
    }
  });
}

function handleUndo(req, res) {
  const cs = req.cs;

  if (READ_ONLY) {
    return res.status(403).json({ error: 'Read-only mode enabled' });
  }

  const { reviewer } = req.body;
  const reviewerName = reviewer || 'anonymous';

  // Find last action by this reviewer
  let undone = null;

  // Check matches (most recent first)
  for (let i = cs.matchState.matches.length - 1; i >= 0; i--) {
    if (cs.matchState.matches[i].reviewer === reviewerName) {
      undone = { type: 'match', ...cs.matchState.matches[i] };
      cs.matchState.matches.splice(i, 1);
      break;
    }
  }

  // If not found, check skips
  if (!undone) {
    for (let i = cs.matchState.skipped.length - 1; i >= 0; i--) {
      if (cs.matchState.skipped[i].reviewer === reviewerName) {
        undone = { type: 'skip', ...cs.matchState.skipped[i] };
        cs.matchState.skipped.splice(i, 1);
        break;
      }
    }
  }

  if (!undone) {
    return res.status(404).json({ error: 'No recent actions to undo' });
  }

  // Decrement per-pass counters
  if (undone.type === 'match') {
    cs.matchState.pass_matched = Math.max(0, (cs.matchState.pass_matched || 0) - 1);
  } else if (undone.type === 'skip') {
    cs.matchState.pass_skipped = Math.max(0, (cs.matchState.pass_skipped || 0) - 1);
  }

  appendAuditLog(cs, 'undo', { undone, reviewer: reviewerName });

  // Rebuild task queue
  cs.taskQueue = buildTaskQueue(cs);
  saveMatchState(cs);

  res.json({ success: true, undone, remaining: cs.taskQueue.length });
}

function handleAudit(req, res) {
  const cs = req.cs;

  try {
    if (!fs.existsSync(cs.auditLogFile)) {
      return res.json({ entries: [] });
    }

    const lines = fs.readFileSync(cs.auditLogFile, 'utf-8').trim().split('\n');
    const entries = lines.filter(Boolean).map(line => JSON.parse(line));

    res.json({ entries, total: entries.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

function handlePassAdvance(req, res) {
  const cs = req.cs;

  if (READ_ONLY) {
    return res.status(403).json({ error: 'Read-only mode enabled' });
  }

  const advanced = advanceToNextPass(cs);

  if (!advanced) {
    return res.json({
      success: false,
      message: 'Cannot advance to next pass',
      current_pass: cs.matchState.current_pass
    });
  }

  const criteria = getPassCriteria(cs.matchState.current_pass);
  res.json({
    success: true,
    current_pass: cs.matchState.current_pass,
    pass_name: criteria.name,
    pending: cs.taskQueue.length
  });
}

function handlePassFinish(req, res) {
  const cs = req.cs;

  if (READ_ONLY) {
    return res.status(403).json({ error: 'Read-only mode enabled' });
  }

  cs.matchState.user_finished = true;

  appendAuditLog(cs, 'user_finished', {
    total_matches: cs.matchState.matches.length,
    total_skipped: cs.matchState.skipped.length,
    passes_completed: cs.matchState.current_pass,
    reviewer: req.body.reviewer || 'anonymous'
  });

  saveMatchState(cs);

  const unmatchedListings = getUnmatchedListings(cs);

  res.json({
    success: true,
    summary: {
      total_matches: cs.matchState.matches.length,
      total_skipped: cs.matchState.skipped.length,
      total_unmatched: unmatchedListings.length,
      passes_completed: cs.matchState.current_pass
    }
  });
}

function handlePassResume(req, res) {
  const cs = req.cs;

  if (READ_ONLY) {
    return res.status(403).json({ error: 'Read-only mode enabled' });
  }

  if (!cs.matchState.user_finished) {
    return res.json({ success: true, message: 'Already active — not in finished state' });
  }

  cs.matchState.user_finished = false;

  appendAuditLog(cs, 'user_resumed', {
    reviewer: req.body.reviewer || 'anonymous',
    current_pass: cs.matchState.current_pass
  });

  // Rebuild task queue in case it was cleared
  cs.taskQueue = buildTaskQueue(cs);
  cs.passStartTotal = cs.taskQueue.length;

  saveMatchState(cs);

  res.json({
    success: true,
    message: 'Resumed matching session',
    pending: cs.taskQueue.length,
    current_pass: cs.matchState.current_pass
  });
}

function handleReportSend(req, res) {
  const cs = req.cs;
  const reportEmail = req.body.to || process.env.REPORT_EMAIL;

  if (!reportEmail || !reportEmail.includes('@')) {
    return res.status(400).json({ error: 'No recipient email configured' });
  }

  (async () => {
    try {
      const unmatchedListings = getUnmatchedListings(cs);
      const htmlContent = generateEmailHTML(unmatchedListings, cs.matchState.matches.length);
      const nodemailer = require('nodemailer');

      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: parseInt(process.env.SMTP_PORT || '587'),
        secure: false,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      });

      await transporter.sendMail({
        from: process.env.SMTP_USER,
        to: reportEmail,
        subject: `Property Matching Report - ${cs.matchState.matches.length} matched, ${unmatchedListings.length} unmatched`,
        html: htmlContent,
      });

      appendAuditLog(cs, 'report_sent', { to: reportEmail, unmatched_count: unmatchedListings.length });
      console.log(`  [${cs.compoundId}] Report sent to ${reportEmail}`);

      res.json({ success: true, sent_to: reportEmail, unmatched_count: unmatchedListings.length });
    } catch (err) {
      console.error(`  [${cs.compoundId}] Failed to send report email: ${err.message}`);
      res.status(500).json({ error: `Failed to send email: ${err.message}` });
    }
  })();
}

function handlePipelineTrigger(req, res) {
  const cs = req.cs;

  try {
    const data = loadNotifications(cs);

    const notification = {
      id: crypto.randomUUID(),
      type: 'pipeline_trigger',
      message: 'Pipeline run requested',
      data: { requested_at: new Date().toISOString() },
      created_at: new Date().toISOString(),
      read: false,
    };

    data.notifications.push(notification);
    saveNotifications(cs, data);

    res.json({ triggered: true, message: 'Pipeline trigger recorded' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

function handlePipelineComplete(req, res) {
  const cs = req.cs;

  try {
    const { new_viva = 0, new_coelho = 0, timestamp } = req.body;
    const data = loadNotifications(cs);

    const notification = {
      id: crypto.randomUUID(),
      type: 'pipeline_complete',
      message: `New properties available! ${new_viva} Viva, ${new_coelho} Coelho listings scraped`,
      data: { new_viva, new_coelho, timestamp: timestamp || new Date().toISOString() },
      created_at: new Date().toISOString(),
      read: false,
    };

    data.notifications.push(notification);
    saveNotifications(cs, data);

    console.log(`[${cs.compoundId}] Pipeline complete notification: ${notification.message}`);
    res.json({ success: true, notification_id: notification.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

function handleNotifications(req, res) {
  const cs = req.cs;

  try {
    const data = loadNotifications(cs);
    const unread = data.notifications.filter(n => !n.read);

    res.json({
      notifications: unread,
      unread_count: unread.length,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

function handleNotificationsDismiss(req, res) {
  const cs = req.cs;

  try {
    const { id, all } = req.body;
    const data = loadNotifications(cs);

    if (all) {
      data.notifications.forEach(n => { n.read = true; });
    } else if (id) {
      const notification = data.notifications.find(n => n.id === id);
      if (notification) {
        notification.read = true;
      } else {
        return res.status(404).json({ error: 'Notification not found' });
      }
    } else {
      return res.status(400).json({ error: 'Must provide id or all: true' });
    }

    saveNotifications(cs, data);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

function handleMatchesValidate(req, res) {
  const cs = req.cs;

  const valid = [];
  const invalid = [];
  const duplicates = [];

  // Build lookup sets
  const vivaCodeSet = new Set(cs.vivaListings.map(l => l.code || l.propertyCode));
  const coelhoCodeSet = new Set(cs.coelhoListings.map(l => l.code || l.propertyCode));

  // Track duplicates
  const vivaMatchCount = {};
  const coelhoMatchCount = {};

  for (const match of cs.matchState.matches) {
    // Check validity
    const vivaExists = vivaCodeSet.has(match.viva_code);
    const coelhoExists = coelhoCodeSet.has(match.coelho_code);

    if (!vivaExists) {
      invalid.push({ match, reason: `viva_code '${match.viva_code}' not found in listings` });
    } else if (!coelhoExists) {
      invalid.push({ match, reason: `coelho_code '${match.coelho_code}' not found in listings` });
    } else {
      valid.push(match);
    }

    // Track for duplicate detection
    vivaMatchCount[match.viva_code] = (vivaMatchCount[match.viva_code] || 0) + 1;
    coelhoMatchCount[match.coelho_code] = (coelhoMatchCount[match.coelho_code] || 0) + 1;
  }

  // Find duplicates
  for (const [code, count] of Object.entries(vivaMatchCount)) {
    if (count > 1) {
      duplicates.push({
        code,
        type: 'viva',
        matches: cs.matchState.matches.filter(m => m.viva_code === code)
      });
    }
  }
  for (const [code, count] of Object.entries(coelhoMatchCount)) {
    if (count > 1) {
      duplicates.push({
        code,
        type: 'coelho',
        matches: cs.matchState.matches.filter(m => m.coelho_code === code)
      });
    }
  }

  res.json({
    valid,
    invalid,
    duplicates,
    summary: {
      total: cs.matchState.matches.length,
      valid_count: valid.length,
      invalid_count: invalid.length,
      duplicate_count: duplicates.length
    }
  });
}

function handleMatchesExport(req, res) {
  const cs = req.cs;

  // Build lookup maps
  const vivaMap = new Map();
  for (const l of cs.vivaListings) {
    vivaMap.set(l.code || l.propertyCode, l);
  }
  const coelhoMap = new Map();
  for (const l of cs.coelhoListings) {
    coelhoMap.set(l.code || l.propertyCode, l);
  }

  const enrichedMatches = cs.matchState.matches.map(match => {
    const vivaListing = vivaMap.get(match.viva_code);
    const coelhoListing = coelhoMap.get(match.coelho_code);

    return {
      viva: vivaListing ? {
        code: match.viva_code,
        price: vivaListing.price,
        address: vivaListing.address,
        url: vivaListing.url,
        beds: vivaListing.beds,
        suites: vivaListing.suites,
        built: vivaListing.built,
        park: vivaListing.park
      } : { code: match.viva_code, error: 'listing not found' },
      coelho: coelhoListing ? {
        code: match.coelho_code,
        price: coelhoListing.price,
        address: coelhoListing.address,
        url: coelhoListing.url,
        beds: coelhoListing.beds,
        suites: coelhoListing.suites,
        built: coelhoListing.built,
        park: coelhoListing.park
      } : { code: match.coelho_code, error: 'listing not found' },
      matched_at: match.matched_at,
      reviewer: match.reviewer,
      ai_score: match.ai_score,
      confidence: match.confidence
    };
  });

  res.json({
    exported_at: new Date().toISOString(),
    total_matches: enrichedMatches.length,
    matches: enrichedMatches
  });
}

function handleReportUnmatched(req, res) {
  const cs = req.cs;

  // Get all viva codes that were in the candidate pool
  const allVivaCodes = new Set();
  for (const item of cs.smartMatches.matches || []) {
    const vivaCode = item.viva?.code || item.viva?.propertyCode;
    if (vivaCode) allVivaCodes.add(vivaCode);
  }

  // Also include viva codes from skipped_previous_passes
  if (cs.matchState.skipped_previous_passes) {
    for (const passData of cs.matchState.skipped_previous_passes) {
      for (const skip of passData.skipped || []) {
        allVivaCodes.add(skip.viva_code);
      }
    }
  }
  for (const skip of cs.matchState.skipped || []) {
    allVivaCodes.add(skip.viva_code);
  }

  // Get matched viva codes
  const matchedVivaCodes = new Set(cs.matchState.matches.map(m => m.viva_code));

  // Find unmatched
  const unmatchedCodes = [...allVivaCodes].filter(code => !matchedVivaCodes.has(code));

  // Build lookup map from vivaListings
  const vivaMap = new Map();
  for (const l of cs.vivaListings) {
    vivaMap.set(l.code || l.propertyCode, l);
  }

  const unmatchedListings = unmatchedCodes.map(code => {
    const listing = vivaMap.get(code);
    if (!listing) {
      return { code, error: 'listing data not found' };
    }
    return {
      code,
      price: listing.price,
      address: listing.address,
      url: listing.url,
      beds: listing.beds,
      suites: listing.suites,
      built: listing.built,
      park: listing.park,
      neighbourhood: listing.neighbourhood || listing.bairro
    };
  });

  res.json({
    total_viva: allVivaCodes.size,
    total_matched: matchedVivaCodes.size,
    total_unmatched: unmatchedListings.length,
    listings: unmatchedListings
  });
}

function handleReportSendEmail(req, res) {
  const cs = req.cs;
  const { to } = req.body;

  if (!to || !to.includes('@')) {
    return res.status(400).json({ error: 'Valid email address required' });
  }

  (async () => {
    try {
      // Get unmatched data
      const allVivaCodes = new Set();
      for (const item of cs.smartMatches.matches || []) {
        const vivaCode = item.viva?.code || item.viva?.propertyCode;
        if (vivaCode) allVivaCodes.add(vivaCode);
      }
      if (cs.matchState.skipped_previous_passes) {
        for (const passData of cs.matchState.skipped_previous_passes) {
          for (const skip of passData.skipped || []) {
            allVivaCodes.add(skip.viva_code);
          }
        }
      }
      for (const skip of cs.matchState.skipped || []) {
        allVivaCodes.add(skip.viva_code);
      }

      const matchedVivaCodes = new Set(cs.matchState.matches.map(m => m.viva_code));
      const unmatchedCodes = [...allVivaCodes].filter(code => !matchedVivaCodes.has(code));

      const vivaMap = new Map();
      for (const l of cs.vivaListings) {
        vivaMap.set(l.code || l.propertyCode, l);
      }

      const unmatchedListings = unmatchedCodes.map(code => {
        const listing = vivaMap.get(code);
        return listing ? { code, ...listing } : { code };
      });

      // Try to load nodemailer
      let nodemailer;
      try {
        nodemailer = require('nodemailer');
      } catch {
        return res.status(500).json({
          error: 'nodemailer not installed. Run: npm install nodemailer',
          fallback: 'Use GET /api/report/unmatched to get the data as JSON'
        });
      }

      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: parseInt(process.env.SMTP_PORT || '587'),
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      });

      const htmlContent = generateEmailHTML(unmatchedListings, cs.matchState.matches.length);

      await transporter.sendMail({
        from: process.env.REPORT_FROM_EMAIL || process.env.SMTP_USER,
        to,
        subject: `Property Matching Report - ${cs.matchState.matches.length} matched, ${unmatchedListings.length} unmatched`,
        html: htmlContent,
      });

      appendAuditLog(cs, 'report_sent', { to, unmatched_count: unmatchedListings.length });

      res.json({ success: true, message: `Report sent to ${to}` });
    } catch (error) {
      console.error('Email error:', error);
      res.status(500).json({ error: `Failed to send email: ${error.message}` });
    }
  })();
}

// ============================================================================
// COMPOUND-SCOPED ROUTER
// ============================================================================

const compoundRouter = express.Router({ mergeParams: true });
compoundRouter.use(resolveCompound);

compoundRouter.get('/session', handleSession);
compoundRouter.get('/listing/:id', handleListing);
compoundRouter.get('/candidates/:id', handleCandidates);
compoundRouter.get('/next', handleNext);
compoundRouter.post('/match', handleMatch);
compoundRouter.post('/reject', handleReject);
compoundRouter.post('/skip', handleSkip);
compoundRouter.get('/progress', handleProgress);
compoundRouter.post('/undo', handleUndo);
compoundRouter.get('/audit', handleAudit);
compoundRouter.post('/pass/advance', handlePassAdvance);
compoundRouter.post('/pass/finish', handlePassFinish);
compoundRouter.post('/pass/resume', handlePassResume);
compoundRouter.post('/report/send', handleReportSend);
compoundRouter.get('/report/unmatched', handleReportUnmatched);
compoundRouter.post('/report/send-email', handleReportSendEmail);
compoundRouter.get('/matches/validate', handleMatchesValidate);
compoundRouter.get('/matches/export', handleMatchesExport);
compoundRouter.post('/pipeline/trigger', handlePipelineTrigger);
compoundRouter.post('/pipeline/complete', handlePipelineComplete);
compoundRouter.get('/notifications', handleNotifications);
compoundRouter.post('/notifications/dismiss', handleNotificationsDismiss);

app.use('/api/compounds/:compoundId', compoundRouter);

// ============================================================================
// LEGACY ROUTES (backward compatibility - forward to default compound)
// ============================================================================

function withDefaultCompound(handler) {
  return (req, res) => {
    req.params = req.params || {};
    req.params.compoundId = defaultCompound;
    resolveCompound(req, res, () => handler(req, res));
  };
}

// GET endpoints
app.get('/api/session', withDefaultCompound(handleSession));
app.get('/api/listing/:id', (req, res) => {
  const id = req.params.id;
  req.params.compoundId = defaultCompound;
  req.params.id = id;
  resolveCompound(req, res, () => handleListing(req, res));
});
app.get('/api/candidates/:id', (req, res) => {
  const id = req.params.id;
  req.params.compoundId = defaultCompound;
  req.params.id = id;
  resolveCompound(req, res, () => handleCandidates(req, res));
});
app.get('/api/next', withDefaultCompound(handleNext));
app.get('/api/progress', withDefaultCompound(handleProgress));
app.get('/api/audit', withDefaultCompound(handleAudit));
app.get('/api/report/unmatched', withDefaultCompound(handleReportUnmatched));
app.get('/api/matches/validate', withDefaultCompound(handleMatchesValidate));
app.get('/api/matches/export', withDefaultCompound(handleMatchesExport));
app.get('/api/notifications', withDefaultCompound(handleNotifications));

// POST endpoints
app.post('/api/match', withDefaultCompound(handleMatch));
app.post('/api/reject', withDefaultCompound(handleReject));
app.post('/api/skip', withDefaultCompound(handleSkip));
app.post('/api/undo', withDefaultCompound(handleUndo));
app.post('/api/pass/advance', withDefaultCompound(handlePassAdvance));
app.post('/api/pass/finish', withDefaultCompound(handlePassFinish));
app.post('/api/pass/resume', withDefaultCompound(handlePassResume));
app.post('/api/report/send', withDefaultCompound(handleReportSend));
app.post('/api/report/send-email', withDefaultCompound(handleReportSendEmail));
app.post('/api/pipeline/trigger', withDefaultCompound(handlePipelineTrigger));
app.post('/api/pipeline/complete', withDefaultCompound(handlePipelineComplete));
app.post('/api/notifications/dismiss', withDefaultCompound(handleNotificationsDismiss));

// ============================================================================
// SERVER STARTUP
// ============================================================================

async function start() {
  console.log('\n Human-in-the-Loop Matching Server');
  console.log('=====================================\n');
  console.log(`Session: ${SESSION_NAME}`);
  console.log(`Data root: ${DATA_ROOT}`);
  console.log(`Public root: ${PUBLIC_ROOT}`);
  console.log(`Port: ${PORT}`);
  console.log(`Host: ${HOST}`);
  console.log(`Read-only: ${READ_ONLY ? 'YES' : 'NO'}`);
  console.log(`Compounds: ${Object.keys(COMPOUNDS_CONFIG.compounds).join(', ')}`);
  console.log(`Default compound: ${defaultCompound}\n`);

  // Step 1: Download data from GCS (graceful — server starts even if GCS fails)
  try {
    await syncAllFromGCS();
  } catch (err) {
    console.warn(`GCS sync failed (${err.message}) — starting with local data`);
  }

  // Step 2: Initialize all compounds
  for (const compoundId of Object.keys(COMPOUNDS_CONFIG.compounds)) {
    console.log(`\nInitializing compound: ${compoundId}`);
    const cs = getCompoundState(compoundId);

    // Ensure data directories exist
    fs.mkdirSync(path.join(cs.dataRoot, 'mosaics', 'viva'), { recursive: true });
    fs.mkdirSync(path.join(cs.dataRoot, 'mosaics', 'coelho'), { recursive: true });
    fs.mkdirSync(path.join(cs.dataRoot, 'listings'), { recursive: true });

    cs.smartMatches = loadSmartMatches(cs);
    cs.matchState = loadManualMatches(cs);
    cs.vivaListings = loadListings('vivaprimeimoveis', cs);
    cs.coelhoListings = loadListings('coelhodafonseca', cs);

    if (cs.vivaListings.length > 0 && cs.coelhoListings.length > 0) {
      console.log(`  [${compoundId}] Loaded ${cs.vivaListings.length} Viva and ${cs.coelhoListings.length} Coelho listings for dynamic matching`);
    }

    cs.taskQueue = buildTaskQueue(cs);
    cs.passStartTotal = cs.taskQueue.length;

    // Log current pass info
    const currentCriteria = getPassCriteria(cs.matchState.current_pass);
    console.log(`  [${compoundId}] Current Pass: ${cs.matchState.current_pass} (${currentCriteria.name})`);
    console.log(`  [${compoundId}] ${cs.smartMatches.matches.length} match groups, ${cs.taskQueue.length} pending tasks`);
  }

  // Step 3: Start Express server
  app.listen(PORT, HOST, () => {
    const networkIP = getLocalIP();

    console.log(`\nServer running on:`);
    console.log(`   Local:    http://localhost:${PORT}`);
    if (networkIP !== 'localhost') {
      console.log(`   Network:  http://${networkIP}:${PORT}`);
    }

    // Summary across all compounds
    let totalPending = 0;
    for (const [id, cs] of compoundStates) {
      totalPending += cs.taskQueue.length;
    }
    console.log(`\nReady to review ${totalPending} total Viva listings across ${compoundStates.size} compound(s)\n`);
    console.log(`Desktop: http://localhost:${PORT}/matcher.html`);
    if (networkIP !== 'localhost') {
      console.log(`Mobile:  http://${networkIP}:${PORT}/matcher.html`);
    }
    console.log();

    if (READ_ONLY) {
      console.log('READ-ONLY MODE: No changes will be saved\n');
    }

    // Check if any compound has data
    let anyData = false;
    for (const [id, cs] of compoundStates) {
      if (cs.smartMatches.matches.length > 0) { anyData = true; break; }
    }
    if (!anyData) {
      console.log('No pipeline data yet — server will auto-load when data arrives via GCS\n');
    }
  });

  // Step 4: Start GCS polling for new pipeline data
  startPolling();

  // Graceful shutdown: flush pending uploads
  process.on('SIGTERM', async () => {
    console.log('\n[Shutdown] SIGTERM received — flushing user decisions...');
    if (_pollTimer) clearInterval(_pollTimer);
    await flushUserDecisions();
    process.exit(0);
  });
}

start().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
