#!/usr/bin/env node
/**
 * Generate Comparison Mosaics for Geometric Matches
 *
 * Creates side-by-side mosaics for matched properties:
 * - Top row: 4 images from Viva property
 * - Bottom row: 4 images from Coelho property
 * - Saves to matched_mosaics/ folder
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// Config
const CELL_WIDTH = 320;
const CELL_HEIGHT = 320;
const IMAGES_PER_ROW = 4;
const MOSAIC_BG = { r: 255, g: 255, b: 255 };
const RENDER_FIT = 'contain'; // letterbox to preserve all details

// Paths
const MATCHES_FILE = path.join(process.cwd(), 'geometric_matches_filtered.json');
const SELECTED_DIR = path.join(process.cwd(), 'selected_exteriors');
const OUTPUT_DIR = path.join(process.cwd(), 'matched_mosaics');

// Utility
function safeId(val) {
  return String(val || '').replace(/[^\w.-]+/g, '_').slice(0, 64);
}

async function ensureDir(p) {
  await fs.promises.mkdir(p, { recursive: true });
}

/**
 * Get N best images from a listing directory
 */
function getTopImages(listingDir, maxImages = IMAGES_PER_ROW) {
  if (!fs.existsSync(listingDir)) {
    console.log(`  ⚠️  Directory not found: ${listingDir}`);
    return [];
  }

  // Check if there's a manifest from fastdup
  const manifestPath = path.join(listingDir, '_manifest.json');

  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

      if (manifest.selected && Array.isArray(manifest.selected)) {
        // Sort by rank_score descending (best first)
        const sorted = manifest.selected
          .filter(item => item.filename && fs.existsSync(item.filename))
          .sort((a, b) => (b.rank_score || 0) - (a.rank_score || 0));

        // Take top N
        return sorted.slice(0, maxImages).map(item => item.filename);
      }
    } catch (err) {
      console.log(`  ⚠️  Error reading manifest: ${err.message}`);
    }
  }

  // Fallback: just get first N image files
  const files = fs.readdirSync(listingDir)
    .filter(f => /\.(jpg|jpeg|png)$/i.test(f) && !f.startsWith('_'))
    .sort()
    .slice(0, maxImages)
    .map(f => path.join(listingDir, f));

  return files;
}

/**
 * Create a 2x4 comparison mosaic
 * Top row: 4 images from property A
 * Bottom row: 4 images from property B
 */
async function createComparisonMosaic(
  vivaImages,
  coelhoImages,
  outputPath,
  vivaCode,
  coelhoCode,
  matchInfo
) {
  const rows = 2;
  const cols = IMAGES_PER_ROW;
  const totalW = cols * CELL_WIDTH;
  const totalH = rows * CELL_HEIGHT;

  // Ensure we have exactly 4 images per row (pad with black if needed)
  const topRow = [...vivaImages];
  const bottomRow = [...coelhoImages];

  while (topRow.length < cols) topRow.push(null);
  while (bottomRow.length < cols) bottomRow.push(null);

  // Combine into single array: [viva0, viva1, viva2, viva3, coelho0, coelho1, coelho2, coelho3]
  const allImages = [...topRow.slice(0, cols), ...bottomRow.slice(0, cols)];

  const composites = [];

  // Generate each cell
  for (let i = 0; i < rows * cols; i++) {
    let buf;

    if (!allImages[i] || !fs.existsSync(allImages[i])) {
      // Empty cell - create black placeholder
      buf = await sharp({
        create: { width: CELL_WIDTH, height: CELL_HEIGHT, channels: 3, background: { r: 0, g: 0, b: 0 } }
      }).png().toBuffer();
    } else {
      // Load and resize image
      const resizeOpts = (RENDER_FIT === 'cover')
        ? { fit: 'cover', position: 'attention' }
        : { fit: 'contain', background: { r: 245, g: 245, b: 245 } }; // neutral letterbox

      buf = await sharp(allImages[i])
        .rotate()
        .resize(CELL_WIDTH, CELL_HEIGHT, resizeOpts)
        .png()
        .toBuffer();
    }

    const row = Math.floor(i / cols);
    const col = i % cols;
    composites.push({ input: buf, top: row * CELL_HEIGHT, left: col * CELL_WIDTH });
  }

  // Add text overlay with match info
  const textHeight = 80;
  const textBg = await sharp({
    create: {
      width: totalW,
      height: textHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0.8 }
    }
  }).png().toBuffer();

  // Create base canvas
  const canvas = await sharp({
    create: { width: totalW, height: totalH + textHeight, channels: 3, background: MOSAIC_BG }
  })
    .composite([
      ...composites.map(c => ({ ...c, top: c.top + textHeight })), // Shift images down
      { input: textBg, top: 0, left: 0 }
    ])
    .png()
    .toBuffer();

  // Add text labels using SVG overlay
  const svgText = `
    <svg width="${totalW}" height="${textHeight}">
      <style>
        .title { fill: white; font-size: 18px; font-family: Arial, sans-serif; font-weight: bold; }
        .info { fill: #aaa; font-size: 14px; font-family: Arial, sans-serif; }
      </style>
      <text x="10" y="25" class="title">VIVA ${vivaCode} ↔ COELHO ${coelhoCode}</text>
      <text x="10" y="50" class="info">Price Δ: ${matchInfo.price_diff_pct.toFixed(1)}% | Area Δ: ${matchInfo.area_diff_pct.toFixed(1)}% | Inliers: ${matchInfo.geometric_match.best_inliers}</text>
      <text x="10" y="70" class="info">Confidence: ${matchInfo.geometric_match.best_inliers >= 200 ? 'HIGH' : matchInfo.geometric_match.best_inliers >= 50 ? 'MEDIUM' : 'LOW'}</text>
    </svg>
  `;

  await sharp(canvas)
    .composite([
      { input: Buffer.from(svgText), top: 0, left: 0 }
    ])
    .png()
    .toFile(outputPath);

  return outputPath;
}

