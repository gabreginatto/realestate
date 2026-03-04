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
const { Storage } = require('@google-cloud/storage');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT       = process.env.PORT || 3001;
const GCS_BUCKET = process.env.GCS_BUCKET || 'realestate-475615-data';
const GCS_BASE   = `https://storage.googleapis.com/${GCS_BUCKET}`;

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

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let vivaMap    = {};
let coelhoMap  = {};
let autoMatches = [];    // array of match objects from auto-matches.json
let currentSession = null;  // { pass, pairs, confirmed }

// ---------------------------------------------------------------------------
// Load listings from GCS
// ---------------------------------------------------------------------------

async function loadListingMaps() {
  try {
    const vRaw = await fetchJson(`${GCS_BASE}/listings/vivaprimeimoveis.json`);
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
    const cRaw = await fetchJson(`${GCS_BASE}/listings/coelhodafonseca.json`);
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

async function loadMatches() {
  try {
    const raw = await fetchJson(`${GCS_BASE}/matches/auto-matches.json`);
    autoMatches = Array.isArray(raw.matches) ? raw.matches : Object.entries(raw.matches || {}).map(([viva_code, v]) => ({
      viva_code,
      coelho_code: v.coelho_code,
      similarity:  v.similarity,
      tier:        v.tier,
      confidence_score: v.confidence_score,
    }));
    console.log(`✓ Loaded ${autoMatches.length} matches from GCS`);
  } catch (e) {
    console.warn('Could not load auto-matches from GCS:', e.message);
    autoMatches = [];
  }
}

// ---------------------------------------------------------------------------
// Session management (in-memory + GCS persistence)
// ---------------------------------------------------------------------------

async function ensureSession() {
  // Try to load existing session from GCS
  try {
    currentSession = await gcsRead('review-sessions/current.json');
    console.log(`✓ Resumed session: pass-${currentSession.pass}, ${currentSession.pairs.length} pairs`);
    return;
  } catch (e) {
    // No existing session — build from matches
  }

  currentSession = buildNewSession(autoMatches, 1, []);
  await saveSession();
  console.log(`✓ Created pass-1 session: ${currentSession.pairs.length} pairs`);
}

function buildNewSession(matches, passN, carryConfirmed) {
  const confirmedSet = new Set(carryConfirmed.map(p => p.viva_code));
  const pairs = matches
    .filter(m => !confirmedSet.has(m.viva_code))
    .map(m => ({ ...m, status: 'pending' }));
  return {
    pass:      passN,
    pairs,
    confirmed: [...carryConfirmed],
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

function currentPair() {
  return currentSession.pairs.find(p => p.status === 'pending') || null;
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

  const fs = fullSite(site);

  // Try CLIP manifest from GCS
  try {
    const manifest = await gcsRead(`selected/${fs}/${code}/_manifest.json`);
    const OUTDOOR  = new Set(['facade', 'pool', 'garden']);
    const urls = (manifest.all_categories || manifest.selected || [])
      .filter(e => OUTDOOR.has(e.category))
      .slice(0, 16)
      .map(e => selectedImageUrl(site, code, e.filename));
    if (urls.length) return res.json(urls);
  } catch (_) { /* fall through */ }

  // Fallback: list images from GCS cache prefix
  try {
    const [files] = await bucket.getFiles({ prefix: `images/${fs}/${code}/` });
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
// API: reload matches from GCS (call after running sync-to-gcs.sh on Mac)
// ---------------------------------------------------------------------------

app.post('/api/reload', async (req, res) => {
  await loadMatches();
  res.json({ ok: true, match_count: autoMatches.length });
});

// ---------------------------------------------------------------------------
// API: session state
// ---------------------------------------------------------------------------

app.get('/api/session', (req, res) => {
  if (!currentSession) return res.status(503).json({ error: 'no session' });

  const pair          = currentPair();
  const total         = currentSession.pairs.length;
  const confirmedCount = currentSession.pairs.filter(p => p.status === 'confirmed').length;
  const skippedCount   = currentSession.pairs.filter(p => p.status === 'skipped').length;
  const currentIndex   = confirmedCount + skippedCount + 1;
  const allDone        = !pair;

  let pairData = null;
  if (pair) {
    const viva   = vivaMap[pair.viva_code]   || {};
    const coelho = coelhoMap[pair.coelho_code] || {};
    pairData = {
      viva_code:        pair.viva_code,
      coelho_code:      pair.coelho_code,
      similarity:       pair.similarity,
      confidence_score: pair.confidence_score ?? pair.similarity,
      tier:             pair.tier ?? 'medium',
      pool_rank:        pair.pool_rank ?? null,
      facade_rank:      pair.facade_rank ?? null,
      viva,
      coelho,
    };
  }

  res.json({
    pass:            currentSession.pass,
    current_index:   allDone ? total : currentIndex,
    total,
    confirmed_count: confirmedCount,
    skipped_count:   skippedCount,
    pair:            pairData,
    all_done:        allDone,
  });
});

// ---------------------------------------------------------------------------
// API: confirm / skip
// ---------------------------------------------------------------------------

app.post('/api/confirm', async (req, res) => {
  const { viva_code, coelho_code } = req.body;
  const pair = currentSession.pairs.find(p => p.viva_code === viva_code && p.coelho_code === coelho_code);
  if (!pair) return res.status(400).json({ error: 'pair not found' });
  pair.status = 'confirmed';
  currentSession.confirmed.push({ ...pair, confirmed_at: new Date().toISOString() });
  console.log(`✓ confirmed  Viva ${viva_code} ↔ Coelho ${coelho_code}`);
  await saveSession();
  res.json({ ok: true });
});

app.post('/api/skip', async (req, res) => {
  const { viva_code, coelho_code } = req.body;
  const pair = currentSession.pairs.find(p => p.viva_code === viva_code && p.coelho_code === coelho_code);
  if (!pair) return res.status(400).json({ error: 'pair not found' });
  pair.status = 'skipped';
  console.log(`✗ skipped    Viva ${viva_code} ↔ Coelho ${coelho_code}`);
  await saveSession();
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
  const output = {
    generated_at:    new Date().toISOString(),
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
  res.json(output);
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
           padding: 12px 24px; display: flex; align-items: center; gap: 20px; flex-wrap: wrap; }
  header h1 { font-size: 1.1rem; font-weight: 700; white-space: nowrap; }
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
              background: var(--surface); min-height: 260px;
              display: flex; align-items: center; justify-content: center; }
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
  #btn-skip  { background: var(--red); color: #fff; }
  #btn-match { background: var(--green); color: #fff; }
  #btn-done  { background: var(--surface); color: var(--muted); border: 1px solid var(--border); }
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
  .lightbox-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.92);
                 overflow-y: auto; z-index: 200; padding: 20px; }
  .lightbox-bg.hidden { display: none; }
  .lightbox-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
  .lightbox-header h3 { font-size: 1rem; }
  .lightbox-close { background: var(--card); border: 1px solid var(--border); color: var(--text);
                    border-radius: 6px; padding: 6px 14px; cursor: pointer; font-size: 0.9rem; }
  .lightbox-grid { display: flex; flex-wrap: wrap; gap: 6px; }
  .lightbox-grid img { max-width: calc(25% - 6px); height: 200px; object-fit: cover;
                       border-radius: 6px; cursor: zoom-in; }
  @media (max-width: 700px) { .lightbox-grid img { max-width: calc(50% - 6px); } }
  .notice { background: #6366f122; border: 1px solid var(--accent); border-radius: 8px;
            padding: 12px 16px; font-size: 0.85rem; color: var(--text); line-height: 1.5; }
  .notice code { color: var(--accent); font-size: 0.8rem; }
</style>
</head>
<body>

<header>
  <h1>🏠 Match Review</h1>
  <div class="badge">Pass <span id="hdr-pass">1</span></div>
  <div class="badge"><span id="hdr-current">1</span> / <span id="hdr-total">?</span></div>
  <div class="badge">✅ <span id="hdr-confirmed">0</span>  ❌ <span id="hdr-skipped">0</span></div>
  <div class="progress-bar"><div class="progress-fill" id="progress-fill" style="width:0%"></div></div>
</header>

<main id="review-panel">
  <div class="prop-card">
    <div class="prop-header">
      <span class="prop-source" style="background:#7c3aed">VIVA</span>
      <span class="prop-code" id="viva-code"></span>
    </div>
    <div class="prop-meta" id="viva-meta"></div>
    <div class="prop-img" id="viva-img" onclick="openLightbox('viva')">
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
    <div class="prop-img" id="coelho-img" onclick="openLightbox('coelho')">
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
  <div class="actions">
    <button id="btn-skip"  onclick="doSkip()">❌ SKIP <span class="kbd">← s</span></button>
    <button id="btn-match" onclick="doMatch()">✅ MATCH <span class="kbd">→ m</span></button>
    <button id="btn-done"  onclick="askDone()">🏁 I'M DONE <span class="kbd">d</span></button>
  </div>
</footer>

<!-- Pass complete modal -->
<div class="modal-bg hidden" id="pass-complete-modal">
  <div class="modal">
    <h2>Pass <span id="pc-pass">1</span> completo ✅</h2>
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
<div class="modal-bg hidden" id="done-confirm-modal">
  <div class="modal">
    <h2>⚠️ Tem certeza?</h2>
    <p id="done-confirm-text"></p>
    <div class="modal-row">
      <button class="btn-outline" onclick="closeDoneModal()">Não, voltar</button>
      <button class="btn-green"   onclick="finalize()">Sim, finalizar</button>
    </div>
  </div>
</div>

<!-- Final modal -->
<div class="modal-bg hidden" id="final-modal">
  <div class="modal">
    <h2>🎉 Revisão concluída!</h2>
    <div class="stat-row">
      <div class="stat"><span class="stat-val green" id="final-count">0</span><span class="stat-lbl">Pares confirmados</span></div>
    </div>
    <p id="final-breakdown"></p>
    <div class="modal-row">
      <button class="btn-green" onclick="downloadFinal()">⬇ Baixar JSON</button>
    </div>
  </div>
</div>

<!-- Lightbox -->
<div class="lightbox-bg hidden" id="lightbox">
  <div class="lightbox-header">
    <h3 id="lightbox-title">Imagens</h3>
    <button class="lightbox-close" onclick="closeLightbox()">✕ Fechar</button>
  </div>
  <div class="lightbox-grid" id="lightbox-grid"></div>
</div>

<script>
let _state = null;
let _finalData = null;

async function fetchSession() {
  const s = await fetch('/api/session').then(r => r.json());
  _state = s;
  render(s);
}

function render(s) {
  document.getElementById('hdr-pass').textContent      = s.pass;
  document.getElementById('hdr-current').textContent   = s.current_index;
  document.getElementById('hdr-total').textContent     = s.total;
  document.getElementById('hdr-confirmed').textContent = s.confirmed_count;
  document.getElementById('hdr-skipped').textContent   = s.skipped_count;
  const pct = s.total > 0 ? ((s.confirmed_count + s.skipped_count) / s.total * 100).toFixed(1) : 0;
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

  const conf = p.confidence_score || p.similarity;
  const tier = p.tier || 'medium';
  const simEl = document.getElementById('sim-val');
  simEl.textContent = conf.toFixed(4);
  simEl.className   = 'sim-val ' + (tier === 'high' ? 'high' : tier === 'medium' ? 'medium' : 'low');
  const infoEl = document.getElementById('sim-extra');
  const tierLabel = tier === 'high' ? 'ALTA' : tier === 'medium' ? 'MEDIA' : 'BAIXA';
  infoEl.textContent = tierLabel;
  infoEl.className   = 'tier-label tier-' + tier;
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
  const urls = await fetch('/api/images/' + site + '/' + code).then(r => r.json());
  if (!urls.length) {
    container.innerHTML = '<div class="no-img">Sem imagens disponíveis</div>';
    return;
  }
  const six  = urls.slice(0, 6);
  const imgs = six.map(u => '<img src="' + u + '" loading="lazy">').join('');
  container.innerHTML = '<div class="img-grid">' + imgs + '</div>' + hint;
}

async function openLightbox(site) {
  if (!_state || !_state.pair) return;
  const code  = site === 'viva' ? _state.pair.viva_code : _state.pair.coelho_code;
  const label = site === 'viva' ? 'Viva #' + code : 'Coelho #' + code;
  document.getElementById('lightbox-title').textContent = label;
  const urls = await fetch('/api/images/' + site + '/' + code).then(r => r.json());
  const grid = document.getElementById('lightbox-grid');
  grid.innerHTML = urls.length
    ? urls.map(u => '<img src="' + u + '" loading="lazy" onclick="window.open(this.src)">').join('')
    : '<p style="color:var(--muted)">Sem imagens.</p>';
  document.getElementById('lightbox').classList.remove('hidden');
}
function closeLightbox() { document.getElementById('lightbox').classList.add('hidden'); }

async function doMatch() {
  if (!_state || !_state.pair || _state.all_done) return;
  await fetch('/api/confirm', { method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ viva_code: _state.pair.viva_code, coelho_code: _state.pair.coelho_code }) });
  fetchSession();
}

async function doSkip() {
  if (!_state || !_state.pair || _state.all_done) return;
  await fetch('/api/skip', { method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ viva_code: _state.pair.viva_code, coelho_code: _state.pair.coelho_code }) });
  fetchSession();
}

function showPassComplete(s) {
  document.getElementById('pc-pass').textContent      = s.pass;
  document.getElementById('pc-confirmed').textContent = s.confirmed_count;
  document.getElementById('pc-skipped').textContent   = s.skipped_count;
  const notice = document.getElementById('pc-notice');
  if (s.skipped_count > 0) {
    notice.innerHTML = 'Para re-matcher os <strong>' + s.skipped_count + '</strong> pares skipped:<br>' +
      '1. Rode <code>recursive-matcher-v2.py</code> no Mac<br>' +
      '2. Rode <code>./scripts/sync-to-gcs.sh</code><br>' +
      '3. Clique em "Recarregar matches" abaixo';
    document.getElementById('pc-reload-btn').style.display = '';
  } else {
    notice.innerHTML = 'Todos os pares foram confirmados!';
    document.getElementById('pc-reload-btn').style.display = 'none';
  }
  document.getElementById('pass-complete-modal').classList.remove('hidden');
}

async function reloadAndContinue() {
  document.getElementById('pass-complete-modal').classList.add('hidden');
  await fetch('/api/reload', { method: 'POST' });
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
  const r = await fetch('/api/final', { method: 'POST' }).then(r => r.json());
  _finalData = r;
  document.getElementById('final-count').textContent = r.total_confirmed;
  document.getElementById('final-breakdown').textContent =
    r.total_confirmed + ' pares confirmados salvos no GCS.';
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
  if (!document.getElementById('lightbox').classList.contains('hidden')) {
    if (e.key === 'Escape') closeLightbox();
    return;
  }
  if (e.key === 'ArrowRight' || e.key === 'm') doMatch();
  if (e.key === 'ArrowLeft'  || e.key === 's') doSkip();
  if (e.key === 'd') askDone();
});

fetchSession();
</script>
</body>
</html>`;
