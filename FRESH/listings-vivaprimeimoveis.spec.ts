import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';

/**
 * Viva Prime Imóveis - Complete Listings Scraper
 *
 * This test:
 * 1. Navigates through all pages of Casa listings in Alphaville 01
 * 2. Collects all listing URLs
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

test('Navigate through all pages and collect complete listing data', async ({ page }) => {
  const allListings: Array<{
    url: string;
    propertyCode: string;
    price: string;
    location: string;
    propertyType: string;
    sqft: string;
    bedrooms: string;
    bathrooms: string;
    parking: string;
    page: number;
    detailedData?: {
      title: string;
      description: string;
      features: string[];
      image1Path: string;
      image2Path: string;
    };
  }> = [];

  // Navigate to the listings page (Casa in Alphaville 01)
  await page.goto('https://www.vivaprimeimoveis.com.br/imoveis?busca=venda&finalidade=venda&tipo=casa&cidade=&empreendimento=alphaville-01', { waitUntil: 'domcontentloaded' });

  // Handle cookie banner if present
  const cookieButton = page.getByRole('button', { name: 'Aceitar Cookies' });
  if (await cookieButton.isVisible({ timeout: 3000 }).catch(() => false)) {
    await cookieButton.click();
    await page.waitForTimeout(500);
  }

  // Wait specifically for listings to appear (href can be relative or absolute)
  await page.waitForSelector('a[href*="imovel/"]', { timeout: 15000 });
  await page.waitForTimeout(1000);

  // Get total number of pages from pagination
  const pageLinks = page.locator('a[href*="pg="]');
  const pageCount = await pageLinks.count();

  // If there are pagination links, get the highest page number
  let totalPages = 1;
  if (pageCount > 0) {
    const lastPageLink = pageLinks.nth(pageCount - 2); // -2 because last is the "next" arrow
    const lastPageText = await lastPageLink.textContent();
    totalPages = parseInt(lastPageText?.trim() || '1', 10);
  }

  console.log(`Found ${totalPages} pages to scrape`);

  // Loop through all pages
  for (let currentPage = 1; currentPage <= totalPages; currentPage++) {
    console.log(`\nCollecting URLs from page ${currentPage} of ${totalPages}...`);

    // Get all listing cards on current page
    const listingCards = page.locator('a[href*="imovel/"]');
    const cardCount = await listingCards.count();

    console.log(`Found ${cardCount} links on page ${currentPage}`);

    // Collect unique URLs only (skip duplicates from carousels)
    const seenUrls = new Set<string>();

    for (let i = 0; i < cardCount; i++) {
      try {
        const card = listingCards.nth(i);
        const url = await card.getAttribute('href') || '';

        // Quick check: skip if URL doesn't look like a property listing
        if (!url.includes('imovel/')) {
          continue;
        }

        // Build full URL
        const fullUrl = url.startsWith('http') ? url : `https://www.vivaprimeimoveis.com.br/${url}`;

        // Skip if we've already seen this URL
        if (seenUrls.has(fullUrl)) {
          continue;
        }

        seenUrls.add(fullUrl);

        // Add to collection (we'll extract all data from detail page later)
        allListings.push({
          url: fullUrl,
          propertyCode: '',
          price: '',
          location: '',
          propertyType: '',
          sqft: '',
          bedrooms: '',
          bathrooms: '',
          parking: '',
          page: currentPage
        });

        console.log(`  [${allListings.length}] ${fullUrl}`);
      } catch (error) {
        console.error(`Error collecting URL from card ${i}:`, error);
      }
    }

    // Navigate to next page if not on last page
    if (currentPage < totalPages) {
      console.log(`Navigating to page ${currentPage + 1}...`);

      // Click the next page link
      const nextPageLink = page.locator(`a[href*="pg=${currentPage + 1}"]`).first();
      await nextPageLink.click();

      // Wait for navigation and new listings to load
      await page.waitForLoadState('domcontentloaded');
      await page.waitForSelector('a[href*="imovel/"]', { timeout: 10000 });
      await page.waitForTimeout(1000); // Additional wait for content to settle
    }
  }

  // Log summary
  console.log(`\n✅ Successfully collected ${allListings.length} listing URLs from ${totalPages} pages`);
  console.log(`\n🔍 Now visiting each listing detail page to extract complete data...\n`);

  // Create images directory
  const imagesDir = path.join(process.cwd(), 'data', 'vivaprimeimoveis', 'images');
  if (!fs.existsSync(imagesDir)) {
    fs.mkdirSync(imagesDir, { recursive: true });
  }

  // Visit each listing detail page
  for (let i = 0; i < allListings.length; i++) {
    const listing = allListings[i];

    // Extract property code from URL (last segment)
    const urlParts = listing.url.split('/');
    const propertyCode = urlParts[urlParts.length - 1];
    listing.propertyCode = propertyCode;

    console.log(`\n[${i + 1}/${allListings.length}] Processing: ${propertyCode}`);
    console.log(`  URL: ${listing.url}`);

    try {
      // Navigate to detail page
      await page.goto(listing.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // Wait for content to load
      await page.waitForTimeout(1500);

      // Extract title (usually in H1 or H2)
      let title = '';
      try {
        const titleElement = page.locator('h1, h2').first();
        title = await titleElement.textContent({ timeout: 5000 }) || '';
        console.log(`  📝 Title: ${title.substring(0, 50)}...`);
      } catch (e) {
        console.log('  ⚠️  Could not extract title');
      }

      // Extract price from detail page
      try {
        const priceElement = page.locator('text=/R\\$\\s*[\\d.,]+/').first();
        listing.price = await priceElement.textContent({ timeout: 3000 }) || '';
        console.log(`  💰 Price: ${listing.price}`);
      } catch (e) {
        console.log('  ⚠️  Could not extract price');
      }

      // Extract property type
      try {
        const typeElement = page.locator('text=/^(Casa|Terreno|Apartamento|Cobertura|Loja)$/').first();
        listing.propertyType = await typeElement.textContent({ timeout: 3000 }) || '';
      } catch (e) {
        console.log('  ⚠️  Could not extract property type');
      }

      // Extract description
      let description = '';
      try {
        // Look for description text - common patterns in real estate sites
        const descElement = page.locator('text=/descrição|sobre|detalhes/i').locator('..').first();
        description = await descElement.textContent({ timeout: 5000 }) || '';
        console.log(`  📄 Description length: ${description.length} chars`);
      } catch (e) {
        console.log('  ⚠️  Could not extract description');
      }

      // Extract features/amenities
      const features: string[] = [];
      try {
        // Look for feature lists
        const featureElements = page.locator('li, .feature, .amenity');
        const count = await featureElements.count();
        for (let j = 0; j < Math.min(count, 20); j++) {
          const feature = await featureElements.nth(j).textContent();
          if (feature && feature.trim().length > 0) {
            features.push(feature.trim());
          }
        }
      } catch (e) {
        console.log('  ⚠️  Could not extract features');
      }

      // Extract first 2 images
      let image1Path = '';
      let image2Path = '';

      try {
        // Find all images in the gallery/carousel
        const images = page.locator('img[src*="vivaprimeimoveis"], img[alt*="Casa"], img[alt*="Imóvel"]');
        const imageCount = await images.count();

        console.log(`  📸 Found ${imageCount} images`);

        // Download first image
        if (imageCount > 0) {
          const img1 = images.nth(0);
          const img1Src = await img1.getAttribute('src');
          if (img1Src) {
            const img1Url = img1Src.startsWith('http') ? img1Src : `https://www.vivaprimeimoveis.com.br${img1Src}`;
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
            const img2Url = img2Src.startsWith('http') ? img2Src : `https://www.vivaprimeimoveis.com.br${img2Src}`;
            const img2Filename = `${listing.propertyCode}_2.jpg`;
            image2Path = path.join(imagesDir, img2Filename);

            console.log(`  ⬇️  Downloading image 2...`);
            await downloadImage(img2Url, image2Path);
          }
        }

        console.log(`  ✅ Extracted data and saved images`);
      } catch (e) {
        console.log(`  ❌ Error downloading images: ${e}`);
      }

      // Add detailed data to listing
      listing.detailedData = {
        title: title.trim(),
        description: description.trim(),
        features,
        image1Path,
        image2Path
      };

    } catch (error) {
      console.log(`  ❌ Error processing detail page: ${error}`);
    }

    // Small delay to avoid overwhelming the server
    await page.waitForTimeout(500);
  }

  console.log(`\n🎉 Finished processing all ${allListings.length} listings!`);

  // Save to JSON file
  const outputDir = path.join(process.cwd(), 'data', 'vivaprimeimoveis', 'listings');
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
          tipo: 'casa',
          empreendimento: 'alphaville-01',
          finalidade: 'venda'
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
});
