import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Coelho da Fonseca - Detail Extraction Script
 *
 * This script:
 * 1. Reads URLs from collected-urls.json
 * 2. Visits each listing detail page
 * 3. Extracts complete property data (including ALL image URLs)
 * 4. Stores image URLs in listing.images array (mosaic module will handle downloading)
 */

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

      // Extract all image URLs (don't download - mosaic module will handle that)
      const imageUrls: string[] = [];

      try {
        // Use specific gallery selectors to avoid picking up thumbnails/related listings
        const images = page.locator('.slider-photos-detail img, .swiper-slide img, [class*="gallery"] img');
        const imageCount = await images.count();

        console.log(`  📸 Found ${imageCount} images in gallery`);

        // Collect all gallery image URLs
        for (let imgIdx = 0; imgIdx < imageCount; imgIdx++) {
          const img = images.nth(imgIdx);
          let imgSrc = await img.getAttribute('src');

          // Handle data-src lazy loading
          if (!imgSrc || imgSrc.includes('data:image')) {
            imgSrc = await img.getAttribute('data-src');
          }

          if (imgSrc && !imgSrc.includes('data:image') && !imgSrc.includes('loader')) {
            // Convert to absolute URL
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

            // Filter: Only include images from static.coelhodafonseca.com.br (property photos)
            // and ensure they're large enough (not thumbnails)
            if (imgUrl.includes('static.coelhodafonseca.com.br')) {
              // Get image dimensions to filter out thumbnails/icons
              const width = await img.evaluate((el: any) => el.naturalWidth || el.width);
              const height = await img.evaluate((el: any) => el.naturalHeight || el.height);

              // Only include larger images (property photos, not tiny icons)
              if (width >= 300 && height >= 300 && !imageUrls.includes(imgUrl)) {
                imageUrls.push(imgUrl);
              }
            }
          }
        }

        console.log(`  ✅ Collected ${imageUrls.length} property image URLs`);
      } catch (e) {
        console.log(`  ❌ Image error: ${e}`);
      }

      // Add detailed data to listing
      listing.images = imageUrls; // Store image URLs in listing root
      listing.detailedData = {
        title: title.trim(),
        fullDescription: fullDescription.trim(),
        amenities
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

  // Count image URLs collected
  const withImages = allListings.filter((l: any) => l.images && l.images.length > 0).length;
  const totalImageUrls = allListings.reduce((sum: number, l: any) => sum + (l.images?.length || 0), 0);
  const avgImages = withImages > 0 ? (totalImageUrls / withImages).toFixed(1) : '0';

  console.log(`📸 Listings with images: ${withImages}/${allListings.length}`);
  console.log(`📸 Total image URLs collected: ${totalImageUrls} (avg ${avgImages} per listing)`);

  expect(allListings.length).toBeGreaterThan(0);
  console.log(`\n✅ All done!\n`);
});
