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
const DATA_ROOT = process.env.DATA_ROOT || (
  fs.existsSync(path.join(__dirname, 'data')) ? path.join(__dirname, 'data') : path.join(__dirname, '..', '..', 'data')
);
const PUBLIC_ROOT = process.env.PUBLIC_ROOT || (
  fs.existsSync(path.join(__dirname, 'public')) ? path.join(__dirname, 'public') : path.join(__dirname, '..', '..', 'server-deploy', 'public')
);
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
};

let smartMatches = null;
let taskQueue = [];
let vivaListings = [];
let coelhoListings = [];
let passStartTotal = 0; // tracks the number of tasks at the start of the current pass

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
      data.pass_matched = data.pass_matched || 0;
      data.pass_skipped = data.pass_skipped || 0;
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
    pass_matched: 0,
    pass_skipped: 0,
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
  matchState.pass_matched = 0;
  matchState.pass_skipped = 0;

  // Rebuild task queue with new candidates
  taskQueue = buildTaskQueue();
  passStartTotal = taskQueue.length;

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

    // Recalculate stats -- use per-pass counters for consistent progress tracking
    const passMatched = matchState.pass_matched || 0;
    const passSkipped = matchState.pass_skipped || 0;
    const passCompleted = passMatched + passSkipped;
    const passTotal = passCompleted + taskQueue.length;
    matchState.stats = {
      total_viva_listings: passTotal,
      matched: passMatched,
      rejected: matchState.rejected.length,
      skipped: passSkipped,
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
    price_delta_pct: priceDelta != null ? parseFloat(priceDelta.toFixed(2)) : null,
    area_viva: vivaArea || null,
    area_coelho: coelhoArea || null,
    area_delta_pct: areaDelta != null ? parseFloat(areaDelta.toFixed(2)) : null
  };
}

// ============================================================================
// EXPRESS APP
// ============================================================================

const app = express();

app.use(cors());
app.use(express.json({ type: ['application/json', 'application/json; charset=utf-8', 'application/json; charset=UTF-8'] }));
app.use(express.static(PUBLIC_ROOT));
app.use('/mosaics', express.static(MOSAICS_DIR));

// ============================================================================
// API ENDPOINTS
// ============================================================================

