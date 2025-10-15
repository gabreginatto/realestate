const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

/**
 * Simple detail extractor using Playwright directly
 */

// Helper to download images
function downloadImage(url, filepath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(filepath);

    protocol.get(url, (response) => {
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      fs.unlink(filepath, () => {});
      reject(err);
    });
  });
}

(async () => {
  console.log('\n🚀 Starting detail extraction...\n');

  // Read collected URLs
  const inputFile = path.join(process.cwd(), 'data', 'coelhodafonseca', 'listings', 'collected-urls.json');
  if (!fs.existsSync(inputFile)) {
    console.error(`❌ File not found: ${inputFile}`);
    process.exit(1);
  }

  const inputData = JSON.parse(fs.readFileSync(inputFile, 'utf-8'));
  const allListings = inputData.listings;
  console.log(`📋 Processing ${allListings.length} listings\n`);

  // Create images directory
  const imagesDir = path.join(process.cwd(), 'data', 'coelhodafonseca', 'images');
  if (!fs.existsSync(imagesDir)) {
    fs.mkdirSync(imagesDir, { recursive: true });
  }

  const browser = await chromium.launch();
  const page = await browser.newPage();

  // Process each listing
  for (let i = 0; i < allListings.length; i++) {
    const listing = allListings[i];
    console.log(`[${i + 1}/${allListings.length}] ${listing.propertyCode} (Page ${listing.page})`);
    console.log(`  ${listing.url}`);

    try {
      await page.goto(listing.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(1500);

      // Title
      let title = '';
      try {
        title = await page.locator('h1, h2').first().textContent({ timeout: 10000 }) || '';
        console.log(`  Title: ${title.substring(0, 40)}...`);
      } catch (e) {
        console.log('  No title');
      }

      // Description
      let fullDescription = '';
      try {
        fullDescription = await page.locator('[class*="description"], [class*="sobre"], p').first().textContent({ timeout: 5000 }) || '';
        console.log(`  Description: ${fullDescription.length} chars`);
      } catch (e) {
        console.log('  No description');
      }

      // Amenities
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
        console.log(`  Amenities: ${amenities.length}`);
      } catch (e) {
        console.log('  No amenities');
      }

      // Images
      let image1Path = '';
      let image2Path = '';

      try {
        const images = page.locator('img[src*="coelhodafonseca"], img[alt*="Casa"], img[src*="imoveis"]');
        const imageCount = await images.count();
        console.log(`  Images: ${imageCount} found`);

        if (imageCount > 0) {
          const img1Src = await images.nth(0).getAttribute('src');
          if (img1Src) {
            const img1Url = img1Src.startsWith('http') ? img1Src : `https://www.coelhodafonseca.com.br${img1Src}`;
            image1Path = path.join(imagesDir, `${listing.propertyCode}_1.jpg`);
            await downloadImage(img1Url, image1Path);
            console.log(`  Downloaded image 1`);
          }
        }

        if (imageCount > 1) {
          const img2Src = await images.nth(1).getAttribute('src');
          if (img2Src) {
            const img2Url = img2Src.startsWith('http') ? img2Src : `https://www.coelhodafonseca.com.br${img2Src}`;
            image2Path = path.join(imagesDir, `${listing.propertyCode}_2.jpg`);
            await downloadImage(img2Url, image2Path);
            console.log(`  Downloaded image 2`);
          }
        }
      } catch (e) {
        console.log(`  Image error: ${e.message}`);
      }

      // Add detailed data
      listing.detailedData = {
        title: title.trim(),
        fullDescription: fullDescription.trim(),
        amenities,
        image1Path,
        image2Path
      };

      console.log(`  ✅ Complete\n`);

    } catch (error) {
      console.log(`  ❌ Error: ${error.message}\n`);
    }

    await page.waitForTimeout(300);

    // Progress
    if ((i + 1) % 10 === 0) {
      console.log(`🔄 Progress: ${i + 1}/${allListings.length} (${Math.round((i + 1) / allListings.length * 100)}%)\n`);
    }
  }

  console.log('\nClosing browser...');
  await browser.close();

  console.log('\n✅ EXTRACTION COMPLETE');
  console.log(`Total processed: ${allListings.length}`);

  // Save
  const outputDir = path.join(process.cwd(), 'data', 'coelhodafonseca', 'listings');
  const outputFile = path.join(outputDir, 'all-listings.json');

  fs.writeFileSync(
    outputFile,
    JSON.stringify(
      {
        scraped_at: new Date().toISOString(),
        total_listings: allListings.length,
        total_pages: inputData.total_pages,
        search_criteria: inputData.search_criteria,
        listings: allListings
      },
      null,
      2
    )
  );

  console.log(`\n💾 Saved to: ${outputFile}`);

  // Count images
  const imageFiles = fs.readdirSync(imagesDir).filter(f => f.endsWith('.jpg'));
  console.log(`📸 Total images: ${imageFiles.length}\n`);

  process.exit(0);
})();
