'use strict';
const sharp = require('sharp');
const path  = require('path');
const fs    = require('fs');

// ── Path constants ─────────────────────────────────────────────────────────────
const REPO_ROOT     = path.join(__dirname, '..');
const SELECTED_ROOT = path.join(REPO_ROOT, 'selected_for_matching');
const DATA_ROOT     = path.join(REPO_ROOT, 'data');
const MOSAICS_ROOT  = path.join(DATA_ROOT, 'alphaville-1', 'mosaics');
const VIVA_CACHE    = path.join(DATA_ROOT, 'vivaprimeimoveis', 'cache');
const COELHO_CACHE  = path.join(DATA_ROOT, 'coelhodafonseca', 'cache');
const VIVA_SELECTED = path.join(SELECTED_ROOT, 'vivaprimeimoveis');
const COELHO_SELECTED = path.join(SELECTED_ROOT, 'coelhodafonseca');

// ── Site config ────────────────────────────────────────────────────────────────
const SITES = {
  viva: {
    fullsite:  'vivaprimeimoveis',
    cacheDir:  VIVA_CACHE,
    selectedDir: VIVA_SELECTED,
    mosaicDir: path.join(MOSAICS_ROOT, 'viva'),
  },
  coelho: {
    fullsite:  'coelhodafonseca',
    cacheDir:  COELHO_CACHE,
    selectedDir: COELHO_SELECTED,
    mosaicDir: path.join(MOSAICS_ROOT, 'coelho'),
  },
};

// ── Mosaic layout ──────────────────────────────────────────────────────────────
const COLS = 4;
const ROWS = 2;
const CW   = 320;
const CH   = 320;
const TOTAL_W = COLS * CW; // 1280
const TOTAL_H = ROWS * CH; // 640

// ── Image selection ────────────────────────────────────────────────────────────
/**
 * Read the manifest and select:
 *   - up to 3 facade images
 *   - up to 5 pool images
 *   - fill remaining slots (up to 8 total) with garden images
 * Images are ordered: facade first, then pool, then garden.
 * Returns an array of absolute file paths (length <= 8).
 */
async function selectImages(manifestPath, cacheDir, code) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  // Prefer all_categories; fall back to selected
  const categories = manifest.all_categories || manifest.selected || [];

  const byCategory = (cat) => categories.filter(e => e.category === cat);

  const facades = byCategory('facade').slice(0, 3);
  const pools   = byCategory('pool').slice(0, 5);

  const taken    = facades.length + pools.length;
  const remaining = Math.max(0, 8 - taken);
  const gardens  = byCategory('garden').slice(0, remaining);

  const chosen = [...facades, ...pools, ...gardens];

  return chosen.map(e => path.join(cacheDir, code, e.filename));
}

// ── Mosaic builder ─────────────────────────────────────────────────────────────
/**
 * Build a 2×4 grid mosaic from up to 8 image paths.
 * Missing or non-existent paths are replaced by a dark-grey placeholder cell.
 */
async function buildMosaic(imagePaths, outputPath) {
  const slots = imagePaths.slice(0, COLS * ROWS);
  while (slots.length < COLS * ROWS) slots.push(null);

  const composites = [];

  for (let i = 0; i < COLS * ROWS; i++) {
    const p = slots[i];
    let buf;

    if (p && fs.existsSync(p)) {
      buf = await sharp(p)
        .rotate()
        .resize(CW, CH, { fit: 'contain', background: { r: 245, g: 245, b: 245 } })
        .png()
        .toBuffer();
    } else {
      buf = await sharp({
        create: {
          width:    CW,
          height:   CH,
          channels: 3,
          background: { r: 60, g: 60, b: 70 },
        },
      })
        .png()
        .toBuffer();
    }

    composites.push({
      input: buf,
      left:  (i % COLS) * CW,
      top:   Math.floor(i / COLS) * CH,
    });
  }

  await sharp({
    create: {
      width:    TOTAL_W,
      height:   TOTAL_H,
      channels: 3,
      background: { r: 245, g: 245, b: 245 },
    },
  })
    .composite(composites)
    .png()
    .toFile(outputPath);
}

