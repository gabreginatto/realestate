// mosaic-module.js
// -----------------------------------------------------------
// 2x4 Mosaic builder using fastdup-ranked images
// - Uses the best 8 images from the fastdup selection process
// - Loads pre-ranked images from selected_exteriors/{site}/{listing_id}/
// - Images are already scored by fastdup (exterior, sharpness, brightness)
// - Builds mosaics with letterbox ("contain") to preserve edges
// - CLI flags to tweak grid, fit, cell size, and background
//
// IMPORTANT: The fastdup pipeline must be run first!
// See PIPELINE.md for the complete image processing workflow.
// -----------------------------------------------------------

const axios = require('axios');
const sharp = require('sharp');
const imghash = require('imghash');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ------------------------- Defaults --------------------------
let GRID_ROWS = 2;
let GRID_COLS = 4;
let CELL_W = 320;
let CELL_H = 320;
const GRID_TILES = () => GRID_ROWS * GRID_COLS;

const MAX_URLS_PER_LISTING = 20; // cap processing per listing
const DUP_HAMMING_THRESH = 10;   // good default for 64-bit pHash

// Selection constraints (tweakable; can override via CLI)
let MIN_POOLS_REQUIRED = 2;    // pool photos to try to include
let MIN_EXT_REQUIRED   = 3;    // exterior non-pool photos
let POOL_MIN_SCORE     = 0.50; // how "pool-ish" to consider as pool
let EXT_MIN_SCORE      = 0.40; // how "exterior-ish" to consider as exterior
let MIN_OUTDOOR_SCORE  = 0.35; // tighten for exterior-only mosaics

// Mosaic render
let MOSAIC_BG = { r: 255, g: 255, b: 255 };
let RENDER_FIT = 'contain'; // 'contain' (letterbox) or 'cover'

// Paths
const MOSAIC_DIR = path.join(process.cwd(), 'data', 'mosaics');
const FASTDUP_SELECTED_DIR = path.join(process.cwd(), 'selected_exteriors');

// ---------------------- CLI Flags ----------------------------
function parseFlags() {
  const flags = {};
  for (const arg of process.argv.slice(3)) {
    if (!arg.startsWith('--')) continue;
    const [k, vRaw] = arg.replace(/^--/, '').split('=');
    const v = (vRaw ?? '').trim();
    flags[k] = v === '' ? true : v;
  }
  // Grid: --grid=2x3
  if (flags.grid && /^[0-9]+x[0-9]+$/.test(flags.grid)) {
    const [r, c] = flags.grid.split('x').map(Number);
    if (r > 0 && c > 0) { GRID_ROWS = r; GRID_COLS = c; }
  }
  if (flags.cellw) CELL_W = Math.max(64, parseInt(flags.cellw, 10) || CELL_W);
  if (flags.cellh) CELL_H = Math.max(64, parseInt(flags.cellh, 10) || CELL_H);
  if (flags.fit && (flags.fit === 'contain' || flags.fit === 'cover')) RENDER_FIT = flags.fit;

  if (flags.minPools) MIN_POOLS_REQUIRED = Math.max(0, parseInt(flags.minPools, 10) || MIN_POOLS_REQUIRED);
  if (flags.minExt)   MIN_EXT_REQUIRED   = Math.max(0, parseInt(flags.minExt,   10) || MIN_EXT_REQUIRED);
  if (flags.poolMin)  POOL_MIN_SCORE     = Math.max(0, Math.min(1, parseFloat(flags.poolMin) || POOL_MIN_SCORE));
  if (flags.extMin)   EXT_MIN_SCORE      = Math.max(0, Math.min(1, parseFloat(flags.extMin)  || EXT_MIN_SCORE));
  if (flags.outdoorMin) MIN_OUTDOOR_SCORE = Math.max(0, Math.min(1, parseFloat(flags.outdoorMin) || MIN_OUTDOOR_SCORE));

  if (flags.bg) {
    // --bg=245,245,245
    const parts = flags.bg.split(',').map(x => parseInt(x, 10));
    if (parts.length === 3 && parts.every(n => Number.isFinite(n) && n >= 0 && n <= 255)) {
      MOSAIC_BG = { r: parts[0], g: parts[1], b: parts[2] };
    }
  }

  if (flags.dupThresh) {
    const t = parseInt(flags.dupThresh, 10);
    if (Number.isFinite(t) && t >= 0 && t <= 64) global.DUP_THRESH_OVERRIDE = t;
  }
  return flags;
}

