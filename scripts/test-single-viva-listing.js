const { chromium } = require('playwright');

(async () => {
  console.log('\n🔍 Testing image extraction for single VIVA listing...\n');

  const testUrl = 'https://www.vivaprimeimoveis.com.br/imovel/alphaville-01-4-dormitorios-alphaville-barueri/17232';

  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  console.log(`📍 URL: ${testUrl}\n`);

  try {
    await page.goto(testUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log('✅ Page loaded');

    await page.waitForTimeout(3000); // Wait for any lazy loading

    // Take a screenshot to see what we're working with
    await page.screenshot({ path: 'debug-viva-listing.png', fullPage: true });
    console.log('📸 Screenshot saved to debug-viva-listing.png\n');

    // Try multiple strategies to find images
    console.log('🔎 Strategy 1: All img tags');
    const allImgs = await page.locator('img').count();
    console.log(`   Found ${allImgs} total img tags\n`);

    // Show first 10 img tags and their attributes
    for (let i = 0; i < Math.min(allImgs, 10); i++) {
      const img = page.locator('img').nth(i);
      const src = await img.getAttribute('src');
      const dataSrc = await img.getAttribute('data-src');
      const alt = await img.getAttribute('alt');
      const className = await img.getAttribute('class');

      console.log(`   [${i + 1}] src: ${src?.substring(0, 60) || 'none'}`);
      console.log(`       data-src: ${dataSrc?.substring(0, 60) || 'none'}`);
      console.log(`       alt: ${alt?.substring(0, 40) || 'none'}`);
      console.log(`       class: ${className || 'none'}\n`);
    }

    // Strategy 2: Look for specific selectors
    console.log('🔎 Strategy 2: Specific selectors');
    const selectors = [
      'img[src*="vivaprimeimoveis"]',
      'img[src*="imoveis"]',
      'img[alt*="Casa"]',
      'img[alt*="Imóvel"]',
      '.gallery img',
      '.fotos img',
      '[class*="foto"] img',
      '[class*="image"] img',
      '[class*="galeria"] img',
      '.carousel img',
      '.slider img'
    ];

    for (const selector of selectors) {
      const count = await page.locator(selector).count();
      if (count > 0) {
        console.log(`   ✓ "${selector}" → ${count} images`);
      }
    }

    // Strategy 3: Collect all unique image URLs (FILTERED for property only)
    console.log('\n🔎 Strategy 3: Collecting property-specific images (filtered)\n');
    const propertyCode = '17232';
    const propertyImagePattern = `/fotos/${propertyCode}/`;
    const imageUrls = [];

    for (let i = 0; i < allImgs; i++) {
      const img = page.locator('img').nth(i);
      let imgSrc = await img.getAttribute('src');

      // Try data-src if src is missing or is a placeholder
      if (!imgSrc || imgSrc.includes('data:image') || imgSrc.includes('placeholder')) {
        imgSrc = await img.getAttribute('data-src');
      }

      if (imgSrc && !imgSrc.includes('data:image') && !imgSrc.includes('placeholder')) {
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

        // Filter: Only THIS property's images
        if (imgUrl.includes(propertyImagePattern)) {
          const width = await img.evaluate(el => el.naturalWidth || el.width);
          const height = await img.evaluate(el => el.naturalHeight || el.height);

          console.log(`   [${imageUrls.length + 1}] ${width}x${height} - ${imgUrl.substring(0, 80)}`);

          // Only include larger images (property photos, not tiny thumbnails)
          if (width >= 400 && height >= 400 && !imageUrls.includes(imgUrl)) {
            imageUrls.push(imgUrl);
            console.log(`       ✓ Added to collection`);
          }
        }
      }
    }

    console.log(`\n📊 RESULTS:`);
    console.log(`   Total img tags: ${allImgs}`);
    console.log(`   Property images collected: ${imageUrls.length}`);

    if (imageUrls.length > 0) {
      console.log(`\n📋 Image URLs:\n`);
      imageUrls.forEach((url, idx) => {
        console.log(`   ${idx + 1}. ${url}`);
      });
    } else {
      console.log(`\n⚠️  No property images found!`);
      console.log(`   This could mean:`);
      console.log(`   - Page requires JavaScript to load images`);
      console.log(`   - Images are in an iframe`);
      console.log(`   - Listing has been removed`);
      console.log(`   - Need to scroll to trigger lazy loading`);
    }

  } catch (error) {
    console.log(`\n❌ Error: ${error.message}`);
  }

  console.log('\n✅ Test complete - check debug-viva-listing.png to see the page\n');
  console.log('Press Ctrl+C to close browser...');

  // Keep browser open for manual inspection
  await page.waitForTimeout(60000);
  await browser.close();
})();
