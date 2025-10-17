const axios = require('axios');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const mkdir = promisify(fs.mkdir);
const exists = promisify(fs.exists);

/**
 * Mosaic Module - Phase 2 (Improved)
 *
 * Handles:
 * 1. Image downloading and caching
 * 2. Smart image selection for mosaics (9 best photos with 2-3 pool photos prioritized)
 * 3. 3×3 mosaic generation (900x900px)
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
 * Detects if an image is likely a pool photo based on filename patterns
 * @param {string} filepath - Path to image file
 * @returns {boolean}
 */
function isLikelyPoolPhoto(filepath) {
  const filename = path.basename(filepath).toLowerCase();
  const poolKeywords = ['piscina', 'pool', 'swimming', 'deck', 'outdoor', 'exterior', 'area-externa'];
  return poolKeywords.some(keyword => filename.includes(keyword));
}

/**
 * Selects 9 diverse, high-quality images for mosaic with pool photo prioritization
 * @param {Array<string>} imagePaths - Array of local file paths
 * @param {number} maxN - Maximum images to select (default 9)
 * @param {number} minPoolPhotos - Minimum pool photos to include (default 2)
 * @returns {Array<string>} - Array of selected file paths
 */
async function selectForMosaic(imagePaths, maxN = 9, minPoolPhotos = 2) {
  if (imagePaths.length === 0) {
    return [];
  }

  // If we have maxN or fewer, return all
  if (imagePaths.length <= maxN) {
    return imagePaths;
  }

  // Score each image based on:
  // - Position (prefer earlier images - usually best photos)
  // - File size (prefer larger = higher quality)
  // - Dimensions (prefer larger resolutions)
  // - Pool photo bonus

  const scored = [];
  const poolPhotos = [];

  for (let i = 0; i < imagePaths.length; i++) {
    const filepath = imagePaths[i];

    try {
      const stats = fs.statSync(filepath);
      const metadata = await sharp(filepath).metadata();
      const isPool = isLikelyPoolPhoto(filepath);

      // Scoring algorithm
      const positionScore = (imagePaths.length - i) / imagePaths.length; // Earlier = higher
      const sizeScore = Math.min(stats.size / (500 * 1024), 1); // Normalize to 500KB max
      const resolutionScore = Math.min((metadata.width * metadata.height) / (2000 * 1500), 1); // Normalize to 3MP
      const poolBonus = isPool ? 0.3 : 0; // Boost pool photos

      const totalScore = (positionScore * 0.4) + (sizeScore * 0.2) + (resolutionScore * 0.2) + poolBonus;

      const scoredItem = {
        path: filepath,
        score: totalScore,
        index: i,
        isPool: isPool
      };

      scored.push(scoredItem);

      if (isPool) {
        poolPhotos.push(scoredItem);
      }
    } catch (error) {
      console.log(`    ⚠️  Could not analyze ${filepath}: ${error.message}`);
    }
  }

  // Sort all images by score (descending)
  scored.sort((a, b) => b.score - a.score);

  const selected = [];

  // Step 1: Ensure we have 2-3 pool photos if available
  const poolPhotosToInclude = Math.min(minPoolPhotos + 1, poolPhotos.length);
  const sortedPoolPhotos = poolPhotos.sort((a, b) => b.score - a.score);

  for (let i = 0; i < poolPhotosToInclude && i < sortedPoolPhotos.length; i++) {
    selected.push(sortedPoolPhotos[i].path);
  }

  // Step 2: Fill remaining slots with highest scored non-pool or remaining images
  for (let i = 0; i < scored.length && selected.length < maxN; i++) {
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
 * Creates a 3×3 mosaic from 9 images
 * @param {Array<string>} imagePaths - Array of 9 image file paths
 * @param {string} outputPath - Where to save the mosaic
 * @param {Object} options - Mosaic options
 * @returns {string} - Path to generated mosaic
 */
async function makeMosaic(imagePaths, outputPath, options = {}) {
  const {
    cellWidth = 300,
    cellHeight = 300,
    rows = 3,
    cols = 3
  } = options;

  const totalWidth = cellWidth * cols;
  const totalHeight = cellHeight * rows;
  const totalCells = rows * cols;

  // Ensure we have exactly 9 images (fill with black if needed)
  const images = [...imagePaths];
  while (images.length < totalCells) {
    images.push(null); // Will be replaced with black square
  }

  // Process each image: resize and crop to fit cell
  const processedImages = [];

  for (let i = 0; i < totalCells; i++) {
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

  // Create composite with all 9 images in 3×3 grid
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

  // 2. Select 9 best images (including 2-3 pool photos if available)
  const selectedPaths = await selectForMosaic(cachedPaths, 9, 2);
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
