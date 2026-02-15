#!/usr/bin/env node
/**
 * Select the best 12 images per listing based on file size (quality proxy)
 * Processes existing downloaded images without fastdup
 */

const fs = require('fs');
const path = require('path');

console.log('\n📸 Selecting Best 12 Images Per Listing');
console.log('='.repeat(60));
console.log('Simple selection based on file size (quality proxy)\n');

function selectBest12(sourceDir, outputDir, siteName) {
  console.log(`\n🔷 Processing ${siteName}...`);

  if (!fs.existsSync(sourceDir)) {
    console.log(`  ⚠️  Source directory not found: ${sourceDir}`);
    return { total: 0, listings: 0 };
  }

  const listings = fs.readdirSync(sourceDir).filter(f => {
    const stat = fs.statSync(path.join(sourceDir, f));
    return stat.isDirectory();
  });

  console.log(`  Found ${listings.length} listings to process\n`);

  let totalSelected = 0;
  let listingsProcessed = 0;

  for (const listing of listings) {
    const listingSourceDir = path.join(sourceDir, listing);
    const listingOutputDir = path.join(outputDir, listing);

    // Get all images
    const images = fs.readdirSync(listingSourceDir)
      .filter(f => f.match(/\.(jpg|jpeg|png|webp)$/i))
      .map(f => {
        const filepath = path.join(listingSourceDir, f);
        const stats = fs.statSync(filepath);
        return { filename: f, filepath, size: stats.size };
      })
      .sort((a, b) => b.size - a.size); // Sort by size descending

    if (images.length === 0) {
      console.log(`  ⚠️  ${listing}: No images found`);
      continue;
    }

    // Keep best 12 (or all if fewer than 12)
    const toKeep = images.slice(0, Math.min(12, images.length));

    // Create output directory
    fs.mkdirSync(listingOutputDir, { recursive: true });

    // Copy selected images
    for (const img of toKeep) {
      const destPath = path.join(listingOutputDir, img.filename);
      fs.copyFileSync(img.filepath, destPath);
    }

    totalSelected += toKeep.length;
    listingsProcessed++;

    const sizeInMB = (toKeep.reduce((sum, img) => sum + img.size, 0) / 1024 / 1024).toFixed(1);
    console.log(`  ✓ ${listing}: Selected ${toKeep.length}/${images.length} images (${sizeInMB} MB)`);
  }

  console.log(`\n  ✅ ${siteName}: ${totalSelected} images selected from ${listingsProcessed} listings`);
  return { total: totalSelected, listings: listingsProcessed };
}

// Process Coelho da Fonseca
const coelhoSource = path.join(process.cwd(), 'data', 'coelhodafonseca', 'images_processed');
const coelhoOutput = path.join(process.cwd(), 'selected_exteriors', 'coelhodafonseca');
const coelhoStats = selectBest12(coelhoSource, coelhoOutput, 'Coelho da Fonseca');

// Process Viva Prime Imóveis
const vivaSource = path.join(process.cwd(), 'data', 'vivaprimeimoveis', 'images_processed');
const vivaOutput = path.join(process.cwd(), 'selected_exteriors', 'vivaprimeimoveis');
const vivaStats = selectBest12(vivaSource, vivaOutput, 'Viva Prime Imóveis');

// Final summary
console.log('\n' + '='.repeat(60));
console.log('✅ SELECTION COMPLETE');
console.log('='.repeat(60));
console.log(`Coelho da Fonseca: ${coelhoStats.total} images from ${coelhoStats.listings} listings`);
console.log(`Viva Prime Imóveis: ${vivaStats.total} images from ${vivaStats.listings} listings`);
console.log(`Total: ${coelhoStats.total + vivaStats.total} images from ${coelhoStats.listings + vivaStats.listings} listings`);
console.log('\nOutput directories:');
console.log(`  - ${coelhoOutput}`);
console.log(`  - ${vivaOutput}`);
console.log('='.repeat(60) + '\n');
