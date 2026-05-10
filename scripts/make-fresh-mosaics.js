'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const REPO_ROOT = path.join(__dirname, '..');
const DATA_ROOT = path.join(REPO_ROOT, 'data');
const SELECTED_ROOT = path.join(REPO_ROOT, 'selected_for_matching_fresh');
const SITES = {
  viva: 'vivaprimeimoveis',
  coelho: 'coelhodafonseca',
};
const OUTDOOR = new Set(['pool', 'facade', 'garden']);
const CATEGORY_PRIORITY = { pool: 0, facade: 1, garden: 2 };
const COLS = 4;
const STANDARD_ROWS = 2;
const EXPANDED_ROWS = 4;
const CELL_W = 320;
const CELL_H = 320;

function parseArgs(argv) {
  const args = {
    compound: 'alphaville-1',
    site: 'both',
    force: false,
    cleanExtra: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--compound') args.compound = argv[++i];
    else if (arg === '--force') args.force = true;
    else if (arg === '--clean-extra') args.cleanExtra = true;
    else if (!arg.startsWith('--')) args.site = arg;
  }
  if (!['viva', 'coelho', 'both'].includes(args.site)) {
    throw new Error('Usage: node scripts/make-fresh-mosaics.js [viva|coelho|both] --compound <slug> [--force] [--clean-extra]');
  }
  return args;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function byOutdoorPriority(a, b) {
  const byCategory = (CATEGORY_PRIORITY[a.category] ?? 99) - (CATEGORY_PRIORITY[b.category] ?? 99);
  if (byCategory !== 0) return byCategory;
  return String(a.filename).localeCompare(String(b.filename), undefined, { numeric: true });
}

function listingCodes(compound, siteFull) {
  const file = path.join(DATA_ROOT, compound, 'fresh-listings', `${siteFull}.json`);
  if (!fs.existsSync(file)) return new Set();
  const listings = readJson(file).listings || [];
  return new Set(listings.map((listing) => String(listing.propertyCode || listing.code || '').trim()).filter(Boolean));
}

function selectedRecords(manifest, key) {
  const records = manifest[key] || manifest.selected || [];
  const outdoor = records.filter((entry) => OUTDOOR.has(entry.category));
  return (outdoor.length ? outdoor : records).sort(byOutdoorPriority);
}

function resolveImage(compound, siteFull, code, filename) {
  const selected = path.join(SELECTED_ROOT, siteFull, code, filename);
  if (fs.existsSync(selected)) return selected;
  return path.join(DATA_ROOT, compound, 'fresh-images', siteFull, code, filename);
}

async function buildMosaic(imagePaths, outputFile, rows, options = {}) {
  const maxSlots = COLS * rows;
  const present = imagePaths.slice(0, maxSlots).filter((imagePath) => imagePath && fs.existsSync(imagePath));
  const slotCount = options.compact ? Math.max(1, present.length) : maxSlots;
  const cols = options.compact ? Math.min(COLS, slotCount) : COLS;
  const actualRows = options.compact ? Math.ceil(slotCount / cols) : rows;
  const slots = options.compact ? present : imagePaths.slice(0, maxSlots);
  while (slots.length < slotCount) slots.push(null);

  const composites = [];
  for (let i = 0; i < slots.length; i++) {
    let input;
    const imagePath = slots[i];
    if (imagePath && fs.existsSync(imagePath)) {
      input = await sharp(imagePath)
        .rotate()
        .resize(CELL_W, CELL_H, { fit: 'cover', position: 'attention' })
        .png()
        .toBuffer();
    } else {
      input = await sharp({
        create: {
          width: CELL_W,
          height: CELL_H,
          channels: 3,
          background: { r: 245, g: 245, b: 245 },
        },
      }).png().toBuffer();
    }
    composites.push({
      input,
      left: (i % cols) * CELL_W,
      top: Math.floor(i / cols) * CELL_H,
    });
  }

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  await sharp({
    create: {
      width: cols * CELL_W,
      height: actualRows * CELL_H,
      channels: 3,
      background: { r: 245, g: 245, b: 245 },
    },
  }).composite(composites).png().toFile(outputFile);
}

function cleanExtraMosaics(compound, shortSite, codes) {
  const dir = path.join(DATA_ROOT, compound, 'fresh-mosaics', shortSite);
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.png')) continue;
    const code = file.replace(/_full\.png$/, '').replace(/\.png$/, '');
    if (!codes.has(code)) {
      fs.unlinkSync(path.join(dir, file));
      removed++;
    }
  }
  return removed;
}

async function processSite(compound, shortSite, force, cleanExtra) {
  const siteFull = SITES[shortSite];
  const selectedDir = path.join(SELECTED_ROOT, siteFull);
  const codes = listingCodes(compound, siteFull);
  if (!fs.existsSync(selectedDir)) {
    console.log(`[${compound}/${shortSite}] no selected dir: ${path.relative(REPO_ROOT, selectedDir)}`);
    return;
  }
  if (cleanExtra) {
    const removed = cleanExtraMosaics(compound, shortSite, codes);
    if (removed) console.log(`[${compound}/${shortSite}] removed ${removed} stale mosaic file(s)`);
  }

  const manifestCodes = fs.readdirSync(selectedDir)
    .filter((code) => codes.has(code))
    .filter((code) => fs.existsSync(path.join(selectedDir, code, '_manifest.json')))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  console.log(`\n=== ${compound}/${shortSite.toUpperCase()} fresh mosaics — ${manifestCodes.length}/${codes.size} listing(s) ===`);
  let generated = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < manifestCodes.length; i++) {
    const code = manifestCodes[i];
    const outputFile = path.join(DATA_ROOT, compound, 'fresh-mosaics', shortSite, `${code}.png`);
    const fullOutputFile = path.join(DATA_ROOT, compound, 'fresh-mosaics', shortSite, `${code}_full.png`);
    if (!force && fs.existsSync(outputFile) && fs.existsSync(fullOutputFile)) {
      skipped++;
      continue;
    }

    try {
      const manifest = readJson(path.join(selectedDir, code, '_manifest.json'));
      const standard = selectedRecords(manifest, 'selected')
        .map((entry) => resolveImage(compound, siteFull, code, entry.filename));
      const expanded = selectedRecords(manifest, 'all_categories')
        .map((entry) => resolveImage(compound, siteFull, code, entry.filename));
      await buildMosaic(standard, outputFile, STANDARD_ROWS, { compact: true });
      await buildMosaic(expanded, fullOutputFile, EXPANDED_ROWS, { compact: true });
      generated++;
      console.log(`[${i + 1}/${manifestCodes.length}] ${shortSite}/${code}: standard=${standard.length}, expanded=${Math.min(expanded.length, COLS * EXPANDED_ROWS)}`);
    } catch (err) {
      failed++;
      console.error(`[${i + 1}/${manifestCodes.length}] ${shortSite}/${code}: ERROR ${err.message}`);
    }
  }

  console.log(`[${compound}/${shortSite}] generated=${generated}, skipped=${skipped}, failed=${failed}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.site === 'both' || args.site === 'viva') {
    await processSite(args.compound, 'viva', args.force, args.cleanExtra);
  }
  if (args.site === 'both' || args.site === 'coelho') {
    await processSite(args.compound, 'coelho', args.force, args.cleanExtra);
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
