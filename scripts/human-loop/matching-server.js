#!/usr/bin/env node
/**
 * Human-in-the-Loop Matching Server
 *
 * Backend API for manual property matching interface.
 * Loads smart-compare results and serves matching tasks to reviewers.
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

// ============================================================================
// CONFIGURATION
// ============================================================================

const HOST = process.env.HOST || '0.0.0.0';  // Bind to all interfaces for network access
const PORT = process.env.PORT || process.env.MATCHING_PORT || process.argv.find(a => a.startsWith('--port='))?.split('=')[1] || 8080;
const DATA_ROOT = process.env.DATA_ROOT || path.join(__dirname, 'data');
const READ_ONLY = process.argv.includes('--read-only') || process.env.READ_ONLY === 'true';
const SESSION_NAME = process.env.SESSION_NAME || 'default';

const SMART_MATCHES_FILE = path.join(DATA_ROOT, 'deterministic-matches.json');
const MANUAL_MATCHES_FILE = path.join(DATA_ROOT, 'manual-matches.json');
const AUDIT_LOG_FILE = path.join(DATA_ROOT, 'manual-matches.log.jsonl');
const MOSAICS_DIR = path.join(DATA_ROOT, 'mosaics');

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

let matchState = {
  session_started: null,
  last_updated: null,
  session_name: SESSION_NAME,
  version: 0,
  current_pass: 1,
  passes_completed: 0,
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
};

let smartMatches = null;
let taskQueue = [];
let vivaListings = [];
let coelhoListings = [];

// ============================================================================
// PASS CRITERIA DEFINITIONS (from iterative-matcher.js)
// ============================================================================

const PASS_CRITERIA = {
  1: {
    name: 'strict',
    price_tolerance: 0.05,      // ±5%
    area_tolerance: 0.10,       // ±10%
    beds_tolerance: 0,          // exact match
    suites_tolerance: 0,        // exact match
    park_tolerance: 0           // exact match
  },
  2: {
    name: 'relaxed',
    price_tolerance: 0.10,      // ±10%
    area_tolerance: 0.15,       // ±15%
    beds_tolerance: 0,          // exact match
    suites_tolerance: 1,        // ±1
    park_tolerance: 999         // ignore
  },
  3: {
    name: 'broader',
    price_tolerance: 0.15,      // ±15%
    area_tolerance: 0.20,       // ±20%
    beds_tolerance: 1,          // ±1
    suites_tolerance: 999,      // ignore
    park_tolerance: 999         // ignore
  },
  4: {
    name: 'very_broad',
    price_tolerance: 0.25,      // ±25%
    area_tolerance: 0.30,       // ±30%
    beds_tolerance: 1,          // ±1
    suites_tolerance: 999,      // ignore
    park_tolerance: 999         // ignore
  },
  5: {
    name: 'exhaustive',
    price_tolerance: 0.40,      // ±40%
    area_tolerance: 0.50,       // ±50%
    beds_tolerance: 2,          // ±2
    suites_tolerance: 999,      // ignore
    park_tolerance: 999         // ignore
  }
};

const MAX_PASSES = 5;
const MAX_CANDIDATES_PER_LISTING = 5;

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
// INITIALIZATION
// ============================================================================

function loadListings(site) {
  const listingsFile = path.join(DATA_ROOT, 'listings', `${site}_listings.json`);

  if (!fs.existsSync(listingsFile)) {
    console.warn(`⚠️  ${listingsFile} not found - dynamic matching disabled`);
    return [];
  }

  try {
    const data = JSON.parse(fs.readFileSync(listingsFile, 'utf-8'));
    return data.listings || [];
  } catch (error) {
    console.warn(`⚠️  Error loading ${listingsFile}: ${error.message}`);
    return [];
  }
}

function loadSmartMatches() {
  try {
    if (!fs.existsSync(SMART_MATCHES_FILE)) {
      console.error(`❌ Error: ${SMART_MATCHES_FILE} not found!`);
      console.error('   Please run deterministic-matcher first to generate candidate pairs.');
      process.exit(1);
    }

    const data = JSON.parse(fs.readFileSync(SMART_MATCHES_FILE, 'utf-8'));
    // Convert deterministic-matches format to expected format
    const matches = (data.candidate_pairs || []).map(pair => ({
      viva: pair.viva,
      coelhoCandidates: pair.candidates || [],
      _scored: (pair.candidates || []).map(c => ({ code: c.code, score: c.score }))
    }));
    console.log(`✓ Loaded deterministic-matches.json: ${matches.length} Viva listings with candidates`);
    return { matches };
  } catch (error) {
    console.error(`❌ Error loading deterministic-matches.json: ${error.message}`);
    process.exit(1);
  }
}

function loadManualMatches() {
  try {
    if (fs.existsSync(MANUAL_MATCHES_FILE)) {
      const data = JSON.parse(fs.readFileSync(MANUAL_MATCHES_FILE, 'utf-8'));
      console.log(`✓ Loaded existing manual-matches.json (${data.matches?.length || 0} matches)`);
      // Ensure pass tracking fields exist
      data.current_pass = data.current_pass || 1;
      data.passes_completed = data.passes_completed || 0;
      return data;
    }
  } catch (error) {
    console.warn(`⚠️  Error loading manual-matches.json: ${error.message}`);
  }

  // Initialize new session
  return {
    session_started: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    session_name: SESSION_NAME,
    version: 0,
    current_pass: 1,
    passes_completed: 0,
    stats: {
      total_viva_listings: smartMatches?.matches?.length || 0,
      matched: 0,
      rejected: 0,
      skipped: 0,
      pending: smartMatches?.matches?.length || 0,
      in_progress: 0
    },
    matches: [],
    rejected: [],
    skipped: [],
    in_progress: []
  };
}

function buildTaskQueue() {
  const tasks = [];

  for (const item of smartMatches.matches || []) {
    const vivaCode = item.viva?.code || item.viva?.propertyCode;

    // Skip if already matched (final decision)
    const alreadyMatched = matchState.matches.some(m => m.viva_code === vivaCode);
    if (alreadyMatched) {
      continue;
    }

    // For current pass, also skip if already skipped (will be reconsidered in next pass)
    const alreadySkipped = matchState.skipped.some(s => s.viva_code === vivaCode);
    if (alreadySkipped) {
      continue;
    }

    // Filter out already rejected candidates AND already matched Coelho codes
    const rejectedCodes = matchState.rejected
      .filter(r => r.viva_code === vivaCode)
      .map(r => r.coelho_code);

    const matchedCoelhoCodes = new Set(matchState.matches.map(m => m.coelho_code));

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

  console.log(`✓ Built task queue: ${tasks.length} pending Viva listings`);
  return tasks;
}

/**
 * Advance to the next pass by regenerating candidates for skipped listings
 * with broader criteria.
 */
