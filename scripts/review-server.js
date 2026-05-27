'use strict';
/**
 * review-server.js — Human Review Loop for AI-matched property pairs
 *
 * Reads data from GCS, serves a review UI, writes confirmed sessions back to GCS.
 * Images are served directly from GCS public URLs (no proxy).
 * Re-matching is queued in GCS for the Mac worker; Cloud Run stays lightweight.
 *
 * Env vars:
 *   GCS_BUCKET   GCS bucket name  (default: realestate-475615-data)
 *   PORT         Server port      (default: 3001)
 *
 * Local usage:   node scripts/review-server.js
 * Cloud Run:     Deployed via scripts/deploy-review-server.sh
 */

const express = require('express');
const https   = require('https');
const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const { Storage } = require('@google-cloud/storage');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT       = process.env.PORT || 3001;
const GCS_BUCKET = process.env.GCS_BUCKET || 'realestate-475615-data';
const GCS_BASE   = `https://storage.googleapis.com/${GCS_BUCKET}`;
const MOSAIC_VERSION = process.env.K_REVISION || String(Date.now());
const storage = new Storage();
const bucket  = storage.bucket(GCS_BUCKET);

const COMMUNITY_NAMES = {
  'alphaville-1': 'Alphaville 1',
  'tambore-xi': 'Tamboré XI',
};

function communityName(slug) {
  return COMMUNITY_NAMES[slug] || slug || 'Community';
}

function normalizeCompound(value) {
  const compound = String(value || '').trim();
  return compound && compound !== 'all' ? compound : null;
}

// ---------------------------------------------------------------------------
// Helpers — GCS reads (public URLs, no auth needed for reads)
// ---------------------------------------------------------------------------

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode} from ${url}`));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse error from ${url}: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Helpers — GCS writes (requires Storage Object Admin on Cloud Run SA)
// ---------------------------------------------------------------------------

async function gcsWrite(gcsPath, data) {
  const file = bucket.file(gcsPath);
  await file.save(JSON.stringify(data, null, 2), { contentType: 'application/json' });
}

async function gcsRead(gcsPath) {
  const [contents] = await bucket.file(gcsPath).download();
  return JSON.parse(contents.toString());
}

// ---------------------------------------------------------------------------
// Image URL helpers — direct GCS public URLs, no proxy
// ---------------------------------------------------------------------------

function fullSite(site) {
  return site === 'viva' ? 'vivaprimeimoveis' : 'coelhodafonseca';
}

function imageUrl(site, code, filename) {
  return `${GCS_BASE}/images/${fullSite(site)}/${code}/${filename}`;
}

function selectedImageUrl(site, code, filename) {
  return `${GCS_BASE}/selected/${fullSite(site)}/${code}/${filename}`;
}

// Mosaic URLs follow the make-clip-mosaics.js output:
//   mosaics/{site}/{code}.png       — standard 4x2 outdoor mosaic
//   mosaics/{site}/{code}_full.png  — expanded 8x4 outdoor mosaic
function mosaicUrl(site, code, mode = 'standard') {
  const suffix = mode === 'expanded' ? '_full' : '';
  return `${GCS_BASE}/mosaics/${site}/${code}${suffix}.png?v=${encodeURIComponent(MOSAIC_VERSION)}`;
}

// In-memory cache for mosaic existence probes (per process)
const _mosaicAvail = new Map();
function mosaicCacheKey(site, code, mode) { return `${site}/${code}/${mode}`; }

const LOCAL_DATA_ROOT = process.env.LOCAL_DATA_ROOT || null;

function localMosaicPath(site, code, mode) {
  if (!LOCAL_DATA_ROOT) return null;
  const suffix = mode === 'expanded' ? '_full' : '';
  return path.join(LOCAL_DATA_ROOT, 'mosaics', site, `${code}${suffix}.png`);
}
function localImagesDir(site, code) {
  if (!LOCAL_DATA_ROOT) return null;
  return path.join(LOCAL_DATA_ROOT, fullSite(site), 'images', code);
}

function fixturePlaceholderMosaic(site, code, mode) {
  if (LOCAL_DATA_ROOT) {
    const suffix = mode === 'expanded' ? '_full' : '';
    return `/local-mosaics/${site}/${code}${suffix}.png`;
  }
  const w = mode === 'expanded' ? 1600 : 800;
  const h = mode === 'expanded' ? 800  : 400;
  return `https://picsum.photos/seed/${site}-${code}-${mode}/${w}/${h}`;
}

async function probeMosaic(site, code, mode) {
  if (LOCAL_DATA_ROOT) {
    const p = localMosaicPath(site, code, mode);
    return !!(p && fs.existsSync(p));
  }
  if (process.env.LOCAL_FIXTURES_MATCHES) return true;
  const key = mosaicCacheKey(site, code, mode);
  if (_mosaicAvail.has(key)) return _mosaicAvail.get(key);
  const suffix = mode === 'expanded' ? '_full' : '';
  const gcsPath = `mosaics/${site}/${code}${suffix}.png`;
  let available = false;
  try { [available] = await bucket.file(gcsPath).exists(); }
  catch (_) { available = false; }
  _mosaicAvail.set(key, available);
  return available;
}

const OUTDOOR_CATEGORIES = new Set(['pool', 'facade', 'garden']);
const CATEGORY_PRIORITY = { pool: 0, facade: 1, garden: 2 };

function sortOutdoorImages(entries) {
  return (entries || [])
    .filter(e => OUTDOOR_CATEGORIES.has(e.category))
    .sort((a, b) => {
      const byCategory = CATEGORY_PRIORITY[a.category] - CATEGORY_PRIORITY[b.category];
      if (byCategory !== 0) return byCategory;
      return String(a.filename).localeCompare(String(b.filename), undefined, { numeric: true });
    });
}

// ---------------------------------------------------------------------------
// Tier normalization — maps tiered + legacy tier values to lanes and labels
// ---------------------------------------------------------------------------

const TIER_MAP = {
  'auto-review-high': { lane: 'high',   label: 'High confidence' },
  'review-normal':    { lane: 'normal', label: 'Normal review'   },
  'review-recall':    { lane: 'recall', label: 'Recall candidate' },
  'reject-low':       { lane: 'audit',  label: 'Audit only'      },
  high:               { lane: 'high',   label: 'High confidence' },
  medium:             { lane: 'normal', label: 'Normal review'   },
  low:                { lane: 'recall', label: 'Recall candidate' },
};

const REVIEW_LANES = ['high', 'normal', 'recall'];
const ALL_LANES    = ['high', 'normal', 'recall', 'audit'];

function normalizeTier(match) {
  const raw = match && (match.tier || match.legacy_tier);
  const mapped = raw && TIER_MAP[raw];
  if (mapped) return { ...mapped, raw };
  return { lane: 'normal', label: 'Normal review', raw: raw || null };
}

const EVIDENCE_FIELDS = [
  'sources',
  'source_scores',
  'geometric_score',
  'best_inliers',
  'best_inlier_ratio',
  'support_pairs_8',
  'support_pairs_12',
  'structural',
  'price_diff',
  'area_diff',
  'structural_failures',
  'top_image_pairs',
  'legacy_tier',
];

