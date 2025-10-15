import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';

/**
 * Coelho da Fonseca - Detail Extraction Script
 *
 * This script:
 * 1. Reads URLs from collected-urls.json
 * 2. Visits each listing detail page
 * 3. Extracts complete property data
 * 4. Downloads the first 2 images for each property
 */

// Helper function to download image
async function downloadImage(url: string, filepath: string): Promise<void> {
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

test('Extract details from all collected listings', async ({ page }) => {
  test.setTimeout(1200000); // 20 minutes for processing all listings

  // Read collected URLs
  const inputFile = path.join(process.cwd(), 'data', 'coelhodafonseca', 'listings', 'collected-urls.json');

  if (!fs.existsSync(inputFile)) {
    throw new Error(`Input file not found: ${inputFile}\nPlease run collect-urls-coelhodafonseca.spec.ts first.`);
  }

  const inputData = JSON.parse(fs.readFileSync(inputFile, 'utf-8'));
  const allListings = inputData.listings;

  console.log(`\n🚀 Starting detail extraction for ${allListings.length} listings\n`);

  // Create images directory
  const imagesDir = path.join(process.cwd(), 'data', 'coelhodafonseca', 'images');
  if (!fs.existsSync(imagesDir)) {
    fs.mkdirSync(imagesDir, { recursive: true });
  }

  // Visit each listing detail page
  for (let i = 0; i < allListings.length; i++) {
    const listing = allListings[i];

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`[${i + 1}/${allListings.length}] ${listing.propertyCode} (Page ${listing.page})`);
    console.log(`  🌐 ${listing.url}`);

    try {
      // Navigate to detail page
      await page.goto(listing.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(1500);

      // Extract title
      let title = '';
      try {
        const titleElement = page.locator('h1, h2').first();
        title = await titleElement.textContent({ timeout: 10000 }) || '';
        console.log(`  📝 Title: ${title.substring(0, 50)}...`);
      } catch (e) {
        console.log('  ⚠️  No title found');
      }

      // Extract full description
      let fullDescription = '';
      try {
        const descElement = page.locator('[class*="description"], [class*="sobre"], p').first();
        fullDescription = await descElement.textContent({ timeout: 5000 }) || '';
        console.log(`  📄 Description: ${fullDescription.length} chars`);
      } catch (e) {
        console.log('  ⚠️  No description found');
      }

      // Extract amenities
      const amenities: string[] = [];
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
      } catch (e) {
        console.log('  ⚠️  No amenities found');
      }

      // Extract and download images
      let image1Path = '';
      let image2Path = '';

      try {
        const images = page.locator('img[src*="coelhodafonseca"], img[alt*="Casa"], img[src*="imoveis"]');
        const imageCount = await images.count();

        console.log(`  📸 Images: ${imageCount} found`);

        // Download first image
        if (imageCount > 0) {
          const img1 = images.nth(0);
          const img1Src = await img1.getAttribute('src');
          if (img1Src) {
            const img1Url = img1Src.startsWith('http') ? img1Src : `https://www.coelhodafonseca.com.br${img1Src}`;
            const img1Filename = `${listing.propertyCode}_1.jpg`;
            image1Path = path.join(imagesDir, img1Filename);

            await downloadImage(img1Url, image1Path);
            console.log(`  ⬇️  Downloaded image 1`);
          }
        }

        // Download second image
        if (imageCount > 1) {
          const img2 = images.nth(1);
          const img2Src = await img2.getAttribute('src');
          if (img2Src) {
            const img2Url = img2Src.startsWith('http') ? img2Src : `https://www.coelhodafonseca.com.br${img2Src}`;
            const img2Filename = `${listing.propertyCode}_2.jpg`;
            image2Path = path.join(imagesDir, img2Filename);

            await downloadImage(img2Url, image2Path);
            console.log(`  ⬇️  Downloaded image 2`);
          }
        }
      } catch (e) {
        console.log(`  ❌ Image error: ${e}`);
      }

      // Add detailed data to listing
      listing.detailedData = {
        title: title.trim(),
        fullDescription: fullDescription.trim(),
        amenities,
        image1Path,
        image2Path
      };

      console.log(`  ✅ Complete`);

    } catch (error) {
      console.log(`  ❌ Error: ${error}`);
    }

    // Small delay between requests
    await page.waitForTimeout(300);

    // Progress indicator
    if ((i + 1) % 10 === 0) {
      console.log(`\n🔄 Progress: ${i + 1}/${allListings.length} (${Math.round((i + 1) / allListings.length * 100)}%)\n`);
    }
  }

  // Save complete data
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🎉 EXTRACTION COMPLETE`);
  console.log(`${'='.repeat(60)}`);
  console.log(`📊 Total listings processed: ${allListings.length}`);

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

  console.log(`\n💾 Complete data saved to: ${outputFile}`);

  // Count images
  const imageFiles = fs.readdirSync(imagesDir).filter(f => f.endsWith('.jpg'));
  console.log(`📸 Total images downloaded: ${imageFiles.length}`);

  expect(allListings.length).toBeGreaterThan(0);
  console.log(`\n✅ All done!\n`);
});