function advanceToNextPass() {
  const currentPass = matchState.current_pass;
  const nextPass = currentPass + 1;

  if (nextPass > MAX_PASSES) {
    console.log(`\n✅ All ${MAX_PASSES} passes completed. No more passes available.`);
    return false;
  }

  // Check if we have raw listings to regenerate candidates
  if (vivaListings.length === 0 || coelhoListings.length === 0) {
    console.log(`\n⚠️  Cannot advance to Pass ${nextPass}: Raw listings not loaded`);
    return false;
  }

  // Get skipped Viva codes from the current pass
  const skippedVivaCodes = matchState.skipped.map(s => s.viva_code);
  const matchedVivaCodes = new Set(matchState.matches.map(m => m.viva_code));

  // Filter to only include listings that were skipped (not matched)
  const remainingVivaCodes = skippedVivaCodes.filter(code => !matchedVivaCodes.has(code));

  if (remainingVivaCodes.length === 0) {
    console.log(`\n✅ No remaining listings to process. All listings have been matched!`);
    return false;
  }

  console.log(`\n🔄 Advancing to Pass ${nextPass} (${getPassCriteria(nextPass).name})`);
  console.log(`   Regenerating candidates for ${remainingVivaCodes.length} previously skipped listings...`);

  const criteria = getPassCriteria(nextPass);
  const remainingSet = new Set(remainingVivaCodes);
  const matchedCoelhoCodes = new Set(matchState.matches.map(m => m.coelho_code));
  const newPairs = [];

  // Filter out already-matched Coelho listings so they can't appear as candidates
  const availableCoelho = coelhoListings.filter(c => {
    const code = c.code || c.propertyCode;
    return !matchedCoelhoCodes.has(code);
  });

  // Find the full Viva listings for the remaining codes
  for (const viva of vivaListings) {
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
    matchState.current_pass = nextPass;
    return advanceToNextPass(); // Recursively try next pass
  }

  // Clear skipped listings (they're being reconsidered with new candidates)
  // Keep track of them in a separate field for audit purposes
  matchState.skipped_previous_passes = matchState.skipped_previous_passes || [];
  matchState.skipped_previous_passes.push({
    pass: currentPass,
    skipped: [...matchState.skipped]
  });
  matchState.skipped = [];

  // Update smartMatches with new pairs
  smartMatches.matches = newPairs;

  // Update pass tracking
  matchState.current_pass = nextPass;
  matchState.passes_completed = currentPass;

  // Rebuild task queue with new candidates
  taskQueue = buildTaskQueue();

  appendAuditLog('pass_advance', {
    from_pass: currentPass,
    to_pass: nextPass,
    criteria: criteria.name,
    listings_reconsidered: remainingVivaCodes.length,
    listings_with_candidates: newPairs.length
  });

  saveMatchState();

  console.log(`✅ Pass ${nextPass} ready: ${taskQueue.length} listings to review\n`);
  return true;
}

