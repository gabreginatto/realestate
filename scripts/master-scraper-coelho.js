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
  console.log('='.repeat(60) + '\n');

  process.exit(0);
})();
