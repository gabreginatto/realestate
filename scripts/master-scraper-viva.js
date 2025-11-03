const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

/**
 * Master Scraper for Viva Prime Imóveis
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
  console.log('\n🚀 VIVA PRIME IMÓVEIS - MASTER SCRAPER');
  console.log('=' .repeat(60));
  console.log('Complete workflow: URLs → Details → Images');
  console.log('=' .repeat(60) + '\n');

  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  // ========================================
  // STEP 1: COLLECT ALL LISTING URLS
  // ========================================
  console.log('STEP 1: Collecting listing URLs...\n');

  // Navigate to homepage
  console.log('🌐 Navigating to Viva homepage...');
  await page.goto('https://www.vivaprimeimoveis.com.br/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  // Handle cookie banner
  const cookieButton = page.getByRole('button', { name: 'Aceitar Cookies' });
  if (await cookieButton.isVisible({ timeout: 5000 }).catch(() => false)) {
    await cookieButton.click();
    await page.waitForTimeout(500);
  }

  // Wait for search form
  console.log('🔍 Waiting for search form...');
  await page.waitForSelector('button:has-text("Buscar")', { timeout: 10000 });

  // Select Tipo: Casa
  console.log('📝 Selecting Tipo: Casa');
  await page.getByRole('button', { name: 'Tipo' }).click();
  await page.waitForTimeout(500);
  await page.locator('.dropdown-item').filter({ hasText: /^Casa$/ }).click();
  await page.waitForTimeout(500);

  // Select Empreendimento: Alphaville 01
  console.log('🏘️  Selecting Empreendimento: Alphaville 01');
  await page.getByRole('button', { name: 'Empreendimento' }).click();
  await page.waitForTimeout(500);
  await page.locator('.dropdown-item').filter({ hasText: /^Alphaville 01$/ }).click();
  await page.waitForTimeout(500);

  // Click search button
  console.log('🔎 Clicking search button...');
  await page.locator('button.btn-search').filter({ hasText: 'Buscar' }).first().click();

  // Wait for results to load
  await page.waitForURL(/imoveis|venda/, { timeout: 10000 }).catch(async () => {
    await page.waitForSelector('a[href*="/imovel/"]', { timeout: 10000 });
  });

  await page.waitForSelector('a[href*="imovel/"]', { timeout: 15000 });
  const searchUrl = page.url();
  console.log(`✅ Results loaded: ${searchUrl}\n`);

  // Get total pages
  const pageLinks = page.locator('a[href*="pg="]');
  const pageCount = await pageLinks.count();
  let totalPages = 1;
  if (pageCount > 0) {
    const lastPageLink = pageLinks.nth(pageCount - 2);
    const lastPageText = await lastPageLink.textContent();
    totalPages = parseInt(lastPageText?.trim() || '1', 10);
  }

  console.log(`📄 Found ${totalPages} pages to scrape\n`);

  const collectedUrls = [];
  const seenUrls = new Set();

  // Loop through all pages to collect URLs
  for (let currentPage = 1; currentPage <= totalPages; currentPage++) {
    console.log(`📄 Page ${currentPage}/${totalPages}...`);

    const listingCards = page.locator('a[href*="imovel/"]');
    const cardCount = await listingCards.count();

    for (let i = 0; i < cardCount; i++) {
      try {
        const card = listingCards.nth(i);

        // Check if this card links to a sold property
        // Look for any parent container that might have a "vendido" indicator
        const parentCard = card.locator('xpath=ancestor::*[contains(@class, "card") or contains(@class, "property") or contains(@class, "listing")]').first();
        const soldText = await parentCard.locator('text=/vendido/i').count().catch(() => 0);

        if (soldText > 0) {
          console.log(`  ⚠️  Skipping SOLD property`);
          continue;
        }

        const url = await card.getAttribute('href') || '';

        if (!url.includes('imovel/')) continue;

        // Ensure URL starts with /
        const normalizedUrl = url.startsWith('/') ? url : `/${url}`;
        const fullUrl = url.startsWith('http') ? url : `https://www.vivaprimeimoveis.com.br${normalizedUrl}`;

        if (seenUrls.has(fullUrl)) continue;
        seenUrls.add(fullUrl);

        // Extract property code from URL
        const propertyCode = fullUrl.split('/').filter(Boolean).pop();

        collectedUrls.push({
          url: fullUrl,
          propertyCode: propertyCode,
          page: currentPage
        });

        console.log(`  ✓ [${collectedUrls.length}] ${propertyCode}`);
      } catch (error) {
        console.error(`  ❌ Error collecting URL: ${error.message}`);
      }
    }

    // Navigate to next page
    if (currentPage < totalPages) {
      const nextPageLink = page.locator(`a[href*="pg=${currentPage + 1}"]`).first();
      await nextPageLink.click();
      await page.waitForLoadState('domcontentloaded');
      await page.waitForSelector('a[href*="imovel/"]', { timeout: 10000 });
      await page.waitForTimeout(1000);
    }
  }

  console.log(`\n✅ Collected ${collectedUrls.length} listing URLs\n`);

  // ========================================
  // STEP 2: EXTRACT DETAILS + IMAGE URLS
  // ========================================
  console.log('STEP 2: Extracting details and image URLs...\n');

  const allListings = collectedUrls;

  for (let i = 0; i < allListings.length; i++) {
    const listing = allListings[i];

    console.log(`\n[${i + 1}/${allListings.length}] ${listing.propertyCode}`);
    console.log(`URL: ${listing.url}`);

    try {
      await page.goto(listing.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(2000);

      // Extract price
      let price = '';
      const priceSelectors = ['.preco', '.price', '.valor', '[class*="preco"]'];
      for (const selector of priceSelectors) {
        try {
          const priceEl = page.locator(selector).first();
          if (await priceEl.count() > 0) {
            price = await priceEl.textContent({ timeout: 3000 });
            if (price && price.includes('R$')) {
              price = price.trim();
              console.log(`  💰 Price: ${price}`);
              break;
            }
          }
        } catch (e) {}
      }

      // Extract title
      let title = '';
      try {
        const titleEl = page.locator('h1, h2, .title, [class*="title"]').first();
        title = await titleEl.textContent({ timeout: 5000 });
        console.log(`  📝 Title: ${title?.substring(0, 50)}...`);
      } catch (e) {}

      // Extract description
      let description = '';
      const descSelectors = ['.description', '[class*="descri"]', 'p', '.text'];
      for (const selector of descSelectors) {
        try {
          const descEl = page.locator(selector).first();
          if (await descEl.count() > 0) {
            const text = await descEl.textContent({ timeout: 3000 });
            if (text && text.length > 50) {
              description = text.trim();
              break;
            }
          }
        } catch (e) {}
      }

      // Extract features
      const features = [];
      try {
        const featureElements = page.locator('li, .feature, .amenity, [class*="caracteristica"]');
        const count = await featureElements.count();
        for (let j = 0; j < Math.min(count, 30); j++) {
          const feature = await featureElements.nth(j).textContent();
          if (feature && feature.trim().length > 0 && feature.trim().length < 100) {
            const cleaned = feature.trim();
            if (!features.includes(cleaned)) {
              features.push(cleaned);
            }
          }
        }
      } catch (e) {}

      // Extract specs
      const specs = {
        dormitorios: null,
        suites: null,
        banheiros: null,
        vagas: null,
        area_construida: null,
        area_total: null
      };

      try {
        const items = page.locator('.item:has(.legenda i.fa)');
        const itemCount = await items.count();

        for (let k = 0; k < itemCount; k++) {
          try {
            const item = items.nth(k);
            const label = await item.locator('.label').textContent({ timeout: 1000 });
            const num = await item.locator('.num').textContent({ timeout: 1000 });

            if (!label || !num) continue;

            const labelText = label.trim().toLowerCase();
            const numText = num.trim();

            if (labelText.includes('dormitório')) specs.dormitorios = parseInt(numText);
            else if (labelText.includes('suíte')) specs.suites = parseInt(numText);
            else if (labelText.includes('banheiro')) specs.banheiros = parseInt(numText);
            else if (labelText.includes('vaga')) specs.vagas = parseInt(numText);
            else if (labelText.includes('construído')) specs.area_construida = numText;
            else if (labelText.includes('total')) specs.area_total = numText;
          } catch (e) {}
        }

        const specsStr = `${specs.dormitorios || '?'} dorms / ${specs.suites || '?'} suítes / ${specs.vagas || '?'} vagas`;
        console.log(`  📐 Specs: ${specsStr}`);
      } catch (e) {}

      // Extract ALL image URLs (NO LIMIT)
      const imageUrls = [];
      try {
        const images = page.locator('img');
        const imageCount = await images.count();

        console.log(`  📸 Scanning ${imageCount} images...`);

        for (let imgIdx = 0; imgIdx < imageCount; imgIdx++) {
          const img = images.nth(imgIdx);
          let imgSrc = await img.getAttribute('src');

          if (!imgSrc || imgSrc.includes('data:image')) {
            imgSrc = await img.getAttribute('data-src');
          }

          if (imgSrc && !imgSrc.includes('data:image')) {
            let imgUrl = imgSrc;
            if (!imgUrl.startsWith('http')) {
              if (imgUrl.startsWith('//')) {
                imgUrl = 'https:' + imgUrl;
              } else if (imgUrl.startsWith('/')) {
                imgUrl = 'https://www.vivaprimeimoveis.com.br' + imgUrl;
              } else {
                imgUrl = 'https://www.vivaprimeimoveis.com.br/' + imgUrl;
              }
            }

            // Only include THIS property's images
            const propertyImagePattern = `/fotos/${listing.propertyCode}/`;
            if (imgUrl.includes(propertyImagePattern)) {
              const width = await img.evaluate(el => el.naturalWidth || el.width);
              const height = await img.evaluate(el => el.naturalHeight || el.height);

              // Filter out tiny icons/thumbnails
              if (width >= 400 && height >= 400 && !imageUrls.includes(imgUrl)) {
                imageUrls.push(imgUrl);
              }
            }
          }
        }

        console.log(`  ✅ Found ${imageUrls.length} image URLs`);
      } catch (e) {
        console.log(`  ❌ Error collecting image URLs: ${e.message}`);
      }

      // Store data
      listing.price = price;
      listing.images = imageUrls;
      listing.detailedData = {
        title: title.trim(),
        description: description.trim(),
        specs,
        features
      };

    } catch (error) {
      console.log(`  ❌ Error: ${error.message}`);
      listing.detailedData = { error: error.message };
    }

    await page.waitForTimeout(1000);
  }

  // Save listings with URLs
  const listingsDir = path.join(process.cwd(), 'data', 'vivaprimeimoveis', 'listings');
  fs.mkdirSync(listingsDir, { recursive: true });

  const listingsFile = path.join(listingsDir, 'all-listings.json');
  const completeData = {
    scraped_at: new Date().toISOString(),
    total_listings: allListings.length,
    total_pages: totalPages,
    search_url: searchUrl,
    listings: allListings
  };

  fs.writeFileSync(listingsFile, JSON.stringify(completeData, null, 2));
  console.log(`\n💾 Saved listings data to: ${listingsFile}`);

  // ========================================
  // STEP 3: DOWNLOAD ALL IMAGES
  // ========================================
  console.log('\nSTEP 3: Downloading all images...\n');

  const imagesBaseDir = path.join(process.cwd(), 'data', 'vivaprimeimoveis', 'images');
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
