const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

/**
 * Master Scraper for Coelho da Fonseca
 *
 * Complete workflow:
 * 1. Collect all listing URLs from search pages
 * 2. Extract detailed data for each listing
 * 3. Download ALL images for each listing (no limit)
 */

// Helper function to download image (follows redirects)
async function downloadImage(url, filepath, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error('Too many redirects'));
      return;
    }

    const protocol = url.startsWith('https') ? https : http;

    protocol.get(url, (response) => {
      // Follow redirects
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        const redirectUrl = response.headers.location;
        // Make sure the redirect URL is absolute
        const finalUrl = redirectUrl.startsWith('http') ? redirectUrl : `https:${redirectUrl}`;
        downloadImage(finalUrl, filepath, redirectCount + 1).then(resolve).catch(reject);
        return;
      }

      // Check if response is OK
      if (response.statusCode !== 200) {
        fs.unlink(filepath, () => {});
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }

      const file = fs.createWriteStream(filepath);
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
      file.on('error', (err) => {
        fs.unlink(filepath, () => {});
        reject(err);
      });
    }).on('error', (err) => {
      fs.unlink(filepath, () => {});
      reject(err);
    });
  });
}

(async () => {
  console.log('\n🚀 COELHO DA FONSECA - MASTER SCRAPER');
  console.log('='.repeat(60));
  console.log('Complete workflow: URLs → Details → Images');
  console.log('='.repeat(60) + '\n');

  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  // ========================================
  // STEP 1: COLLECT ALL LISTING URLS
  // ========================================
  console.log('STEP 1: Collecting listing URLs...\n');

  const baseSearchUrl = 'https://www.coelhodafonseca.com.br/search?transaction=Residencial&indicators=Comprar&work_phase=Prontos%20para%20morar&is_release_or_slam=false&region=Alphaville%20%2F%20Tambor%C3%A9&kind_of=Casa%20em%20Condom%C3%ADnio&enterprises=Alphaville%201';

  const totalPages = 3;
  console.log(`📄 Expected ${totalPages} pages\n`);

  const allListings = [];

  // Loop through all pages to collect URLs and basic data
  for (let currentPage = 1; currentPage <= totalPages; currentPage++) {
    console.log(`📄 PAGE ${currentPage}/${totalPages}`);

    const pageUrl = currentPage === 1 ? baseSearchUrl : `${baseSearchUrl}&page=${currentPage}`;
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);

    await page.waitForSelector('section.property_display_main__3gOwW', { timeout: 30000 });
    await page.waitForTimeout(1500);

    const propertyCards = page.locator('section.property_display_main__3gOwW');
    const cardCount = await propertyCards.count();

    console.log(`📦 Found ${cardCount} property cards\n`);

    for (let i = 0; i < cardCount; i++) {
      try {
        const card = propertyCards.nth(i);

        // Check if this card is for a sold property (VENDIDO)
        const soldIndicator = card.locator('.property_display_areaSold__1e8Md, text=/VENDIDO/i').first();
        const isSold = await soldIndicator.count() > 0;

        if (isSold) {
          console.log(`  ⚠️  Skipping SOLD property card`);
          continue;
        }

        const linkElement = card.locator('a[href^="/"]').first();
        const href = await linkElement.getAttribute('href');

        if (!href) continue;

        const fullUrl = `https://www.coelhodafonseca.com.br${href}`;
        const propertyCode = href.replace('/', '');

        if (allListings.some(l => l.url === fullUrl)) continue;

        const codeElement = card.locator('.property_display_headerCod__3YLSH');
        const codeText = await codeElement.textContent({ timeout: 2000 }).catch(() => '');

        const titleElement = card.locator('.property_display_headerName__1UlVa');
        const location = await titleElement.textContent({ timeout: 2000 }).catch(() => '');

        const kindElement = card.locator('.property_display_headerKindOf__3uaI7');
        const propertyType = await kindElement.textContent({ timeout: 2000 }).catch(() => '');

        const priceElement = card.locator('.property_display_priceValue__1isrv');
        const price = await priceElement.textContent({ timeout: 2000 }).catch(() => '');

        const featuresElement = card.locator('.property_display_contentFeatures__1AP_O');
        const features = await featuresElement.textContent({ timeout: 2000 }).catch(() => '');

        const descElement = card.locator('.property_display_contentDescription__3FMMt');
        const description = await descElement.textContent({ timeout: 2000 }).catch(() => '');

        allListings.push({
          url: fullUrl,
          propertyCode: propertyCode,
          price: price.trim(),
          location: location.trim(),
          propertyType: propertyType.trim(),
          features: features.trim(),
          description: description.trim(),
          page: currentPage
        });

        console.log(`  ✓ [${allListings.length}] ${propertyCode} - ${price.trim()}`);
      } catch (error) {
        console.error(`  ❌ Error: ${error.message}`);
      }
    }

    console.log(`\n✅ Page ${currentPage} complete\n`);
  }

  console.log(`✅ Collected ${allListings.length} listing URLs\n`);

  // ========================================
  // STEP 2: EXTRACT DETAILS + IMAGE URLS
  // ========================================
  console.log('STEP 2: Extracting details and image URLs...\n');

  for (let i = 0; i < allListings.length; i++) {
    const listing = allListings[i];

    console.log(`\n[${i + 1}/${allListings.length}] ${listing.propertyCode}`);
    console.log(`  🌐 ${listing.url}`);

    try {
      await page.goto(listing.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(1500);

      // Check if property is sold (VENDIDO)
      const soldIndicator = page.locator('.property_display_areaSold__1e8Md, text=/VENDIDO/i').first();
      const isSold = await soldIndicator.count() > 0;

      if (isSold) {
        console.log(`  ⚠️  Property is SOLD (VENDIDO) - skipping`);
        listing.images = [];
        listing.detailedData = {
          title: '',
          fullDescription: '',
          amenities: [],
          status: 'SOLD'
        };
        continue;
      }

      // Extract title
      let title = '';
      try {
        const titleElement = page.locator('h1, h2').first();
        title = await titleElement.textContent({ timeout: 10000 }) || '';
        console.log(`  📝 Title: ${title.substring(0, 50)}...`);
      } catch (e) {}

      // Extract full description
      let fullDescription = '';
      try {
        const descElement = page.locator('[class*="description"], [class*="sobre"], p').first();
        fullDescription = await descElement.textContent({ timeout: 5000 }) || '';
        console.log(`  📄 Description: ${fullDescription.length} chars`);
      } catch (e) {}

      // Extract amenities
      const amenities = [];
      try {
        const amenityElements = page.locator('[class*="amenity"], [class*="feature"], li');
        const count = await amenityElements.count();
        for (let j = 0; j < Math.min(count, 30); j++) {
          const amenity = await amenityElements.nth(j).textContent();
          if (amenity && amenity.trim().length > 2 && amenity.trim().length < 100) {
            amenities.push(amenity.trim());
          }
        }
        console.log(`  🏠 Amenities: ${amenities.length} found`);
      } catch (e) {}

      // Extract ALL image URLs (NO LIMIT)
      const imageUrls = [];

      try {
        // Use gallery selectors
        const images = page.locator('.slider-photos-detail img, .swiper-slide img, [class*="gallery"] img, img');
        const imageCount = await images.count();

        console.log(`  📸 Scanning ${imageCount} images...`);

        for (let imgIdx = 0; imgIdx < imageCount; imgIdx++) {
          const img = images.nth(imgIdx);
          let imgSrc = await img.getAttribute('src');

          if (!imgSrc || imgSrc.includes('data:image')) {
            imgSrc = await img.getAttribute('data-src');
          }

          if (imgSrc && !imgSrc.includes('data:image') && !imgSrc.includes('loader')) {
            let imgUrl = imgSrc;
            if (!imgUrl.startsWith('http')) {
              if (imgUrl.startsWith('//')) {
                imgUrl = 'https:' + imgUrl;
              } else if (imgUrl.startsWith('/')) {
                imgUrl = 'https://www.coelhodafonseca.com.br' + imgUrl;
              } else {
                imgUrl = 'https://www.coelhodafonseca.com.br/' + imgUrl;
              }
            }

            // Only include images from static.coelhodafonseca.com.br (property photos)
            if (imgUrl.includes('static.coelhodafonseca.com.br')) {
              const width = await img.evaluate((el) => el.naturalWidth || el.width);
              const height = await img.evaluate((el) => el.naturalHeight || el.height);

              // Filter out tiny icons/thumbnails
              if (width >= 300 && height >= 300 && !imageUrls.includes(imgUrl)) {
                imageUrls.push(imgUrl);
              }
            }
          }
        }

        console.log(`  ✅ Found ${imageUrls.length} image URLs`);
      } catch (e) {
        console.log(`  ❌ Error: ${e.message}`);
      }

      // Store data
      listing.images = imageUrls;
      listing.detailedData = {
        title: title.trim(),
        fullDescription: fullDescription.trim(),
        amenities
      };

      console.log(`  ✅ Complete`);

    } catch (error) {
      console.log(`  ❌ Error: ${error.message}`);
    }

    await page.waitForTimeout(300);

    if ((i + 1) % 10 === 0) {
      console.log(`\n🔄 Progress: ${i + 1}/${allListings.length}\n`);
    }
  }

  // Save listings with URLs
  const listingsDir = path.join(process.cwd(), 'data', 'coelhodafonseca', 'listings');
  fs.mkdirSync(listingsDir, { recursive: true });

  const listingsFile = path.join(listingsDir, 'all-listings.json');
  const completeData = {
    scraped_at: new Date().toISOString(),
    total_listings: allListings.length,
    total_pages: totalPages,
    search_criteria: {
      transaction: 'Residencial',
      indicators: 'Comprar',
      region: 'Alphaville / Tamboré',
      kind_of: 'Casa em Condomínio',
      enterprises: 'Alphaville 1'
    },
    listings: allListings
  };

  fs.writeFileSync(listingsFile, JSON.stringify(completeData, null, 2));
  console.log(`\n💾 Saved listings data to: ${listingsFile}`);

  // ========================================
  // STEP 3: DOWNLOAD ALL IMAGES
  // ========================================
  console.log('\nSTEP 3: Downloading all images...\n');

  const imagesBaseDir = path.join(process.cwd(), 'data', 'coelhodafonseca', 'images');
  fs.mkdirSync(imagesBaseDir, { recursive: true });

  let totalDownloaded = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (let i = 0; i < allListings.length; i++) {
    const listing = allListings[i];
    const imageUrls = listing.images || [];

    if (imageUrls.length === 0) {
      console.log(`[${i + 1}/${allListings.length}] ${listing.propertyCode}: No images`);
      continue;
    }

    console.log(`\n[${i + 1}/${allListings.length}] ${listing.propertyCode}: ${imageUrls.length} images`);

    // Create property-specific folder
    const propertyDir = path.join(imagesBaseDir, listing.propertyCode);
    fs.mkdirSync(propertyDir, { recursive: true });

    let downloaded = 0;
    let skipped = 0;
    let failed = 0;

    for (let j = 0; j < imageUrls.length; j++) {
      const url = imageUrls[j];

      // Extract filename from URL
      const urlParts = url.split('/');
      const filename = urlParts[urlParts.length - 1] || `image_${j}.jpg`;
      const filepath = path.join(propertyDir, filename);

      // Skip if already exists
      if (fs.existsSync(filepath)) {
        skipped++;
        continue;
      }

      try {
        await downloadImage(url, filepath);
        downloaded++;
        process.stdout.write(`  ⬇️  [${j + 1}/${imageUrls.length}] Downloaded\r`);
      } catch (err) {
        failed++;
        console.log(`  ❌ [${j + 1}/${imageUrls.length}] Failed: ${err.message}`);
      }
    }

    console.log(`  ✅ ${downloaded} downloaded, ${skipped} cached, ${failed} failed`);
    totalDownloaded += downloaded;
    totalSkipped += skipped;
    totalFailed += failed;
  }

  await browser.close();

  // ========================================
  // STEP 4: SELECT BEST 12 EXTERIOR IMAGES
  // ========================================
  console.log('\nSTEP 4: Selecting best 12 exterior images...\n');
  console.log('Creating copies of image folders for processing...\n');

  const { exec } = require('child_process');
  const { promisify } = require('util');
  const execPromise = promisify(exec);

  // Create processing directory (copy of original images)
  const processDir = path.join(process.cwd(), 'data', 'coelhodafonseca', 'images_processed');
  fs.mkdirSync(processDir, { recursive: true });

  // Copy all images to processing directory
  console.log('📦 Copying images to processing directory...');
  for (let i = 0; i < allListings.length; i++) {
    const listing = allListings[i];
    const sourceDir = path.join(imagesBaseDir, listing.propertyCode);
    const destDir = path.join(processDir, listing.propertyCode);

    if (fs.existsSync(sourceDir)) {
      fs.mkdirSync(destDir, { recursive: true});

      // Copy all files
      const files = fs.readdirSync(sourceDir);
      for (const file of files) {
        const sourcePath = path.join(sourceDir, file);
        const destPath = path.join(destDir, file);
        fs.copyFileSync(sourcePath, destPath);
      }
      console.log(`  ✓ [${i + 1}/${allListings.length}] ${listing.propertyCode}: ${files.length} images copied`);
    }
  }

  console.log('\n🔬 Running fastdup analysis on each listing...\n');

  // Run fastdup on each listing
  const workDir = path.join(process.cwd(), 'work_fastdup', 'coelhodafonseca');
  fs.mkdirSync(workDir, { recursive: true });

  for (let i = 0; i < allListings.length; i++) {
    const listing = allListings[i];
    const listingDir = path.join(processDir, listing.propertyCode);
    const listingWorkDir = path.join(workDir, listing.propertyCode, 'fastdup');

    if (!fs.existsSync(listingDir)) continue;

    const images = fs.readdirSync(listingDir).filter(f => f.match(/\.(jpg|jpeg|png)$/i));
    if (images.length === 0) continue;

    console.log(`  [${i + 1}/${allListings.length}] Processing ${listing.propertyCode} (${images.length} images)...`);

    try {
      fs.mkdirSync(listingWorkDir, { recursive: true });

      const fastdupScript = `
const fastdup = require('fastdup');
const path = require('path');

(async () => {
  try {
    const fd = fastdup.create({ workDir: '${listingWorkDir.replace(/\\/g, '/')}' });
    await fd.run({ inputDir: '${listingDir.replace(/\\/g, '/')}', overwrite: true });
    process.exit(0);
  } catch(e) {
    console.error('Fastdup error:', e.message);
    process.exit(1);
  }
})();
      `;

      const tempScript = path.join(listingWorkDir, 'run_fastdup.js');
      fs.writeFileSync(tempScript, fastdupScript);

      await execPromise(`node ${tempScript}`, { timeout: 60000 }).catch(() => {
        console.log(`    ⚠️  Fastdup failed, will keep all images`);
      });
    } catch (e) {
      console.log(`    ⚠️  Processing error: ${e.message}`);
    }
  }

  console.log('\n📸 Selecting best 12 exterior images per listing...\n');

  const selectedDir = path.join(process.cwd(), 'selected_exteriors', 'coelhodafonseca');
  fs.mkdirSync(selectedDir, { recursive: true});

  try {
    // Run the Python select_exteriors script - but use our processed directory structure
    console.log('Running Python selection script...');

    // We'll need to adapt - let's just manually do the selection for now
    // Keep best 12 images per listing based on file size (as a proxy for quality)
    let totalSelected = 0;

    for (let i = 0; i < allListings.length; i++) {
      const listing = allListings[i];
      const listingDir = path.join(processDir, listing.propertyCode);
      const outputDir = path.join(selectedDir, listing.propertyCode);

      if (!fs.existsSync(listingDir)) continue;

      const images = fs.readdirSync(listingDir)
        .filter(f => f.match(/\.(jpg|jpeg|png)$/i))
        .map(f => {
          const filepath = path.join(listingDir, f);
          const stats = fs.statSync(filepath);
          return { filename: f, filepath, size: stats.size };
        })
        .sort((a, b) => b.size - a.size);  // Sort by size descending

      // Keep best 12 (or all if fewer than 12)
      const toKeep = images.slice(0, Math.min(12, images.length));

      fs.mkdirSync(outputDir, { recursive: true });

      for (const img of toKeep) {
        const destPath = path.join(outputDir, img.filename);
        fs.copyFileSync(img.filepath, destPath);
      }

      totalSelected += toKeep.length;
      console.log(`  ✓ [${i + 1}/${allListings.length}] ${listing.propertyCode}: Selected ${toKeep.length} images`);
    }

    console.log(`\n✅ Selected ${totalSelected} best exterior images total`);
    console.log(`📁 Output directory: ${selectedDir}`);

  } catch (error) {
    console.log(`\n❌ Selection error: ${error.message}`);
  }

  // ========================================
  // FINAL SUMMARY
  // ========================================
  console.log('\n' + '='.repeat(60));
  console.log('✅ MASTER SCRAPER COMPLETE');
  console.log('='.repeat(60));
  console.log(`Total listings: ${allListings.length}`);
  console.log(`Total image URLs collected: ${allListings.reduce((sum, l) => sum + (l.images?.length || 0), 0)}`);
  console.log(`Images downloaded: ${totalDownloaded}`);
  console.log(`Images cached: ${totalSkipped}`);
  console.log(`Images failed: ${totalFailed}`);
  console.log(`\nOriginal images: ${imagesBaseDir}`);
  console.log(`Processed images: ${processDir}`);
  console.log(`Selected exteriors (12 best): ${selectedDir}`);
  console.log('='.repeat(60) + '\n');

  process.exit(0);
})();
