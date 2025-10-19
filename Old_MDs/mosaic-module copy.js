const axios = require('axios');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const mkdir = promisify(fs.mkdir);
const exists = promisify(fs.exists);

/**
 * Mosaic Module - Phase 2
 *
 * Handles:
 * 1. Image downloading and caching
 * 2. Smart image selection for mosaics (6 best photos)
 * 3. 3×2 mosaic generation (900x600px)
 */

// ============================================
// 1. IMAGE DOWNLOADING & CACHING
// ============================================

/**
 * Downloads and caches images for a single listing
 * @param {Object} listing - Listing object with images[] array
 * @param {string} side - 'viva' or 'coelho'
 * @returns {Array<string>} - Array of local file paths
 */
async function downloadAndCache(listing, side) {
  const propertyCode = listing.propertyCode;
  const imageUrls = listing.images || [];

  if (imageUrls.length === 0) {
    console.log(`  ⚠️  No images for ${side}/${propertyCode}`);
    return [];
  }

  // Create cache directory
  const cacheDir = path.join(
    process.cwd(),
    'data',
    side === 'viva' ? 'vivaprimeimoveis' : 'coelhodafonseca',
    'cache',
    String(propertyCode)
  );

  await mkdir(cacheDir, { recursive: true });

  const localPaths = [];
  let downloaded = 0;
  let skipped = 0;
  const failed = [];

  for (let i = 0; i < imageUrls.length; i++) {
    const url = imageUrls[i];

    // Extract original filename
    const urlParts = url.split('/');
    const originalName = urlParts[urlParts.length - 1];

    // Create indexed filename: 0_originalname.jpg
    const filename = `${i}_${originalName}`;
    const filepath = path.join(cacheDir, filename);

    // Check if already cached
    if (fs.existsSync(filepath)) {
      localPaths.push(filepath);
      skipped++;
      continue;
    }

    // Download image
    try {
      const response = await axios({
        url,
        method: 'GET',
        responseType: 'arraybuffer',
        timeout: 30000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      fs.writeFileSync(filepath, response.data);
      localPaths.push(filepath);
      downloaded++;
    } catch (error) {
      failed.push({ url, error: error.message });
      console.log(`    ❌ Failed: ${url} - ${error.message}`);
    }

    // Rate limiting
    if (downloaded % 10 === 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  console.log(`  📁 ${side}/${propertyCode}: ${downloaded} downloaded, ${skipped} cached, ${failed.length} failed`);

  return localPaths;
}

// ============================================
// 2. SMART IMAGE SELECTION
// ============================================

/**
 * Selects 6 diverse, high-quality images for mosaic
 * @param {Array<string>} imagePaths - Array of local file paths
 * @param {number} maxN - Maximum images to select (default 6)
 * @returns {Array<string>} - Array of selected file paths
 */
async function selectForMosaic(imagePaths, maxN = 6) {
  if (imagePaths.length === 0) {
    return [];
  }

  // If we have 6 or fewer, return all
  if (imagePaths.length <= maxN) {
    return imagePaths;
  }

  // Score each image based on:
  // - Position (prefer earlier images - usually best photos)
  // - File size (prefer larger = higher quality)
  // - Dimensions (prefer larger resolutions)

  const scored = [];

  for (let i = 0; i < imagePaths.length; i++) {
    const filepath = imagePaths[i];

    try {
      const stats = fs.statSync(filepath);
      const metadata = await sharp(filepath).metadata();

      // Scoring algorithm
      const positionScore = (imagePaths.length - i) / imagePaths.length; // Earlier = higher
      const sizeScore = Math.min(stats.size / (500 * 1024), 1); // Normalize to 500KB max
      const resolutionScore = Math.min((metadata.width * metadata.height) / (2000 * 1500), 1); // Normalize to 3MP

      const totalScore = (positionScore * 0.5) + (sizeScore * 0.25) + (resolutionScore * 0.25);

      scored.push({
        path: filepath,
        score: totalScore,
        index: i
      });
    } catch (error) {
      console.log(`    ⚠️  Could not analyze ${filepath}: ${error.message}`);
    }
  }

  // Sort by score (descending)
  scored.sort((a, b) => b.score - a.score);

  // Select top N, but ensure they're distributed across the set
  // Take top 2, then distribute the rest
  const selected = [];

  // Always include top 2 highest scored
  selected.push(scored[0].path);
  if (scored.length > 1) {
    selected.push(scored[1].path);
  }

  // For remaining slots, pick evenly distributed images from top 20%
  const topN = Math.ceil(scored.length * 0.2);
  const candidates = scored.slice(2, topN);

  const step = Math.max(1, Math.floor(candidates.length / (maxN - 2)));

  for (let i = 0; i < candidates.length && selected.length < maxN; i += step) {
    selected.push(candidates[i].path);
  }

  // If still need more, fill from remaining top scored
  for (let i = 2; i < scored.length && selected.length < maxN; i++) {
    if (!selected.includes(scored[i].path)) {
      selected.push(scored[i].path);
    }
  }

  return selected.slice(0, maxN);
}

// ============================================
// 3. MOSAIC GENERATION
// ============================================

/**
 * Creates a 3×2 mosaic from 6 images
 * @param {Array<string>} imagePaths - Array of 6 image file paths
 * @param {string} outputPath - Where to save the mosaic
 * @param {Object} options - Mosaic options
 * @returns {string} - Path to generated mosaic
 */
async function makeMosaic(imagePaths, outputPath, options = {}) {
  const {
    cellWidth = 300,
    cellHeight = 300,
    rows = 2,
    cols = 3
  } = options;

  const totalWidth = cellWidth * cols;
  const totalHeight = cellHeight * rows;

  // Ensure we have exactly 6 images (fill with black if needed)
  const images = [...imagePaths];
  while (images.length < 6) {
    images.push(null); // Will be replaced with black square
  }

  // Process each image: resize and crop to fit cell
  const processedImages = [];

  for (let i = 0; i < 6; i++) {
    if (images[i] === null || !fs.existsSync(images[i])) {
      // Create black square
      const black = await sharp({
        create: {
          width: cellWidth,
          height: cellHeight,
          channels: 3,
          background: { r: 0, g: 0, b: 0 }
        }
      })
        .png()
        .toBuffer();

      processedImages.push(black);
    } else {
      // Load and process image
      const processed = await sharp(images[i])
        .resize(cellWidth, cellHeight, {
          fit: 'cover',
          position: 'center'
        })
        .png()
        .toBuffer();

      processedImages.push(processed);
    }
  }

  // Create composite with all 6 images in 3×2 grid
  const composites = [];

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const index = row * cols + col;
      composites.push({
        input: processedImages[index],
        top: row * cellHeight,
        left: col * cellWidth
      });
    }
  }

  // Create blank canvas and composite all images
  await sharp({
    create: {
      width: totalWidth,
      height: totalHeight,
      channels: 3,
      background: { r: 255, g: 255, b: 255 }
    }
  })
    .composite(composites)
    .png()
    .toFile(outputPath);

  return outputPath;
}

// ============================================
// 4. MAIN WORKFLOW FUNCTION
// ============================================

/**
 * Complete workflow: download → select → generate mosaic
 * @param {Object} listing - Listing object with images[]
 * @param {string} side - 'viva' or 'coelho'
 * @returns {Object} - { mosaicPath, stats }
 */
async function generateMosaicForListing(listing, side) {
  const propertyCode = listing.propertyCode;

  console.log(`\n🖼️  Processing ${side}/${propertyCode}...`);

  // 1. Download and cache images
  const cachedPaths = await downloadAndCache(listing, side);

  if (cachedPaths.length === 0) {
    console.log(`  ❌ No images available for mosaic`);
    return { mosaicPath: null, stats: { error: 'No images' } };
  }

  // 2. Select 6 best images
  const selectedPaths = await selectForMosaic(cachedPaths, 6);
  console.log(`  ✅ Selected ${selectedPaths.length} images for mosaic`);

  // 3. Check if mosaic already exists
  const mosaicDir = path.join(
    process.cwd(),
    'data',
    'mosaics',
    side
  );

  await mkdir(mosaicDir, { recursive: true });

  const mosaicPath = path.join(mosaicDir, `${propertyCode}.png`);

  if (fs.existsSync(mosaicPath)) {
    console.log(`  ♻️  Mosaic already exists: ${mosaicPath}`);
    return { mosaicPath, stats: { cached: true, images: selectedPaths.length } };
  }

  // 4. Generate mosaic
  await makeMosaic(selectedPaths, mosaicPath);
  console.log(`  ✅ Mosaic generated: ${mosaicPath}`);

  return {
    mosaicPath,
    stats: {
      totalImages: cachedPaths.length,
      selectedImages: selectedPaths.length,
      cached: false
    }
  };
}

// ============================================
// 5. BATCH PROCESSING
// ============================================

/**
 * Generate mosaics for all listings from a JSON file
 * @param {string} jsonPath - Path to all-listings.json
 * @param {string} side - 'viva' or 'coelho'
 */
async function generateMosaicsForAll(jsonPath, side) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🚀 Generating mosaics for ${side.toUpperCase()}`);
  console.log(`${'='.repeat(60)}\n`);

  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  const listings = data.listings;

  console.log(`📊 Total listings: ${listings.length}\n`);

  const results = [];

  for (let i = 0; i < listings.length; i++) {
    const listing = listings[i];

    console.log(`[${i + 1}/${listings.length}] ${listing.propertyCode}`);

    try {
      const result = await generateMosaicForListing(listing, side);
      results.push({
        propertyCode: listing.propertyCode,
        success: result.mosaicPath !== null,
        mosaicPath: result.mosaicPath,
        stats: result.stats
      });
    } catch (error) {
      console.log(`  ❌ Error: ${error.message}`);
      results.push({
        propertyCode: listing.propertyCode,
        success: false,
        error: error.message
      });
    }

    // Progress indicator
    if ((i + 1) % 10 === 0) {
      const successful = results.filter(r => r.success).length;
      console.log(`\n✅ Progress: ${i + 1}/${listings.length} (${successful} successful)\n`);
    }
  }

  // Summary
  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`📊 SUMMARY - ${side.toUpperCase()}`);
  console.log(`${'='.repeat(60)}`);
  console.log(`✅ Successful: ${successful}/${listings.length}`);
  console.log(`❌ Failed: ${failed}/${listings.length}`);
  console.log(`${'='.repeat(60)}\n`);

  return results;
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
  downloadAndCache,
  selectForMosaic,
  makeMosaic,
  generateMosaicForListing,
  generateMosaicsForAll
};

// ============================================
// CLI USAGE (if run directly)
// ============================================

if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log(`
Usage:
  node mosaic-module.js viva    # Generate mosaics for VIVA listings
  node mosaic-module.js coelho  # Generate mosaics for Coelho listings
  node mosaic-module.js both    # Generate mosaics for both
    `);
    process.exit(0);
  }

  const target = args[0];

  (async () => {
    try {
      if (target === 'viva' || target === 'both') {
        const vivaPath = path.join(process.cwd(), 'data', 'vivaprimeimoveis', 'listings', 'all-listings.json');
        await generateMosaicsForAll(vivaPath, 'viva');
      }

      if (target === 'coelho' || target === 'both') {
        const coelhoPath = path.join(process.cwd(), 'data', 'coelhodafonseca', 'listings', 'all-listings.json');
        await generateMosaicsForAll(coelhoPath, 'coelho');
      }

      console.log('\n🎉 All done!\n');
    } catch (error) {
      console.error(`\n❌ Error: ${error.message}\n`);
      process.exit(1);
    }
  })();
}
