'use strict';
/**
 * review-server.js — Human Review Loop for AI-matched property pairs
 *
 * Usage:  node scripts/review-server.js
 * Opens:  http://localhost:3001
 *
 * Pass 1 is auto-initialised from data/auto-matches.json.
 * Subsequent passes are triggered by /api/done.
 */

const express      = require('express');
const path         = require('path');
const fs           = require('fs');
const { execSync } = require('child_process');

const session = require('./review-session');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT      = 3001;
const DATA_ROOT = path.join(__dirname, '..', 'data');
const REPO_ROOT = path.join(__dirname, '..');

const VIVA_LISTINGS_PATH   = path.join(DATA_ROOT, 'vivaprimeimoveis',  'listings', 'all-listings.json');
const COELHO_LISTINGS_PATH = path.join(DATA_ROOT, 'coelhodafonseca',   'listings', 'all-listings.json');
const AUTO_MATCHES_PATH    = path.join(DATA_ROOT, 'auto-matches.json');
const MOSAICS_ROOT         = path.join(DATA_ROOT, 'alphaville-1', 'mosaics');
const VIVA_CACHE_ROOT      = path.join(DATA_ROOT, 'vivaprimeimoveis',  'cache');
const COELHO_CACHE_ROOT    = path.join(DATA_ROOT, 'coelhodafonseca',   'cache');
const FINAL_MATCHES_PATH   = path.join(DATA_ROOT, 'review-sessions', 'final-matches.json');

// ---------------------------------------------------------------------------
// Listing metadata lookup
// ---------------------------------------------------------------------------

let vivaMap   = {};
let coelhoMap = {};