// ----------------------- Utilities ---------------------------
function safeId(val) {
  return String(val || '').replace(/[^\w.-]+/g, '_').slice(0, 64);
}
async function ensureDir(p) {
  await fs.promises.mkdir(p, { recursive: true });
}

// Simple concurrency limiter (no external deps)
function pLimit(concurrency) {
  const queue = [];
  let active = 0;
  const next = () => {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then((v) => { resolve(v); active--; next(); })
        .catch((e) => { reject(e); active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

// HSV and Hamming
function hsv(r, g, b) {
  // 0..255 -> HSV(h:0..360, s:0..1, v:0..1)
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    switch (max) {
      case r: h = ((g - b) / d) % 6; break;
      case g: h = (b - r) / d + 2;   break;
      case b: h = (r - g) / d + 4;   break;
    }
    h *= 60; if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  const v = max;
  return [h, s, v];
}

function hammingHex(a, b) {
  if (!a || !b) return Infinity;
  a = a.toLowerCase(); b = b.toLowerCase();
  const n = Math.min(a.length, b.length);
  let d = 0;
  for (let i = 0; i < n; i++) {
    const x = (parseInt(a[i], 16) ^ parseInt(b[i], 16)) >>> 0;
    d += (x & 1) + ((x >> 1) & 1) + ((x >> 2) & 1) + ((x >> 3) & 1);
  }
  return d + 4 * Math.abs(a.length - b.length);
}

// -------------------- Download & Cache ---------------------
async function downloadAndCache(listing, side) {
  const code = listing.propertyCode || listing.code || safeId(listing.url);
  const imageUrls = (listing.images || []).slice(0, MAX_URLS_PER_LISTING);
  if (!imageUrls.length) {
    console.log(`  ⚠️  No images for ${side}/${code}`);
    return [];
  }
  const cacheDir = path.join(process.cwd(), 'data',
    side === 'viva' ? 'vivaprimeimoveis' : 'coelhodafonseca', 'cache', String(code));
  await ensureDir(cacheDir);

  const localPaths = [];
  let downloaded = 0, skipped = 0, failed = 0;

  for (let i = 0; i < imageUrls.length; i++) {
    const url = imageUrls[i];
    const tail = url.split('/').pop() || `img_${i}`;
    let ext = path.extname(tail).toLowerCase();
    if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) ext = '.jpg';
    const base = safeId(path.basename(tail, ext)) || `img_${i}`;
    const fname = `${i}_${base}${ext}`;
    const fpath = path.join(cacheDir, fname);

    if (fs.existsSync(fpath)) { skipped++; localPaths.push(fpath); continue; }

    try {
      const res = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 30000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MosaicBot/2.0)' }
      });
      fs.writeFileSync(fpath, res.data);
      downloaded++; localPaths.push(fpath);
    } catch (e) {
      failed++;
      console.log(`    ❌ Failed: ${url} - ${e.message}`);
    }
  }
  console.log(`  📁 ${side}/${code}: ${downloaded} downloaded, ${skipped} cached, ${failed} failed`);
  return localPaths;
}

