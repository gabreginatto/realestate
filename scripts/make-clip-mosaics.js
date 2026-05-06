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
const STANDARD_ROWS = 2;
const EXPANDED_ROWS = 4;
const CW   = 320;
const CH   = 320;
const OUTDOOR = new Set(['pool', 'facade', 'garden']);
const CATEGORY_PRIORITY = { pool: 0, facade: 1, garden: 2 };

function byOutdoorPriority(a, b) {
  const byCategory = CATEGORY_PRIORITY[a.category] - CATEGORY_PRIORITY[b.category];
  if (byCategory !== 0) return byCategory;
  return String(a.filename).localeCompare(String(b.filename), undefined, { numeric: true });
}

// ── Image selection ────────────────────────────────────────────────────────────
/**
 * Read the manifest and return the curated exterior set.
 * This uses manifest.selected, which is already produced by the pool-first
 * CLIP selector and copied to selected_for_matching/.
 */
async function selectStandardImages(manifestPath, cacheDir, code) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const selected = (manifest.selected || [])
    .filter(e => OUTDOOR.has(e.category))
    .sort(byOutdoorPriority);

  return selected.map(e => ({
    category: e.category,
    path: path.join(cacheDir, code, e.filename),
  }));
}

/**
 * Return a larger outdoor-only set for expanded mosaics.
 * all_categories points at the full image cache, not selected_for_matching/.
 */
async function selectExpandedImages(manifestPath, cacheDir, code) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const expanded = (manifest.all_categories || manifest.selected || [])
    .filter(e => OUTDOOR.has(e.category))
    .sort(byOutdoorPriority);

  return expanded.map(e => ({
    category: e.category,
    path: path.join(cacheDir, code, e.filename),
  }));
}

// ── Mosaic builder ─────────────────────────────────────────────────────────────
/**
 * Build a grid mosaic from image paths.
 * Missing or non-existent paths are replaced by a neutral placeholder cell.
 */
async function buildMosaic(imagePaths, outputPath, rows = STANDARD_ROWS) {
  const totalW = COLS * CW;
  const totalH = rows * CH;
  const slots = imagePaths.slice(0, COLS * rows);
  while (slots.length < COLS * rows) slots.push(null);

  const composites = [];

  for (let i = 0; i < COLS * rows; i++) {
    const p = slots[i];
    let buf;

    if (p && fs.existsSync(p)) {
      buf = await sharp(p)
        .rotate()
        .resize(CW, CH, { fit: 'cover', position: 'attention' })
        .png()
        .toBuffer();
    } else {
      buf = await sharp({
        create: {
          width:    CW,
          height:   CH,
          channels: 3,
          background: { r: 245, g: 245, b: 245 },
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
      width:    totalW,
      height:   totalH,
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
  const fullOutputPath = path.join(site.mosaicDir, `${code}_full.png`);

  if (!fs.existsSync(manifestPath)) {
    return { code, status: 'no_manifest', images: 0 };
  }

  if (!force && fs.existsSync(outputPath) && fs.existsSync(fullOutputPath)) {
    return { code, status: 'skipped', images: 0 };
  }

  try {
    const standardImages = await selectStandardImages(manifestPath, site.cacheDir, code);
    const expandedImages = await selectExpandedImages(manifestPath, site.cacheDir, code);

    // Count breakdown for progress line
    const nPool   = standardImages.filter(e => e.category === 'pool').length;
    const nFacade = standardImages.filter(e => e.category === 'facade').length;
    const nGarden = standardImages.filter(e => e.category === 'garden').length;
    const total   = standardImages.length;
    const expandedTotal = Math.min(expandedImages.length, COLS * EXPANDED_ROWS);

    // Ensure output directory exists
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    await buildMosaic(standardImages.map(e => e.path), outputPath, STANDARD_ROWS);
    await buildMosaic(expandedImages.map(e => e.path), fullOutputPath, EXPANDED_ROWS);

    return { code, status: 'ok', images: total, nFacade, nPool, nGarden, expandedTotal };
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
          ` (${result.nPool} pool + ${result.nFacade} facade + ${result.nGarden} garden),` +
          ` expanded ${result.expandedTotal}  ✓`
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
