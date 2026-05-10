'use strict';
const sharp = require('sharp');
const path  = require('path');
const fs    = require('fs');

// ── Path constants ─────────────────────────────────────────────────────────────
const REPO_ROOT     = path.join(__dirname, '..');
const SELECTED_ROOT = path.join(REPO_ROOT, 'selected_for_matching');
const DATA_ROOT     = path.join(REPO_ROOT, 'data');
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
    listingFiles: ['vivaprimeimoveis_listings.json', 'all-listings.json'],
  },
  coelho: {
    fullsite:  'coelhodafonseca',
    cacheDir:  COELHO_CACHE,
    selectedDir: COELHO_SELECTED,
    listingFiles: ['coelhodafonseca_listings.json', 'all-listings.json'],
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
  const byCategory = (CATEGORY_PRIORITY[a.category] ?? 99) - (CATEGORY_PRIORITY[b.category] ?? 99);
  if (byCategory !== 0) return byCategory;
  return String(a.filename).localeCompare(String(b.filename), undefined, { numeric: true });
}

function imageBasename(url) {
  try {
    return path.basename(new URL(url).pathname);
  } catch {
    return path.basename(String(url).split('?')[0]);
  }
}

function canonicalFilename(index, ext = '.jpg') {
  return `${String(index).padStart(2, '0')}${ext}`;
}

function buildOfficialImageMap(shortsite, compound) {
  const site = SITES[shortsite];
  const files = [
    path.join(DATA_ROOT, compound, 'listings', site.listingFiles[0]),
    path.join(DATA_ROOT, compound, site.fullsite, 'listings', site.listingFiles[1]),
  ];

  const byCode = new Map();
  for (const filePath of files) {
    for (const listing of readListings(filePath)) {
      const code = listingCode(listing);
      const images = Array.isArray(listing.images) ? listing.images : [];
      if (!code || images.length === 0) continue;

      const map = byCode.get(code) || new Map();
      for (let i = 0; i < images.length; i++) {
        const basename = imageBasename(images[i]);
        const ext = path.extname(basename) || '.jpg';
        const officialPath = path.join(DATA_ROOT, compound, site.fullsite, 'images', code, basename);
        if (fs.existsSync(officialPath)) {
          map.set(basename, officialPath);
          map.set(canonicalFilename(i + 1, ext), officialPath);
          map.set(canonicalFilename(i + 1, '.jpg'), officialPath);
        }
      }
      byCode.set(code, map);
    }
  }
  return byCode;
}

function resolveImagePath(cacheDir, selectedDir, compoundImageDir, officialImageMap, code, filename) {
  const officialPath = officialImageMap.get(code)?.get(filename);
  if (officialPath && fs.existsSync(officialPath)) return officialPath;
  const compoundPath = path.join(compoundImageDir, code, filename);
  if (fs.existsSync(compoundPath)) return compoundPath;
  const selectedPath = path.join(selectedDir, code, filename);
  if (fs.existsSync(selectedPath)) return selectedPath;
  return path.join(cacheDir, code, filename);
}

function parseArgs(argv) {
  const args = {
    site: 'both',
    compound: 'alphaville-1',
    force: false,
    onlyListed: false,
    cleanExtra: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--force') {
      args.force = true;
    } else if (arg === '--only-listed') {
      args.onlyListed = true;
    } else if (arg === '--clean-extra') {
      args.cleanExtra = true;
    } else if (arg === '--compound') {
      args.compound = argv[++i];
    } else if (arg.startsWith('--compound=')) {
      args.compound = arg.slice('--compound='.length);
    } else if (!arg.startsWith('--')) {
      args.site = arg;
    }
  }

  return args;
}

function listingCode(listing) {
  return String(listing.propertyCode || listing.code || listing.id || '').trim();
}

function readListings(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return Array.isArray(data) ? data : (data.listings || []);
}

