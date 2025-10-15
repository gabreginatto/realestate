import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Coelho da Fonseca - URL Collection Script
 *
 * This script:
 * 1. Navigates through all 3 pages of Casa em Condomínio listings in Alphaville 1
 * 2. Collects all listing URLs and basic data
 * 3. Saves to JSON file for later processing
 */

test('Collect all listing URLs from 3 pages', async ({ page }) => {
  test.setTimeout(300000); // 5 minutes should be enough for URL collection

  const allListings: Array<{
    url: string;
    propertyCode: string;
    price: string;
    location: string;
    propertyType: string;
    features: string;
    description: string;
    page: number;
  }> = [];

  const baseSearchUrl = 'https://www.coelhodafonseca.com.br/search?transaction=Residencial&indicators=Comprar&work_phase=Prontos%20para%20morar&is_release_or_slam=false&region=Alphaville%20%2F%20Tambor%C3%A9&kind_of=Casa%20em%20Condom%C3%ADnio&enterprises=Alphaville%201';
  const totalPages = 3;

  console.log(`\n🚀 Starting URL collection for ${totalPages} pages\n`);

  // Loop through all 3 pages
  for (let currentPage = 1; currentPage <= totalPages; currentPage++) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📄 PAGE ${currentPage} of ${totalPages}`);
    console.log(`${'='.repeat(60)}`);

    const pageUrl = currentPage === 1 ? baseSearchUrl : `${baseSearchUrl}&page=${currentPage}`;

    console.log(`🌐 Navigating to page ${currentPage}...`);
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);

    console.log(`⏳ Waiting for property cards...`);
    await page.waitForSelector('section.property_display_main__3gOwW', { timeout: 30000 });
    await page.waitForTimeout(1500);

    const propertyCards = page.locator('section.property_display_main__3gOwW');
    const cardCount = await propertyCards.count();

    console.log(`📦 Found ${cardCount} property cards`);

    // Collect data from each card
    for (let i = 0; i < cardCount; i++) {
      try {
        const card = propertyCards.nth(i);

        const linkElement = card.locator('a[href^="/"]').first();
        const href = await linkElement.getAttribute('href');

        if (!href) {
          console.log(`  ⚠️  Skipping card ${i} - no href`);
          continue;
        }

        const fullUrl = `https://www.coelhodafonseca.com.br${href}`;
        const propertyCode = href.replace('/', '');

        // Check for duplicates
        if (allListings.some(l => l.url === fullUrl)) {
          console.log(`  ⚠️  Skipping duplicate: ${propertyCode}`);
          continue;
        }

        // Extract basic data
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

        console.log(`  ✓ [${allListings.length}] ${propertyCode} - ${location.trim()}`);
      } catch (error) {
        console.error(`  ❌ Error on card ${i}:`, error);
      }
    }

    console.log(`✅ Page ${currentPage} complete: Collected ${cardCount} listings`);
  }

  // Close the browser page before proceeding
  await page.close();

  // Summary
  console.log(`\n${'='.repeat(60)}`);
  console.log(`✅ URL COLLECTION COMPLETE`);
  console.log(`${'='.repeat(60)}`);
  console.log(`📊 Total listings collected: ${allListings.length}`);
  console.log(`📋 Expected: 82 listings`);
  console.log(`${allListings.length === 82 ? '✅' : '⚠️ '} Match: ${allListings.length === 82 ? 'YES' : 'NO'}`);

  // Save to JSON
  const outputDir = path.join(process.cwd(), 'data', 'coelhodafonseca', 'listings');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const outputFile = path.join(outputDir, 'collected-urls.json');
  fs.writeFileSync(
    outputFile,
    JSON.stringify(
      {
        collected_at: new Date().toISOString(),
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

  console.log(`\n💾 URLs saved to: ${outputFile}`);

  // Also save simple URL list
  const urlsFile = path.join(outputDir, 'listing-urls.txt');
  fs.writeFileSync(
    urlsFile,
    allListings.map(l => l.url).join('\n')
  );

  console.log(`📋 URL list saved to: ${urlsFile}`);

  expect(allListings.length).toBeGreaterThan(0);
  console.log(`\n✅ Collection complete: ${allListings.length} listings\n`);
});