function pickEvidence(match) {
  const out = {};
  for (const k of EVIDENCE_FIELDS) {
    if (match[k] !== undefined && match[k] !== null) out[k] = match[k];
  }
  return out;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let vivaMap    = {};
let coelhoMap  = {};
let vivaListings = [];
let coelhoListings = [];
let autoMatches = [];    // review queue (lanes high/normal/recall), non-reject pairs
let auditMatches = [];   // reject-low pairs, accessible via audit lane
let currentSession = null;  // { pass, pairs, audit, confirmed }
let loadedMatchesMeta = {};
let eventCounter = 0;

// ---------------------------------------------------------------------------
// Load listings from GCS
// ---------------------------------------------------------------------------

function readLocalJson(envVar) {
  const p = process.env[envVar];
  if (!p) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { console.warn(`Could not read ${envVar}=${p}:`, e.message); return null; }
}

async function loadListingMaps() {
  vivaMap = {};
  coelhoMap = {};
  vivaListings = [];
  coelhoListings = [];

  const localViva = readLocalJson('LOCAL_FIXTURES_VIVA');
  const localCoe  = readLocalJson('LOCAL_FIXTURES_COELHO');
  try {
    const vRaw = localViva || await fetchJson(`${GCS_BASE}/listings/vivaprimeimoveis.json`);
    vivaListings = vRaw.listings || [];
    for (const l of vivaListings) {
      const specs  = (l.detailedData || {}).specs || {};
      const areaStr = specs.area_construida || '';
      const areaM  = areaStr.match(/(\d+(?:[.,]\d+)?)/);
      vivaMap[String(l.propertyCode)] = {
        price: l.price || '',
        area:  areaM ? areaM[1] : '',
        beds:  specs.dormitorios != null ? String(specs.dormitorios) : '',
        url:   l.url || '',
      };
    }
    console.log(`✓ Loaded ${Object.keys(vivaMap).length} Viva listings from GCS`);
  } catch (e) {
    console.warn('Could not load Viva listings from GCS:', e.message);
  }

  try {
    const cRaw = localCoe || await fetchJson(`${GCS_BASE}/listings/coelhodafonseca.json`);
    coelhoListings = cRaw.listings || [];
    for (const l of coelhoListings) {
      const features = l.features || '';
      const areaM = features.match(/(\d+(?:[.,]\d+)?)\s*m²\s*construída/i);
      const bedsM = features.match(/(\d+)\s*dorms?/i);
      coelhoMap[String(l.propertyCode)] = {
        price: l.price || '',
        area:  areaM ? areaM[1] : '',
        beds:  bedsM ? bedsM[1] : '',
        url:   l.url || '',
      };
    }
    console.log(`✓ Loaded ${Object.keys(coelhoMap).length} Coelho listings from GCS`);
  } catch (e) {
    console.warn('Could not load Coelho listings from GCS:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Load auto-matches from GCS + build session
// ---------------------------------------------------------------------------

function decorateMatch(m) {
  const norm = normalizeTier(m);
  return {
    viva_code:        m.viva_code,
    coelho_code:      m.coelho_code,
    similarity:       m.similarity ?? m.confidence_score ?? m.confidence ?? null,
    confidence_score: m.confidence_score ?? m.similarity ?? null,
    tier:             m.tier || norm.raw || null,
    tier_label:       norm.label,
    lane:             norm.lane,
    pool_rank:        m.pool_rank ?? null,
    facade_rank:      m.facade_rank ?? null,
    evidence:         pickEvidence(m),
  };
}

function splitMatches(raw) {
  const rawMatches = Array.isArray(raw.matches)
    ? raw.matches
    : Object.entries(raw.matches || {}).map(([viva_code, v]) => ({ viva_code, ...v }));

  const review = [];
  const audit  = [];
  for (const m of rawMatches) {
    const norm = normalizeTier(m);
    if (m.include_in_review === false && norm.lane !== 'audit') continue;
    const decorated = decorateMatch(m);
    if (norm.lane === 'audit') audit.push(decorated);
    else                       review.push(decorated);
  }
  return { review, audit };
}

async function loadMatches() {
  const localMatches = readLocalJson('LOCAL_FIXTURES_MATCHES');
  try {
    const raw = localMatches || await fetchJson(`${GCS_BASE}/matches/auto-matches.json`);
    const { review, audit } = splitMatches(raw);
    autoMatches  = review;
    auditMatches = audit;
    loadedMatchesMeta = {
      compound: normalizeCompound(raw.compound)
        || normalizeCompound(review.find(m => m.compound)?.compound)
        || normalizeCompound(audit.find(m => m.compound)?.compound)
        || null,
      community_name: raw.community_name || null,
    };

    const byLane = REVIEW_LANES.reduce((acc, l) => (acc[l] = review.filter(m => m.lane === l).length, acc), {});
    console.log(
      `✓ Loaded ${review.length} review matches from GCS ` +
      `(high=${byLane.high}, normal=${byLane.normal}, recall=${byLane.recall}; audit=${audit.length})`
    );
  } catch (e) {
    console.warn('Could not load auto-matches from GCS:', e.message);
    autoMatches = [];
    auditMatches = [];
    loadedMatchesMeta = {};
  }
}

// ---------------------------------------------------------------------------
// Session management (in-memory + GCS persistence)
// ---------------------------------------------------------------------------

async function ensureSession() {
  // When running on local fixtures, always rebuild — never resume a stale GCS session
  if (process.env.LOCAL_FIXTURES_MATCHES) {
    currentSession = buildNewSession(autoMatches, auditMatches, 1, []);
    ensureSessionCompound();
    console.log(`✓ Created local-fixture session: ${currentSession.pairs.length} review pairs, ${currentSession.audit.length} audit`);
    return;
  }
  // Try to load existing session from GCS
  try {
    currentSession = await gcsRead('review-sessions/current.json');
    if (!Array.isArray(currentSession.audit)) currentSession.audit = [];
    let changed = false;
    if (!currentSession.trial_run_id) {
      currentSession.trial_run_id = crypto.randomUUID();
      changed = true;
    }
    if (!currentSession.compound) {
      const compound = sessionCompound();
      if (compound) {
        currentSession.compound = compound;
        changed = true;
      }
    }
    // Backfill lane / tier_label / evidence on legacy persisted pairs
    for (const p of currentSession.pairs || []) {
      if (!p.lane || !p.tier_label) {
        const norm = normalizeTier(p);
        p.lane       = p.lane || norm.lane;
        p.tier_label = p.tier_label || norm.label;
        changed = true;
      }
      if (!p.evidence) {
        p.evidence = pickEvidence(p);
        changed = true;
      }
    }
    if (changed) await saveSession();
    console.log(`✓ Resumed session: pass-${currentSession.pass}, ${currentSession.pairs.length} review pairs, ${currentSession.audit.length} audit`);
    return;
  } catch (e) {
    // No existing session — build from matches
  }

  currentSession = buildNewSession(autoMatches, auditMatches, 1, []);
  ensureSessionCompound();
  await saveSession();
  console.log(`✓ Created pass-1 session: ${currentSession.pairs.length} review pairs, ${currentSession.audit.length} audit`);
}

function buildNewSession(reviewMatches, auditMatches_, passN, carryConfirmed, trialRunId = null) {
  const confirmedSet = new Set(carryConfirmed.map(p => p.viva_code));
  const pairs = reviewMatches
    .filter(m => !confirmedSet.has(m.viva_code))
    .map(m => ({ ...m, status: 'pending' }));
  const audit = (auditMatches_ || [])
    .filter(m => !confirmedSet.has(m.viva_code))
    .map(m => ({ ...m, status: 'pending' }));
  const compound = inferCompoundFromPairs([...pairs, ...audit, ...carryConfirmed]) || loadedMatchesMeta.compound || null;
  return {
    pass:      passN,
    compound,
    pairs,
    audit,
    confirmed: [...carryConfirmed],
    trial_run_id: trialRunId || crypto.randomUUID(),
    created_at: new Date().toISOString(),
  };
}

function inferCompoundFromPairs(pairs = []) {
  const compounds = new Set(
    pairs
      .map(p => normalizeCompound(p && p.compound))
      .filter(Boolean)
  );
  return compounds.size === 1 ? [...compounds][0] : null;
}

function sessionCompound() {
  return normalizeCompound(currentSession?.compound)
    || inferCompoundFromPairs([...(currentSession?.pairs || []), ...(currentSession?.audit || []), ...(currentSession?.confirmed || [])])
    || loadedMatchesMeta.compound
    || null;
}

function ensureSessionCompound() {
  const compound = sessionCompound();
  if (currentSession && compound && !currentSession.compound) {
    currentSession.compound = compound;
  }
  return compound;
}

function enforceRequestedCompound(req, res) {
  const requested = normalizeCompound(req.query.compound);
  const active = ensureSessionCompound();
  if (!requested || !active || requested === active) return true;
  res.status(409).json({
    error: 'wrong_compound',
    requested_compound: requested,
    requested_community_name: communityName(requested),
    active_compound: active,
    active_community_name: communityName(active),
    message: `This link asked for ${communityName(requested)}, but the active review queue is ${communityName(active)}.`,
  });
  return false;
}

async function saveSession() {
  try {
    await gcsWrite('review-sessions/current.json', currentSession);
  } catch (e) {
    console.warn('Could not save session to GCS:', e.message);
  }
}

function safeGcsSegment(value, fallback = 'no-session') {
  return String(value || fallback).replace(/[^A-Za-z0-9._-]/g, '_');
}

function encodeGcsPath(gcsPath) {
  return gcsPath.split('/').map(encodeURIComponent).join('/');
}

function trialRoundPrefix(trialRunId, round) {
  return `review-rounds/${safeGcsSegment(trialRunId)}/pass-${round}`;
}

function roundOutputPath(trialRunId, round) {
  return `${trialRoundPrefix(trialRunId, round)}/auto-matches-round-${round}.json`;
}

function legacyRoundOutputPath(round) {
  return `matches/auto-matches-round-${round}.json`;
}

function roundStatusPath(trialRunId, round) {
  return `review-sessions/round-jobs/${safeGcsSegment(trialRunId)}/round-${round}.json`;
}

function macWorkerCommand(statusPath) {
  return `node scripts/mac-round-worker.js --once --status ${statusPath}`;
}

async function writeRoundStatus(statusPath, status) {
  await gcsWrite(statusPath, {
    ...status,
    updated_at: new Date().toISOString(),
  });
}

async function readRoundStatus(statusPath) {
  try { return await gcsRead(statusPath); }
  catch (_) { return null; }
}

async function readRoundJson(gcsPath) {
  try {
    return await gcsRead(gcsPath);
  } catch (gcsErr) {
    try {
      return await fetchJson(`${GCS_BASE}/${encodeGcsPath(gcsPath)}?v=${Date.now()}`);
    } catch (_) {
      throw gcsErr;
    }
  }
}

async function loadRoundFromGcs(nextPass, trialRunId) {
  const candidates = [
    roundOutputPath(trialRunId, nextPass),
    legacyRoundOutputPath(nextPass),
  ];
  let lastErr = null;
  let raw = null;
  let sourcePath = null;
  for (const gcsPath of candidates) {
    try {
      raw = await readRoundJson(gcsPath);
      sourcePath = gcsPath;
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!raw) throw lastErr || new Error(`Round ${nextPass} not found in GCS.`);
  const { review, audit } = splitMatches(raw);
  const carryConfirmed = Array.isArray(currentSession.confirmed) ? currentSession.confirmed : [];
  currentSession = buildNewSession(review, audit, nextPass, carryConfirmed, trialRunId || currentSession.trial_run_id);
  await saveSession();
  return { review, audit, sourcePath };
}

async function queueRoundForMacWorker({ nextPass, trialRunId, summaryPath, summaryUrl, statusPath, summary }) {
  const status = {
    state: 'queued',
    compute_target: 'mac',
    round: nextPass,
    trial_run_id: trialRunId,
    summary_path: summaryPath,
    summary_url: summaryUrl,
    status_path: statusPath,
    output_path: roundOutputPath(trialRunId, nextPass),
    legacy_output_path: legacyRoundOutputPath(nextPass),
    artifact_prefix: trialRoundPrefix(trialRunId, nextPass),
    pending_viva_count: summary.pending_viva_count || 0,
    command: macWorkerCommand(statusPath),
    message: `Round ${nextPass} queued. Waiting for the Mac worker to run the matcher pipeline.`,
    requested_at: new Date().toISOString(),
  };
  await writeRoundStatus(statusPath, status);
  return status;
}

function lanePool(lane) {
  if (lane === 'audit') return currentSession.audit || [];
  return (currentSession.pairs || []).filter(p => !lane || p.lane === lane);
}

function currentPair(lane) {
  const pool = lanePool(lane);
  return pool.find(p => p.status === 'pending') || null;
}

function findPair(viva_code, coelho_code) {
  const all = [...(currentSession.pairs || []), ...(currentSession.audit || [])];
  return all.find(p => p.viva_code === viva_code && p.coelho_code === coelho_code) || null;
}

function retirePendingAlternates(confirmedPair) {
  const retired = [];
  const keep = (p) => {
    if (p === confirmedPair || p.status !== 'pending') return true;
    if (p.viva_code === confirmedPair.viva_code || p.coelho_code === confirmedPair.coelho_code) {
      retired.push({ viva_code: p.viva_code, coelho_code: p.coelho_code, lane: p.lane });
      return false;
    }
    return true;
  };
  currentSession.pairs = (currentSession.pairs || []).filter(keep);
  currentSession.audit = (currentSession.audit || []).filter(keep);
  return retired;
}

function laneCounts() {
  const counts = {};
  for (const lane of REVIEW_LANES) {
    const pool = (currentSession.pairs || []).filter(p => p.lane === lane);
    counts[lane] = {
      total:     pool.length,
      pending:   pool.filter(p => p.status === 'pending').length,
      confirmed: pool.filter(p => p.status === 'confirmed').length,
      skipped:   pool.filter(p => p.status === 'skipped').length,
      unsure:    pool.filter(p => p.status === 'unsure').length,
    };
  }
  const audit = currentSession.audit || [];
  counts.audit = {
    total:     audit.length,
    pending:   audit.filter(p => p.status === 'pending').length,
    confirmed: audit.filter(p => p.status === 'confirmed').length,
    skipped:   audit.filter(p => p.status === 'skipped').length,
    unsure:    audit.filter(p => p.status === 'unsure').length,
  };
  return counts;
}

function requestMeta(req) {
  return {
    ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress || null,
    user_agent: req.headers['user-agent'] || null,
    referer: req.headers.referer || null,
  };
}

function pairSnapshot(pair) {
  if (!pair) return null;
  return {
    viva_code: pair.viva_code,
    coelho_code: pair.coelho_code,
    lane: pair.lane || normalizeTier(pair).lane,
    tier: pair.tier || null,
    similarity: pair.similarity ?? null,
    confidence_score: pair.confidence_score ?? null,
    evidence: pair.evidence || pickEvidence(pair),
    viva: vivaMap[pair.viva_code] || {},
    coelho: coelhoMap[pair.coelho_code] || {},
  };
}

async function logEvent(req, type, payload = {}) {
  const now = new Date().toISOString();
  const trialRunId = currentSession?.trial_run_id || 'no-session';
  const event = {
    ts: now,
    type,
    trial_run_id: trialRunId,
    pass: currentSession?.pass ?? null,
    sequence: ++eventCounter,
    ...payload,
    request: requestMeta(req),
  };
  console.log(`[event] ${type} trial=${trialRunId} viva=${payload.viva_code || ''} coelho=${payload.coelho_code || ''} lane=${payload.lane || ''}`);
  try {
    const stamp = now.replace(/[:.]/g, '-');
    await gcsWrite(`review-sessions/events/${trialRunId}/${stamp}-${String(eventCounter).padStart(6, '0')}.json`, event);
  } catch (e) {
    console.warn('Could not write analytics event to GCS:', e.message);
  }
}

function allSessionPairs() {
  if (!currentSession) return [];
  return [...(currentSession.pairs || []), ...(currentSession.audit || [])];
}

function buildTrialSummary() {
  const compound = ensureSessionCompound();
  const pairs = allSessionPairs();
  const confirmed = currentSession?.confirmed || [];
  const confirmedViva = new Set(confirmed.map(p => p.viva_code));
  const reviewedViva = new Set(pairs.filter(p => p.status && p.status !== 'pending').map(p => p.viva_code));
  const nonConfirmedReviewed = pairs.filter(p =>
    p.status && p.status !== 'pending' && p.status !== 'confirmed' && !confirmedViva.has(p.viva_code)
  );
  const vivaWithoutConfirmedCoelho = [...new Map(nonConfirmedReviewed.map(p => [p.viva_code, {
    viva_code: p.viva_code,
    attempted_coelho_code: p.coelho_code,
    status: p.status,
    lane: p.lane || normalizeTier(p).lane,
    reviewed_at: p.reviewed_at || null,
    viva: vivaMap[p.viva_code] || {},
    attempted_coelho: coelhoMap[p.coelho_code] || {},
  }])).values()];
  const pendingViva = vivaListings
    .filter(l => !confirmedViva.has(String(l.propertyCode)))
    .map(l => ({
      viva_code: String(l.propertyCode),
      reviewed_in_current_session: reviewedViva.has(String(l.propertyCode)),
      viva: vivaMap[String(l.propertyCode)] || {},
    }));
  const vivaNeverReviewed = pendingViva.filter(p => !p.reviewed_in_current_session);

  return {
    generated_at: new Date().toISOString(),
    trial_run_id: currentSession?.trial_run_id || null,
    compound,
    community_name: communityName(compound),
    pass: currentSession?.pass || null,
    total_viva_listings: vivaListings.length,
    total_coelho_listings: coelhoListings.length,
    lanes: currentSession ? laneCounts() : {},
    total_candidates: pairs.length,
    total_confirmed: confirmed.length,
    confirmed_viva_count: confirmedViva.size,
    pending_viva_count: pendingViva.length,
    reviewed_unmatched_viva_count: vivaWithoutConfirmedCoelho.length,
    never_reviewed_viva_count: vivaNeverReviewed.length,
    total_skipped: pairs.filter(p => p.status === 'skipped').length,
    total_unsure: pairs.filter(p => p.status === 'unsure').length,
    total_pending: pairs.filter(p => p.status === 'pending').length,
    confirmed_matches: confirmed.map(p => ({
      viva_code: p.viva_code,
      coelho_code: p.coelho_code,
      lane: p.lane || normalizeTier(p).lane,
      similarity: p.similarity,
      confirmed_at: p.confirmed_at,
      viva: vivaMap[p.viva_code] || {},
      coelho: coelhoMap[p.coelho_code] || {},
    })),
    viva_without_confirmed_coelho: vivaWithoutConfirmedCoelho,
    pending_viva: pendingViva,
    viva_never_reviewed: vivaNeverReviewed,
  };
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// Redirect image requests → GCS public URLs
// ---------------------------------------------------------------------------

app.get('/image/:site/:code/:file', (req, res) => {
  const { site, code, file } = req.params;
  if (!['viva', 'coelho'].includes(site)) return res.status(400).end();
  if (file.includes('/') || file.includes('..')) return res.status(400).end();
  res.redirect(302, imageUrl(site, code, file));
});

// ---------------------------------------------------------------------------
// API: list images for a listing (returns GCS URLs)
// ---------------------------------------------------------------------------

app.get('/api/images/:site/:code', async (req, res) => {
  const { site, code } = req.params;
  if (!['viva', 'coelho'].includes(site)) return res.status(400).json([]);

  const fsName = fullSite(site);
  const requested = String(req.query.mode || 'standard').toLowerCase();
  const mode = ['standard', 'expanded', 'all'].includes(requested) ? requested : 'standard';

  if (process.env.LOCAL_FIXTURES_MATCHES) {
    const n = mode === 'all' ? 16 : (mode === 'expanded' ? 12 : 6);
    const urls = Array.from({ length: n }, (_, i) =>
      `https://picsum.photos/seed/${site}-${code}-${mode}-${i}/400/300`);
    return res.json(urls);
  }

  if (mode === 'all') {
    // Use the CLIP manifest as the source of truth. Some GCS cache prefixes
    // contain stale images from older scrapes with the same listing code.
    try {
      const manifest = await gcsRead(`selected/${fsName}/${code}/_manifest.json`);
      const entries = manifest.all_categories || manifest.selected || [];
      const urls = entries
        .map(e => e && e.filename)
        .filter(Boolean)
        .map(file => imageUrl(site, code, file));
      if (urls.length) return res.json(urls);
    } catch (_) { /* fall through to legacy cache prefix */ }

    // Legacy fallback: caller asked for everything and no manifest exists.
    try {
      const [files] = await bucket.getFiles({ prefix: `images/${fsName}/${code}/` });
      const urls = files
        .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f.name))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
        .map(f => `${GCS_BASE}/${f.name}`);
      return res.json(urls);
    } catch (e) { return res.json([]); }
  }

  // Try CLIP manifest from GCS for outdoor-filtered modes
  try {
    const manifest = await gcsRead(`selected/${fsName}/${code}/_manifest.json`);
    const entries = mode === 'expanded'
      ? sortOutdoorImages(manifest.all_categories || manifest.selected).slice(0, 32)
      : sortOutdoorImages(manifest.selected || []).slice(0, 8);
    const urls = entries.map(e => mode === 'expanded'
      ? imageUrl(site, code, e.filename)
      : selectedImageUrl(site, code, e.filename)
    );
    if (urls.length) return res.json(urls);
  } catch (_) { /* fall through */ }

  // Fallback: list images from GCS cache prefix
  try {
    const [files] = await bucket.getFiles({ prefix: `images/${fsName}/${code}/` });
    const urls = files
      .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(f => `${GCS_BASE}/${f.name}`);
    return res.json(urls);
  } catch (e) {
    return res.json([]);
  }
});

// ---------------------------------------------------------------------------
// API: mosaic availability — checks GCS for the generated mosaic PNG
// ---------------------------------------------------------------------------

app.get('/api/mosaic/:site/:code', async (req, res) => {
  const { site, code } = req.params;
  if (!['viva', 'coelho'].includes(site)) return res.status(400).json({ available: false });
  const mode = req.query.mode === 'expanded' ? 'expanded' : 'standard';
  const available = await probeMosaic(site, code, mode);
  if (!available) return res.json({ available: false, url: null, mode });
  const url = process.env.LOCAL_FIXTURES_MATCHES
    ? fixturePlaceholderMosaic(site, code, mode)
    : mosaicUrl(site, code, mode);
  res.json({ available: true, url, mode });
});

// ---------------------------------------------------------------------------
// API: reload matches from GCS (call after running sync-to-gcs.sh on Mac)
// ---------------------------------------------------------------------------

app.post('/api/reload', async (req, res) => {
  await loadListingMaps();
  await loadMatches();
  const resetSession = Boolean(req.body && req.body.reset);
  const trialRunId = resetSession ? null : currentSession?.trial_run_id;
  const carryConfirmed = !resetSession && Array.isArray(currentSession && currentSession.confirmed)
    ? currentSession.confirmed
    : [];
  currentSession = buildNewSession(autoMatches, auditMatches, resetSession ? 1 : (currentSession?.pass || 1), carryConfirmed, trialRunId);
  currentSession.compound = normalizeCompound(req.body?.compound)
    || currentSession.compound
    || loadedMatchesMeta.compound
    || null;
  await saveSession();
  _mosaicAvail.clear();
  await logEvent(req, 'session_reloaded', {
    client: req.body || {},
    reset: resetSession,
  });
  res.json({
    ok: true,
    reset: resetSession,
    match_count: autoMatches.length,
    audit_count: auditMatches.length,
    session_review_count: currentSession.pairs.length,
    session_audit_count: currentSession.audit.length,
  });
});

// ---------------------------------------------------------------------------
// API: session state
// ---------------------------------------------------------------------------

app.get('/api/session', (req, res) => {
  if (!currentSession) return res.status(503).json({ error: 'no session' });
  if (!enforceRequestedCompound(req, res)) return;
  const compound = ensureSessionCompound();

  const requested = String(req.query.lane || '').toLowerCase();
  let lane = ALL_LANES.includes(requested) ? requested : 'high';
  const preferredPool = lanePool(lane);
  if (!ALL_LANES.includes(requested) || preferredPool.length === 0) {
    lane = REVIEW_LANES.find(l => lanePool(l).some(p => p.status === 'pending'))
        || REVIEW_LANES.find(l => lanePool(l).length > 0)
        || lane;
  }

  const pool           = lanePool(lane);
  const total          = pool.length;
  const confirmedCount = pool.filter(p => p.status === 'confirmed').length;
  const skippedCount   = pool.filter(p => p.status === 'skipped').length;
  const unsureCount    = pool.filter(p => p.status === 'unsure').length;
  const completed      = confirmedCount + skippedCount + unsureCount;
  const pair           = currentPair(lane);
  const currentIndex   = completed + 1;
  const allDone        = !pair;

  let pairData = null;
  if (pair) {
    const norm   = normalizeTier(pair);
    const viva   = vivaMap[pair.viva_code]   || {};
    const coelho = coelhoMap[pair.coelho_code] || {};
    pairData = {
      viva_code:        pair.viva_code,
      coelho_code:      pair.coelho_code,
      similarity:       pair.similarity,
      confidence_score: pair.confidence_score ?? pair.similarity,
      tier:             pair.tier ?? norm.raw ?? 'medium',
      tier_label:       pair.tier_label || norm.label,
      lane:             pair.lane || norm.lane,
      pool_rank:        pair.pool_rank ?? null,
      facade_rank:      pair.facade_rank ?? null,
      evidence:         pair.evidence || pickEvidence(pair),
      viva,
      coelho,
    };
  }

  // Global confirmed count (across review + audit) for header chip
  const globalConfirmed = Array.isArray(currentSession.confirmed)
    ? currentSession.confirmed.length
    : (currentSession.pairs || []).filter(p => p.status === 'confirmed').length +
      (currentSession.audit  || []).filter(p => p.status === 'confirmed').length;

  res.json({
    trial_run_id:      currentSession.trial_run_id,
    compound,
    community_name:    communityName(compound),
    pass:             currentSession.pass,
    lane,
    current_index:    allDone ? total : currentIndex,
    total,
    confirmed_count:  confirmedCount,
    skipped_count:    skippedCount,
    unsure_count:     unsureCount,
    pair:             pairData,
    all_done:         allDone,
    lanes:            laneCounts(),
    global_confirmed: globalConfirmed,
  });
});

app.post('/api/event', async (req, res) => {
  const body = req.body || {};
  const type = String(body.type || '').slice(0, 80);
  if (!type) return res.status(400).json({ error: 'missing event type' });
  await logEvent(req, type, {
    lane: body.lane || null,
    viva_code: body.viva_code || null,
    coelho_code: body.coelho_code || null,
    mode: body.mode || null,
    source: body.source || null,
    elapsed_ms: Number.isFinite(body.elapsed_ms) ? body.elapsed_ms : null,
    pair: body.pair || null,
    client: body.client || null,
  });
  res.json({ ok: true });
});

// Audit-only listing — returns the reject-low pool for the audit lane UI
app.get('/api/audit', (req, res) => {
  if (!currentSession) return res.status(503).json({ error: 'no session' });
  const audit = (currentSession.audit || []).map(p => ({
    viva_code:   p.viva_code,
    coelho_code: p.coelho_code,
    tier:        p.tier,
    tier_label:  p.tier_label,
    status:      p.status,
    evidence:    p.evidence || pickEvidence(p),
  }));
  res.json({ count: audit.length, audit });
});

// ---------------------------------------------------------------------------
// API: confirm / skip
// ---------------------------------------------------------------------------

app.post('/api/confirm', async (req, res) => {
  const { viva_code, coelho_code } = req.body;
  const pair = findPair(viva_code, coelho_code);
  if (!pair) return res.status(400).json({ error: 'pair not found' });
  pair.status = 'confirmed';
  pair.reviewed_at = new Date().toISOString();
  currentSession.confirmed.push({ ...pair, confirmed_at: pair.reviewed_at });
  const retired = retirePendingAlternates(pair);
  console.log(`✓ confirmed  Viva ${viva_code} ↔ Coelho ${coelho_code} (lane=${pair.lane || 'unknown'})`);
  await saveSession();
  await logEvent(req, 'decision_confirmed', {
    viva_code,
    coelho_code,
    lane: pair.lane || normalizeTier(pair).lane,
    retired_alternates: retired,
    elapsed_ms: req.body.elapsed_ms,
    pair: pairSnapshot(pair),
  });
  res.json({ ok: true });
});

app.post('/api/skip', async (req, res) => {
  const { viva_code, coelho_code } = req.body;
  const pair = findPair(viva_code, coelho_code);
  if (!pair) return res.status(400).json({ error: 'pair not found' });
  pair.status = 'skipped';
  pair.reviewed_at = new Date().toISOString();
  console.log(`✗ skipped    Viva ${viva_code} ↔ Coelho ${coelho_code} (lane=${pair.lane || 'unknown'})`);
  await saveSession();
  await logEvent(req, 'decision_skipped', {
    viva_code,
    coelho_code,
    lane: pair.lane || normalizeTier(pair).lane,
    elapsed_ms: req.body.elapsed_ms,
    pair: pairSnapshot(pair),
  });
  res.json({ ok: true });
});

app.post('/api/unsure', async (req, res) => {
  const { viva_code, coelho_code, note } = req.body;
  const pair = findPair(viva_code, coelho_code);
  if (!pair) return res.status(400).json({ error: 'pair not found' });
  pair.status = 'unsure';
  pair.reviewed_at = new Date().toISOString();
  if (note) pair.note = String(note).slice(0, 500);
  console.log(`? unsure     Viva ${viva_code} ↔ Coelho ${coelho_code} (lane=${pair.lane || 'unknown'})`);
  await saveSession();
  await logEvent(req, 'decision_unsure', {
    viva_code,
    coelho_code,
    lane: pair.lane || normalizeTier(pair).lane,
    elapsed_ms: req.body.elapsed_ms,
    pair: pairSnapshot(pair),
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// API: done — save final, clear session, tell user to re-run on Mac
// ---------------------------------------------------------------------------

app.post('/api/done', async (req, res) => {
  const skipped = currentSession.pairs.filter(p => p.status === 'skipped');
  const confirmed = currentSession.confirmed;

  // Save final matches to GCS
  const finalOutput = {
    generated_at:    new Date().toISOString(),
    total_confirmed: confirmed.length,
    matches: confirmed.map(p => ({
      viva_code:    p.viva_code,
      coelho_code:  p.coelho_code,
      similarity:   p.similarity,
      confirmed_at: p.confirmed_at,
      pass:         currentSession.pass,
    })),
  };
  await gcsWrite('review-sessions/final-matches.json', finalOutput);

  res.json({
    ok: true,
    confirmed: confirmed.length,
    skipped:   skipped.length,
    message:   skipped.length > 0
      ? `${skipped.length} pairs skipped. Run recursive-matcher-v2.py on your Mac, then sync-to-gcs.sh, then POST /api/reload to load new matches.`
      : 'All pairs reviewed. Final matches saved to GCS.',
    skipped_viva_codes: skipped.map(p => p.viva_code),
  });
});

// ---------------------------------------------------------------------------
// API: final — generate downloadable final-matches.json
// ---------------------------------------------------------------------------

app.post('/api/final', async (req, res) => {
  const confirmed = currentSession ? currentSession.confirmed : [];
  const trialSummary = buildTrialSummary();
  const output = {
    generated_at:    new Date().toISOString(),
    trial_run_id:    currentSession?.trial_run_id || null,
    total_confirmed: confirmed.length,
    total_viva_listings: trialSummary.total_viva_listings,
    total_coelho_listings: trialSummary.total_coelho_listings,
    pending_viva_count: trialSummary.pending_viva_count,
    reviewed_unmatched_viva_count: trialSummary.reviewed_unmatched_viva_count,
    never_reviewed_viva_count: trialSummary.never_reviewed_viva_count,
    matches: confirmed.map(p => ({
      viva_code:    p.viva_code,
      coelho_code:  p.coelho_code,
      similarity:   p.similarity,
      confirmed_at: p.confirmed_at,
      pass:         p.pass || currentSession.pass,
    })),
  };
  await gcsWrite('review-sessions/final-matches.json', output);
  await gcsWrite(`review-sessions/trial-summaries/${trialSummary.trial_run_id || 'no-session'}.json`, trialSummary);
  await logEvent(req, 'trial_finalized', {
    client: req.body || {},
    lane: req.body?.lane || null,
    elapsed_ms: req.body?.elapsed_ms,
  });
  res.json(output);
});

app.post('/api/start-next-round', async (req, res) => {
  if (!currentSession) return res.status(503).json({ error: 'no session' });

  const currentPass = Number(currentSession.pass || 1);
  const nextPass = currentPass + 1;
  const trialRunId = currentSession.trial_run_id || null;
  const summary = buildTrialSummary();
  const summaryPath = `review-sessions/trial-summaries/${trialRunId || 'no-session'}.json`;
  const summaryUrl = `${GCS_BASE}/${summaryPath}`;
  const statusPath = roundStatusPath(trialRunId, nextPass);
  await gcsWrite(summaryPath, summary);

  if (!summary.pending_viva_count) {
    return res.json({
      ok: false,
      done: true,
      message: 'All Viva listings in this session already have confirmed matches.',
      summary,
    });
  }

  try {
    const { review, audit, sourcePath } = await loadRoundFromGcs(nextPass, trialRunId);
    await logEvent(req, 'round_started', {
      from_pass: currentPass,
      next_pass: nextPass,
      session_review_count: currentSession.pairs.length,
      session_audit_count: currentSession.audit.length,
      pending_viva_count: summary.pending_viva_count,
      source_path: sourcePath,
    });
    return res.json({
      ok: true,
      pass: nextPass,
      review_count: currentSession.pairs.length,
      audit_count: currentSession.audit.length,
      lanes: laneCounts(),
      summary,
    });
  } catch (e) {
    const existing = await readRoundStatus(statusPath);
    if (existing && ['queued', 'running'].includes(existing.state)) {
      return res.status(202).json({
        ok: false,
        generating: true,
        next_pass: nextPass,
        pending_viva_count: summary.pending_viva_count,
        status: existing,
      });
    }

    const queued = await queueRoundForMacWorker({ nextPass, trialRunId, summaryPath, summaryUrl, statusPath, summary });
    await logEvent(req, 'next_round_queued_for_mac_worker', {
      next_pass: nextPass,
      pending_viva_count: summary.pending_viva_count,
      status_path: statusPath,
      output_path: queued.output_path,
    });
    return res.status(202).json({
      ok: false,
      generating: true,
      worker_required: true,
      next_pass: nextPass,
      pending_viva_count: summary.pending_viva_count,
      status_path: statusPath,
      command: queued.command,
      status: queued,
    });
  }
});

app.get('/api/round-status', async (req, res) => {
  if (!currentSession) return res.status(503).json({ error: 'no session' });
  const requestedRound = Number(req.query.round || 0);
  const round = requestedRound || Number(currentSession.pass || 1) + 1;
  const trialRunId = currentSession.trial_run_id || null;
  const statusPath = roundStatusPath(trialRunId, round);
  const status = await readRoundStatus(statusPath);
  if (!status) {
    if (Number(currentSession.pass || 0) >= round) {
      return res.json({
        ok: true,
        ready: true,
        already_loaded: true,
        pass: currentSession.pass,
        review_count: currentSession.pairs.length,
        audit_count: currentSession.audit.length,
        lanes: laneCounts(),
        status: {
          state: 'ready',
          round,
          message: `Round ${round} is already loaded`,
        },
      });
    }
    try {
      const { review, audit, sourcePath } = await loadRoundFromGcs(round, trialRunId);
      await logEvent(req, 'round_loaded_without_status', {
        next_pass: round,
        source_path: sourcePath,
        session_review_count: currentSession.pairs.length,
        session_audit_count: currentSession.audit.length,
      });
      return res.json({
        ok: true,
        ready: true,
        pass: round,
        review_count: review.length,
        audit_count: audit.length,
        lanes: laneCounts(),
        status: {
          state: 'ready',
          round,
          source_path: sourcePath,
          message: `Round ${round} was found in GCS and loaded`,
        },
      });
    } catch (_) {
      return res.status(404).json({
        ok: false,
        round,
        state: 'missing',
        command: macWorkerCommand(statusPath),
        message: `Round ${round} has not been queued or uploaded yet.`,
      });
    }
  }
  if (status.state === 'ready') {
    try {
      const { review, audit, sourcePath } = await loadRoundFromGcs(round, trialRunId);
      await logEvent(req, 'round_loaded_after_generation', {
        next_pass: round,
        source_path: sourcePath,
        session_review_count: currentSession.pairs.length,
        session_audit_count: currentSession.audit.length,
      });
      return res.json({
        ok: true,
        ready: true,
        pass: round,
        review_count: review.length,
        audit_count: audit.length,
        lanes: laneCounts(),
        status,
      });
    } catch (e) {
      return res.status(500).json({ ok: false, round, state: 'load_failed', message: e.message, status });
    }
  }
  res.json({ ok: false, generating: ['queued', 'running'].includes(status.state), round, status });
});

app.get('/api/trial-summary', async (req, res) => {
  const summary = buildTrialSummary();
  res.json(summary);
});

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(HTML);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function start() {
  console.log(`GCS bucket: ${GCS_BUCKET}`);
  await loadListingMaps();
  await loadMatches();
  await ensureSession();
  app.listen(PORT, () => {
    console.log(`\n🏠 Review server → http://localhost:${PORT}\n`);
  });
}

start().catch(e => { console.error('Fatal:', e); process.exit(1); });

// ---------------------------------------------------------------------------
// Embedded HTML UI (unchanged from original — image URLs now come from API)
// ---------------------------------------------------------------------------

const HTML = /* html */`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Match Review</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    color-scheme: light;
    --bg: #eef2f6;
    --surface: #ffffff;
    --surface-soft: #f7f9fc;
    --surface-strong: #182230;
    --border: #d8e0ea;
    --border-strong: #b6c3d1;
    --text: #17202e;
    --muted: #687586;
    --muted-strong: #455468;
    --accent: #007aff;
    --accent-soft: #eaf3ff;
    --green: #15803d;
    --green-soft: #dcfce7;
    --red: #c2410c;
    --red-soft: #ffedd5;
    --yellow: #a16207;
    --yellow-soft: #fef3c7;
    --cyan: #0f766e;
    --cyan-soft: #ccfbf1;
    --control-fill: rgba(255, 255, 255, 0.82);
    --control-stroke: rgba(15, 23, 42, 0.12);
    --shadow: 0 18px 46px rgba(15, 23, 42, 0.12);
    --radius: 8px;
  }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, Inter, ui-sans-serif, system-ui, "Segoe UI", sans-serif;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    line-height: 1.4;
  }
  a { color: inherit; }
  button {
    font: inherit;
    cursor: pointer;
    border: 0;
    border-radius: var(--radius);
    transition: background-color 0.15s, border-color 0.15s, color 0.15s, transform 0.15s, box-shadow 0.15s;
  }
  button:hover { transform: translateY(-1px); }
  button:disabled { cursor: not-allowed; opacity: 0.55; transform: none; }
  button:focus-visible, a:focus-visible { outline: 3px solid rgba(37, 99, 235, 0.35); outline-offset: 2px; }
  .app-header {
    position: sticky;
    top: 0;
    z-index: 40;
    pointer-events: none;
    background: rgba(255, 255, 255, 0.94);
    backdrop-filter: blur(16px);
    border-bottom: 1px solid var(--border);
  }
  .header-inner {
    width: min(1680px, 100%);
    margin: 0 auto;
    padding: 16px 24px 14px;
    display: grid;
    gap: 14px;
  }
  .topline {
    display: grid;
    grid-template-columns: minmax(220px, 1fr) auto;
    gap: 18px;
    align-items: start;
  }
  .eyebrow {
    color: var(--cyan);
    font-size: 0.72rem;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  h1 {
    margin-top: 2px;
    font-size: clamp(1.25rem, 2vw, 1.85rem);
    line-height: 1.08;
    letter-spacing: 0;
  }
  .subhead {
    color: var(--muted);
    font-size: 0.88rem;
    margin-top: 4px;
  }
  .status-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(92px, 1fr));
    gap: 8px;
  }
  .status-item {
    min-height: 58px;
    padding: 9px 11px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-soft);
  }
  .status-label {
    display: block;
    color: var(--muted);
    font-size: 0.68rem;
    font-weight: 800;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .status-value {
    display: block;
    margin-top: 3px;
    color: var(--text);
    font-size: 1rem;
    font-weight: 800;
    white-space: nowrap;
  }
  .progress-row {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 12px;
    align-items: center;
  }
  .progress-bar {
    width: 100%;
    height: 10px;
    overflow: hidden;
    background: #e2e8f0;
    border-radius: 999px;
  }
  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--cyan), var(--accent));
    border-radius: inherit;
    transition: width 0.3s;
  }
  .progress-copy {
    color: var(--muted);
    font-size: 0.82rem;
    font-weight: 700;
    white-space: nowrap;
  }
  .lane-tabs {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 8px;
    pointer-events: auto;
  }
  .lane-tab {
    display: flex;
    min-height: 46px;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 9px 12px;
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--muted-strong);
    font-size: 0.9rem;
    font-weight: 800;
  }
  .lane-tab:hover:not(.active) { border-color: var(--border-strong); background: var(--surface-soft); }
  .lane-tab.active {
    color: var(--text);
    border-color: var(--accent);
    background: var(--accent-soft);
    box-shadow: inset 0 0 0 1px rgba(37, 99, 235, 0.16);
  }
  .lane-tab .lane-count {
    display: inline-flex;
    min-width: 50px;
    justify-content: center;
    border-radius: 999px;
    padding: 2px 8px;
    background: rgba(255, 255, 255, 0.72);
    color: var(--muted-strong);
    font-size: 0.76rem;
  }
  .lane-tab.is-empty { opacity: 0.58; }
  .lane-tab.is-audit { display: none; border-style: dashed; }
  .workspace {
    width: min(1680px, 100%);
    margin: 0 auto;
    padding: 20px 24px 124px;
    flex: 1;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 16px;
    align-items: start;
  }
  .hidden { display: none !important; }
  .session-error {
    width: min(920px, calc(100% - 48px));
    margin: 20px auto 124px;
    padding: 18px;
    border: 1px solid #fbbf24;
    border-radius: var(--radius);
    background: #fffbeb;
    box-shadow: var(--shadow);
  }
  .session-error h2 {
    margin-bottom: 8px;
    font-size: 1.1rem;
    letter-spacing: 0;
  }
  .session-error p {
    color: var(--muted-strong);
    line-height: 1.5;
  }
  .prop-card {
    min-width: 0;
    display: grid;
    grid-template-rows: auto minmax(280px, 1fr) auto auto;
    gap: 14px;
    padding: 14px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    box-shadow: var(--shadow);
  }
  .prop-header {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 12px;
    align-items: start;
  }
  .prop-identity {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .prop-source {
    display: inline-flex;
    align-items: center;
    min-height: 26px;
    padding: 3px 9px;
    border-radius: 999px;
    color: #fff;
    font-size: 0.74rem;
    font-weight: 900;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .source-viva { background: #7c3aed; }
  .source-coelho { background: #0f766e; }
  .prop-code {
    color: var(--muted-strong);
    font-size: 0.93rem;
    font-weight: 800;
  }
  .prop-link {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 34px;
    padding: 7px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-soft);
    color: var(--muted-strong);
    font-size: 0.82rem;
    font-weight: 800;
    text-decoration: none;
    white-space: nowrap;
  }
  .prop-link:hover { border-color: var(--accent); color: var(--accent); }
  .prop-img {
    position: relative;
    width: 100%;
    min-height: 280px;
    aspect-ratio: 2 / 1;
    scroll-margin: 180px 0 190px;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: #0f172a;
    color: #fff;
  }
  .prop-img:hover { transform: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.16); }
  .prop-img .mosaic-img {
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
  }
  .prop-img.is-fallback { aspect-ratio: auto; min-height: 330px; background: #101827; }
  .prop-img .img-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 3px;
    width: 100%;
    height: 100%;
    padding: 3px;
  }
  .prop-img .img-grid img { width: 100%; height: 130px; object-fit: cover; border-radius: 4px; }
  .prop-img .zoom-hint {
    position: absolute;
    right: 10px;
    bottom: 10px;
    padding: 5px 9px;
    border-radius: 999px;
    background: rgba(15, 23, 42, 0.76);
    color: #fff;
    font-size: 0.72rem;
    font-weight: 800;
    pointer-events: none;
  }
  .prop-img .no-img { color: #cbd5e1; font-size: 0.9rem; padding: 40px; }
  .prop-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    min-height: 34px;
  }
  .fact {
    display: inline-flex;
    align-items: center;
    min-height: 30px;
    padding: 5px 9px;
    border-radius: 999px;
    background: var(--surface-soft);
    border: 1px solid var(--border);
    color: var(--muted-strong);
    font-size: 0.84rem;
    font-weight: 750;
  }
  .fact strong { color: var(--text); font-weight: 850; }
  .fact-price { color: var(--green); background: var(--green-soft); border-color: #bbf7d0; }
  .muted-empty { color: var(--muted); font-size: 0.86rem; align-self: center; }
  .decision-bar {
    position: fixed;
    left: 50%;
    bottom: 14px;
    transform: translateX(-50%);
    z-index: 35;
    pointer-events: none;
    width: min(1380px, calc(100% - 32px));
    display: grid;
    grid-template-columns: minmax(210px, 0.78fr) minmax(280px, 1.2fr) auto;
    gap: 12px;
    align-items: center;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: rgba(255, 255, 255, 0.96);
    box-shadow: 0 22px 70px rgba(15, 23, 42, 0.22);
    backdrop-filter: blur(18px);
  }
  .decision-summary {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 12px;
    align-items: center;
    min-width: 0;
  }
  .score-card {
    min-width: 122px;
    padding: 9px 10px;
    border-radius: var(--radius);
    background: var(--surface-strong);
    color: #fff;
  }
  .score-label {
    display: block;
    color: #cbd5e1;
    font-size: 0.68rem;
    font-weight: 850;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .sim-val {
    display: block;
    margin-top: 2px;
    color: #fff;
    font-size: 1.26rem;
    font-weight: 900;
    line-height: 1;
  }
  .sim-val.high { color: #86efac; }
  .sim-val.medium { color: #fde68a; }
  .sim-val.low { color: #fdba74; }
  .pair-status {
    min-width: 0;
    display: grid;
    gap: 5px;
  }
  .tier-label {
    display: inline-flex;
    width: fit-content;
    max-width: 100%;
    align-items: center;
    min-height: 25px;
    padding: 3px 9px;
    border-radius: 999px;
    font-size: 0.73rem;
    font-weight: 900;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .tier-high { background: var(--green-soft); color: var(--green); border: 1px solid #86efac; }
  .tier-medium { background: var(--yellow-soft); color: var(--yellow); border: 1px solid #fde68a; }
  .tier-low { background: var(--red-soft); color: var(--red); border: 1px solid #fed7aa; }
  .pair-counter {
    color: var(--muted);
    font-size: 0.82rem;
    font-weight: 750;
  }
  .pair-counter strong { color: var(--text); }
  .evidence-panel {
    min-width: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 7px 10px;
    align-items: center;
    color: var(--muted);
    font-size: 0.8rem;
  }
  .evidence-panel[hidden] { display: none; }
  .evidence-panel .ev-group { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .evidence-panel .ev-label {
    color: var(--muted);
    font-size: 0.68rem;
    font-weight: 900;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .evidence-panel .ev-val { color: var(--text); font-weight: 850; }
  .ev-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-height: 25px;
    padding: 3px 8px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface-soft);
    color: var(--muted-strong);
    font-size: 0.75rem;
    font-weight: 800;
  }
  .ev-chip.is-active { border-color: #93c5fd; background: var(--accent-soft); color: var(--accent); }
  .ev-chip .ev-score { color: var(--muted-strong); font-weight: 750; font-size: 0.72rem; }
  .ev-pairs {
    flex-basis: 100%;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding-top: 2px;
  }
  .ev-pairs .ev-pair {
    display: inline-flex;
    min-height: 24px;
    align-items: center;
    padding: 2px 7px;
    border-radius: 999px;
    background: var(--surface-soft);
    color: var(--muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.7rem;
  }
  .ev-pairs .ev-pair strong { color: var(--text); font-weight: 850; }
  .actions {
    display: grid;
    grid-template-columns: repeat(4, minmax(92px, max-content));
    gap: 7px;
    justify-content: end;
    pointer-events: auto;
    padding: 5px;
    border: 1px solid rgba(15, 23, 42, 0.08);
    border-radius: 16px;
    background: rgba(248, 250, 252, 0.78);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.84);
  }
  .modal-row button {
    min-height: 42px;
    padding: 9px 14px;
    font-size: 0.9rem;
    font-weight: 900;
    white-space: nowrap;
  }
  .actions button {
    min-height: 44px;
    padding: 9px 16px;
    border: 1px solid var(--control-stroke);
    border-radius: 12px;
    background: var(--control-fill);
    color: var(--muted-strong);
    box-shadow: 0 1px 2px rgba(15, 23, 42, 0.06), inset 0 1px 0 rgba(255, 255, 255, 0.95);
    font-size: 0.9rem;
    font-weight: 750;
    letter-spacing: 0;
    white-space: nowrap;
  }
  .actions button:hover {
    background: #fff;
    border-color: rgba(15, 23, 42, 0.18);
    box-shadow: 0 5px 16px rgba(15, 23, 42, 0.09), inset 0 1px 0 rgba(255, 255, 255, 0.95);
  }
  .actions button:active {
    transform: translateY(0) scale(0.985);
    box-shadow: inset 0 1px 2px rgba(15, 23, 42, 0.12);
  }
  #btn-skip {
    background: rgba(255, 245, 245, 0.88);
    color: #b42318;
    border-color: rgba(244, 63, 94, 0.18);
  }
  #btn-unsure {
    background: rgba(255, 248, 230, 0.9);
    color: #936000;
    border-color: rgba(245, 158, 11, 0.2);
  }
  #btn-match {
    background: linear-gradient(180deg, #1c8cff 0%, var(--accent) 100%);
    border-color: rgba(0, 122, 255, 0.72);
    color: #fff;
    box-shadow: 0 8px 18px rgba(0, 122, 255, 0.24), inset 0 1px 0 rgba(255, 255, 255, 0.34);
    font-weight: 800;
  }
  #btn-match:hover {
    background: linear-gradient(180deg, #2f98ff 0%, #087cff 100%);
    border-color: rgba(0, 122, 255, 0.84);
    box-shadow: 0 10px 22px rgba(0, 122, 255, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.38);
  }
  #btn-done {
    background: rgba(241, 245, 249, 0.86);
    color: var(--muted-strong);
    border-color: rgba(100, 116, 139, 0.16);
  }
  .lane-summary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 12px; }
  .lane-summary .lane-cell {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 9px;
    background: var(--surface-soft);
    color: var(--muted-strong);
    font-size: 0.82rem;
  }
  .lane-summary .lane-cell strong {
    display: block;
    margin-bottom: 4px;
    color: var(--text);
    font-size: 0.72rem;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .modal-bg { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.58);
              display: flex; align-items: center; justify-content: center; z-index: 100; padding: 20px; }
  .modal-bg.hidden { display: none; }
  .modal {
    width: min(560px, 100%);
    display: flex;
    flex-direction: column;
    gap: 18px;
    padding: 24px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    box-shadow: var(--shadow);
  }
  .modal h2 { font-size: 1.18rem; letter-spacing: 0; }
  .modal p { color: var(--muted); font-size: 0.92rem; line-height: 1.5; }
  .modal-row { display: flex; gap: 10px; justify-content: flex-end; flex-wrap: wrap; }
  .btn-outline { background: var(--surface-soft); border: 1px solid var(--border); color: var(--muted-strong); }
  .btn-green { background: var(--green); color: #fff; }
  .btn-accent { background: var(--accent); color: #fff; }
  .stat-row { display: flex; gap: 12px; flex-wrap: wrap; }
  .stat { display: flex; flex-direction: column; }
  .stat-val { font-size: 1.8rem; font-weight: 900; }
  .stat-lbl { font-size: 0.8rem; color: var(--muted); }
  .green { color: var(--green); } .red { color: var(--red); }
  .compare-bg { position: fixed; inset: 0; background: #0b1018;
                overflow-y: auto; z-index: 200; padding: 18px; }
  .compare-bg.hidden { display: none; }
  .compare-header { position: sticky; top: -18px; background: rgba(11, 16, 24, 0.94);
                    margin: -18px -18px 16px; padding: 16px 18px;
                    z-index: 1; display: grid; grid-template-columns: 1fr auto; gap: 12px;
                    align-items: center; border-bottom: 1px solid rgba(255,255,255,0.12);
                    backdrop-filter: blur(14px); }
  .compare-titlebar { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
  .compare-titlebar h3 { color: #fff; font-size: 1rem; }
  .compare-close { background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.14);
                   color: #fff; padding: 8px 14px; font-size: 0.9rem; font-weight: 850; }
  .compare-modes { display: inline-flex; justify-self: end; background: rgba(255,255,255,0.08);
                   border: 1px solid rgba(255,255,255,0.14); border-radius: var(--radius); padding: 3px; }
  .compare-modes button { background: transparent; color: #cbd5e1;
                          padding: 7px 13px; font-size: 0.84rem; font-weight: 850; }
  .compare-modes button.active { background: var(--accent); color: #fff; }
  .compare-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .compare-col { background: #101827; border: 1px solid rgba(255,255,255,0.12);
                 border-radius: var(--radius); padding: 12px; }
  .compare-col h4 { font-size: 0.9rem; margin-bottom: 10px; color: #94a3b8; }
  .compare-col h4 strong { color: #fff; }
  .compare-mosaic { width: 100%; border-radius: 8px; display: block; }
  .compare-images { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .compare-images img { width: 100%; height: 180px; object-fit: cover;
                        border-radius: 6px; cursor: zoom-in; }
  .compare-empty { color: #94a3b8; font-size: 0.9rem; padding: 28px; text-align: center; }
  .notice { background: var(--accent-soft); border: 1px solid #93c5fd; border-radius: var(--radius);
            padding: 12px 14px; font-size: 0.88rem; color: var(--text); line-height: 1.5; }
  .notice code { color: var(--accent); font-size: 0.82rem; }
  @media (max-width: 1100px) {
    .topline { grid-template-columns: 1fr; }
    .status-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    .decision-bar {
      grid-template-columns: 1fr;
      align-items: stretch;
    }
    .actions { grid-template-columns: repeat(4, minmax(0, 1fr)); justify-content: stretch; }
    .actions button { width: 100%; }
  }
  @media (max-width: 820px) {
    .app-header { position: static; }
    .header-inner { padding: 14px 14px 12px; }
    .status-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
    .status-item { min-height: 50px; padding: 8px 7px; }
    .status-label { font-size: 0.58rem; }
    .status-value { font-size: 0.94rem; }
    .lane-tabs { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
    .workspace {
      grid-template-columns: 1fr;
      padding: 14px 14px 264px;
    }
    .prop-card {
      grid-template-rows: auto auto auto auto;
      padding: 12px;
      box-shadow: 0 10px 28px rgba(15, 23, 42, 0.12);
    }
    .prop-header { grid-template-columns: 1fr; }
    .prop-link { width: 100%; }
    .prop-img { min-height: 220px; scroll-margin: 230px 0 270px; }
    .prop-img.is-fallback { min-height: 300px; }
    .decision-bar {
      bottom: 0;
      width: 100%;
      border-right: 0;
      border-bottom: 0;
      border-left: 0;
      border-radius: 8px 8px 0 0;
    }
    .decision-summary { grid-template-columns: 96px minmax(0, 1fr); }
    .score-card { min-width: 0; }
    .sim-val { font-size: 1.08rem; }
    .evidence-panel {
      flex-wrap: nowrap;
      overflow-x: auto;
      padding-bottom: 2px;
      scrollbar-width: thin;
    }
    .evidence-panel .ev-group { flex: 0 0 auto; }
    .ev-pairs { display: none; }
    .actions {
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 6px;
      padding: 6px;
      border-radius: 14px;
    }
    .actions button { min-height: 44px; padding: 8px 7px; white-space: normal; font-size: 0.82rem; }
    .compare-header { grid-template-columns: 1fr; }
    .compare-modes { justify-self: stretch; display: grid; grid-template-columns: repeat(3, 1fr); }
    .compare-grid { grid-template-columns: 1fr; }
    .compare-images img { height: 138px; }
    .lane-summary { grid-template-columns: 1fr; }
  }
  @media (max-width: 460px) {
    .progress-row { grid-template-columns: 1fr; }
    .progress-copy { white-space: normal; }
    .lane-tab { font-size: 0.82rem; padding: 8px; }
    .lane-tab .lane-count { min-width: 44px; padding: 2px 5px; }
    .prop-img .img-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .prop-img .img-grid img { height: 112px; }
    .compare-modes button { padding: 7px 6px; font-size: 0.78rem; }
  }
</style>
</head>
<body>

<header class="app-header">
  <div class="header-inner">
    <div class="topline">
      <div>
        <p class="eyebrow">AI property matching</p>
        <h1 id="community-title">Review desk</h1>
        <p class="subhead" id="community-subhead">Loading active queue</p>
      </div>
      <div class="status-grid" aria-label="Review status">
        <div class="status-item">
          <span class="status-label">Pass</span>
          <span class="status-value" id="hdr-pass">1</span>
        </div>
        <div class="status-item">
          <span class="status-label">Current</span>
          <span class="status-value"><span id="hdr-current">1</span> / <span id="hdr-total">?</span></span>
        </div>
        <div class="status-item">
          <span class="status-label">Reviewed</span>
          <span class="status-value"><span id="hdr-confirmed">0</span> / <span id="hdr-skipped">0</span></span>
        </div>
        <div class="status-item">
          <span class="status-label">Confirmed</span>
          <span class="status-value" id="hdr-global">0</span>
        </div>
      </div>
    </div>
    <div class="progress-row">
      <div class="progress-bar" aria-hidden="true"><div class="progress-fill" id="progress-fill" style="width:0%"></div></div>
      <div class="progress-copy"><span id="hdr-percent">0%</span> complete</div>
    </div>
  <div class="lane-tabs" role="tablist" aria-label="Review lanes">
    <button class="lane-tab" id="lane-high"   role="tab" onclick="switchLane('high')"  >High <span class="lane-count" id="lane-count-high">0/0</span></button>
    <button class="lane-tab" id="lane-normal" role="tab" onclick="switchLane('normal')">Normal <span class="lane-count" id="lane-count-normal">0/0</span></button>
    <button class="lane-tab" id="lane-recall" role="tab" onclick="switchLane('recall')">Recall <span class="lane-count" id="lane-count-recall">0/0</span></button>
    <button class="lane-tab is-audit" id="lane-audit" role="tab" onclick="switchLane('audit')">Audit <span class="lane-count" id="lane-count-audit">0/0</span></button>
  </div>
  </div>
</header>

<section class="session-error hidden" id="session-error" role="alert">
  <h2 id="session-error-title">Review queue mismatch</h2>
  <p id="session-error-text">This review link does not match the active queue.</p>
</section>

<main class="workspace" id="review-panel">
  <div class="prop-card">
    <div class="prop-header">
      <div class="prop-identity">
        <span class="prop-source source-viva">Viva</span>
        <span class="prop-code" id="viva-code"></span>
      </div>
      <a class="prop-link" id="viva-link" href="#" target="_blank" rel="noopener">Open Viva</a>
    </div>
    <button class="prop-img" id="viva-img" onclick="openComparison()" aria-label="Open Viva image comparison">
      <span class="zoom-hint">Compare</span>
    </button>
    <div class="prop-meta" id="viva-meta" aria-label="Viva listing facts"></div>
  </div>

  <div class="prop-card">
    <div class="prop-header">
      <div class="prop-identity">
        <span class="prop-source source-coelho">Coelho</span>
        <span class="prop-code" id="coelho-code"></span>
      </div>
      <a class="prop-link" id="coelho-link" href="#" target="_blank" rel="noopener">Open Coelho</a>
    </div>
    <button class="prop-img" id="coelho-img" onclick="openComparison()" aria-label="Open Coelho image comparison">
      <span class="zoom-hint">Compare</span>
    </button>
    <div class="prop-meta" id="coelho-meta" aria-label="Coelho listing facts"></div>
  </div>
</main>

<footer class="decision-bar">
  <div class="decision-summary">
    <div class="score-card">
      <span class="score-label">Confidence</span>
      <span class="sim-val" id="sim-val">—</span>
    </div>
    <div class="pair-status">
      <span id="sim-extra" class="tier-label"></span>
      <span class="pair-counter">Pair <strong id="footer-current">1</strong> of <strong id="footer-total">?</strong> · Pass <strong id="footer-pass">1</strong></span>
    </div>
  </div>
  <div class="evidence-panel" id="evidence-panel" hidden></div>
  <div class="actions">
    <button id="btn-skip"   onclick="doSkip()"   aria-label="Not a match">No match</button>
    <button id="btn-unsure" onclick="doUnsure()" aria-label="Mark as unsure">Unsure</button>
    <button id="btn-match"  onclick="doMatch()"  aria-label="Confirm match">Match</button>
    <button id="btn-done"   onclick="askDone()"  aria-label="Finish review">Finish</button>
  </div>
</footer>

<!-- Pass complete modal -->
<div class="modal-bg hidden" id="pass-complete-modal" role="dialog" aria-modal="true" aria-labelledby="pc-heading">
  <div class="modal">
    <h2 id="pc-heading">Pass <span id="pc-pass">1</span> complete</h2>
    <div class="stat-row">
      <div class="stat"><span class="stat-val green" id="pc-confirmed">0</span><span class="stat-lbl">Matched</span></div>
      <div class="stat"><span class="stat-val red"   id="pc-skipped">0</span><span class="stat-lbl">Rejected</span></div>
    </div>
    <div class="notice" id="pc-notice"></div>
    <div id="pc-next-round-help"></div>
    <div class="modal-row">
      <button class="btn-outline" onclick="finalize()">Finalize</button>
      <button class="btn-accent" id="pc-next-round-btn" onclick="startNextRound('pass-complete')">Prepare next round</button>
      <button class="btn-accent"  id="pc-reload-btn" onclick="reloadAndContinue()">Reload matches</button>
    </div>
  </div>
</div>

<!-- Done confirm modal -->
<div class="modal-bg hidden" id="done-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="dc-heading">
  <div class="modal">
    <h2 id="dc-heading">Confirm finish</h2>
    <p id="done-confirm-text"></p>
    <div class="modal-row">
      <button class="btn-outline" onclick="closeDoneModal()">Go back</button>
      <button class="btn-green"   onclick="finalize()">Finish</button>
    </div>
  </div>
</div>

<!-- Final modal -->
<div class="modal-bg hidden" id="final-modal" role="dialog" aria-modal="true" aria-labelledby="final-heading">
  <div class="modal">
    <h2 id="final-heading">Review complete</h2>
    <div class="stat-row">
      <div class="stat"><span class="stat-val green" id="final-count">0</span><span class="stat-lbl">Matched pairs</span></div>
    </div>
    <p id="final-breakdown"></p>
    <div class="modal-row">
      <button class="btn-accent" id="next-round-btn" onclick="startNextRound('final')">Prepare round 2</button>
      <button class="btn-green" onclick="downloadFinal()">Download JSON</button>
    </div>
  </div>
</div>

<!-- Comparison modal -->
<div class="compare-bg hidden" id="compare" role="dialog" aria-modal="true" aria-labelledby="compare-title">
  <div class="compare-header">
    <div class="compare-titlebar">
      <h3 id="compare-title">Expanded mosaic comparison</h3>
      <button class="compare-close" onclick="closeComparison()" aria-label="Close comparison">Close</button>
    </div>
    <div class="compare-modes" role="tablist" aria-label="Comparison mode">
      <button id="cmp-mode-standard" role="tab" onclick="setComparisonMode('standard')">Standard</button>
      <button id="cmp-mode-expanded" role="tab" onclick="setComparisonMode('expanded')" class="active">Expanded outdoor</button>
      <button id="cmp-mode-all"      role="tab" onclick="setComparisonMode('all')">All photos</button>
    </div>
  </div>
  <div class="compare-grid">
    <section class="compare-col" aria-labelledby="cmp-viva-title">
      <h4 id="cmp-viva-title">Viva <strong id="cmp-viva-code"></strong></h4>
      <div id="cmp-viva-body"></div>
    </section>
    <section class="compare-col" aria-labelledby="cmp-coelho-title">
      <h4 id="cmp-coelho-title">Coelho <strong id="cmp-coelho-code"></strong></h4>
      <div id="cmp-coelho-body"></div>
    </section>
  </div>
</div>

<script>
let _state = null;
let _finalData = null;
let _lane = 'high';
let _pageStartedAt = Date.now();
let _pairStartedAt = Date.now();
let _lastPairKey = null;
const _requestedCompound = new URLSearchParams(window.location.search).get('compound') || '';

function currentPairKey() {
  return _state && _state.pair ? _state.pair.viva_code + ':' + _state.pair.coelho_code : null;
}

function pairPayload() {
  if (!_state || !_state.pair) return null;
  return {
    viva_code: _state.pair.viva_code,
    coelho_code: _state.pair.coelho_code,
    lane: _state.pair.lane,
    tier: _state.pair.tier,
    confidence_score: _state.pair.confidence_score,
  };
}

function logClientEvent(type, extra) {
  const p = pairPayload();
  const body = Object.assign({
    type,
    lane: _lane,
    viva_code: p && p.viva_code,
    coelho_code: p && p.coelho_code,
    elapsed_ms: Date.now() - _pairStartedAt,
    pair: p,
    client: {
      page_elapsed_ms: Date.now() - _pageStartedAt,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    },
  }, extra || {});
  try {
    const json = JSON.stringify(body);
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/event', new Blob([json], { type: 'application/json' }));
      return;
    }
  } catch (_) {}
  fetch('/api/event', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(body),
    keepalive: true,
  }).catch(() => {});
}

function switchLane(lane) {
  if (!['high', 'normal', 'recall', 'audit'].includes(lane)) return;
  logClientEvent('lane_switch', { source: _lane + '->' + lane });
  _lane = lane;
  fetchSession();
}

async function fetchSession() {
  const params = new URLSearchParams({ lane: _lane });
  if (_requestedCompound) params.set('compound', _requestedCompound);
  const response = await fetch('/api/session?' + params.toString());
  const s = await response.json();
  if (!response.ok) {
    showSessionError(s);
    return;
  }
  hideSessionError();
  _state = s;
  render(s);
  const key = currentPairKey();
  if (key && key !== _lastPairKey) {
    _lastPairKey = key;
    _pairStartedAt = Date.now();
    logClientEvent('pair_viewed', { elapsed_ms: 0 });
  }
}

function showSessionError(error) {
  const requested = error.requested_community_name || error.requested_compound || _requestedCompound || 'Selected community';
  const active = error.active_community_name || error.active_compound || 'another community';
  document.title = 'Match Review - ' + requested;
  document.getElementById('community-title').textContent = requested + ' review desk';
  document.getElementById('community-subhead').textContent = 'Wrong active queue';
  document.getElementById('hdr-pass').textContent = '-';
  document.getElementById('hdr-current').textContent = '-';
  document.getElementById('hdr-total').textContent = '-';
  document.getElementById('hdr-confirmed').textContent = '0';
  document.getElementById('hdr-skipped').textContent = '0';
  document.getElementById('hdr-global').textContent = '0';
  document.getElementById('progress-fill').style.width = '0%';
  document.getElementById('hdr-percent').textContent = '0%';
  document.getElementById('session-error-title').textContent = 'Wrong review queue';
  document.getElementById('session-error-text').textContent =
    error.message || ('This link asked for ' + requested + ', but the active review queue is ' + active + '.');
  document.getElementById('session-error').classList.remove('hidden');
  document.getElementById('review-panel').classList.add('hidden');
  document.querySelector('.decision-bar').classList.add('hidden');
}

function hideSessionError() {
  document.getElementById('session-error').classList.add('hidden');
  document.getElementById('review-panel').classList.remove('hidden');
  document.querySelector('.decision-bar').classList.remove('hidden');
}

function renderLaneTabs(s) {
  const lanes = s.lanes || {};
  for (const lane of ['high', 'normal', 'recall', 'audit']) {
    const tab   = document.getElementById('lane-' + lane);
    const count = document.getElementById('lane-count-' + lane);
    const info  = lanes[lane] || { total: 0, pending: 0 };
    if (count) count.textContent = info.pending + '/' + info.total;
    if (tab) {
      tab.classList.toggle('active', s.lane === lane);
      tab.classList.toggle('is-empty', !info.total);
      tab.setAttribute('aria-selected', s.lane === lane ? 'true' : 'false');
    }
  }
}

function renderCommunityHeader(s) {
  const label = s.community_name || s.compound || 'Community';
  document.title = 'Match Review - ' + label;
  document.getElementById('community-title').textContent = label + ' review desk';
  document.getElementById('community-subhead').textContent = label + ' / active queue';
}

function render(s) {
  if (s.lane) _lane = s.lane;
  renderCommunityHeader(s);
  renderLaneTabs(s);
  document.getElementById('hdr-pass').textContent      = s.pass;
  document.getElementById('hdr-current').textContent   = s.current_index;
  document.getElementById('hdr-total').textContent     = s.total;
  document.getElementById('hdr-confirmed').textContent = s.confirmed_count;
  document.getElementById('hdr-skipped').textContent   = s.skipped_count;
  document.getElementById('hdr-global').textContent    = s.global_confirmed != null ? s.global_confirmed : s.confirmed_count;
  const completed = (s.confirmed_count || 0) + (s.skipped_count || 0) + (s.unsure_count || 0);
  const pct = s.total > 0 ? (completed / s.total * 100).toFixed(1) : 0;
  document.getElementById('progress-fill').style.width = pct + '%';
  document.getElementById('hdr-percent').textContent = pct + '%';
  document.getElementById('footer-current').textContent = s.current_index;
  document.getElementById('footer-total').textContent   = s.total;
  document.getElementById('footer-pass').textContent    = s.pass;

  if (s.all_done) { showPassComplete(s); return; }

  const p = s.pair;
  document.getElementById('viva-code').textContent   = '#' + p.viva_code;
  document.getElementById('viva-meta').innerHTML     = metaHTML(p.viva);
  if (p.viva.url)   document.getElementById('viva-link').href   = p.viva.url;
  document.getElementById('coelho-code').textContent = '#' + p.coelho_code;
  document.getElementById('coelho-meta').innerHTML   = metaHTML(p.coelho);
  if (p.coelho.url) document.getElementById('coelho-link').href = p.coelho.url;

  renderImage('viva',   p.viva_code);
  renderImage('coelho', p.coelho_code);

  const conf = p.confidence_score || p.similarity || 0;
  const lane = p.lane || 'normal';
  const simEl = document.getElementById('sim-val');
  simEl.textContent = (typeof conf === 'number' ? conf : 0).toFixed(4);
  simEl.className   = 'sim-val ' + (lane === 'high' ? 'high' : lane === 'recall' ? 'low' : 'medium');
  const infoEl = document.getElementById('sim-extra');
  infoEl.textContent = (p.tier_label || '').toUpperCase() || (LANE_LABELS[lane] || lane).toUpperCase();
  infoEl.className   = 'tier-label tier-' + (lane === 'high' ? 'high' : lane === 'recall' ? 'low' : 'medium');

  renderEvidence(p);
}

const SOURCE_LABELS = { megaloc: 'MegaLoc', vlad: 'VLAD', 'patch-vlad': 'patch-VLAD' };

function renderEvidence(pair) {
  const panel = document.getElementById('evidence-panel');
  const ev = pair.evidence || {};
  const groups = [];

  // Source chips with per-source scores (compact)
  const sources = Array.isArray(ev.sources) ? ev.sources : [];
  const scores  = ev.source_scores || {};
  if (sources.length || Object.keys(scores).length) {
    const keys = sources.length ? sources : Object.keys(scores);
    const chips = keys.map(k => {
      const label = SOURCE_LABELS[k] || k;
      const s = scores[k];
      const score = (typeof s === 'number') ? '<span class="ev-score">' + s.toFixed(3) + '</span>' : '';
      return '<span class="ev-chip is-active">' + label + ' ' + score + '</span>';
    }).join('');
    groups.push('<div class="ev-group"><span class="ev-label">Models</span>' + chips + '</div>');
  }

  // Geometry block
  const geomBits = [];
  if (typeof ev.geometric_score === 'number')   geomBits.push('score <span class="ev-val">' + ev.geometric_score.toFixed(3) + '</span>');
  if (typeof ev.best_inliers === 'number')      geomBits.push('inliers <span class="ev-val">' + ev.best_inliers + '</span>');
  if (typeof ev.best_inlier_ratio === 'number') geomBits.push('ratio <span class="ev-val">' + ev.best_inlier_ratio.toFixed(2) + '</span>');
  if (typeof ev.support_pairs_8 === 'number' || typeof ev.support_pairs_12 === 'number') {
    const sp8  = ev.support_pairs_8  != null ? ev.support_pairs_8  : '–';
    const sp12 = ev.support_pairs_12 != null ? ev.support_pairs_12 : '–';
    geomBits.push('support <span class="ev-val">' + sp8 + '/' + sp12 + '</span>');
  }
  if (geomBits.length) {
    groups.push('<div class="ev-group"><span class="ev-label">Geometry</span>' + geomBits.join(' &middot; ') + '</div>');
  }

  // Structural deltas
  const structuralBits = [];
  if (typeof ev.price_diff === 'number') structuralBits.push('price <span class="ev-val">' + Math.round(ev.price_diff * 100) + '%</span>');
  if (typeof ev.area_diff === 'number') structuralBits.push('area <span class="ev-val">' + Math.round(ev.area_diff * 100) + '%</span>');
  if (ev.structural && typeof ev.structural === 'object') {
    for (const key of ['price', 'area', 'beds']) {
      if (ev.structural[key] !== undefined && ev.structural[key] !== null) {
        structuralBits.push(key + ' <span class="ev-val">' + String(ev.structural[key]) + '</span>');
      }
    }
  }
  if (Array.isArray(ev.structural_failures) && ev.structural_failures.length) {
    structuralBits.push('flags <span class="ev-val">' + ev.structural_failures.slice(0, 2).join(', ') + '</span>');
  }
  if (structuralBits.length) {
    groups.push('<div class="ev-group"><span class="ev-label">Data</span>' + structuralBits.join(' &middot; ') + '</div>');
  }

  // Top image pairs
  const pairs = Array.isArray(ev.top_image_pairs) ? ev.top_image_pairs.slice(0, 3) : [];
  let pairsHTML = '';
  if (pairs.length) {
    pairsHTML = '<div class="ev-pairs">' + pairs.map(p => {
      const a = p.a_image || '?';
      const b = p.b_image || '?';
      const sc = (typeof p.score === 'number') ? ' <span class="ev-score">(' + p.score.toFixed(2) + ')</span>' : '';
      return '<span class="ev-pair"><strong>Viva ' + a + '</strong> ↔ <strong>Coelho ' + b + '</strong>' + sc + '</span>';
    }).join('') + '</div>';
  }

  if (!groups.length && !pairsHTML) {
    panel.hidden = true;
    panel.innerHTML = '';
    return;
  }
  panel.hidden = false;
  panel.innerHTML = groups.join('') + pairsHTML;
}

function metaHTML(info) {
  const parts = [];
  if (info.price) parts.push('<span class="fact fact-price"><strong>' + info.price + '</strong></span>');
  if (info.area)  parts.push('<span class="fact">' + info.area + ' m²</span>');
  if (info.beds)  parts.push('<span class="fact">' + info.beds + ' dorms</span>');
  return parts.join('') || '<span class="muted-empty">No structured data</span>';
}

async function renderImage(site, code) {
  const container = document.getElementById(site + '-img');
  const hint = '<span class="zoom-hint">Compare</span>';

  // Try the generated standard mosaic first
  try {
    const probe = await fetch('/api/mosaic/' + site + '/' + code + '?mode=standard').then(r => r.json());
    if (probe && probe.available && probe.url) {
      container.classList.remove('is-fallback');
      container.innerHTML =
        '<img class="mosaic-img" src="' + probe.url + '" alt="Standard mosaic ' + site + ' ' + code + '" loading="lazy">' + hint;
      return;
    }
  } catch (_) { /* fall through to image grid */ }

  // Fallback: legacy outdoor image grid
  const urls = await fetch('/api/images/' + site + '/' + code + '?mode=standard').then(r => r.json());
  container.classList.add('is-fallback');
  if (!urls.length) {
    container.innerHTML = '<div class="no-img">No images available</div>';
    return;
  }
  const six  = urls.slice(0, 6);
  const imgs = six.map(u => '<img src="' + u + '" alt="' + site + ' photo" loading="lazy">').join('');
  container.innerHTML = '<div class="img-grid">' + imgs + '</div>' + hint;
}

let _compareMode = 'expanded';

async function openComparison() {
  if (!_state || !_state.pair) return;
  logClientEvent('comparison_opened', { mode: _compareMode });
  document.getElementById('cmp-viva-code').textContent   = '#' + _state.pair.viva_code;
  document.getElementById('cmp-coelho-code').textContent = '#' + _state.pair.coelho_code;
  document.getElementById('compare').classList.remove('hidden');
  setComparisonMode(_compareMode);
}

function closeComparison() {
  logClientEvent('comparison_closed', { mode: _compareMode });
  document.getElementById('compare').classList.add('hidden');
}

function setComparisonMode(mode) {
  if (!['standard', 'expanded', 'all'].includes(mode)) mode = 'expanded';
  if (mode !== _compareMode) logClientEvent('comparison_mode_changed', { mode });
  _compareMode = mode;
  for (const m of ['standard', 'expanded', 'all']) {
    document.getElementById('cmp-mode-' + m).classList.toggle('active', m === mode);
  }
  if (!_state || !_state.pair) return;
  renderComparisonSide('viva',   _state.pair.viva_code,   mode);
  renderComparisonSide('coelho', _state.pair.coelho_code, mode);
}

async function renderComparisonSide(site, code, mode) {
  const body = document.getElementById('cmp-' + site + '-body');
  body.innerHTML = '<p class="compare-empty">Loading...</p>';

  // Standard / Expanded prefer the generated mosaic
  if (mode === 'standard' || mode === 'expanded') {
    try {
      const probe = await fetch('/api/mosaic/' + site + '/' + code + '?mode=' + mode).then(r => r.json());
      if (probe && probe.available && probe.url) {
        body.innerHTML =
          '<img class="compare-mosaic" src="' + probe.url +
          '" alt="Mosaic ' + mode + ' ' + site + ' ' + code +
          '" loading="lazy" onclick="window.open(this.src)">';
        return;
      }
    } catch (_) { /* fall through to image grid */ }
  }

  // Fallback or "all": image grid from /api/images
  const apiMode = mode === 'all' ? 'all' : (mode === 'standard' ? 'standard' : 'expanded');
  const urls = await fetch('/api/images/' + site + '/' + code + '?mode=' + apiMode).then(r => r.json());
  if (!Array.isArray(urls) || !urls.length) {
    body.innerHTML = '<p class="compare-empty">No images.</p>';
    return;
  }
  body.innerHTML = '<div class="compare-images">' +
    urls.map(u => '<img src="' + u + '" loading="lazy" onclick="window.open(this.src)">').join('') +
    '</div>';
}

async function doMatch() {
  if (!_state || !_state.pair || _state.all_done) return;
  const elapsed = Date.now() - _pairStartedAt;
  await fetch('/api/confirm', { method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ viva_code: _state.pair.viva_code, coelho_code: _state.pair.coelho_code, elapsed_ms: elapsed }) });
  fetchSession();
}

async function doSkip() {
  if (!_state || !_state.pair || _state.all_done) return;
  const elapsed = Date.now() - _pairStartedAt;
  await fetch('/api/skip', { method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ viva_code: _state.pair.viva_code, coelho_code: _state.pair.coelho_code, elapsed_ms: elapsed }) });
  fetchSession();
}

async function doUnsure() {
  if (!_state || !_state.pair || _state.all_done) return;
  const elapsed = Date.now() - _pairStartedAt;
  await fetch('/api/unsure', { method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ viva_code: _state.pair.viva_code, coelho_code: _state.pair.coelho_code, elapsed_ms: elapsed }) });
  fetchSession();
}

const LANE_LABELS = { high: 'High confidence', normal: 'Normal', recall: 'Recall', audit: 'Audit' };

function laneSummaryHTML(lanes) {
  if (!lanes) return '';
  return '<div class="lane-summary">' +
    ['high', 'normal', 'recall'].map(l => {
      const c = lanes[l] || {};
      return '<div class="lane-cell"><strong>' + LANE_LABELS[l] + '</strong>' +
        'Matched ' + (c.confirmed || 0) +
        ' &middot; Rejected ' + (c.skipped || 0) +
        ' &middot; Unsure ' + (c.unsure || 0) +
        ' &middot; Pending ' + (c.pending || 0) + '</div>';
    }).join('') + '</div>';
}

function nextLaneWithPending(lanes, exclude) {
  for (const l of ['high', 'normal', 'recall']) {
    if (l === exclude) continue;
    if ((lanes && lanes[l] && lanes[l].pending) || 0) return l;
  }
  return null;
}

function showPassComplete(s) {
  const next = nextLaneWithPending(s.lanes, s.lane);
  if (next) {
    document.getElementById('pass-complete-modal').classList.add('hidden');
    logClientEvent('lane_auto_advanced', { source: s.lane + '->' + next });
    _lane = next;
    fetchSession();
    return;
  }

  document.getElementById('pc-pass').textContent      = s.pass;
  document.getElementById('pc-confirmed').textContent = s.confirmed_count;
  document.getElementById('pc-skipped').textContent   = s.skipped_count;
  const notice = document.getElementById('pc-notice');
  let html = '<strong>' + (LANE_LABELS[s.lane] || s.lane) + '</strong> lane complete.';
  html += laneSummaryHTML(s.lanes);
  html += '<p style="margin-top:10px">All review lanes are complete. Preparing the next round queues the Mac worker and stores the finished round in GCS.</p>';
  notice.innerHTML = html;
  const nextPass = (Number(s.pass) || 1) + 1;
  const nextBtn = document.getElementById('pc-next-round-btn');
  nextBtn.textContent = 'Prepare round ' + nextPass;
  nextBtn.style.display = '';
  const nextHelp = document.getElementById('pc-next-round-help');
  if (nextHelp) nextHelp.innerHTML = '';
  document.getElementById('pc-reload-btn').style.display =
    s.skipped_count > 0 ? '' : 'none';
  document.getElementById('pass-complete-modal').classList.remove('hidden');
}

async function reloadAndContinue() {
  document.getElementById('pass-complete-modal').classList.add('hidden');
  await fetch('/api/reload', { method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ lane: _lane, page_elapsed_ms: Date.now() - _pageStartedAt }) });
  await fetchSession();
}

function askDone() {
  const s = _state;
  if (!s) return;
  document.getElementById('done-confirm-text').innerHTML =
    'You matched <strong>' + s.confirmed_count + '</strong> pairs.' +
    (s.skipped_count > 0 ? ' The <strong>' + s.skipped_count + '</strong> rejected pairs will be ignored.' : '');
  document.getElementById('done-confirm-modal').classList.remove('hidden');
}
function closeDoneModal() { document.getElementById('done-confirm-modal').classList.add('hidden'); }

async function finalize() {
  closeDoneModal();
  document.getElementById('pass-complete-modal').classList.add('hidden');
  const r = await fetch('/api/final', { method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ lane: _lane, page_elapsed_ms: Date.now() - _pageStartedAt }) }).then(r => r.json());
  _finalData = r;
  document.getElementById('final-count').textContent = r.total_confirmed;
  const lanes = (_state && _state.lanes) || null;
  const vivaLine = r.total_viva_listings != null
    ? '<br><strong>' + r.total_confirmed + '</strong> of <strong>' + r.total_viva_listings + '</strong> Viva listings matched. ' +
      '<strong>' + (r.pending_viva_count || 0) + '</strong> continue to the next round.'
    : '';
  document.getElementById('final-breakdown').innerHTML =
    r.total_confirmed + ' matched pairs saved to GCS.' + vivaLine + laneSummaryHTML(lanes);
  const nextRoundBtn = document.getElementById('next-round-btn');
  const nextPass = ((_state && Number(_state.pass)) || 1) + 1;
  nextRoundBtn.textContent = 'Prepare round ' + nextPass;
  nextRoundBtn.style.display = (r.pending_viva_count || 0) > 0 ? '' : 'none';
  document.getElementById('final-modal').classList.remove('hidden');
}

async function startNextRound(source) {
  const fromPassComplete = source === 'pass-complete';
  const btn = fromPassComplete
    ? document.getElementById('pc-next-round-btn')
    : document.getElementById('next-round-btn');
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Preparing...';
  try {
    const resp = await fetch('/api/start-next-round', { method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ lane: _lane, page_elapsed_ms: Date.now() - _pageStartedAt }) });
    const r = await resp.json();
    if (r.ok) {
      document.getElementById('final-modal').classList.add('hidden');
      document.getElementById('pass-complete-modal').classList.add('hidden');
      await fetchSession();
      return;
    }
    if (r.generating) {
      showRoundGenerationStatus(fromPassComplete, r.next_pass, r.status || { message: r.message, command: r.command });
      pollRoundStatus(r.next_pass, fromPassComplete).catch(err => console.error(err));
      return;
    }
    const helpId = fromPassComplete ? 'pc-next-round-help-text' : 'next-round-help';
    const previousHelp = document.getElementById(helpId);
    if (previousHelp) previousHelp.remove();
    const commandHtml = r.command
      ? '<div id="' + helpId + '" class="notice" style="margin-top:12px">' +
        '<strong>Round ' + r.next_pass + ' is not generated yet.</strong><br>' +
        'Start or check the Mac worker, then click <strong>Prepare round ' + r.next_pass + '</strong> again:<br>' +
        '<code>' + escapeHtml(r.command) + '</code></div>'
      : '<div id="' + helpId + '" class="notice" style="margin-top:12px">' +
        escapeHtml(r.message || 'Could not queue the next round.') + '</div>';
    const target = fromPassComplete
      ? document.getElementById('pc-next-round-help')
      : document.getElementById('final-breakdown');
    target.insertAdjacentHTML('beforeend', commandHtml);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

function generationTarget(fromPassComplete) {
  return fromPassComplete
    ? document.getElementById('pc-next-round-help')
    : document.getElementById('final-breakdown');
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function roundStatusHtml(nextPass, status) {
  const state = status && status.state ? status.state : 'queued';
  const label = state === 'running'
    ? 'Running round ' + nextPass + ' on the Mac'
    : state === 'ready'
      ? 'Round ' + nextPass + ' is ready'
      : state === 'failed'
        ? 'Failed to generate round ' + nextPass
        : 'Waiting for Mac worker for round ' + nextPass;
  const fallback = state === 'queued'
    ? 'Keep the Mac worker running. The review app will advance when the result is uploaded to GCS.'
    : 'Waiting for matcher status.';
  let html = '<strong>' + escapeHtml(label) + '</strong><br>' +
    escapeHtml((status && status.message) || fallback);
  if (status && status.command && state === 'queued') {
    html += '<br><code>' + escapeHtml(status.command) + '</code>';
  }
  return html;
}

function showRoundGenerationStatus(fromPassComplete, nextPass, status) {
  const helpId = fromPassComplete ? 'pc-next-round-help-text' : 'next-round-help';
  const previousHelp = document.getElementById(helpId);
  if (previousHelp) previousHelp.remove();
  generationTarget(fromPassComplete).insertAdjacentHTML('beforeend',
    '<div id="' + helpId + '" class="notice" style="margin-top:12px">' +
    roundStatusHtml(nextPass, status) +
    '</div>'
  );
}

async function pollRoundStatus(nextPass, fromPassComplete) {
  const helpId = fromPassComplete ? 'pc-next-round-help-text' : 'next-round-help';
  for (let attempt = 0; attempt < 720; attempt++) {
    await new Promise(resolve => setTimeout(resolve, attempt < 6 ? 3000 : 10000));
    const resp = await fetch('/api/round-status?round=' + encodeURIComponent(nextPass));
    const r = await resp.json();
    const el = document.getElementById(helpId);
    if (r.ok && r.ready) {
      document.getElementById('final-modal').classList.add('hidden');
      document.getElementById('pass-complete-modal').classList.add('hidden');
      await fetchSession();
      return;
    }
    if (el && r.status) el.innerHTML = roundStatusHtml(nextPass, r.status);
    if (r.status && r.status.state === 'failed') {
      if (el) el.innerHTML = roundStatusHtml(nextPass, r.status);
      return;
    }
  }
}

function downloadFinal() {
  if (!_finalData) return;
  const blob = new Blob([JSON.stringify(_finalData, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'final-matches.json';
  a.click();
}

document.addEventListener('keydown', e => {
  const modalOpen =
    !document.getElementById('pass-complete-modal').classList.contains('hidden') ||
    !document.getElementById('done-confirm-modal').classList.contains('hidden')  ||
    !document.getElementById('final-modal').classList.contains('hidden');
  if (modalOpen) return;
  if (!document.getElementById('compare').classList.contains('hidden')) {
    if (e.key === 'Escape') closeComparison();
    return;
  }
  if (e.key === 'ArrowRight' || e.key === 'm') doMatch();
  if (e.key === 'ArrowLeft'  || e.key === 's') doSkip();
  if (e.key === 'u') doUnsure();
  if (e.key === 'd') askDone();
});

logClientEvent('page_loaded', { elapsed_ms: 0, client: { page_elapsed_ms: 0, viewport: { width: window.innerWidth, height: window.innerHeight } } });
fetchSession();
</script>
</body>
</html>`;