// ------------------- Load from Fastdup Selection -----------
async function loadFromFastdupSelection(listing, side, maxN = GRID_TILES()) {
  const code = listing.propertyCode || listing.code || safeId(listing.url);

  // Map 'viva' to 'vivaprimeimoveis' and 'coelho' to 'coelhodafonseca'
  const siteDir = side === 'viva' ? 'vivaprimeimoveis' : 'coelhodafonseca';

  const selectionDir = path.join(FASTDUP_SELECTED_DIR, siteDir, String(code));

  if (!fs.existsSync(selectionDir)) {
    console.log(`  ⚠️  No fastdup selection found at: ${selectionDir}`);
    return [];
  }

  try {
    // Read all image files directly from the directory (ignore manifest)
    const imageExts = ['.jpg', '.jpeg', '.png', '.webp'];
    const allFiles = fs.readdirSync(selectionDir);

    const imageFiles = allFiles
      .filter(file => {
        const ext = path.extname(file).toLowerCase();
        return imageExts.includes(ext) && !file.startsWith('_');
      })
      .map(file => path.join(selectionDir, file));

    if (imageFiles.length === 0) {
      console.log(`  ⚠️  No images found in ${selectionDir}`);
      return [];
    }

    // Try to read manifest for ranking information
    const manifestPath = path.join(selectionDir, '_manifest.json');
    let rankedImages = imageFiles;

    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

        if (manifest.selected && Array.isArray(manifest.selected)) {
          // Create a map of filename -> rank_score
          const scoreMap = {};
          manifest.selected.forEach(item => {
            const filename = path.basename(item.filename);
            scoreMap[filename] = item.rank_score || 0;
          });

          // Sort images by rank_score (if available)
          rankedImages = imageFiles.sort((a, b) => {
            const filenameA = path.basename(a);
            const filenameB = path.basename(b);
            const scoreA = scoreMap[filenameA] || 0;
            const scoreB = scoreMap[filenameB] || 0;
            return scoreB - scoreA; // Descending order (best first)
          });
        }
      } catch (err) {
        // If manifest is invalid, just use all images unsorted
        console.log(`  ⚠️  Could not read manifest ranking, using all images`);
      }
    }

    // Take top N images
    const selectedImages = rankedImages.slice(0, maxN);

    console.log(`  ✅ Loaded ${selectedImages.length} images from fastdup selection`);
    console.log(`     (from ${imageFiles.length} total images available)`);

    return selectedImages;
  } catch (err) {
    console.log(`  ❌ Error loading images: ${err.message}`);
    return [];
  }
}

// ------------------- Content Scorers -----------------------
async function outdoorScore(filepath) {
  const W = 256, H = 256;
  const img = sharp(filepath).rotate().resize(W, H, { fit: 'inside' }).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });

  let blue = 0, green = 0, interior = 0, total = 0;

  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const [h, s, v] = hsv(r, g, b);

      const isBlue = (h >= 180 && h <= 240) && s >= 0.25 && v >= 0.35;
      const isGreen = (h >= 80 && h <= 150) && s >= 0.25 && v >= 0.30;
      const isInterior = (
        (s < 0.15 && v >= 0.20 && v <= 0.85) ||
        ((h >= 20 && h <= 45) && s >= 0.15 && s <= 0.50 && v >= 0.30)
      );
      if (isBlue) blue++;
      if (isGreen) green++;
      if (isInterior && !isBlue && !isGreen) interior++;
      total++;
    }
  }
  const blueRatio = blue / Math.max(1, total);
  const greenRatio = green / Math.max(1, total);
  const interiorRatio = interior / Math.max(1, total);
  let score = 0.55 * blueRatio + 0.45 * greenRatio - 0.40 * interiorRatio;
  return Math.max(0, Math.min(1, score));
}