// GET /api/session - Get current session info
app.get('/api/session', (req, res) => {
  const criteria = getPassCriteria(matchState.current_pass);

  // Check for unread pipeline_complete notifications
  let has_new_properties = false;
  try {
    const notifData = loadNotifications();
    has_new_properties = notifData.notifications.some(n => n.type === 'pipeline_complete' && !n.read);
  } catch {
    // Ignore notification errors in session endpoint
  }

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
    },
    has_new_properties,
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

  // If user has finished, return done
  if (matchState.user_finished) {
    return res.json({
      done: true,
      message: `Matching complete! ${matchState.matches.length} total matches found.`,
      final_stats: {
        total_matches: matchState.matches.length,
        total_skipped: matchState.skipped.length,
        passes_completed: matchState.current_pass
      }
    });
  }

  // Check if current pass is exhausted
  if (taskQueue.length === 0) {
    const skippedCount = matchState.skipped.length;
    const currentCriteria = getPassCriteria(matchState.current_pass);
    const nextPassNum = matchState.current_pass + 1;
    const hasNextPass = nextPassNum <= MAX_PASSES && skippedCount > 0;
    const nextCriteria = hasNextPass ? getPassCriteria(nextPassNum) : null;

    return res.json({
      pass_complete: true,
      current_pass: matchState.current_pass,
      pass_name: currentCriteria.name,
      stats: {
        matched: matchState.matches.length,
        skipped: skippedCount,
        total_reviewed: matchState.matches.length + skippedCount
      },
      has_next_pass: hasNextPass,
      next_pass: hasNextPass ? {
        number: nextPassNum,
        name: nextCriteria.name,
        price_tolerance: `\u00b1${(nextCriteria.price_tolerance * 100).toFixed(0)}%`,
        area_tolerance: `\u00b1${(nextCriteria.area_tolerance * 100).toFixed(0)}%`
      } : null
    });
  }

  // Clean up stale locks (older than LOCK_TIMEOUT_MS)
  const now = Date.now();
  const staleBefore = matchState.in_progress.length;
  matchState.in_progress = matchState.in_progress.filter(ip => {
    const lockTime = new Date(ip.last_active || ip.started_at).getTime();
    return (now - lockTime) < LOCK_TIMEOUT_MS;
  });
  if (matchState.in_progress.length < staleBefore) {
    console.log(`🔓 Cleaned up ${staleBefore - matchState.in_progress.length} stale lock(s)`);
  }

  // Find first listing not in progress by another reviewer
  const available = taskQueue.find(t => {
    const inProgress = matchState.in_progress.find(ip => ip.viva_code === t.viva_code);
    return !inProgress || inProgress.reviewer === reviewer;
  });

  if (!available) {
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
  matchState.pass_matched = (matchState.pass_matched || 0) + 1;

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
  matchState.pass_skipped = (matchState.pass_skipped || 0) + 1;
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
  // Use per-pass counters for progress so percentages are scoped to the current pass
  const passMatched = matchState.pass_matched || 0;
  const passSkipped = matchState.pass_skipped || 0;
  const passCompleted = passMatched + passSkipped;
  const passTotal = passCompleted + taskQueue.length;
  const progress_pct = passTotal > 0 ? ((passCompleted / passTotal) * 100).toFixed(1) : 0;

  const currentCriteria = getPassCriteria(matchState.current_pass);
  res.json({
    total_viva_listings: passTotal,
    matched: passMatched,
    skipped: passSkipped,
    pending: taskQueue.length,
    in_progress: matchState.in_progress.length,
    completed: passCompleted,
    progress_pct: parseFloat(progress_pct),
    // Cumulative stats across all passes for overall context
    cumulative_matched: matchState.matches.length,
    cumulative_skipped: matchState.skipped.length + (matchState.skipped_previous_passes || []).reduce((sum, p) => sum + p.skipped.length, 0),
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

  // Decrement per-pass counters
  if (undone.type === 'match') {
    matchState.pass_matched = Math.max(0, (matchState.pass_matched || 0) - 1);
  } else if (undone.type === 'skip') {
    matchState.pass_skipped = Math.max(0, (matchState.pass_skipped || 0) - 1);
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

// POST /api/pass/advance - User confirms advancing to next pass
app.post('/api/pass/advance', (req, res) => {
  if (READ_ONLY) {
    return res.status(403).json({ error: 'Read-only mode enabled' });
  }

  const advanced = advanceToNextPass();

  if (!advanced) {
    return res.json({
      success: false,
      message: 'Cannot advance to next pass',
      current_pass: matchState.current_pass
    });
  }

  const criteria = getPassCriteria(matchState.current_pass);
  res.json({
    success: true,
    current_pass: matchState.current_pass,
    pass_name: criteria.name,
    pending: taskQueue.length
  });
});

// POST /api/pass/finish - User says "I'm done"
app.post('/api/pass/finish', (req, res) => {
  if (READ_ONLY) {
    return res.status(403).json({ error: 'Read-only mode enabled' });
  }

  matchState.user_finished = true;

  appendAuditLog('user_finished', {
    total_matches: matchState.matches.length,
    total_skipped: matchState.skipped.length,
    passes_completed: matchState.current_pass,
    reviewer: req.body.reviewer || 'anonymous'
  });

  saveMatchState();

  res.json({
    success: true,
    summary: {
      total_matches: matchState.matches.length,
      total_skipped: matchState.skipped.length,
      passes_completed: matchState.current_pass
    }
  });
});

// ============================================================================
// PIPELINE & NOTIFICATION ENDPOINTS
// ============================================================================

const NOTIFICATIONS_FILE = path.join(DATA_ROOT, 'notifications.json');

function loadNotifications() {
  try {
    if (fs.existsSync(NOTIFICATIONS_FILE)) {
      return JSON.parse(fs.readFileSync(NOTIFICATIONS_FILE, 'utf-8'));
    }
  } catch {
    // Corrupted file, start fresh
  }
  return { notifications: [] };
}

function saveNotifications(data) {
  fs.writeFileSync(NOTIFICATIONS_FILE, JSON.stringify(data, null, 2));
}

// POST /api/pipeline/trigger - Record that a pipeline run was requested
app.post('/api/pipeline/trigger', (req, res) => {
  try {
    const data = loadNotifications();

    const notification = {
      id: crypto.randomUUID(),
      type: 'pipeline_trigger',
      message: 'Pipeline run requested',
      data: { requested_at: new Date().toISOString() },
      created_at: new Date().toISOString(),
      read: false,
    };

    data.notifications.push(notification);
    saveNotifications(data);

    res.json({ triggered: true, message: 'Pipeline trigger recorded' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/pipeline/complete - Called by pipeline-runner when done
app.post('/api/pipeline/complete', (req, res) => {
  try {
    const { new_viva = 0, new_coelho = 0, timestamp } = req.body;
    const data = loadNotifications();

    const notification = {
      id: crypto.randomUUID(),
      type: 'pipeline_complete',
      message: `New properties available! ${new_viva} Viva, ${new_coelho} Coelho listings scraped`,
      data: { new_viva, new_coelho, timestamp: timestamp || new Date().toISOString() },
      created_at: new Date().toISOString(),
      read: false,
    };

    data.notifications.push(notification);
    saveNotifications(data);

    console.log(`Pipeline complete notification: ${notification.message}`);
    res.json({ success: true, notification_id: notification.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/notifications - Returns unread notifications
app.get('/api/notifications', (req, res) => {
  try {
    const data = loadNotifications();
    const unread = data.notifications.filter(n => !n.read);

    res.json({
      notifications: unread,
      unread_count: unread.length,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/notifications/dismiss - Mark notifications as read
app.post('/api/notifications/dismiss', (req, res) => {
  try {
    const { id, all } = req.body;
    const data = loadNotifications();

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

    saveNotifications(data);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// MATCH VALIDATION & EXPORT ENDPOINTS
// ============================================================================

// GET /api/matches/validate - Cross-reference matches against listings
app.get('/api/matches/validate', (req, res) => {
  const valid = [];
  const invalid = [];
  const duplicates = [];

  // Build lookup sets
  const vivaCodeSet = new Set(vivaListings.map(l => l.code || l.propertyCode));
  const coelhoCodeSet = new Set(coelhoListings.map(l => l.code || l.propertyCode));

  // Track duplicates
  const vivaMatchCount = {};
  const coelhoMatchCount = {};

  for (const match of matchState.matches) {
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
        matches: matchState.matches.filter(m => m.viva_code === code)
      });
    }
  }
  for (const [code, count] of Object.entries(coelhoMatchCount)) {
    if (count > 1) {
      duplicates.push({
        code,
        type: 'coelho',
        matches: matchState.matches.filter(m => m.coelho_code === code)
      });
    }
  }

  res.json({
    valid,
    invalid,
    duplicates,
    summary: {
      total: matchState.matches.length,
      valid_count: valid.length,
      invalid_count: invalid.length,
      duplicate_count: duplicates.length
    }
  });
});

// GET /api/matches/export - Export enriched match data with full listing details
app.get('/api/matches/export', (req, res) => {
  // Build lookup maps
  const vivaMap = new Map();
  for (const l of vivaListings) {
    vivaMap.set(l.code || l.propertyCode, l);
  }
  const coelhoMap = new Map();
  for (const l of coelhoListings) {
    coelhoMap.set(l.code || l.propertyCode, l);
  }

  const enrichedMatches = matchState.matches.map(match => {
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
});

// ============================================================================
// UNMATCHED REPORT & EMAIL ENDPOINTS
// ============================================================================

app.get('/api/report/unmatched', (req, res) => {
  // Get all viva codes that were in the candidate pool
  const allVivaCodes = new Set();
  for (const item of smartMatches.matches || []) {
    const vivaCode = item.viva?.code || item.viva?.propertyCode;
    if (vivaCode) allVivaCodes.add(vivaCode);
  }

  // Also include viva codes from skipped_previous_passes
  if (matchState.skipped_previous_passes) {
    for (const passData of matchState.skipped_previous_passes) {
      for (const skip of passData.skipped || []) {
        allVivaCodes.add(skip.viva_code);
      }
    }
  }
  for (const skip of matchState.skipped || []) {
    allVivaCodes.add(skip.viva_code);
  }

  // Get matched viva codes
  const matchedVivaCodes = new Set(matchState.matches.map(m => m.viva_code));

  // Find unmatched
  const unmatchedCodes = [...allVivaCodes].filter(code => !matchedVivaCodes.has(code));

  // Build lookup map from vivaListings
  const vivaMap = new Map();
  for (const l of vivaListings) {
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
});

app.post('/api/report/send-email', async (req, res) => {
  const { to } = req.body;

  if (!to || !to.includes('@')) {
    return res.status(400).json({ error: 'Valid email address required' });
  }

  try {
    // Get unmatched data
    const allVivaCodes = new Set();
    for (const item of smartMatches.matches || []) {
      const vivaCode = item.viva?.code || item.viva?.propertyCode;
      if (vivaCode) allVivaCodes.add(vivaCode);
    }
    if (matchState.skipped_previous_passes) {
      for (const passData of matchState.skipped_previous_passes) {
        for (const skip of passData.skipped || []) {
          allVivaCodes.add(skip.viva_code);
        }
      }
    }
    for (const skip of matchState.skipped || []) {
      allVivaCodes.add(skip.viva_code);
    }

    const matchedVivaCodes = new Set(matchState.matches.map(m => m.viva_code));
    const unmatchedCodes = [...allVivaCodes].filter(code => !matchedVivaCodes.has(code));

    const vivaMap = new Map();
    for (const l of vivaListings) {
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

    const htmlContent = generateEmailHTML(unmatchedListings, matchState.matches.length);

    await transporter.sendMail({
      from: process.env.REPORT_FROM_EMAIL || process.env.SMTP_USER,
      to,
      subject: `Property Matching Report - ${matchState.matches.length} matched, ${unmatchedListings.length} unmatched`,
      html: htmlContent,
    });

    appendAuditLog('report_sent', { to, unmatched_count: unmatchedListings.length });

    res.json({ success: true, message: `Report sent to ${to}` });
  } catch (error) {
    console.error('Email error:', error);
    res.status(500).json({ error: `Failed to send email: ${error.message}` });
  }
});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

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
// SERVER STARTUP
// ============================================================================

// Initialize
console.log('\n🚀 Human-in-the-Loop Matching Server');
console.log('=====================================\n');
console.log(`Session: ${SESSION_NAME}`);
console.log(`Data root: ${DATA_ROOT}`);
console.log(`Public root: ${PUBLIC_ROOT}`);
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
passStartTotal = taskQueue.length;

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