function loadListingMaps() {
  try {
    const vRaw = JSON.parse(fs.readFileSync(VIVA_LISTINGS_PATH, 'utf8'));
    for (const l of vRaw.listings) {
      const specs = (l.detailedData || {}).specs || {};
      const areaStr = specs.area_construida || '';
      const areaM = areaStr.match(/(\d+(?:[.,]\d+)?)/);
      vivaMap[String(l.propertyCode)] = {
        price: l.price || '',
        area:  areaM ? areaM[1] : '',
        beds:  specs.dormitorios != null ? String(specs.dormitorios) : '',
        url:   l.url || '',
      };
    }
  } catch (e) {
    console.warn('Could not load Viva listings:', e.message);
  }

  try {
    const cRaw = JSON.parse(fs.readFileSync(COELHO_LISTINGS_PATH, 'utf8'));
    for (const l of cRaw.listings) {
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
  } catch (e) {
    console.warn('Could not load Coelho listings:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

let currentState = null;

function ensureSession() {
  // Find or create pass-1
  let passN = session.latestPassN();
  if (!passN) {
    passN = 1;
    currentState = session.buildSession(AUTO_MATCHES_PATH, 1);
    console.log(`✓ Created pass-1 session: ${currentState.pairs.length} pairs`);
  } else {
    currentState = session.loadSession(passN);
    console.log(`✓ Loaded pass-${passN} session: ${currentState.pairs.length} pairs`);
  }
}

// ---------------------------------------------------------------------------
// Helper: mosaic path
// ---------------------------------------------------------------------------

function mosaicPath(site, code) {
  const siteDir = site === 'viva' ? 'viva' : 'coelho';
  return path.join(MOSAICS_ROOT, siteDir, `${code}.png`);
}

function hasMosaic(site, code) {
  return fs.existsSync(mosaicPath(site, code));
}

// ---------------------------------------------------------------------------
// Helper: cache dir images
// ---------------------------------------------------------------------------

function cacheDir(site, code) {
  const cacheRoot = site === 'viva' ? VIVA_CACHE_ROOT : COELHO_CACHE_ROOT;
  return path.join(cacheRoot, code);
}

function listCacheImages(site, code) {
  const dir = cacheDir(site, code);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
    .sort();
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// Static image serving
// ---------------------------------------------------------------------------

// Serve mosaic PNG
app.get('/mosaic/:site/:code', (req, res) => {
  const { site, code } = req.params;
  if (!['viva', 'coelho'].includes(site)) return res.status(400).end();
  const p = mosaicPath(site, code);
  if (!fs.existsSync(p)) return res.status(404).end();
  res.sendFile(p);
});

// Serve individual cache image
app.get('/image/:site/:code/:file', (req, res) => {
  const { site, code, file } = req.params;
  if (!['viva', 'coelho'].includes(site)) return res.status(400).end();
  // Prevent path traversal
  if (file.includes('/') || file.includes('..')) return res.status(400).end();
  const dir = cacheDir(site, code);
  const p   = path.join(dir, file);
  if (!fs.existsSync(p)) return res.status(404).end();
  res.sendFile(p);
});

// List CLIP-selected images for lightbox (facade/pool/garden only, up to 16)
app.get('/api/images/:site/:code', (req, res) => {
  const { site, code } = req.params;
  if (!['viva', 'coelho'].includes(site)) return res.status(400).json([]);

  const fullsite = site === 'viva' ? 'vivaprimeimoveis' : 'coelhodafonseca';
  const manifestPath = path.join(REPO_ROOT, 'selected_for_matching', fullsite, code, '_manifest.json');

  // Try CLIP manifest first — return only facade/pool/garden (up to 16)
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const OUTDOOR_CATS = new Set(['facade', 'pool', 'garden']);
      const entries = (manifest.all_categories || manifest.selected || [])
        .filter(e => OUTDOOR_CATS.has(e.category))
        .slice(0, 16)
        .map(e => path.basename(e.filename));
      if (entries.length > 0) return res.json(entries);
    } catch (e) {
      // fall through to cache listing
    }
  }

  // Fallback: all cache images
  res.json(listCacheImages(site, code));
});

// ---------------------------------------------------------------------------
// API: current session state
// ---------------------------------------------------------------------------

app.get('/api/session', (req, res) => {
  if (!currentState) return res.status(503).json({ error: 'no session' });

  const pair = session.currentPair(currentState);
  const total = currentState.pairs.length;
  const confirmedCount = currentState.pairs.filter(p => p.status === 'confirmed').length;
  const skippedCount   = currentState.pairs.filter(p => p.status === 'skipped').length;
  const currentIndex   = confirmedCount + skippedCount + 1;  // 1-based
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
      viva_has_mosaic:   hasMosaic('viva',   pair.viva_code),
      coelho_has_mosaic: hasMosaic('coelho', pair.coelho_code),
    };
  }

  res.json({
    pass:            currentState.pass,
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

app.post('/api/confirm', (req, res) => {
  const { viva_code, coelho_code } = req.body;
  try {
    session.confirmPair(currentState, viva_code, coelho_code);
    console.log(`✓ confirmed  Viva ${viva_code} ↔ Coelho ${coelho_code}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/skip', (req, res) => {
  const { viva_code, coelho_code } = req.body;
  try {
    session.skipPair(currentState, viva_code, coelho_code);
    console.log(`✗ skipped    Viva ${viva_code} ↔ Coelho ${coelho_code}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// API: done → trigger re-match on skipped pairs → load new session
// ---------------------------------------------------------------------------

app.post('/api/done', (req, res) => {
  const incorrectPool = currentState.pairs.filter(p => p.status === 'skipped');
  const confirmedAll  = currentState.confirmed;

  if (!incorrectPool.length) {
    return res.json({ message: 'No skipped pairs — nothing to re-match.', newPairCount: 0 });
  }

  const vivaCodes     = incorrectPool.map(p => p.viva_code).join(',');
  const coelhoExclude = confirmedAll.map(p => p.coelho_code).join(',');
  const nextPass      = currentState.pass + 1;
  const outFile       = path.join(DATA_ROOT, 'review-sessions', `pass-${nextPass}-auto.json`);

  const cmd = [
    'python3', path.join(__dirname, 'dino-auto-matcher.py'),
    '--viva-filter',    vivaCodes,
    '--coelho-exclude', coelhoExclude,
    '--threshold',      '0.80',
    '--data-root',      DATA_ROOT,
    '--output',         outFile,
  ].join(' ');

  console.log(`\nRunning re-matcher for pass ${nextPass}:\n  ${cmd}\n`);

  try {
    execSync(cmd, { stdio: 'inherit', timeout: 10 * 60 * 1000 });
  } catch (e) {
    return res.status(500).json({ error: `Re-matcher failed: ${e.message}` });
  }

  if (!fs.existsSync(outFile)) {
    return res.status(500).json({ error: 'Re-matcher produced no output file' });
  }

  // Build new session carrying all confirmed pairs forward
  currentState = session.buildNextSession(outFile, nextPass, confirmedAll);
  console.log(`✓ Pass ${nextPass} session built: ${currentState.pairs.length} new pairs`);

  res.json({ nextPass, newPairCount: currentState.pairs.length });
});

// ---------------------------------------------------------------------------
// API: final — generate final-matches.json
// ---------------------------------------------------------------------------

app.post('/api/final', (req, res) => {
  const confirmed = currentState ? currentState.confirmed : [];

  const output = {
    generated_at:    new Date().toISOString(),
    total_confirmed: confirmed.length,
    matches:         confirmed.map(p => ({
      viva_code:    p.viva_code,
      coelho_code:  p.coelho_code,
      similarity:   p.similarity,
      confirmed_at: p.confirmed_at,
      pass:         p.pass || currentState.pass,
    })),
  };

  fs.mkdirSync(path.dirname(FINAL_MATCHES_PATH), { recursive: true });
  fs.writeFileSync(FINAL_MATCHES_PATH, JSON.stringify(output, null, 2));
  console.log(`✓ Final matches written → ${FINAL_MATCHES_PATH}`);

  res.json(output);
});

// ---------------------------------------------------------------------------
// UI — serve full HTML page
// ---------------------------------------------------------------------------

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(HTML);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

loadListingMaps();
ensureSession();

app.listen(PORT, () => {
  console.log(`\n🏠 Review server running at http://localhost:${PORT}\n`);
});

// ---------------------------------------------------------------------------
// Embedded HTML UI
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
    --bg: #0f1117;
    --surface: #1a1d27;
    --card: #21253a;
    --border: #2d3250;
    --accent: #6366f1;
    --green: #22c55e;
    --red: #ef4444;
    --yellow: #eab308;
    --text: #e2e8f0;
    --muted: #94a3b8;
    --radius: 12px;
  }
  body { background: var(--bg); color: var(--text); font-family: system-ui, sans-serif;
         min-height: 100vh; display: flex; flex-direction: column; }

  /* ── Header ── */
  header {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 12px 24px;
    display: flex; align-items: center; gap: 20px; flex-wrap: wrap;
  }
  header h1 { font-size: 1.1rem; font-weight: 700; color: var(--text); white-space: nowrap; }
  .badge {
    background: var(--card); border: 1px solid var(--border);
    border-radius: 6px; padding: 4px 10px; font-size: 0.85rem; color: var(--muted);
  }
  .badge span { color: var(--text); font-weight: 600; }
  .progress-bar {
    flex: 1; min-width: 120px; height: 8px;
    background: var(--card); border-radius: 4px; overflow: hidden;
  }
  .progress-fill { height: 100%; background: var(--accent); transition: width 0.3s; }

  /* ── Main layout ── */
  main {
    flex: 1; display: grid; grid-template-columns: 1fr 1fr;
    gap: 16px; padding: 16px; max-width: 1400px; margin: 0 auto; width: 100%;
  }
  @media (max-width: 700px) { main { grid-template-columns: 1fr; } }

  /* ── Property card ── */
  .prop-card {
    background: var(--card); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 16px; display: flex; flex-direction: column; gap: 12px;
  }
  .prop-header {
    display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
  }
  .prop-source {
    font-size: 0.7rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
    padding: 2px 8px; border-radius: 4px; background: var(--accent); color: #fff;
  }
  .prop-code { font-size: 0.9rem; font-weight: 600; color: var(--muted); }
  .prop-meta { font-size: 0.9rem; color: var(--muted); line-height: 1.5; }
  .prop-meta strong { color: var(--text); }
  .prop-img {
    position: relative; cursor: pointer; border-radius: 8px; overflow: hidden;
    background: var(--surface); min-height: 260px;
    display: flex; align-items: center; justify-content: center;
  }
  .prop-img img.mosaic { width: 100%; height: 100%; object-fit: contain; display: block; }
  .prop-img .img-grid {
    display: flex; flex-wrap: wrap; gap: 2px; width: 100%;
  }
  .prop-img .img-grid img {
    width: calc(33.33% - 2px); height: 130px; object-fit: cover;
  }
  .prop-img .zoom-hint {
    position: absolute; bottom: 8px; right: 8px;
    background: rgba(0,0,0,0.65); color: #fff; font-size: 0.75rem;
    padding: 3px 8px; border-radius: 4px; pointer-events: none;
  }
  .prop-img .no-img {
    color: var(--muted); font-size: 0.85rem; padding: 40px;
  }
  .prop-link { font-size: 0.82rem; color: var(--accent); text-decoration: none; }
  .prop-link:hover { text-decoration: underline; }

  /* ── Footer / action bar ── */
  footer {
    background: var(--surface); border-top: 1px solid var(--border);
    padding: 16px 24px; display: flex; flex-direction: column; align-items: center; gap: 12px;
  }
  .sim-badge {
    font-size: 0.9rem; color: var(--muted);
  }
  .sim-badge .sim-val {
    font-weight: 700; font-size: 1rem;
  }
  .sim-badge .sim-val.high   { color: var(--green); }
  .sim-badge .sim-val.medium { color: var(--yellow); }
  .sim-badge .sim-val.low    { color: var(--red); }
  .tier-label {
    display: inline-block; margin-left: 8px; padding: 2px 8px;
    border-radius: 4px; font-size: 0.75rem; font-weight: 700;
  }
  .tier-high   { background: #22c55e22; color: var(--green); border: 1px solid var(--green); }
  .tier-medium { background: #eab30822; color: var(--yellow); border: 1px solid var(--yellow); }
  .tier-low    { background: #ef444422; color: var(--red); border: 1px solid var(--red); }
  .actions { display: flex; gap: 12px; }
  button {
    cursor: pointer; border: none; border-radius: 8px;
    padding: 10px 28px; font-size: 0.95rem; font-weight: 600; transition: opacity 0.15s;
  }
  button:hover { opacity: 0.85; }
  #btn-skip  { background: var(--red);    color: #fff; }
  #btn-match { background: var(--green);  color: #fff; }
  #btn-done  { background: var(--surface); color: var(--muted);
               border: 1px solid var(--border); }
  .kbd { display: inline-block; background: var(--card); border: 1px solid var(--border);
         border-radius: 4px; padding: 1px 6px; font-size: 0.75rem; color: var(--muted); }

  /* ── Modal / overlay ── */
  .modal-bg {
    position: fixed; inset: 0; background: rgba(0,0,0,0.75);
    display: flex; align-items: center; justify-content: center; z-index: 100;
  }
  .modal-bg.hidden { display: none; }
  .modal {
    background: var(--card); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 32px; max-width: 460px; width: 90%; display: flex; flex-direction: column; gap: 20px;
  }
  .modal h2 { font-size: 1.2rem; }
  .modal p  { color: var(--muted); font-size: 0.9rem; line-height: 1.5; }
  .modal-row { display: flex; gap: 10px; justify-content: flex-end; }
  .btn-outline { background: transparent; border: 1px solid var(--border); color: var(--text); }
  .btn-green   { background: var(--green); color: #fff; }
  .btn-accent  { background: var(--accent); color: #fff; }
  .stat-row { display: flex; gap: 24px; }
  .stat { display: flex; flex-direction: column; }
  .stat-val { font-size: 1.8rem; font-weight: 700; }
  .stat-lbl { font-size: 0.8rem; color: var(--muted); }
  .green { color: var(--green); }
  .red   { color: var(--red); }

  /* ── Lightbox ── */
  .lightbox-bg {
    position: fixed; inset: 0; background: rgba(0,0,0,0.92);
    overflow-y: auto; z-index: 200; padding: 20px;
  }
  .lightbox-bg.hidden { display: none; }
  .lightbox-header {
    display: flex; justify-content: space-between; align-items: center;
    margin-bottom: 16px;
  }
  .lightbox-header h3 { font-size: 1rem; }
  .lightbox-close {
    background: var(--card); border: 1px solid var(--border); color: var(--text);
    border-radius: 6px; padding: 6px 14px; cursor: pointer; font-size: 0.9rem;
  }
  .lightbox-grid { display: flex; flex-wrap: wrap; gap: 6px; }
  .lightbox-grid img { max-width: calc(25% - 6px); height: 200px; object-fit: cover;
                       border-radius: 6px; cursor: zoom-in; }
  @media (max-width: 700px) { .lightbox-grid img { max-width: calc(50% - 6px); } }

  /* ── Final summary ── */
  #final-summary { display: none; }
  #final-summary.visible { display: block; }

  /* ── Loading overlay ── */
  .loading-spinner {
    width: 48px; height: 48px;
    border: 4px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 1.1s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>

<!-- ═══ Header ═══ -->
<header>
  <h1>🏠 Match Review</h1>
  <div class="badge">Pass <span id="hdr-pass">1</span></div>
  <div class="badge"><span id="hdr-current">1</span> / <span id="hdr-total">?</span></div>
  <div class="badge">✅ <span id="hdr-confirmed">0</span>  ❌ <span id="hdr-skipped">0</span></div>
  <div class="progress-bar"><div class="progress-fill" id="progress-fill" style="width:0%"></div></div>
</header>

<!-- ═══ Main review panel ═══ -->
<main id="review-panel">
  <!-- Viva card -->
  <div class="prop-card">
    <div class="prop-header">
      <span class="prop-source" style="background:#7c3aed">VIVA</span>
      <span class="prop-code" id="viva-code"></span>
    </div>
    <div class="prop-meta" id="viva-meta"></div>
    <div class="prop-img" id="viva-img" onclick="openLightbox('viva')">
      <span class="zoom-hint">🔍 clique para ampliar</span>
    </div>
    <a class="prop-link" id="viva-link" href="#" target="_blank" rel="noopener">🔗 Abrir no Viva Primeiros Imóveis</a>
  </div>

  <!-- Coelho card -->
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

<!-- ═══ Footer actions ═══ -->
<footer>
  <div class="sim-badge">
    Confianca: <span class="sim-val" id="sim-val">—</span>
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

<!-- ═══ Pass-complete modal ═══ -->
<div class="modal-bg hidden" id="pass-complete-modal">
  <div class="modal">
    <h2>Pass <span id="pc-pass">1</span> completo ✅</h2>
    <div class="stat-row">
      <div class="stat"><span class="stat-val green" id="pc-confirmed">0</span><span class="stat-lbl">Confirmados</span></div>
      <div class="stat"><span class="stat-val red"   id="pc-skipped">0</span><span class="stat-lbl">Skipped</span></div>
    </div>
    <p id="pc-desc">Deseja fazer um novo pass sobre os pares skipped?</p>
    <div class="modal-row">
      <button class="btn-outline" onclick="triggerDone()">🏁 I'm Done</button>
      <button class="btn-accent"  id="pc-next-btn" onclick="triggerNextPass()">➡ Próximo pass</button>
    </div>
  </div>
</div>

<!-- ═══ "I'm Done" confirmation modal ═══ -->
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

<!-- ═══ Final summary ═══ -->
<div class="modal-bg hidden" id="final-modal">
  <div class="modal">
    <h2>🎉 Revisão concluída!</h2>
    <div class="stat-row">
      <div class="stat"><span class="stat-val green" id="final-count">0</span><span class="stat-lbl">Pares confirmados</span></div>
    </div>
    <p id="final-breakdown"></p>
    <p style="margin-top:4px">
      Arquivo salvo em:<br>
      <code style="font-size:0.8rem;color:var(--accent)">data/review-sessions/final-matches.json</code>
    </p>
    <div class="modal-row">
      <button class="btn-green" onclick="downloadFinal()">⬇ Baixar JSON</button>
    </div>
  </div>
</div>

<!-- ═══ Loading overlay (re-match in progress) ═══ -->
<div class="modal-bg hidden" id="loading-overlay">
  <div class="modal" style="align-items:center;text-align:center;gap:24px">
    <div style="font-size:2.5rem">🔄</div>
    <h2 id="loading-title">Re-matching skipped pairs...</h2>
    <div class="loading-spinner"></div>
    <p style="color:var(--muted);line-height:1.6">
      O matcher de IA está rodando. CPU alta é normal!<br>
      Isso pode levar alguns minutos — aguarde.
    </p>
    <p id="loading-detail" style="color:var(--muted);font-size:0.8rem;font-family:monospace"></p>
  </div>
</div>

<!-- ═══ Lightbox ═══ -->
<div class="lightbox-bg hidden" id="lightbox">
  <div class="lightbox-header">
    <h3 id="lightbox-title">Imagens</h3>
    <button class="lightbox-close" onclick="closeLightbox()">✕ Fechar</button>
  </div>
  <div class="lightbox-grid" id="lightbox-grid"></div>
</div>

<script>
// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

let _state = null;      // current /api/session response
let _finalData = null;  // from /api/final

// ─────────────────────────────────────────────────────────────────────────────
// Fetch session + render
// ─────────────────────────────────────────────────────────────────────────────

async function fetchSession() {
  const s = await fetch('/api/session').then(r => r.json());
  _state = s;
  render(s);
}

function render(s) {
  // Header
  document.getElementById('hdr-pass').textContent      = s.pass;
  document.getElementById('hdr-current').textContent   = s.current_index;
  document.getElementById('hdr-total').textContent     = s.total;
  document.getElementById('hdr-confirmed').textContent = s.confirmed_count;
  document.getElementById('hdr-skipped').textContent   = s.skipped_count;
  const pct = s.total > 0 ? ((s.confirmed_count + s.skipped_count) / s.total * 100).toFixed(1) : 0;
  document.getElementById('progress-fill').style.width = pct + '%';

  // Footer
  document.getElementById('footer-current').textContent = s.current_index;
  document.getElementById('footer-total').textContent   = s.total;
  document.getElementById('footer-pass').textContent    = s.pass;

  if (s.all_done) {
    showPassComplete(s);
    return;
  }

  const p = s.pair;

  // Viva side
  document.getElementById('viva-code').textContent = '#' + p.viva_code;
  document.getElementById('viva-meta').innerHTML   = metaHTML(p.viva);
  if (p.viva.url) document.getElementById('viva-link').href = p.viva.url;
  renderImage('viva', p.viva_code, p.viva_has_mosaic);

  // Coelho side
  document.getElementById('coelho-code').textContent = '#' + p.coelho_code;
  document.getElementById('coelho-meta').innerHTML   = metaHTML(p.coelho);
  if (p.coelho.url) document.getElementById('coelho-link').href = p.coelho.url;
  renderImage('coelho', p.coelho_code, p.coelho_has_mosaic);

  // Confidence badge
  const conf = p.confidence_score || p.similarity;
  const tier = p.tier || 'medium';
  const cls = tier === 'high' ? 'high' : tier === 'medium' ? 'medium' : 'low';
  const simEl = document.getElementById('sim-val');
  simEl.textContent  = conf.toFixed(4);
  simEl.className    = 'sim-val ' + cls;

  // Show tier + extra info
  const infoEl = document.getElementById('sim-extra');
  if (infoEl) {
    const tierLabel = tier === 'high' ? 'ALTA' : tier === 'medium' ? 'MEDIA' : 'BAIXA';
    const rankInfo = (p.pool_rank ? ' pool#' + p.pool_rank : '') +
                     (p.facade_rank ? ' fachada#' + p.facade_rank : '');
    infoEl.textContent = tierLabel + rankInfo;
    infoEl.className = 'tier-label tier-' + tier;
  }
}

function metaHTML(info) {
  const parts = [];
  if (info.price) parts.push('<strong>' + info.price + '</strong>');
  if (info.area)  parts.push(info.area + ' m²');
  if (info.beds)  parts.push(info.beds + ' dorms');
  return parts.join(' &middot; ') || '<span style="color:var(--muted)">sem dados</span>';
}

// ─────────────────────────────────────────────────────────────────────────────
// Image rendering
// ─────────────────────────────────────────────────────────────────────────────

function renderImage(site, code, hasMosaic) {
  const container = document.getElementById(site + '-img');
  // Keep zoom hint
  const hint = '<span class="zoom-hint">🔍 clique para ampliar</span>';

  if (hasMosaic) {
    container.innerHTML = '<img class="mosaic" src="/mosaic/' + site + '/' + code + '" alt="mosaic">' + hint;
  } else {
    showCacheGrid(site, code, container, hint);
  }
}

async function showCacheGrid(site, code, container, hint) {
  const files = await fetch('/api/images/' + site + '/' + code).then(r => r.json());
  if (!files.length) {
    container.innerHTML = '<div class="no-img">Sem imagens disponíveis</div>';
    return;
  }
  const six = files.slice(0, 6);
  const imgs = six.map(f =>
    '<img src="/image/' + site + '/' + code + '/' + f + '" alt="' + f + '" loading="lazy">'
  ).join('');
  container.innerHTML = '<div class="img-grid">' + imgs + '</div>' + hint;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lightbox
// ─────────────────────────────────────────────────────────────────────────────

async function openLightbox(site) {
  if (!_state || !_state.pair) return;
  const code = site === 'viva' ? _state.pair.viva_code : _state.pair.coelho_code;
  const label = site === 'viva' ? 'Viva #' + code : 'Coelho #' + code;
  document.getElementById('lightbox-title').textContent = label;

  const files = await fetch('/api/images/' + site + '/' + code).then(r => r.json());
  const grid  = document.getElementById('lightbox-grid');
  if (!files.length) {
    grid.innerHTML = '<p style="color:var(--muted)">Sem imagens em cache.</p>';
  } else {
    grid.innerHTML = files.map(f =>
      '<img src="/image/' + site + '/' + code + '/' + f + '" loading="lazy" onclick="window.open(this.src)">'
    ).join('');
  }
  document.getElementById('lightbox').classList.remove('hidden');
}

function closeLightbox() {
  document.getElementById('lightbox').classList.add('hidden');
}

// ─────────────────────────────────────────────────────────────────────────────
// Actions: match / skip
// ─────────────────────────────────────────────────────────────────────────────

async function doMatch() {
  if (!_state || !_state.pair || _state.all_done) return;
  await fetch('/api/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ viva_code: _state.pair.viva_code, coelho_code: _state.pair.coelho_code }),
  });
  fetchSession();
}

async function doSkip() {
  if (!_state || !_state.pair || _state.all_done) return;
  await fetch('/api/skip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ viva_code: _state.pair.viva_code, coelho_code: _state.pair.coelho_code }),
  });
  fetchSession();
}

// ─────────────────────────────────────────────────────────────────────────────
// Pass-complete modal
// ─────────────────────────────────────────────────────────────────────────────

function showPassComplete(s) {
  document.getElementById('pc-pass').textContent      = s.pass;
  document.getElementById('pc-confirmed').textContent = s.confirmed_count;
  document.getElementById('pc-skipped').textContent   = s.skipped_count;

  const nextBtn = document.getElementById('pc-next-btn');
  if (s.skipped_count === 0) {
    document.getElementById('pc-desc').textContent = 'Todos os pares foram confirmados!';
    nextBtn.style.display = 'none';
  } else {
    document.getElementById('pc-desc').textContent =
      'Deseja re-matcher os ' + s.skipped_count + ' pares skipped em um novo pass?';
    nextBtn.textContent = '➡ Pass ' + (s.pass + 1);
    nextBtn.style.display = '';
  }
  document.getElementById('pass-complete-modal').classList.remove('hidden');
}

async function triggerNextPass() {
  document.getElementById('pass-complete-modal').classList.add('hidden');

  // Show loading overlay — Python matcher can take minutes
  const skipped = _state ? _state.skipped_count : '?';
  document.getElementById('loading-detail').textContent =
    'Re-matching ' + skipped + ' pairs skipped...';
  document.getElementById('loading-overlay').classList.remove('hidden');

  try {
    const r = await fetch('/api/done', { method: 'POST' }).then(resp => resp.json());
    document.getElementById('loading-overlay').classList.add('hidden');
    if (r.error) { alert('Erro: ' + r.error); return; }
    if (r.newPairCount === 0) {
      alert('Nenhum novo par encontrado pelo re-matcher.');
      return;
    }
    await fetchSession();
  } catch (e) {
    document.getElementById('loading-overlay').classList.add('hidden');
    alert('Erro de rede: ' + e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// "I'm Done" flow
// ─────────────────────────────────────────────────────────────────────────────

function askDone() {
  closeDoneModal(); // reset
  const s = _state;
  if (!s) return;
  const confirmed = s.confirmed_count;
  const skipped   = s.skipped_count;
  const pending   = s.total - confirmed - skipped;
  document.getElementById('done-confirm-text').innerHTML =
    'Você confirmou <strong>' + confirmed + '</strong> par' + (confirmed !== 1 ? 'es' : '') + '.' +
    (skipped  > 0 ? ' Os <strong>' + skipped  + '</strong> skipped não serão re-matchados.' : '') +
    (pending  > 0 ? ' Ainda há <strong>' + pending + '</strong> par' + (pending !== 1 ? 'es' : '') + ' pendentes.' : '');
  document.getElementById('done-confirm-modal').classList.remove('hidden');
}

function triggerDone() {
  document.getElementById('pass-complete-modal').classList.add('hidden');
  askDone();
}

function closeDoneModal() {
  document.getElementById('done-confirm-modal').classList.add('hidden');
}

async function finalize() {
  closeDoneModal();
  const r = await fetch('/api/final', { method: 'POST' }).then(r => r.json());
  _finalData = r;
  document.getElementById('final-count').textContent = r.total_confirmed;
  document.getElementById('final-breakdown').textContent =
    r.total_confirmed + ' par' + (r.total_confirmed !== 1 ? 'es' : '') + ' confirmado' +
    (r.total_confirmed !== 1 ? 's' : '') + ' em ' + r.matches.length + ' registros.';
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

// ─────────────────────────────────────────────────────────────────────────────
// Keyboard shortcuts
// ─────────────────────────────────────────────────────────────────────────────

document.addEventListener('keydown', e => {
  // Don't fire when modal is open
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

// ─────────────────────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────────────────────

fetchSession();
</script>
</body>
</html>`;