function listedCodesFor(shortsite, compound) {
  const site = SITES[shortsite];
  const candidates = [
    path.join(DATA_ROOT, compound, 'listings', site.listingFiles[0]),
    path.join(DATA_ROOT, compound, site.fullsite, 'listings', site.listingFiles[1]),
  ];

  const codes = new Set();
  for (const filePath of candidates) {
    for (const listing of readListings(filePath)) {
      const code = listingCode(listing);
      if (code) codes.add(code);
    }
  }
  return codes;
}

// ── Image selection ────────────────────────────────────────────────────────────
/**
 * Read the manifest and return the curated exterior set.
 * This uses manifest.selected, which is already produced by the pool-first
 * CLIP selector and copied to selected_for_matching/.
 */
async function selectStandardImages(manifestPath, cacheDir, selectedDir, compoundImageDir, officialImageMap, code) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const selectedRecords = manifest.selected || [];
  const outdoor = selectedRecords.filter(e => OUTDOOR.has(e.category));
  const selected = (outdoor.length ? outdoor : selectedRecords).sort(byOutdoorPriority);

  return selected.map(e => ({
    category: e.category,
    path: resolveImagePath(cacheDir, selectedDir, compoundImageDir, officialImageMap, code, e.filename),
  }));
}

/**
 * Return a larger outdoor-only set for expanded mosaics.
 * all_categories points at the full image cache, not selected_for_matching/.
 */
async function selectExpandedImages(manifestPath, cacheDir, selectedDir, compoundImageDir, officialImageMap, code) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const records = manifest.all_categories || manifest.selected || [];
  const outdoor = records.filter(e => OUTDOOR.has(e.category));
  const expanded = (outdoor.length ? outdoor : records).sort(byOutdoorPriority);

  return expanded.map(e => ({
    category: e.category,
    path: resolveImagePath(cacheDir, selectedDir, compoundImageDir, officialImageMap, code, e.filename),
  }));
}

// ── Mosaic builder ─────────────────────────────────────────────────────────────
/**
 * Build a grid mosaic from image paths.
 * Missing or non-existent paths are replaced by a neutral placeholder cell.
 */
