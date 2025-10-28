import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';

/**
 * Coelho da Fonseca - Complete Listings Scraper
 *
 * This test:
 * 1. Navigates through all 3 pages of Casa em Condomínio listings in Alphaville 1
 * 2. Collects all 82 listing URLs
 * 3. Visits each individual listing detail page
 * 4. Extracts complete property data
 * 5. Downloads the first 2 images for each property
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

test('Navigate through all 3 pages and collect complete listing data', async ({ page }) => {
  // Increase test timeout to 20 minutes to handle all 82 listings
  test.setTimeout(1200000);
  const allListings: Array<{
    url: string;
    propertyCode: string;
    price: string;
    location: string;
    propertyType: string;
    features: string;
    description: string;
    page: number;
    detailedData?: {
      title: string;
      fullDescription: string;
      amenities: string[];
      image1Path: string;
      image2Path: string;
    };
  }> = [];

  // Base URL - search results for Casa em Condomínio in Alphaville 1
  const baseSearchUrl = 'https://www.coelhodafonseca.com.br/search?transaction=Residencial&indicators=Comprar&work_phase=Prontos%20para%20morar&is_release_or_slam=false&region=Alphaville%20%2F%20Tambor%C3%A9&kind_of=Casa%20em%20Condom%C3%ADnio&enterprises=Alphaville%201';

  const totalPages = 3; // User confirmed 3 pages with 82 total listings
  console.log(`\n🚀 Starting scraper for ${totalPages} pages (82 total listings expected)\n`);

  // Loop through all 3 pages
  for (let currentPage = 1; currentPage <= totalPages; currentPage++) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📄 PAGE ${currentPage} of ${totalPages}`);
    console.log(`${'='.repeat(60)}`);

    // Navigate directly to the page with page parameter
    const pageUrl = currentPage === 1 ? baseSearchUrl : `${baseSearchUrl}&page=${currentPage}`;

    console.log(`🌐 Navigating to: ${pageUrl}`);
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);

    // Wait for property cards to load
    console.log(`⏳ Waiting for property cards to load...`);
    await page.waitForSelector('section.property_display_main__3gOwW', { timeout: 30000 });
    await page.waitForTimeout(1500);

    console.log(`✅ Page loaded: ${page.url()}`);

    // Get all property cards on current page
    const propertyCards = page.locator('section.property_display_main__3gOwW');
    const cardCount = await propertyCards.count();

    console.log(`📦 Found ${cardCount} property cards on page ${currentPage}`);

    // Collect data from each card
    for (let i = 0; i < cardCount; i++) {
      try {
        const card = propertyCards.nth(i);

        // Get property link (numeric ID like /663777)
        const linkElement = card.locator('a[href^="/"]').first();
        const href = await linkElement.getAttribute('href');

        if (!href) {
          console.log(`  ⚠️  Skipping card ${i} - no href found`);
          continue;
        }

        const fullUrl = `https://www.coelhodafonseca.com.br${href}`;
        const propertyCode = href.replace('/', '');

        // Check if we already have this URL (avoid duplicates)
        if (allListings.some(l => l.url === fullUrl)) {
          continue;
        }

        // Extract data from card
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

        console.log(`  ✓ [${allListings.length}] ${propertyCode} - ${location.trim()} - ${price.trim()}`);
      } catch (error) {
        console.error(`  ❌ Error collecting data from card ${i}:`, error);
      }
    }

    console.log(`✅ Page ${currentPage} complete: Collected ${cardCount} listings`);
  }

  // Log summary
  console.log(`\n${'='.repeat(60)}`);
  console.log(`✅ URL COLLECTION COMPLETE`);
  console.log(`${'='.repeat(60)}`);
  console.log(`📊 Total listings collected: ${allListings.length} from ${totalPages} pages`);
  console.log(`📋 Expected: 82 listings`);
  console.log(`${allListings.length === 82 ? '✅' : '⚠️ '} Match: ${allListings.length === 82 ? 'YES' : 'NO'}`);
  console.log(`\n🔍 Now visiting each listing detail page to extract complete data...\n`);

  // Create images directory
  const imagesDir = path.join(process.cwd(), 'data', 'coelhodafonseca', 'images');
  if (!fs.existsSync(imagesDir)) {
    fs.mkdirSync(imagesDir, { recursive: true });
  }

  // Visit each listing detail page
  for (let i = 0; i < allListings.length; i++) {
    const listing = allListings[i];

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`[${i + 1}/${allListings.length}] Processing: ${listing.propertyCode} (Page ${listing.page})`);
    console.log(`  🌐 URL: ${listing.url}`);

    try {
      // Navigate to detail page
      console.log(`  ⏳ Loading detail page...`);
      await page.goto(listing.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(1500);

      // Extract title
      let title = '';
      try {
        const titleElement = page.locator('h1, h2').first();
        title = await titleElement.textContent({ timeout: 10000 }) || '';
        console.log(`  📝 Title: ${title.substring(0, 60)}...`);
      } catch (e) {
        console.log('  ⚠️  Could not extract title');
      }

      // Extract full description from detail page
      let fullDescription = '';
      try {
        const descElement = page.locator('[class*="description"], [class*="sobre"], p').first();
        fullDescription = await descElement.textContent({ timeout: 5000 }) || '';
        console.log(`  📄 Description length: ${fullDescription.length} chars`);
      } catch (e) {
        console.log('  ⚠️  Could not extract full description');
      }

      // Extract amenities/features
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
        console.log(`  🏠 Found ${amenities.length} amenities`);
      } catch (e) {
        console.log('  ⚠️  Could not extract amenities');
      }

      // Extract first 2 images
      let image1Path = '';
      let image2Path = '';

      try {
        // Find all images (look for property images in common locations)
        const images = page.locator('img[src*="coelhodafonseca"], img[alt*="Casa"], img[src*="imoveis"]');
        const imageCount = await images.count();

        console.log(`  📸 Found ${imageCount} images`);

        // Download first image
        if (imageCount > 0) {
          const img1 = images.nth(0);
          const img1Src = await img1.getAttribute('src');
          if (img1Src) {
            const img1Url = img1Src.startsWith('http') ? img1Src : `https://www.coelhodafonseca.com.br${img1Src}`;
            const img1Filename = `${listing.propertyCode}_1.jpg`;
            image1Path = path.join(imagesDir, img1Filename);

            console.log(`  ⬇️  Downloading image 1...`);
            await downloadImage(img1Url, image1Path);
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

            console.log(`  ⬇️  Downloading image 2...`);
            await downloadImage(img2Url, image2Path);
          }
        }

        console.log(`  ✅ Data extracted and images saved`);
      } catch (e) {
        console.log(`  ❌ Error downloading images: ${e}`);
      }

      // Add detailed data to listing
      listing.detailedData = {
        title: title.trim(),
        fullDescription: fullDescription.trim(),
        amenities,
        image1Path,
        image2Path
      };

    } catch (error) {
      console.log(`  ❌ Error processing detail page: ${error}`);
    }

    // Small delay to avoid overwhelming the server
    await page.waitForTimeout(300);

    // Progress indicator every 10 listings
    if ((i + 1) % 10 === 0) {
      console.log(`\n🔄 Progress: ${i + 1}/${allListings.length} listings processed (${Math.round((i + 1) / allListings.length * 100)}%)\n`);
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`🎉 SCRAPING COMPLETE`);
  console.log(`${'='.repeat(60)}`);
  console.log(`📊 Total listings processed: ${allListings.length}`);

  // Save to JSON file
  const outputDir = path.join(process.cwd(), 'data', 'coelhodafonseca', 'listings');
  const outputFile = path.join(outputDir, 'all-listings.json');

  // Ensure directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Write JSON file
  fs.writeFileSync(
    outputFile,
    JSON.stringify(
      {
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
      },
      null,
      2
    )
  );

  console.log(`\n💾 Data saved to: ${outputFile}`);

  // Also save just the URLs for quick reference
  const urlsFile = path.join(outputDir, 'listing-urls.txt');
  fs.writeFileSync(
    urlsFile,
    allListings.map(l => l.url).join('\n')
  );

  console.log(`📋 URLs saved to: ${urlsFile}`);

  // Verify we got data
  expect(allListings.length).toBeGreaterThan(0);
  console.log(`\n✅ Expected 82 listings, collected ${allListings.length}`);
});
