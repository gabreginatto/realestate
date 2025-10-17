const { chromium } = require('playwright');

(async () => {
  console.log('\n🔍 Testing Coelho da Fonseca image extraction...\n');

  const testUrl = 'https://www.coelhodafonseca.com.br/661974';
  const propertyCode = '661974';

  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  console.log(`📍 URL: ${testUrl}\n`);

  try {
    await page.goto(testUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log('✅ Page loaded\n');

    await page.waitForTimeout(3000); // Wait for any lazy loading

    // Strategy: Find images in the main gallery
    console.log('🔎 Strategy: Looking for main gallery images\n');

    // Coelho uses a swiper carousel
    const galleryImages = page.locator('.slider-photos-detail img, .swiper-slide img');
    const galleryCount = await galleryImages.count();
    console.log(`  📸 Found ${galleryCount} images in gallery carousel\n`);

    const imageUrls = [];

    for (let i = 0; i < galleryCount; i++) {
      const img = galleryImages.nth(i);
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
            imgUrl = 'https://www.coelhodafonseca.com.br' + imgUrl;
          }
        }

        // Get dimensions
        const width = await img.evaluate(el => el.naturalWidth || el.width);
        const height = await img.evaluate(el => el.naturalHeight || el.height);

        console.log(`  [${i + 1}] ${width}x${height} - ${imgUrl}`);

        // Filter by size (≥300x300)
        if (width >= 300 && height >= 300 && !imageUrls.includes(imgUrl)) {
          imageUrls.push(imgUrl);
          console.log(`       ✓ Added to collection`);
        }
      }
    }

    // Check ALL images on page to see if there are thumbnails or related listings
    console.log('\n🔎 Checking ALL images on page for comparison\n');
    const allImages = await page.locator('img').count();
    console.log(`  Total img tags on page: ${allImages}`);

    // Count images by domain
    const imagesByDomain = {
      'static.coelhodafonseca.com.br': 0,
      'other': 0
    };

    for (let i = 0; i < Math.min(allImages, 50); i++) {
      const img = page.locator('img').nth(i);
      const src = await img.getAttribute('src');
      if (src) {
        if (src.includes('static.coelhodafonseca.com.br')) {
          imagesByDomain['static.coelhodafonseca.com.br']++;
        } else {
          imagesByDomain['other']++;
        }
      }
    }

    console.log(`\n  Images from static.coelhodafonseca.com.br: ${imagesByDomain['static.coelhodafonseca.com.br']}`);
    console.log(`  Images from other domains: ${imagesByDomain['other']}`);

    console.log(`\n📊 RESULTS:`);
    console.log(`   Gallery images found: ${galleryCount}`);
    console.log(`   Property images collected: ${imageUrls.length}`);

    if (imageUrls.length > 0) {
      console.log(`\n📋 Collected URLs:\n`);
      imageUrls.forEach((url, idx) => {
        console.log(`   ${idx + 1}. ${url}`);
      });
    }

  } catch (error) {
    console.log(`\n❌ Error: ${error.message}`);
  }

  console.log('\n✅ Test complete\n');
  console.log('Press Ctrl+C to close browser...');

  await page.waitForTimeout(60000);
  await browser.close();
})();