async function exteriorScore(filepath) {
  const W = 256, H = 256;
  const img = sharp(filepath).rotate().resize(W, H, { fit: 'inside' }).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });

  const topRows = Math.floor(info.height * 0.30);
  let sky = 0, veg = 0, totalTop = 0;
  let edgeH = 0;

  const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

  for (let y = 0; y < topRows; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const [h, s, v] = hsv(r, g, b);

      const isSky = (h >= 180 && h <= 260) && s >= 0.20 && v >= 0.45;
      const isVeg = (h >= 75 && h <= 150)  && s >= 0.25 && v >= 0.30;

      if (isSky) sky++;
      if (isVeg) veg++;
      totalTop++;

      if (x > 0) {
        const j = (y * info.width + (x - 1)) * 4;
        const r0 = data[j], g0 = data[j + 1], b0 = data[j + 2];
        edgeH += Math.abs(lum(r, g, b) - lum(r0, g0, b0));
      }
    }
  }
  const skyRatio = sky / Math.max(1, totalTop);
  const vegRatio = veg / Math.max(1, totalTop);
  const edgeNorm = edgeH / (topRows * info.width * 255);
  return Math.max(0, Math.min(1, 0.42 * skyRatio + 0.38 * vegRatio + 0.20 * edgeNorm));
}

async function poolScore(filepath) {
  const W = 256, H = 256;
  const img = sharp(filepath).rotate().resize(W, H, { fit: 'inside' }).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });

  const yStart = Math.floor(info.height * 0.45);
  let waterish = 0, total = 0, edgeH = 0, greenOnly = 0;

  const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

  for (let y = yStart; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const [h, s, v] = hsv(r, g, b);

      const blueWater = (h >= 160 && h <= 220) && s >= 0.35 && v >= 0.35;
      const tealWater = (h >= 120 && h <= 170) && s >= 0.35 && v >= 0.35;
      const isLawn = (h >= 80 && h <= 140) && s >= 0.25 && v >= 0.25 && !tealWater;

      if (blueWater || tealWater) waterish++;
      if (isLawn && !blueWater && !tealWater) greenOnly++;
      total++;

      if (x > 0) {
        const j = (y * info.width + (x - 1)) * 4;
        const r0 = data[j], g0 = data[j + 1], b0 = data[j + 2];
        edgeH += Math.abs(lum(r, g, b) - lum(r0, g0, b0));
      }
    }
  }

  const waterRatio = waterish / Math.max(1, total);
  const lawnRatio  = greenOnly / Math.max(1, total);
  const edgeNorm   = edgeH / ((info.height - yStart) * info.width * 255);

  // bottom-edge bonus
  let bottomWater = 0, bottomTot = 0;
  for (let y = info.height - 12; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const [h, s, v] = hsv(r, g, b);
      const bw = (h >= 160 && h <= 220) && s >= 0.35 && v >= 0.35;
      const tw = (h >= 120 && h <= 170) && s >= 0.35 && v >= 0.35;
      if (bw || tw) bottomWater++;
      bottomTot++;
    }
  }
  const bottomWaterRatio = bottomWater / Math.max(1, bottomTot);
  let score = 0.65 * waterRatio + 0.20 * edgeNorm + 0.10 * Math.min(0.2, bottomWaterRatio) / 0.2;
  score -= 0.20 * Math.min(0.5, lawnRatio) / 0.5;
  return Math.max(0, Math.min(1, score));
}

// ------------------- Selection (smart) ---------------------
const isPoolish      = (x) => x.pool >= POOL_MIN_SCORE;
const isExteriorish  = (x) => x.ext  >= EXT_MIN_SCORE && !isPoolish(x);

