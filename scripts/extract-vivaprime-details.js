const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  console.log('\n🔍 Starting Vivaprime detail extraction...\n');

  // Load collected URLs
  const inputFile = path.join(process.cwd(), 'data', 'vivaprimeimoveis', 'listings', 'collected-urls.json');
  const inputData = JSON.parse(fs.readFileSync(inputFile, 'utf8'));

  console.log(`📊 Loaded ${inputData.actual_collected} listings to process\n`);

  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  const allListings = inputData.listings;

  // Process each listing
  for (let i = 0; i < allListings.length; i++) {
    const listing = allListings[i];

    console.log(`\n[${i + 1}/${allListings.length}] Processing ${listing.propertyCode}`);
    console.log(`URL: ${listing.url}`);

    try {
      // Navigate to listing page
      await page.goto(listing.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(2000);

      // Extract price
      let price = '';
      try {
        // Try different price selectors - START WITH THE CORRECT ONE
        const priceSelectors = [
          '.preco',           // CORRECT SELECTOR: <div class="preco color-2">
          '.price',
          '.valor',
          '[class*="preco"]',
          '[class*="price"]',
          '[class*="valor"]',
          'text=/R\\$\\s*[\\d.,]+/'
        ];

        for (const selector of priceSelectors) {
          try {
            const priceEl = page.locator(selector).first();
            if (await priceEl.count() > 0) {
              price = await priceEl.textContent({ timeout: 3000 });
              if (price && price.includes('R$')) {
                price = price.trim();
                console.log(`  💰 Price found with selector '${selector}': ${price}`);
                break;
              }
            }
          } catch (e) {
            // Try next selector
          }
        }

        if (!price) {
          console.log(`  ⚠️  Price not found with any selector`);
        }
      } catch (e) {
        console.log(`  ❌ Error extracting price: ${e.message}`);
      }

      // Extract title
      let title = '';
      try {
        const titleEl = page.locator('h1, h2, .title, [class*="title"]').first();
        title = await titleEl.textContent({ timeout: 5000 });
        console.log(`  📝 Title: ${title?.substring(0, 60)}...`);
      } catch (e) {
        console.log(`  ⚠️  Could not extract title`);
      }

      // Extract description
      let description = '';
      try {
        const descSelectors = [
          '.description',
          '[class*="descri"]',
          'p',
          '.text'
        ];

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
          } catch (e) {
            // Try next selector
          }
        }

        console.log(`  📄 Description: ${description ? description.substring(0, 60) + '...' : 'Not found'}`);
      } catch (e) {
        console.log(`  ⚠️  Could not extract description`);
      }

      // Extract features/amenities
      const features = [];
      try {
        const featureElements = page.locator('li, .feature, .amenity, [class*="caracteristica"]');
        const count = await featureElements.count();

        for (let j = 0; j < Math.min(count, 30); j++) {
          const feature = await featureElements.nth(j).textContent();
          if (feature && feature.trim().length > 0 && feature.trim().length < 100) {
            const cleaned = feature.trim();
            // Avoid duplicates
            if (!features.includes(cleaned)) {
              features.push(cleaned);
            }
          }
        }

        console.log(`  🏠 Features: ${features.length} found`);
      } catch (e) {
        console.log(`  ⚠️  Could not extract features`);
      }

      // Extract property specs (bedrooms, area, etc.)
      const specs = {
        dormitorios: null,
        suites: null,
        banheiros: null,
        vagas: null,
        area_construida: null,
        area_total: null
      };

      try {
        // Target items with fa icons (more specific selector)
        // Look for items that contain .legenda with font-awesome icons
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

            if (labelText.includes('dormitório')) {
              specs.dormitorios = parseInt(numText);
            } else if (labelText.includes('suíte')) {
              specs.suites = parseInt(numText);
            } else if (labelText.includes('banheiro')) {
              specs.banheiros = parseInt(numText);
            } else if (labelText.includes('vaga')) {
              specs.vagas = parseInt(numText);
            } else if (labelText.includes('construído')) {
              specs.area_construida = numText;
            } else if (labelText.includes('total')) {
              specs.area_total = numText;
            }
          } catch (e) {
            // Skip this item
          }
        }

        // Log extracted specs
        const specsStr = `${specs.dormitorios || '?'} dorms / ${specs.suites || '?'} suítes / ${specs.vagas || '?'} vagas / ${specs.area_construida || '?'} construída / ${specs.area_total || '?'} terreno`;
        console.log(`  📐 Specs: ${specsStr}`);
      } catch (e) {
        console.log(`  ⚠️  Could not extract specs: ${e.message}`);
      }

      // Extract all image URLs (don't download - mosaic module will handle that)
      const imageUrls = [];

      try {
        // Find all images
        const images = page.locator('img');
        const imageCount = await images.count();

        console.log(`  📸 Found ${imageCount} total images`);

        for (let imgIdx = 0; imgIdx < imageCount; imgIdx++) {
          const img = images.nth(imgIdx);
          let imgSrc = await img.getAttribute('src');

          // Handle data-src lazy loading
          if (!imgSrc || imgSrc.includes('data:image')) {
            imgSrc = await img.getAttribute('data-src');
          }

          if (imgSrc && !imgSrc.includes('data:image')) {
            // Convert to absolute URL
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

            // Filter: Only include THIS property's images (not related listings)
            // Property images follow pattern: /fotos/{propertyCode}/
            const propertyImagePattern = `/fotos/${listing.propertyCode}/`;

            if (imgUrl.includes(propertyImagePattern)) {
              // Get image dimensions to filter out thumbnails/icons
              const width = await img.evaluate(el => el.naturalWidth || el.width);
              const height = await img.evaluate(el => el.naturalHeight || el.height);

              // Only include larger images (property photos, not tiny icons)
              if (width >= 400 && height >= 400 && !imageUrls.includes(imgUrl)) {
                imageUrls.push(imgUrl);
              }
            }
          }
        }

        console.log(`  ✅ Collected ${imageUrls.length} property image URLs`);
      } catch (e) {
        console.log(`  ❌ Error collecting image URLs: ${e.message}`);
      }

      // Add detailed data to listing
      listing.price = price;
      listing.images = imageUrls; // Store image URLs in listing root
      listing.detailedData = {
        title: title.trim(),
        description: description.trim(),
        specs,
        features
      };

    } catch (error) {
      console.log(`  ❌ Error processing: ${error.message}`);
      listing.detailedData = {
        error: error.message
      };
    }

    // Small delay between requests
    await page.waitForTimeout(1000);
  }

  await browser.close();

  // Save complete data
  const outputFile = path.join(process.cwd(), 'data', 'vivaprimeimoveis', 'listings', 'all-listings.json');

  const completeData = {
    scraped_at: new Date().toISOString(),
    total_listings: allListings.length,
    total_pages: inputData.total_pages,
    search_url: inputData.search_url,
    listings: allListings
  };

  fs.writeFileSync(outputFile, JSON.stringify(completeData, null, 2));

  console.log(`\n\n✅ Processing complete!`);
  console.log(`💾 Saved to: ${outputFile}\n`);

  // Summary
  const withPrice = allListings.filter(l => l.price && l.price.includes('R$')).length;
  const withImages = allListings.filter(l => l.images && l.images.length > 0).length;
  const withErrors = allListings.filter(l => l.detailedData?.error).length;
  const totalImages = allListings.reduce((sum, l) => sum + (l.images?.length || 0), 0);
  const avgImagesPerListing = withImages > 0 ? (totalImages / withImages).toFixed(1) : 0;

  console.log('📊 SUMMARY:');
  console.log(`   Total listings: ${allListings.length}`);
  console.log(`   With price: ${withPrice}`);
  console.log(`   With images: ${withImages} (avg ${avgImagesPerListing} images/listing)`);
  console.log(`   Total image URLs: ${totalImages}`);
  console.log(`   With errors: ${withErrors}\n`);

  process.exit(0);
})();