/**
 * Check if current pass is complete and advance if needed.
 * Returns true if there are tasks available (either existing or from next pass).
 */
function checkAndAdvancePass() {
  if (taskQueue.length > 0) {
    return true; // Still have work in current pass
  }

  // Current pass complete - check if we should advance
  const skippedCount = matchState.skipped.length;
  const matchedCount = matchState.matches.length;

  console.log(`\n📊 Pass ${matchState.current_pass} complete:`);
  console.log(`   Matched: ${matchedCount}`);
  console.log(`   Skipped: ${skippedCount}`);

  if (skippedCount === 0) {
    console.log(`   All listings processed successfully!`);
    return false;
  }

  // Try to advance to next pass
  return advanceToNextPass();
}

function saveMatchState() {
  if (READ_ONLY) {
    console.log('⚠️  Read-only mode: not saving state');
    return;
  }

  try {
    matchState.last_updated = new Date().toISOString();
    matchState.version++;

    // Recalculate stats
    matchState.stats = {
      total_viva_listings: smartMatches?.matches?.length || 0,
      matched: matchState.matches.length,
      rejected: matchState.rejected.length,
      skipped: matchState.skipped.length,
      pending: taskQueue.length,
      in_progress: matchState.in_progress.length
    };

    fs.writeFileSync(MANUAL_MATCHES_FILE, JSON.stringify(matchState, null, 2));
    console.log(`✓ Saved match state (version ${matchState.version})`);
  } catch (error) {
    console.error(`❌ Error saving match state: ${error.message}`);
  }
}

function appendAuditLog(action, payload) {
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

    fs.appendFileSync(AUDIT_LOG_FILE, JSON.stringify(logEntry) + '\n');
  } catch (error) {
    console.error(`❌ Error writing audit log: ${error.message}`);
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
    price_delta_pct: priceDelta ? parseFloat(priceDelta.toFixed(2)) : null,
    area_viva: vivaArea || null,
    area_coelho: coelhoArea || null,
    area_delta_pct: areaDelta ? parseFloat(areaDelta.toFixed(2)) : null
  };
}

// ============================================================================
// EXPRESS APP
// ============================================================================

const app = express();

app.use(cors());
app.use(express.json({ type: ['application/json', 'application/json; charset=utf-8', 'application/json; charset=UTF-8'] }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/mosaics', express.static(MOSAICS_DIR));

// ============================================================================
// API ENDPOINTS
// ============================================================================

// GET /api/session - Get current session info
app.get('/api/session', (req, res) => {
  const criteria = getPassCriteria(matchState.current_pass);
  res.json({
    session_name: matchState.session_name,
    session_started: matchState.session_started,
    last_updated: matchState.last_updated,
    version: matchState.version,
    stats: matchState.stats,
    read_only: READ_ONLY,
    current_pass: matchState.current_pass,
    passes_completed: matchState.passes_completed,
    max_passes: MAX_PASSES,
    pass_criteria: {
      name: criteria.name,
      price_tolerance: `±${(criteria.price_tolerance * 100).toFixed(0)}%`,
      area_tolerance: `±${(criteria.area_tolerance * 100).toFixed(0)}%`
    }
  });
});

// GET /api/listing/:id - Get specific Viva listing
app.get('/api/listing/:id', (req, res) => {
  const vivaCode = req.params.id;
  const task = taskQueue.find(t => t.viva_code === vivaCode);

  if (!task) {
    return res.status(404).json({ error: 'Listing not found or already processed' });
  }

  res.json({
    viva_code: task.viva_code,
    viva: task.viva,
    remaining_candidates: task.remaining_candidates,
    mosaic_path: `/mosaics/viva/${vivaCode}.png`
  });
});

// GET /api/candidates/:id - Get candidates for Viva listing
app.get('/api/candidates/:id', (req, res) => {
  const vivaCode = req.params.id;
  const task = taskQueue.find(t => t.viva_code === vivaCode);

  if (!task) {
    return res.status(404).json({ error: 'Listing not found' });
  }

  // Filter out already rejected candidates AND already matched Coelho codes
  const rejectedCodes = matchState.rejected
    .filter(r => r.viva_code === vivaCode)
    .map(r => r.coelho_code);

  const matchedCoelhoCodes = new Set(matchState.matches.map(m => m.coelho_code));

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
        features: `${candidate.built || 0}m² construída, ${candidate.beds || 0} dorm, ${candidate.suites || 0} suíte`
      };

      return {
        code,
        candidate: transformedCandidate,
        ai_score: scored?.score || null,
        deltas: calculateDeltas(task.viva, candidate),
        mosaic_path: `/mosaics/coelho/${code}.png`
      };
    });

  res.json({
    viva_code: vivaCode,
    candidates,
    total_candidates: candidates.length
  });
});