async function selectForMosaic(imagePaths, maxN = GRID_TILES()) {
  if (!imagePaths?.length) return [];

  // Parallel scoring with small concurrency
  const limit = pLimit(Math.max(2, Math.min(8, os.cpus().length)));
  const scored = (await Promise.all(imagePaths.map((p, i) => limit(async () => {
    try {
      const stats = await fs.promises.stat(p);
      const meta = await sharp(p).metadata();

      // quality: earlier favored, size (<=500KB), resolution (~> 3MP capped)
      const positionScore   = (imagePaths.length - i) / imagePaths.length;
      const sizeScore       = Math.min((stats.size || 0) / (500 * 1024), 1);
      const resolutionScore = Math.min(((meta.width || 0) * (meta.height || 0)) / (2000 * 1500), 1);
      const qualityScore    = 0.5 * positionScore + 0.25 * sizeScore + 0.25 * resolutionScore;

      // content
      const [ext, pool, outdoor] = await Promise.all([
        exteriorScore(p), poolScore(p), outdoorScore(p)
      ]);

      // true 64-bit pHash (8x8)
      const ph = await imghash.hash(p, 8, 'hex');
      return { path: p, idx: i, qualityScore, ext, pool, outdoor, ph, size: stats.size || 0 };
    } catch {
      return null;
    }
  })))).filter(Boolean);

  if (!scored.length) return [];

  // De-dup near-identicals: keep larger file (proxy for sharpness)
  const dedup = [];
  const dupThresh = global.DUP_THRESH_OVERRIDE ?? DUP_HAMMING_THRESH;
  for (const it of scored) {
    const dup = dedup.find(d => hammingHex(d.ph, it.ph) <= dupThresh);
    if (!dup) dedup.push(it);
    else if (it.size > dup.size) Object.assign(dup, it);
  }

  // Filter: must have some outdoor presence
  const outdoorFiltered = dedup.filter(x => x.outdoor >= MIN_OUTDOOR_SCORE);

  // If too few pass, keep best-by-outdoor; never drop to unrestricted interiors
  const workingSet = outdoorFiltered.length
    ? outdoorFiltered
    : dedup.sort((a, b) => b.outdoor - a.outdoor).slice(0, Math.max(maxN * 2, 8));

  // Pools (strong first), then exteriors (non-pool)
  const pools = workingSet
    .filter(isPoolish)
    .sort((a, b) => (b.pool + 0.5 * b.outdoor) - (a.pool + 0.5 * a.outdoor));

  const exteriors = workingSet
    .filter(x => !isPoolish(x) && x.ext >= EXT_MIN_SCORE)
    .sort((a, b) => (b.ext + 0.5 * b.outdoor) - (a.ext + 0.5 * a.outdoor));

  const chosen = [];
  const addIfRoom = (it) => {
    if (chosen.length >= maxN) return false;
    if (chosen.some(x => x.path === it.path)) return false;
    chosen.push(it);
    return true;
  };

  // 1) Pools up to MIN_POOLS_REQUIRED
  for (const it of pools) {
    if (chosen.filter(isPoolish).length >= MIN_POOLS_REQUIRED) break;
    addIfRoom(it);
  }
  if (chosen.filter(isPoolish).length < MIN_POOLS_REQUIRED) {
    const morePoolish = workingSet
      .filter(x => !chosen.includes(x))
      .sort((a, b) => b.pool - a.pool);
    for (const it of morePoolish) {
      if (chosen.filter(isPoolish).length >= MIN_POOLS_REQUIRED) break;
      addIfRoom(it);
    }
  }

  // 2) Non-pool exteriors to reach MIN_EXT_REQUIRED
  for (const it of exteriors) {
    if (chosen.filter(isExteriorish).length >= MIN_EXT_REQUIRED) break;
    addIfRoom(it);
  }
  if (chosen.filter(isExteriorish).length < MIN_EXT_REQUIRED) {
    const moreExtish = workingSet
      .filter(x => !chosen.includes(x))
      .sort((a, b) => b.ext - a.ext);
    for (const it of moreExtish) {
      if (chosen.filter(isExteriorish).length >= MIN_EXT_REQUIRED) break;
      addIfRoom(it);
    }
  }

  // 3) Fill remaining slots with more exterior-leaning, then pHash diversity
  const remaining = workingSet.filter(x => !chosen.includes(x));
  const preferExteriorish = remaining
    .filter(r => r.ext >= 0.35 || r.pool >= 0.35)
    .sort((a, b) => (b.outdoor + b.ext + 0.5 * b.pool) - (a.outdoor + a.ext + 0.5 * a.pool));
  for (const it of preferExteriorish) {
    if (!addIfRoom(it)) break;
  }

  // Diversity: farthest-first by pHash
  const leftovers = workingSet.filter(x => !chosen.includes(x));
  const minHamToChosen = (h) => chosen.length ? Math.min(...chosen.map(o => hammingHex(o.ph, h))) : Infinity;

  while (chosen.length < Math.min(maxN, workingSet.length)) {
    let best = null, bestD = -1;
    for (const r of leftovers) {
      const d = minHamToChosen(r.ph);
      if (d > bestD) { bestD = d; best = r; }
    }
    if (!best) break;
    addIfRoom(best);
    const idx = leftovers.findIndex(x => x.path === best.path);
    if (idx >= 0) leftovers.splice(idx, 1);
  }

  const finalPaths = chosen.slice(0, maxN).map(x => x.path);

  // Debug counts
  const poolsChosen = chosen.filter(isPoolish).length;
  const extsChosen  = chosen.filter(isExteriorish).length;
  if (poolsChosen < MIN_POOLS_REQUIRED) console.log(`  ⚠️ Only ${poolsChosen}/${MIN_POOLS_REQUIRED} pool shots available`);
  if (extsChosen  < MIN_EXT_REQUIRED)   console.log(`  ⚠️ Only ${extsChosen}/${MIN_EXT_REQUIRED} exterior shots available`);

  return finalPaths;
}