async function buildMosaic(imagePaths, outputPath, rows = STANDARD_ROWS, options = {}) {
  const maxSlots = COLS * rows;
  const present = imagePaths.slice(0, maxSlots).filter((p) => p && fs.existsSync(p));
  const slotCount = options.compact ? Math.max(1, present.length) : maxSlots;
  const cols = options.compact ? Math.min(COLS, slotCount) : COLS;
  const actualRows = options.compact ? Math.ceil(slotCount / cols) : rows;
  const totalW = cols * CW;
  const totalH = actualRows * CH;
  const slots = options.compact ? present : imagePaths.slice(0, maxSlots);
  while (slots.length < slotCount) slots.push(null);

  const composites = [];

  for (let i = 0; i < slotCount; i++) {
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
      left:  (i % cols) * CW,
      top:   Math.floor(i / cols) * CH,
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
async function processListing(shortsite, code, force, compound, officialImageMap) {
  const site = SITES[shortsite];
  const manifestPath = path.join(site.selectedDir, code, '_manifest.json');
  const compoundImageDir = path.join(DATA_ROOT, compound, site.fullsite, 'images');
  const mosaicDir = path.join(DATA_ROOT, compound, 'mosaics', shortsite);
  const outputPath   = path.join(mosaicDir, `${code}.png`);
  const fullOutputPath = path.join(mosaicDir, `${code}_full.png`);

  if (!fs.existsSync(manifestPath)) {
    return { code, status: 'no_manifest', images: 0 };
  }

  if (!force && fs.existsSync(outputPath) && fs.existsSync(fullOutputPath)) {
    return { code, status: 'skipped', images: 0 };
  }

  try {
    const standardImages = await selectStandardImages(manifestPath, site.cacheDir, site.selectedDir, compoundImageDir, officialImageMap, code);
    const expandedImages = await selectExpandedImages(manifestPath, site.cacheDir, site.selectedDir, compoundImageDir, officialImageMap, code);

    // Count breakdown for progress line
    const nPool   = standardImages.filter(e => e.category === 'pool').length;
    const nFacade = standardImages.filter(e => e.category === 'facade').length;
    const nGarden = standardImages.filter(e => e.category === 'garden').length;
    const total   = standardImages.length;
    const expandedTotal = Math.min(expandedImages.length, COLS * EXPANDED_ROWS);

    // Ensure output directory exists
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    await buildMosaic(standardImages.map(e => e.path), outputPath, STANDARD_ROWS, { compact: true });
    await buildMosaic(expandedImages.map(e => e.path), fullOutputPath, EXPANDED_ROWS, { compact: true });

    return { code, status: 'ok', images: total, nFacade, nPool, nGarden, expandedTotal };
  } catch (err) {
    return { code, status: 'error', images: 0, error: err.message };
  }
}

// ── Site-level processor ───────────────────────────────────────────────────────
function cleanExtraMosaics(shortsite, compound, listedCodes) {
  const mosaicDir = path.join(DATA_ROOT, compound, 'mosaics', shortsite);
  if (!fs.existsSync(mosaicDir)) return 0;

  let removed = 0;
  for (const file of fs.readdirSync(mosaicDir)) {
    if (!file.endsWith('.png')) continue;
    const code = file.replace(/_full\.png$/, '').replace(/\.png$/, '');
    if (!listedCodes.has(code)) {
      fs.unlinkSync(path.join(mosaicDir, file));
      removed++;
    }
  }
  return removed;
}

async function processSite(shortsite, force, compound, onlyListed, cleanExtra) {
  const site = SITES[shortsite];
  const officialImageMap = buildOfficialImageMap(shortsite, compound);

  if (!fs.existsSync(site.selectedDir)) {
    console.log(`[${shortsite}] selected_for_matching directory not found: ${site.selectedDir}`);
    return;
  }

  // Each subdirectory in selectedDir that contains a _manifest.json is a code
  const entries = fs.readdirSync(site.selectedDir, { withFileTypes: true });
  let codes   = entries
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .filter(name => fs.existsSync(path.join(site.selectedDir, name, '_manifest.json')))
    .sort();

  if (onlyListed) {
    const listedCodes = listedCodesFor(shortsite, compound);
    codes = codes.filter(code => listedCodes.has(code));
    if (cleanExtra) {
      const removed = cleanExtraMosaics(shortsite, compound, listedCodes);
      if (removed) console.log(`[${shortsite}] removed ${removed} stale mosaic file(s)`);
    }
  }

  if (codes.length === 0) {
    console.log(`[${shortsite}] No listings with manifests found.`);
    return;
  }

  console.log(`\n=== ${compound}/${shortsite.toUpperCase()} — ${codes.length} listing(s) ===`);

  let nOk = 0, nSkipped = 0, nFailed = 0, nNoManifest = 0;

  for (let i = 0; i < codes.length; i++) {
    const code   = codes[i];
    const prefix = `[${i + 1}/${codes.length}]`;
    const result = await processListing(shortsite, code, force, compound, officialImageMap);

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
  const args = parseArgs(process.argv);

  if (!['viva', 'coelho', 'both'].includes(args.site)) {
    console.log('Usage: node make-clip-mosaics.js [viva|coelho|both] [--force] [--compound alphaville-1] [--only-listed] [--clean-extra]');
    process.exit(0);
  }

  if (args.site === 'viva'   || args.site === 'both') {
    await processSite('viva', args.force, args.compound, args.onlyListed, args.cleanExtra);
  }
  if (args.site === 'coelho' || args.site === 'both') {
    await processSite('coelho', args.force, args.compound, args.onlyListed, args.cleanExtra);
  }

  console.log('\nDone!');
}

main().catch(e => { console.error(e); process.exit(1); });