// GET /api/next - Get next listing to review
app.get('/api/next', (req, res) => {
  const reviewer = req.query.reviewer || 'anonymous';

  // Check if we need to advance to next pass
  if (taskQueue.length === 0) {
    const hasMoreWork = checkAndAdvancePass();
    if (!hasMoreWork) {
      const totalPasses = matchState.current_pass;
      return res.json({
        done: true,
        message: `All ${MAX_PASSES} passes completed! ${matchState.matches.length} total matches found.`,
        final_stats: {
          total_matches: matchState.matches.length,
          total_skipped: matchState.skipped.length,
          passes_completed: totalPasses
        }
      });
    }
  }

  // Find first listing not in progress by this reviewer
  const available = taskQueue.find(t => {
    const inProgress = matchState.in_progress.find(ip => ip.viva_code === t.viva_code);
    return !inProgress || inProgress.reviewer === reviewer;
  });

  if (!available) {
    // This shouldn't happen after checkAndAdvancePass, but handle it gracefully
    return res.json({ done: true, message: 'All listings reviewed!' });
  }

  // Mark as in progress
  const existingIdx = matchState.in_progress.findIndex(ip => ip.viva_code === available.viva_code);
  if (existingIdx >= 0) {
    matchState.in_progress[existingIdx].last_active = new Date().toISOString();
  } else {
    matchState.in_progress.push({
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

  const currentCriteria = getPassCriteria(matchState.current_pass);
  res.json({
    viva_code: available.viva_code,
    viva: transformedViva,
    remaining_candidates: available.remaining_candidates,
    mosaic_path: `/mosaics/viva/${available.viva_code}.png`,
    current_pass: matchState.current_pass,
    pass_name: currentCriteria.name,
    pending_in_pass: taskQueue.length
  });
});

// POST /api/match - Record a confirmed match
app.post('/api/match', (req, res) => {
  if (READ_ONLY) {
    return res.status(403).json({ error: 'Read-only mode enabled' });
  }

  const { viva_code, coelho_code, reviewer, time_spent_sec, notes } = req.body;

  if (!viva_code || !coelho_code) {
    return res.status(400).json({ error: 'Missing viva_code or coelho_code' });
  }

  // Find task
  const task = taskQueue.find(t => t.viva_code === viva_code);
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

  matchState.matches.push(match);

  // Remove from in_progress
  matchState.in_progress = matchState.in_progress.filter(ip => ip.viva_code !== viva_code);

  // Remove from task queue
  const taskIdx = taskQueue.findIndex(t => t.viva_code === viva_code);
  if (taskIdx >= 0) taskQueue.splice(taskIdx, 1);

  appendAuditLog('match', match);
  saveMatchState();

  res.json({ success: true, match, remaining: taskQueue.length });
});

// POST /api/reject - Reject a specific candidate
app.post('/api/reject', (req, res) => {
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

  matchState.rejected.push(rejection);
  appendAuditLog('reject', rejection);
  saveMatchState();

  // Rebuild task queue to update remaining candidates
  taskQueue = buildTaskQueue();

  res.json({ success: true, rejection, remaining: taskQueue.length });
});

// POST /api/skip - Skip to next Viva listing (no matches found)
app.post('/api/skip', (req, res) => {
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

  matchState.skipped.push(skip);
  matchState.in_progress = matchState.in_progress.filter(ip => ip.viva_code !== viva_code);

  // Remove from task queue
  const taskIdx = taskQueue.findIndex(t => t.viva_code === viva_code);
  if (taskIdx >= 0) taskQueue.splice(taskIdx, 1);

  appendAuditLog('skip', skip);
  saveMatchState();

  res.json({ success: true, skip, remaining: taskQueue.length });
});

// GET /api/progress - Get completion stats
app.get('/api/progress', (req, res) => {
  const total = matchState.stats.total_viva_listings;
  const completed = matchState.stats.matched + matchState.stats.skipped;
  const progress_pct = total > 0 ? ((completed / total) * 100).toFixed(1) : 0;

  const currentCriteria = getPassCriteria(matchState.current_pass);
  res.json({
    total_viva_listings: total,
    matched: matchState.stats.matched,
    skipped: matchState.stats.skipped,
    pending: matchState.stats.pending,
    in_progress: matchState.stats.in_progress,
    completed,
    progress_pct: parseFloat(progress_pct),
    current_pass: matchState.current_pass,
    max_passes: MAX_PASSES,
    pass_name: currentCriteria.name,
    pass_criteria: {
      price_tolerance: `±${(currentCriteria.price_tolerance * 100).toFixed(0)}%`,
      area_tolerance: `±${(currentCriteria.area_tolerance * 100).toFixed(0)}%`
    }
  });
});

// POST /api/undo - Undo last decision for current reviewer
app.post('/api/undo', (req, res) => {
  if (READ_ONLY) {
    return res.status(403).json({ error: 'Read-only mode enabled' });
  }

  const { reviewer } = req.body;
  const reviewerName = reviewer || 'anonymous';

  // Find last action by this reviewer
  let undone = null;

  // Check matches (most recent first)
  for (let i = matchState.matches.length - 1; i >= 0; i--) {
    if (matchState.matches[i].reviewer === reviewerName) {
      undone = { type: 'match', ...matchState.matches[i] };
      matchState.matches.splice(i, 1);
      break;
    }
  }

  // If not found, check skips
  if (!undone) {
    for (let i = matchState.skipped.length - 1; i >= 0; i--) {
      if (matchState.skipped[i].reviewer === reviewerName) {
        undone = { type: 'skip', ...matchState.skipped[i] };
        matchState.skipped.splice(i, 1);
        break;
      }
    }
  }

  if (!undone) {
    return res.status(404).json({ error: 'No recent actions to undo' });
  }

  appendAuditLog('undo', { undone, reviewer: reviewerName });

  // Rebuild task queue
  taskQueue = buildTaskQueue();
  saveMatchState();

  res.json({ success: true, undone, remaining: taskQueue.length });
});

// GET /api/audit - Stream decision history
app.get('/api/audit', (req, res) => {
  try {
    if (!fs.existsSync(AUDIT_LOG_FILE)) {
      return res.json({ entries: [] });
    }

    const lines = fs.readFileSync(AUDIT_LOG_FILE, 'utf-8').trim().split('\n');
    const entries = lines.filter(Boolean).map(line => JSON.parse(line));

    res.json({ entries, total: entries.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

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
// SERVER STARTUP
// ============================================================================

// Initialize
console.log('\n🚀 Human-in-the-Loop Matching Server');
console.log('=====================================\n');
console.log(`Session: ${SESSION_NAME}`);
console.log(`Data root: ${DATA_ROOT}`);
console.log(`Port: ${PORT}`);
console.log(`Host: ${HOST}`);
console.log(`Read-only: ${READ_ONLY ? 'YES' : 'NO'}\n`);

smartMatches = loadSmartMatches();
matchState = loadManualMatches();

// Load raw listings for dynamic pass advancement
vivaListings = loadListings('vivaprimeimoveis');
coelhoListings = loadListings('coelhodafonseca');
if (vivaListings.length > 0 && coelhoListings.length > 0) {
  console.log(`✓ Loaded ${vivaListings.length} Viva and ${coelhoListings.length} Coelho listings for dynamic matching`);
}

taskQueue = buildTaskQueue();

// Log current pass info
const currentCriteria = getPassCriteria(matchState.current_pass);
console.log(`\n📍 Current Pass: ${matchState.current_pass} (${currentCriteria.name})`);
console.log(`   Price tolerance: ±${(currentCriteria.price_tolerance * 100).toFixed(0)}%`);
console.log(`   Area tolerance: ±${(currentCriteria.area_tolerance * 100).toFixed(0)}%`);

// Start server
app.listen(PORT, HOST, () => {
  const networkIP = getLocalIP();

  console.log(`\n✅ Server running on:`);
  console.log(`   Local:    http://localhost:${PORT}`);
  if (networkIP !== 'localhost') {
    console.log(`   Network:  http://${networkIP}:${PORT}`);
  }
  console.log(`\n📊 Ready to review ${taskQueue.length} Viva listings\n`);
  console.log(`Desktop: http://localhost:${PORT}/matcher.html`);
  if (networkIP !== 'localhost') {
    console.log(`Mobile:  http://${networkIP}:${PORT}/matcher.html`);
  }
  console.log();

  if (READ_ONLY) {
    console.log('⚠️  READ-ONLY MODE: No changes will be saved\n');
  }
});