// ------------------- Mosaic Generation ---------------------
async function makeMosaic(imagePaths, outputPath, {
  rows = GRID_ROWS,
  cols = GRID_COLS,
  cellWidth = CELL_W,
  cellHeight = CELL_H,
  bg = MOSAIC_BG,
  fit = RENDER_FIT
} = {}) {
  const totalW = cols * cellWidth;
  const totalH = rows * cellHeight;

  const imgs = [...imagePaths];
  while (imgs.length < rows * cols) imgs.push(null);

  const composites = [];
  for (let i = 0; i < rows * cols; i++) {
    let buf;
    if (!imgs[i] || !fs.existsSync(imgs[i])) {
      buf = await sharp({
        create: { width: cellWidth, height: cellHeight, channels: 3, background: { r: 0, g: 0, b: 0 } }
      }).png().toBuffer();
    } else {
      const resizeOpts = (fit === 'cover')
        ? { fit: 'cover', position: 'attention' }
        : { fit: 'contain', background: { r: 245, g: 245, b: 245 } }; // neutral letterbox
      buf = await sharp(imgs[i])
        .rotate()
        .resize(cellWidth, cellHeight, resizeOpts)
        .png()
        .toBuffer();
    }
    const row = Math.floor(i / cols);
    const col = i % cols;
    composites.push({ input: buf, top: row * cellHeight, left: col * cellWidth });
  }

  await sharp({
    create: { width: totalW, height: totalH, channels: 3, background: bg }
  }).composite(composites).png().toFile(outputPath);

  return outputPath;
}

// ---------------------- Main Workflow ----------------------
async function generateMosaicForListing(listing, side) {
  const code = listing.propertyCode || listing.code || safeId(listing.url);
  console.log(`\n🖼️  Processing ${side}/${code}...`);

  // Load top 8 images from fastdup selection (already ranked)
  const selected = await loadFromFastdupSelection(listing, side, GRID_TILES());

  if (!selected.length) {
    console.log('  ❌ No images available from fastdup selection for mosaic');
    return { mosaicPath: null, stats: { error: 'No fastdup images' } };
  }

  console.log(`  ✅ Using ${selected.length} top-ranked images from fastdup`);

  const outDir = path.join(MOSAIC_DIR, side);
  await ensureDir(outDir);
  const outPath = path.join(outDir, `${safeId(code)}.png`);

  if (fs.existsSync(outPath)) {
    console.log(`  ♻️  Mosaic already exists: ${outPath}`);
    return { mosaicPath: outPath, stats: { cached: true, images: selected.length } };
  }

  await makeMosaic(selected, outPath, { rows: GRID_ROWS, cols: GRID_COLS, cellWidth: CELL_W, cellHeight: CELL_H, fit: RENDER_FIT });
  console.log(`  ✅ Mosaic generated: ${outPath}`);

  return {
    mosaicPath: outPath,
    stats: { selectedImages: selected.length, cached: false, source: 'fastdup' }
  };
}

