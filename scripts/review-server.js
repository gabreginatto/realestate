'use strict';
/**
 * review-server.js — Human Review Loop for AI-matched property pairs
 *
 * Reads data from GCS, serves a review UI, writes confirmed sessions back to GCS.
 * Images are served directly from GCS public URLs (no proxy).
 * Re-matching runs on the user's Mac — Cloud Run just handles review.
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
let autoMatches = [];    // review queue (lanes high/normal/recall), non-reject pairs
let auditMatches = [];   // reject-low pairs, accessible via audit lane
let currentSession = null;  // { pass, pairs, audit, confirmed }
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
  const localViva = readLocalJson('LOCAL_FIXTURES_VIVA');
  const localCoe  = readLocalJson('LOCAL_FIXTURES_COELHO');
  try {
    const vRaw = localViva || await fetchJson(`${GCS_BASE}/listings/vivaprimeimoveis.json`);
    for (const l of vRaw.listings || []) {
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
    for (const l of cRaw.listings || []) {
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

async function loadMatches() {
  const localMatches = readLocalJson('LOCAL_FIXTURES_MATCHES');
  try {
    const raw = localMatches || await fetchJson(`${GCS_BASE}/matches/auto-matches.json`);
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
    autoMatches  = review;
    auditMatches = audit;

    const byLane = REVIEW_LANES.reduce((acc, l) => (acc[l] = review.filter(m => m.lane === l).length, acc), {});
    console.log(
      `✓ Loaded ${review.length} review matches from GCS ` +
      `(high=${byLane.high}, normal=${byLane.normal}, recall=${byLane.recall}; audit=${audit.length})`
    );
  } catch (e) {
    console.warn('Could not load auto-matches from GCS:', e.message);
    autoMatches = [];
    auditMatches = [];
  }
}

// ---------------------------------------------------------------------------
// Session management (in-memory + GCS persistence)
// ---------------------------------------------------------------------------

async function ensureSession() {
  // When running on local fixtures, always rebuild — never resume a stale GCS session
  if (process.env.LOCAL_FIXTURES_MATCHES) {
    currentSession = buildNewSession(autoMatches, auditMatches, 1, []);
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
  await saveSession();
  console.log(`✓ Created pass-1 session: ${currentSession.pairs.length} review pairs, ${currentSession.audit.length} audit`);
}

function buildNewSession(reviewMatches, auditMatches_, passN, carryConfirmed) {
  const confirmedSet = new Set(carryConfirmed.map(p => p.viva_code));
  const pairs = reviewMatches
    .filter(m => !confirmedSet.has(m.viva_code))
    .map(m => ({ ...m, status: 'pending' }));
  const audit = (auditMatches_ || [])
    .filter(m => !confirmedSet.has(m.viva_code))
    .map(m => ({ ...m, status: 'pending' }));
  return {
    pass:      passN,
    pairs,
    audit,
    confirmed: [...carryConfirmed],
    trial_run_id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
  };
}

async function saveSession() {
  try {
    await gcsWrite('review-sessions/current.json', currentSession);
  } catch (e) {
    console.warn('Could not save session to GCS:', e.message);
  }
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
  const pairs = allSessionPairs();
  const confirmed = currentSession?.confirmed || [];
  const confirmedViva = new Set(confirmed.map(p => p.viva_code));
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

  return {
    generated_at: new Date().toISOString(),
    trial_run_id: currentSession?.trial_run_id || null,
    pass: currentSession?.pass || null,
    lanes: currentSession ? laneCounts() : {},
    total_candidates: pairs.length,
    total_confirmed: confirmed.length,
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
    // Intentionally include interiors — caller asked for everything
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
  await loadMatches();
  const trialRunId = currentSession?.trial_run_id;
  const carryConfirmed = Array.isArray(currentSession && currentSession.confirmed)
    ? currentSession.confirmed
    : [];
  currentSession = buildNewSession(autoMatches, auditMatches, currentSession?.pass || 1, carryConfirmed);
  if (trialRunId) currentSession.trial_run_id = trialRunId;
  await saveSession();
  _mosaicAvail.clear();
  await logEvent(req, 'session_reloaded', {
    client: req.body || {},
  });
  res.json({
    ok: true,
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

  const requested = String(req.query.lane || '').toLowerCase();
  const lane      = ALL_LANES.includes(requested) ? requested : 'high';

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
  const globalConfirmed =
    (currentSession.pairs || []).filter(p => p.status === 'confirmed').length +
    (currentSession.audit  || []).filter(p => p.status === 'confirmed').length;

  res.json({
    trial_run_id:      currentSession.trial_run_id,
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
  console.log(`✓ confirmed  Viva ${viva_code} ↔ Coelho ${coelho_code} (lane=${pair.lane || 'unknown'})`);
  await saveSession();
  await logEvent(req, 'decision_confirmed', {
    viva_code,
    coelho_code,
    lane: pair.lane || normalizeTier(pair).lane,
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
<title>Match Review — Alphaville 1</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0f1117; --surface: #1a1d27; --card: #21253a; --border: #2d3250;
    --accent: #6366f1; --green: #22c55e; --red: #ef4444; --yellow: #eab308;
    --text: #e2e8f0; --muted: #94a3b8; --radius: 12px;
  }
  body { background: var(--bg); color: var(--text); font-family: system-ui, sans-serif;
         min-height: 100vh; display: flex; flex-direction: column; }
  header { background: var(--surface); border-bottom: 1px solid var(--border);
           padding: 12px 24px; display: flex; flex-direction: column; gap: 10px; }
  .header-row { display: flex; align-items: center; gap: 20px; flex-wrap: wrap; }
  header h1 { font-size: 1.1rem; font-weight: 700; white-space: nowrap; }
  .lane-tabs { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  .lane-tab { background: var(--card); border: 1px solid var(--border); color: var(--muted);
              border-radius: 6px; padding: 6px 12px; font-size: 0.85rem; font-weight: 600;
              cursor: pointer; display: inline-flex; gap: 6px; align-items: center;
              transition: all 0.15s; }
  .lane-tab:hover:not(.active) { border-color: var(--accent); color: var(--text); }
  .lane-tab.active { background: var(--accent); border-color: var(--accent); color: #fff; }
  .lane-tab .lane-count { font-size: 0.75rem; opacity: 0.85; }
  .lane-tab.is-empty { opacity: 0.55; }
  .lane-tab.is-audit { margin-left: auto; border-style: dashed; }
  .lane-tab.is-audit.active { border-style: solid; }
  @media (max-width: 700px) { .lane-tab.is-audit { margin-left: 0; } }
  .badge { background: var(--card); border: 1px solid var(--border);
           border-radius: 6px; padding: 4px 10px; font-size: 0.85rem; color: var(--muted); }
  .badge span { color: var(--text); font-weight: 600; }
  .progress-bar { flex: 1; min-width: 120px; height: 8px; background: var(--card);
                  border-radius: 4px; overflow: hidden; }
  .progress-fill { height: 100%; background: var(--accent); transition: width 0.3s; }
  main { flex: 1; display: grid; grid-template-columns: 1fr 1fr; gap: 16px;
         padding: 16px; max-width: 1400px; margin: 0 auto; width: 100%; }
  @media (max-width: 700px) { main { grid-template-columns: 1fr; } }
  .prop-card { background: var(--card); border: 1px solid var(--border);
               border-radius: var(--radius); padding: 16px; display: flex;
               flex-direction: column; gap: 12px; }
  .prop-header { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .prop-source { font-size: 0.7rem; font-weight: 700; letter-spacing: 0.08em;
                 text-transform: uppercase; padding: 2px 8px; border-radius: 4px; color: #fff; }
  .prop-code { font-size: 0.9rem; font-weight: 600; color: var(--muted); }
  .prop-meta { font-size: 0.9rem; color: var(--muted); line-height: 1.5; }
  .prop-meta strong { color: var(--text); }
  .prop-img { position: relative; cursor: pointer; border-radius: 8px; overflow: hidden;
              background: var(--surface); aspect-ratio: 2 / 1; min-height: 200px;
              display: flex; align-items: center; justify-content: center; }
  .prop-img .mosaic-img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .prop-img.is-fallback { aspect-ratio: auto; min-height: 260px; }
  .prop-img .img-grid { display: flex; flex-wrap: wrap; gap: 2px; width: 100%; }
  .prop-img .img-grid img { width: calc(33.33% - 2px); height: 130px; object-fit: cover; }
  .prop-img .zoom-hint { position: absolute; bottom: 8px; right: 8px;
                         background: rgba(0,0,0,0.65); color: #fff; font-size: 0.75rem;
                         padding: 3px 8px; border-radius: 4px; pointer-events: none; }
  .prop-img .no-img { color: var(--muted); font-size: 0.85rem; padding: 40px; }
  .prop-link { font-size: 0.82rem; color: var(--accent); text-decoration: none; }
  .prop-link:hover { text-decoration: underline; }
  footer { background: var(--surface); border-top: 1px solid var(--border);
           padding: 16px 24px; display: flex; flex-direction: column; align-items: center; gap: 12px; }
  .evidence-panel { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center;
                    justify-content: center; max-width: 1100px; width: 100%;
                    background: var(--card); border: 1px solid var(--border);
                    border-radius: 8px; padding: 8px 14px; font-size: 0.8rem;
                    color: var(--muted); }
  .evidence-panel .ev-group { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .evidence-panel .ev-label { font-size: 0.7rem; text-transform: uppercase;
                              letter-spacing: 0.05em; color: var(--muted); }
  .evidence-panel .ev-val   { color: var(--text); font-weight: 600; }
  .ev-chip { display: inline-flex; align-items: center; gap: 4px;
             background: var(--surface); border: 1px solid var(--border);
             border-radius: 4px; padding: 2px 8px; font-size: 0.75rem; color: var(--text); }
  .ev-chip.is-active { border-color: var(--accent); color: var(--accent); }
  .ev-chip .ev-score { color: var(--muted); font-weight: 400; font-size: 0.7rem; }
  .ev-pairs { width: 100%; display: flex; flex-wrap: wrap; gap: 4px 10px; justify-content: center;
              border-top: 1px dashed var(--border); padding-top: 6px; margin-top: 2px; }
  .ev-pairs .ev-pair { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 0.72rem; color: var(--muted); }
  .ev-pairs .ev-pair strong { color: var(--text); font-weight: 600; }
  .sim-badge { font-size: 0.9rem; color: var(--muted); }
  .sim-val { font-weight: 700; font-size: 1rem; }
  .sim-val.high { color: var(--green); } .sim-val.medium { color: var(--yellow); } .sim-val.low { color: var(--red); }
  .tier-label { display: inline-block; margin-left: 8px; padding: 2px 8px;
                border-radius: 4px; font-size: 0.75rem; font-weight: 700; }
  .tier-high   { background: #22c55e22; color: var(--green); border: 1px solid var(--green); }
  .tier-medium { background: #eab30822; color: var(--yellow); border: 1px solid var(--yellow); }
  .tier-low    { background: #ef444422; color: var(--red); border: 1px solid var(--red); }
  .actions { display: flex; gap: 12px; }
  button { cursor: pointer; border: none; border-radius: 8px;
           padding: 10px 28px; font-size: 0.95rem; font-weight: 600; transition: opacity 0.15s; }
  button:hover { opacity: 0.85; }
  #btn-skip   { background: var(--red); color: #fff; }
  #btn-unsure { background: var(--yellow); color: #1a1d27; }
  #btn-match  { background: var(--green); color: #fff; }
  #btn-done   { background: var(--surface); color: var(--muted); border: 1px solid var(--border); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .lane-summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 10px; }
  .lane-summary .lane-cell { background: var(--surface); border: 1px solid var(--border);
                             border-radius: 6px; padding: 8px; text-align: left; font-size: 0.8rem; }
  .lane-summary .lane-cell strong { display: block; font-size: 0.7rem; color: var(--muted);
                                    text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }
  @media (max-width: 700px) { .lane-summary { grid-template-columns: repeat(2, 1fr); } }
  .kbd { display: inline-block; background: var(--card); border: 1px solid var(--border);
         border-radius: 4px; padding: 1px 6px; font-size: 0.75rem; color: var(--muted); }
  .modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.75);
              display: flex; align-items: center; justify-content: center; z-index: 100; }
  .modal-bg.hidden { display: none; }
  .modal { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius);
           padding: 32px; max-width: 480px; width: 90%; display: flex; flex-direction: column; gap: 20px; }
  .modal h2 { font-size: 1.2rem; } .modal p { color: var(--muted); font-size: 0.9rem; line-height: 1.5; }
  .modal-row { display: flex; gap: 10px; justify-content: flex-end; }
  .btn-outline { background: transparent; border: 1px solid var(--border); color: var(--text); }
  .btn-green { background: var(--green); color: #fff; }
  .btn-accent { background: var(--accent); color: #fff; }
  .stat-row { display: flex; gap: 24px; }
  .stat { display: flex; flex-direction: column; }
  .stat-val { font-size: 1.8rem; font-weight: 700; }
  .stat-lbl { font-size: 0.8rem; color: var(--muted); }
  .green { color: var(--green); } .red { color: var(--red); }
  .compare-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.92);
                overflow-y: auto; z-index: 200; padding: 20px; }
  .compare-bg.hidden { display: none; }
  .compare-header { position: sticky; top: -20px; background: rgba(15,17,23,0.95);
                    padding: 12px 0; margin: -20px -20px 16px -20px; padding: 16px 20px;
                    z-index: 1; display: flex; flex-direction: column; gap: 12px;
                    border-bottom: 1px solid var(--border); }
  .compare-titlebar { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
  .compare-titlebar h3 { font-size: 1rem; }
  .compare-close { background: var(--card); border: 1px solid var(--border); color: var(--text);
                   border-radius: 6px; padding: 6px 14px; cursor: pointer; font-size: 0.9rem; }
  .compare-modes { display: inline-flex; background: var(--card); border: 1px solid var(--border);
                   border-radius: 8px; padding: 2px; }
  .compare-modes button { background: transparent; border: none; color: var(--muted);
                          padding: 6px 14px; font-size: 0.85rem; font-weight: 600;
                          border-radius: 6px; cursor: pointer; transition: all 0.15s; }
  .compare-modes button.active { background: var(--accent); color: #fff; }
  .compare-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .compare-col { background: var(--card); border: 1px solid var(--border);
                 border-radius: var(--radius); padding: 12px; }
  .compare-col h4 { font-size: 0.9rem; margin-bottom: 8px; color: var(--muted); }
  .compare-col h4 strong { color: var(--text); }
  .compare-mosaic { width: 100%; border-radius: 8px; display: block; }
  .compare-images { display: flex; flex-wrap: wrap; gap: 6px; }
  .compare-images img { max-width: calc(50% - 6px); height: 160px; object-fit: cover;
                        border-radius: 6px; cursor: zoom-in; }
  .compare-empty { color: var(--muted); font-size: 0.85rem; padding: 16px; text-align: center; }
  @media (max-width: 700px) {
    .compare-grid { grid-template-columns: 1fr; }
    .compare-images img { max-width: calc(50% - 6px); height: 130px; }
  }
  .notice { background: #6366f122; border: 1px solid var(--accent); border-radius: 8px;
            padding: 12px 16px; font-size: 0.85rem; color: var(--text); line-height: 1.5; }
  .notice code { color: var(--accent); font-size: 0.8rem; }
</style>
</head>
<body>

<header>
  <div class="header-row">
    <h1>🏠 Match Review</h1>
    <div class="badge">Pass <span id="hdr-pass">1</span></div>
    <div class="badge"><span id="hdr-current">1</span> / <span id="hdr-total">?</span></div>
    <div class="badge">✅ <span id="hdr-confirmed">0</span>  ❌ <span id="hdr-skipped">0</span></div>
    <div class="badge" title="Confirmados em todas as raias">Total ✅ <span id="hdr-global">0</span></div>
    <div class="progress-bar"><div class="progress-fill" id="progress-fill" style="width:0%"></div></div>
  </div>
  <div class="lane-tabs" role="tablist" aria-label="Raias de revisão">
    <button class="lane-tab" id="lane-high"   role="tab" onclick="switchLane('high')"  >Alta <span class="lane-count" id="lane-count-high">0/0</span></button>
    <button class="lane-tab" id="lane-normal" role="tab" onclick="switchLane('normal')">Normal <span class="lane-count" id="lane-count-normal">0/0</span></button>
    <button class="lane-tab" id="lane-recall" role="tab" onclick="switchLane('recall')">Recall <span class="lane-count" id="lane-count-recall">0/0</span></button>
    <button class="lane-tab is-audit" id="lane-audit" role="tab" onclick="switchLane('audit')">Auditoria <span class="lane-count" id="lane-count-audit">0/0</span></button>
  </div>
</header>

<main id="review-panel">
  <div class="prop-card">
    <div class="prop-header">
      <span class="prop-source" style="background:#7c3aed">VIVA</span>
      <span class="prop-code" id="viva-code"></span>
    </div>
    <div class="prop-meta" id="viva-meta"></div>
    <div class="prop-img" id="viva-img" onclick="openComparison()">
      <span class="zoom-hint">🔍 clique para ampliar</span>
    </div>
    <a class="prop-link" id="viva-link" href="#" target="_blank" rel="noopener">🔗 Abrir no Viva Prime Imóveis</a>
  </div>

  <div class="prop-card">
    <div class="prop-header">
      <span class="prop-source" style="background:#0ea5e9">COELHO</span>
      <span class="prop-code" id="coelho-code"></span>
    </div>
    <div class="prop-meta" id="coelho-meta"></div>
    <div class="prop-img" id="coelho-img" onclick="openComparison()">
      <span class="zoom-hint">🔍 clique para ampliar</span>
    </div>
    <a class="prop-link" id="coelho-link" href="#" target="_blank" rel="noopener">🔗 Abrir no Coelho da Fonseca</a>
  </div>
</main>

<footer>
  <div class="sim-badge">
    Confiança: <span class="sim-val" id="sim-val">—</span>
    <span id="sim-extra" class="tier-label"></span>
    &nbsp;|&nbsp; par <span id="footer-current">1</span> de <span id="footer-total">?</span>,
    pass <span id="footer-pass">1</span>
  </div>
  <div class="evidence-panel" id="evidence-panel" hidden></div>
  <div class="actions">
    <button id="btn-skip"   onclick="doSkip()"   aria-label="Não é o mesmo imóvel">❌ Não match <span class="kbd">← s</span></button>
    <button id="btn-unsure" onclick="doUnsure()" aria-label="Marcar como incerto">❓ Incerto <span class="kbd">u</span></button>
    <button id="btn-match"  onclick="doMatch()"  aria-label="Confirmar match">✅ Match <span class="kbd">→ m</span></button>
    <button id="btn-done"   onclick="askDone()"  aria-label="Finalizar revisão">🏁 Finalizar <span class="kbd">d</span></button>
  </div>
</footer>

<!-- Pass complete modal -->
<div class="modal-bg hidden" id="pass-complete-modal" role="dialog" aria-modal="true" aria-labelledby="pc-heading">
  <div class="modal">
    <h2 id="pc-heading">Pass <span id="pc-pass">1</span> completo ✅</h2>
    <div class="stat-row">
      <div class="stat"><span class="stat-val green" id="pc-confirmed">0</span><span class="stat-lbl">Confirmados</span></div>
      <div class="stat"><span class="stat-val red"   id="pc-skipped">0</span><span class="stat-lbl">Skipped</span></div>
    </div>
    <div class="notice" id="pc-notice"></div>
    <div class="modal-row">
      <button class="btn-outline" onclick="finalize()">🏁 Finalizar</button>
      <button class="btn-accent"  id="pc-reload-btn" onclick="reloadAndContinue()">🔄 Recarregar matches</button>
    </div>
  </div>
</div>

<!-- Done confirm modal -->
<div class="modal-bg hidden" id="done-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="dc-heading">
  <div class="modal">
    <h2 id="dc-heading">⚠️ Tem certeza?</h2>
    <p id="done-confirm-text"></p>
    <div class="modal-row">
      <button class="btn-outline" onclick="closeDoneModal()">Não, voltar</button>
      <button class="btn-green"   onclick="finalize()">Sim, finalizar</button>
    </div>
  </div>
</div>

<!-- Final modal -->
<div class="modal-bg hidden" id="final-modal" role="dialog" aria-modal="true" aria-labelledby="final-heading">
  <div class="modal">
    <h2 id="final-heading">🎉 Revisão concluída!</h2>
    <div class="stat-row">
      <div class="stat"><span class="stat-val green" id="final-count">0</span><span class="stat-lbl">Pares confirmados</span></div>
    </div>
    <p id="final-breakdown"></p>
    <div class="modal-row">
      <button class="btn-green" onclick="downloadFinal()">⬇ Baixar JSON</button>
    </div>
  </div>
</div>

<!-- Comparison modal -->
<div class="compare-bg hidden" id="compare" role="dialog" aria-modal="true" aria-labelledby="compare-title">
  <div class="compare-header">
    <div class="compare-titlebar">
      <h3 id="compare-title">Comparar mosaicos expandidos</h3>
      <button class="compare-close" onclick="closeComparison()" aria-label="Fechar comparação">✕ Fechar</button>
    </div>
    <div class="compare-modes" role="tablist" aria-label="Modo de comparação">
      <button id="cmp-mode-standard" role="tab" onclick="setComparisonMode('standard')">Padrão</button>
      <button id="cmp-mode-expanded" role="tab" onclick="setComparisonMode('expanded')" class="active">Outdoor expandido</button>
      <button id="cmp-mode-all"      role="tab" onclick="setComparisonMode('all')">Todas as fotos</button>
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
  const s = await fetch('/api/session?lane=' + encodeURIComponent(_lane)).then(r => r.json());
  _state = s;
  render(s);
  const key = currentPairKey();
  if (key && key !== _lastPairKey) {
    _lastPairKey = key;
    _pairStartedAt = Date.now();
    logClientEvent('pair_viewed', { elapsed_ms: 0 });
  }
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

function render(s) {
  if (s.lane) _lane = s.lane;
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
    groups.push('<div class="ev-group"><span class="ev-label">Modelos</span>' + chips + '</div>');
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
    groups.push('<div class="ev-group"><span class="ev-label">Geometria</span>' + geomBits.join(' &middot; ') + '</div>');
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
  if (info.price) parts.push('<strong>' + info.price + '</strong>');
  if (info.area)  parts.push(info.area + ' m²');
  if (info.beds)  parts.push(info.beds + ' dorms');
  return parts.join(' &middot; ') || '<span style="color:var(--muted)">sem dados</span>';
}

async function renderImage(site, code) {
  const container = document.getElementById(site + '-img');
  const hint = '<span class="zoom-hint">🔍 clique para ampliar</span>';

  // Try the generated standard mosaic first
  try {
    const probe = await fetch('/api/mosaic/' + site + '/' + code + '?mode=standard').then(r => r.json());
    if (probe && probe.available && probe.url) {
      container.classList.remove('is-fallback');
      container.innerHTML =
        '<img class="mosaic-img" src="' + probe.url + '" alt="Mosaico padrão ' + site + ' ' + code + '" loading="lazy">' + hint;
      return;
    }
  } catch (_) { /* fall through to image grid */ }

  // Fallback: legacy outdoor image grid
  const urls = await fetch('/api/images/' + site + '/' + code + '?mode=standard').then(r => r.json());
  container.classList.add('is-fallback');
  if (!urls.length) {
    container.innerHTML = '<div class="no-img">Sem imagens disponíveis</div>';
    return;
  }
  const six  = urls.slice(0, 6);
  const imgs = six.map(u => '<img src="' + u + '" loading="lazy">').join('');
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
  body.innerHTML = '<p class="compare-empty">Carregando…</p>';

  // Standard / Expanded prefer the generated mosaic
  if (mode === 'standard' || mode === 'expanded') {
    try {
      const probe = await fetch('/api/mosaic/' + site + '/' + code + '?mode=' + mode).then(r => r.json());
      if (probe && probe.available && probe.url) {
        body.innerHTML =
          '<img class="compare-mosaic" src="' + probe.url +
          '" alt="Mosaico ' + mode + ' ' + site + ' ' + code +
          '" loading="lazy" onclick="window.open(this.src)">';
        return;
      }
    } catch (_) { /* fall through to image grid */ }
  }

  // Fallback or "all": image grid from /api/images
  const apiMode = mode === 'all' ? 'all' : (mode === 'standard' ? 'standard' : 'expanded');
  const urls = await fetch('/api/images/' + site + '/' + code + '?mode=' + apiMode).then(r => r.json());
  if (!Array.isArray(urls) || !urls.length) {
    body.innerHTML = '<p class="compare-empty">Sem imagens.</p>';
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

const LANE_LABELS = { high: 'Alta confiança', normal: 'Normal', recall: 'Recall', audit: 'Auditoria' };

function laneSummaryHTML(lanes) {
  if (!lanes) return '';
  return '<div class="lane-summary">' +
    ['high', 'normal', 'recall', 'audit'].map(l => {
      const c = lanes[l] || {};
      return '<div class="lane-cell"><strong>' + LANE_LABELS[l] + '</strong>' +
        '✅ ' + (c.confirmed || 0) +
        ' &middot; ❌ ' + (c.skipped || 0) +
        ' &middot; ❓ ' + (c.unsure || 0) +
        ' &middot; ⏳ ' + (c.pending || 0) + '</div>';
    }).join('') + '</div>';
}

function nextLaneWithPending(lanes, exclude) {
  for (const l of ['high', 'normal', 'recall', 'audit']) {
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
  let html = 'Raia <strong>' + (LANE_LABELS[s.lane] || s.lane) + '</strong> concluída.';
  html += laneSummaryHTML(s.lanes);
  if (s.skipped_count > 0) {
    html += '<p style="margin-top:10px">Para re-matcher pares skipped: rode <code>recursive-matcher-v2.py</code>, depois <code>./scripts/sync-to-gcs.sh</code>, depois "Recarregar matches".</p>';
  } else {
    html += '<p style="margin-top:10px">Todas as raias de revisão concluídas!</p>';
  }
  notice.innerHTML = html;
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
    'Você confirmou <strong>' + s.confirmed_count + '</strong> pares.' +
    (s.skipped_count > 0 ? ' Os <strong>' + s.skipped_count + '</strong> skipped serão ignorados.' : '');
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
  document.getElementById('final-breakdown').innerHTML =
    r.total_confirmed + ' pares confirmados salvos no GCS.' + laneSummaryHTML(lanes);
  document.getElementById('final-modal').classList.remove('hidden');
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
