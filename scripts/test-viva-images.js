const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  console.log('\n🔍 Testing VIVA image URL extraction...\n');

  // Load collected URLs
  const inputFile = path.join(process.cwd(), 'data', 'vivaprimeimoveis', 'listings', 'collected-urls.json');
  const inputData = JSON.parse(fs.readFileSync(inputFile, 'utf8'));

  console.log(`📊 Testing with first 2 listings\n`);

  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  // Test with first 2 listings only
  const testListings = inputData.listings.slice(0, 2);

  for (let i = 0; i < testListings.length; i++) {
    const listing = testListings[i];

    console.log(`\n[${i + 1}/${testListings.length}] Testing ${listing.propertyCode}`);
    console.log(`URL: ${listing.url}`);

    try {
      await page.goto(listing.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(2000);

      // Extract all image URLs
      const imageUrls = [];

      const imageSelectors = [
        'img[src*="vivaprimeimoveis"]',
        'img[alt*="Casa"]',
        'img[alt*="Imóvel"]',
        '.gallery img',
        '[class*="foto"] img',
        '[class*="image"] img'
      ];

      let images = null;
      for (const selector of imageSelectors) {
        images = page.locator(selector);
        const count = await images.count();
        if (count > 0) {
          console.log(`  📸 Found ${count} images with selector: ${selector}`);
          break;
        }
      }

      if (images && await images.count() > 0) {
        const imageCount = await images.count();

        for (let imgIdx = 0; imgIdx < imageCount; imgIdx++) {
          const img = images.nth(imgIdx);
          let imgSrc = await img.getAttribute('src');

          // Handle data-src lazy loading
          if (!imgSrc || imgSrc.includes('data:image')) {
            imgSrc = await img.getAttribute('data-src');
          }

          if (imgSrc && !imgSrc.includes('data:image')) {
            const imgUrl = imgSrc.startsWith('http') ? imgSrc : `https://www.vivaprimeimoveis.com.br${imgSrc}`;

            if (!imageUrls.includes(imgUrl)) {
              imageUrls.push(imgUrl);
            }
          }
        }

        console.log(`  ✅ Collected ${imageUrls.length} unique image URLs`);

        // Show first 3 URLs as sample
        console.log(`  📋 Sample URLs:`);
        imageUrls.slice(0, 3).forEach((url, idx) => {
          console.log(`     ${idx + 1}. ${url.substring(0, 80)}...`);
        });
      } else {
        console.log(`  ⚠️  No images found`);
      }

      listing.images = imageUrls;

    } catch (error) {
      console.log(`  ❌ Error: ${error.message}`);
    }

    await page.waitForTimeout(1000);
  }

  await browser.close();

  // Show results
  console.log('\n\n📊 TEST RESULTS:\n');
  testListings.forEach(listing => {
    console.log(`${listing.propertyCode}: ${listing.images?.length || 0} images`);
    if (listing.images && listing.images.length > 0) {
      console.log(`   First: ${listing.images[0]}`);
    }
  });

  console.log('\n✅ Test complete!\n');
  process.exit(0);
})();