/**
 * Main function
 */
async function main() {
  console.log('\n🖼️  GEOMETRIC MATCH COMPARISON MOSAICS\n');
  console.log('=' .repeat(60));

  // Load matches
  if (!fs.existsSync(MATCHES_FILE)) {
    console.error(`❌ Matches file not found: ${MATCHES_FILE}`);
    process.exit(1);
  }

  const matchData = JSON.parse(fs.readFileSync(MATCHES_FILE, 'utf-8'));
  const matches = matchData.matches || [];

  console.log(`\n📊 Found ${matches.length} matches to process\n`);

  // Create output directory
  await ensureDir(OUTPUT_DIR);

  // Process each match
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const vivaCode = match.viva.code;
    const coelhoCode = match.coelho.code;

    console.log(`\n[${i + 1}/${matches.length}] Processing: Viva ${vivaCode} ↔ Coelho ${coelhoCode}`);

    try {
      // Get image paths
      const vivaDir = path.join(SELECTED_DIR, 'vivaprimeimoveis', vivaCode);
      const coelhoDir = path.join(SELECTED_DIR, 'coelhodafonseca', coelhoCode);

      const vivaImages = getTopImages(vivaDir, IMAGES_PER_ROW);
      const coelhoImages = getTopImages(coelhoDir, IMAGES_PER_ROW);

      console.log(`  Viva images: ${vivaImages.length}`);
      console.log(`  Coelho images: ${coelhoImages.length}`);

      if (vivaImages.length === 0 && coelhoImages.length === 0) {
        console.log(`  ⚠️  No images found for either property - skipping`);
        failCount++;
        continue;
      }

      // Create output filename
      const outputFilename = `match_${String(i + 1).padStart(2, '0')}_viva_${vivaCode}_coelho_${coelhoCode}.png`;
      const outputPath = path.join(OUTPUT_DIR, outputFilename);

      // Generate mosaic
      await createComparisonMosaic(
        vivaImages,
        coelhoImages,
        outputPath,
        vivaCode,
        coelhoCode,
        match
      );

      console.log(`  ✅ Saved: ${outputFilename}`);
      console.log(`     Price: ${match.viva.price} vs ${match.coelho.price}`);
      console.log(`     Inliers: ${match.geometric_match.best_inliers} (${match.geometric_match.best_inliers >= 200 ? 'HIGH' : match.geometric_match.best_inliers >= 50 ? 'MEDIUM' : 'LOW'} confidence)`);

      successCount++;

    } catch (err) {
      console.log(`  ❌ Error: ${err.message}`);
      failCount++;
    }
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('📊 SUMMARY\n');
  console.log(`Total matches: ${matches.length}`);
  console.log(`✅ Successful: ${successCount}`);
  console.log(`❌ Failed: ${failCount}`);
  console.log(`\n📁 Output directory: ${OUTPUT_DIR}`);
  console.log('='.repeat(60) + '\n');
}

// Run
if (require.main === module) {
  main().catch(err => {
    console.error(`\n❌ Fatal error: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { createComparisonMosaic, getTopImages };