// ── Per-listing processor ──────────────────────────────────────────────────────
/**
 * Returns { code, status, images } where status is one of:
 *   'ok' | 'skipped' | 'no_manifest' | 'error'
 */
async function processListing(shortsite, code, force) {
  const site        = SITES[shortsite];
  const manifestPath = path.join(site.selectedDir, code, '_manifest.json');
  const outputPath   = path.join(site.mosaicDir, `${code}.png`);

  if (!fs.existsSync(manifestPath)) {
    return { code, status: 'no_manifest', images: 0 };
  }

  if (!force && fs.existsSync(outputPath)) {
    return { code, status: 'skipped', images: 0 };
  }

  try {
    const imagePaths = await selectImages(manifestPath, site.cacheDir, code);

    // Count breakdown for progress line
    const manifest    = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const categories  = manifest.all_categories || manifest.selected || [];
    const nFacade = categories.filter(e => e.category === 'facade').slice(0, 3).length;
    const nPool   = categories.filter(e => e.category === 'pool').slice(0, 5).length;
    const taken   = nFacade + nPool;
    const nGarden = categories.filter(e => e.category === 'garden').slice(0, Math.max(0, 8 - taken)).length;
    const total   = nFacade + nPool + nGarden;

    // Ensure output directory exists
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    await buildMosaic(imagePaths, outputPath);

    return { code, status: 'ok', images: total, nFacade, nPool, nGarden };
  } catch (err) {
    return { code, status: 'error', images: 0, error: err.message };
  }
}

// ── Site-level processor ───────────────────────────────────────────────────────
async function processSite(shortsite, force) {
  const site = SITES[shortsite];

  if (!fs.existsSync(site.selectedDir)) {
    console.log(`[${shortsite}] selected_for_matching directory not found: ${site.selectedDir}`);
    return;
  }

  // Each subdirectory in selectedDir that contains a _manifest.json is a code
  const entries = fs.readdirSync(site.selectedDir, { withFileTypes: true });
  const codes   = entries
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .filter(name => fs.existsSync(path.join(site.selectedDir, name, '_manifest.json')))
    .sort();

  if (codes.length === 0) {
    console.log(`[${shortsite}] No listings with manifests found.`);
    return;
  }

  console.log(`\n=== ${shortsite.toUpperCase()} — ${codes.length} listing(s) ===`);

  let nOk = 0, nSkipped = 0, nFailed = 0, nNoManifest = 0;

  for (let i = 0; i < codes.length; i++) {
    const code   = codes[i];
    const prefix = `[${i + 1}/${codes.length}]`;
    const result = await processListing(shortsite, code, force);

    switch (result.status) {
      case 'ok':
        console.log(
          `${prefix} ${shortsite}/${code} → ${result.images} images` +
          ` (${result.nFacade} facade + ${result.nPool} pool + ${result.nGarden} garden)  ✓`
        );
        nOk++;
        break;

      case 'skipped':
        console.log(`${prefix} ${shortsite}/${code} → skipped (cached)`);
        nSkipped++;
        break;

      case 'no_manifest':
        console.log(`${prefix} ${shortsite}/${code} → no manifest`);
        nNoManifest++;
        break;

      case 'error':
        console.error(`${prefix} ${shortsite}/${code} → ERROR: ${result.error}`);
        nFailed++;
        break;
    }
  }

  console.log(
    `\n[${shortsite}] Summary: ${nOk} generated, ${nSkipped} skipped (cached),` +
    ` ${nFailed} failed, ${nNoManifest} no_manifest`
  );
}

// ── Entry point ────────────────────────────────────────────────────────────────
async function main() {
  const arg   = process.argv[2] || 'both';
  const force = process.argv.includes('--force');

  if (!['viva', 'coelho', 'both'].includes(arg)) {
    console.log('Usage: node make-clip-mosaics.js [viva|coelho|both] [--force]');
    process.exit(0);
  }

  if (arg === 'viva'   || arg === 'both') await processSite('viva',   force);
  if (arg === 'coelho' || arg === 'both') await processSite('coelho', force);

  console.log('\nDone!');
}

main().catch(e => { console.error(e); process.exit(1); });
