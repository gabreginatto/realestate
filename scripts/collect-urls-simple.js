const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

/**
 * Simple URL collector using Playwright directly (no test framework)
 */

(async () => {
  console.log('\n🚀 Starting URL collection...\n');

  const browser = await chromium.launch();
  const page = await browser.newPage();

  const baseSearchUrl = 'https://www.coelhodafonseca.com.br/search?transaction=Residencial&indicators=Comprar&work_phase=Prontos%20para%20morar&is_release_or_slam=false&region=Alphaville%20%2F%20Tambor%C3%A9&kind_of=Casa%20em%20Condom%C3%ADnio&enterprises=Alphaville%201';
  const totalPages = 3;
  const allListings = [];

  for (let currentPage = 1; currentPage <= totalPages; currentPage++) {
    console.log(`\nPAGE ${currentPage} of ${totalPages}`);
    const pageUrl = currentPage === 1 ? baseSearchUrl : `${baseSearchUrl}&page=${currentPage}`;

    console.log(`Navigating...`);
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);

    console.log(`Waiting for cards...`);
    await page.waitForSelector('section.property_display_main__3gOwW', { timeout: 30000 });
    await page.waitForTimeout(1500);

    const propertyCards = page.locator('section.property_display_main__3gOwW');
    const cardCount = await propertyCards.count();
    console.log(`Found ${cardCount} cards`);

    for (let i = 0; i < cardCount; i++) {
      try {
        const card = propertyCards.nth(i);
        const linkElement = card.locator('a[href^="/"]').first();
        const href = await linkElement.getAttribute('href');

        if (!href) continue;

        const fullUrl = `https://www.coelhodafonseca.com.br${href}`;
        if (allListings.some(l => l.url === fullUrl)) continue;

        const location = await card.locator('.property_display_headerName__1UlVa').textContent({ timeout: 2000 }).catch(() => '');
        const price = await card.locator('.property_display_priceValue__1isrv').textContent({ timeout: 2000 }).catch(() => '');
        const propertyType = await card.locator('.property_display_headerKindOf__3uaI7').textContent({ timeout: 2000 }).catch(() => '');
        const features = await card.locator('.property_display_contentFeatures__1AP_O').textContent({ timeout: 2000 }).catch(() => '');
        const description = await card.locator('.property_display_contentDescription__3FMMt').textContent({ timeout: 2000 }).catch(() => '');

        allListings.push({
          url: fullUrl,
          propertyCode: href.replace('/', ''),
          price: price.trim(),
          location: location.trim(),
          propertyType: propertyType.trim(),
          features: features.trim(),
          description: description.trim(),
          page: currentPage
        });

        console.log(`  [${allListings.length}] ${href.replace('/', '')} - ${location.trim()}`);
      } catch (error) {
        console.error(`  Error on card ${i}:`, error.message);
      }
    }

    console.log(`Page ${currentPage} complete`);
  }

  console.log(`\nClosing browser...`);
  await browser.close();

  console.log(`\n✅ URL COLLECTION COMPLETE`);
  console.log(`Total: ${allListings.length} listings`);
  console.log(`Expected: 82`);

  // Save
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

  console.log(`\n💾 Saved to: ${outputFile}`);

  const urlsFile = path.join(outputDir, 'listing-urls.txt');
  fs.writeFileSync(urlsFile, allListings.map(l => l.url).join('\n'));
  console.log(`📋 URLs saved to: ${urlsFile}\n`);

  process.exit(0);
})();