async function generateMosaicsForAll(jsonPath, side) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🚀 Generating mosaics for ${side.toUpperCase()}  (grid: ${GRID_ROWS}x${GRID_COLS}, ${GRID_TILES()} images, fit: ${RENDER_FIT})`);
  console.log(`${'='.repeat(60)}\n`);

  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  const listings = data.listings || [];
  console.log(`📊 Total listings: ${listings.length}\n`);

  const results = [];
  for (let i = 0; i < listings.length; i++) {
    const listing = listings[i];
    console.log(`[${i + 1}/${listings.length}] ${listing.propertyCode || listing.code || i + 1}`);
    try {
      const r = await generateMosaicForListing(listing, side);
      results.push({
        propertyCode: listing.propertyCode || listing.code || safeId(listing.url),
        success: !!r.mosaicPath,
        mosaicPath: r.mosaicPath,
        stats: r.stats
      });
    } catch (e) {
      console.log(`  ❌ Error: ${e.message}`);
      results.push({ propertyCode: listing.propertyCode || listing.code || i + 1, success: false, error: e.message });
    }

    if ((i + 1) % 10 === 0) {
      const ok = results.filter(x => x.success).length;
      console.log(`\n✅ Progress: ${i + 1}/${listings.length} (${ok} successful)\n`);
    }
  }

  const ok = results.filter(x => x.success).length;
  const fail = results.length - ok;
  console.log(`\n${'='.repeat(60)}`);
  console.log(`📊 SUMMARY - ${side.toUpperCase()}`);
  console.log(`${'='.repeat(60)}`);
  console.log(`✅ Successful: ${ok}/${listings.length}`);
  console.log(`❌ Failed: ${fail}/${listings.length}`);
  console.log(`${'='.repeat(60)}\n`);

  return results;
}

// -------------------------- Exports ------------------------
module.exports = {
  downloadAndCache,
  loadFromFastdupSelection,
  selectForMosaic,
  makeMosaic,
  generateMosaicForListing,
  generateMosaicsForAll
};

// --------------------------- CLI ---------------------------
if (require.main === module) {
  (async () => {
    const arg = (process.argv[2] || '').toLowerCase();
    if (!arg || !['viva','coelho','both'].includes(arg)) {
      console.log(`
Usage:
  node mosaic-module.js viva   [--grid=2x4] [--fit=contain|cover] [--cellw=320] [--cellh=320] [--bg=245,245,245]
  node mosaic-module.js coelho [--grid=2x4] [--fit=contain|cover] ...
  node mosaic-module.js both   [--grid=2x4] ...

Defaults:
  grid=2x4, fit=contain, cellw=320, cellh=320, bg=255,255,255

Notes:
  - This script now uses the top 8 ranked images from the fastdup selection process.
  - Images are loaded from selected_exteriors/{site}/{listing_id}/ directory.
  - The fastdup process must be run first (see PIPELINE.md for details).
  - Image selection is based on fastdup's quality ranking (exterior score, sharpness, brightness).
  - For a 2x4 grid, the top 8 best-ranked images are used automatically.
`);
      process.exit(0);
    }

    parseFlags();

    try {
      if (arg === 'viva' || arg === 'both') {
        const vivaPath = path.join(process.cwd(), 'data', 'vivaprimeimoveis', 'listings', 'all-listings.json');
        await generateMosaicsForAll(vivaPath, 'viva');
      }
      if (arg === 'coelho' || arg === 'both') {
        const coelhoPath = path.join(process.cwd(), 'data', 'coelhodafonseca', 'listings', 'all-listings.json');
        await generateMosaicsForAll(coelhoPath, 'coelho');
      }
      console.log('\n🎉 All done!\n');
    } catch (e) {
      console.error(`\n❌ Error: ${e.message}\n`);
      process.exit(1);
    }
  })();
}
