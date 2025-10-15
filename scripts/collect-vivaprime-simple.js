const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  console.log('\n🚀 Starting Vivaprime scraper...\n');

  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  // Navigate to search page (Casa in Alphaville 01) - WITHOUT tipo parameter to see all results
  const baseUrl = 'https://www.vivaprimeimoveis.com.br/imoveis?busca=venda&finalidade=venda&tipo=casa&empreendimento=alphaville-01';

  console.log('Navigating to:', baseUrl);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);

  // Handle cookie banner
  try {
    const cookieButton = page.getByRole('button', { name: 'Aceitar Cookies' });
    if (await cookieButton.isVisible({ timeout: 3000 })) {
      await cookieButton.click();
      await page.waitForTimeout(500);
    }
  } catch (e) {
    console.log('No cookie banner found');
  }

  // Wait for listings
  await page.waitForSelector('a[href*="imovel/"]', { timeout: 15000 });
  await page.waitForTimeout(2000);

  // Check total count from page
  let expectedTotal = 0;
  try {
    const totalElement = page.locator('text=/à Venda \\(\\d+\\)/').first();
    const totalText = await totalElement.textContent({ timeout: 5000 });
    const totalMatch = totalText?.match(/\\((\\d+)\\)/);
    expectedTotal = totalMatch ? parseInt(totalMatch[1]) : 0;
  } catch (e) {
    console.log('Could not extract total count from page');
  }
  console.log(`\n📊 Site shows: ${expectedTotal} total listings\n`);

  // Get pagination info - check up to 10 pages to be safe
  const maxPagesToCheck = 10;
  let totalPages = 1;

  // Try to get page count from pagination links
  const pageLinks = page.locator('a[href*="pg="]');
  const pageLinkCount = await pageLinks.count();

  if (pageLinkCount > 0) {
    // Get all page numbers
    const pageNumbers = [];
    for (let i = 0; i < pageLinkCount; i++) {
      const text = await pageLinks.nth(i).textContent();
      const num = parseInt(text?.trim());
      if (!isNaN(num)) {
        pageNumbers.push(num);
      }
    }
    if (pageNumbers.length > 0) {
      totalPages = Math.max(...pageNumbers);
    }
  }

  // If we expect 70 listings and get 12 per page, we need at least 6 pages
  // Override if needed
  const listingsPerPage = 12;
  const expectedPages = Math.ceil(expectedTotal / listingsPerPage);
  if (expectedTotal > 0 && expectedPages > totalPages) {
    console.log(`⚠️  Pagination shows ${totalPages} pages, but ${expectedTotal} listings need ${expectedPages} pages`);
    totalPages = Math.min(expectedPages, maxPagesToCheck);
  }

  console.log(`📄 Will scrape ${totalPages} pages\n`);

  const allListings = [];
  const seenUrls = new Set();

  let pageNum = 1;
  let hasNextPage = true;

  // Scrape all pages - keep going until no more "next" button
  while (hasNextPage) {
    console.log(`\n═══ PAGE ${pageNum} ═══`);

    // Wait for listings to load
    await page.waitForSelector('a[href*="imovel/"]', { timeout: 15000 });
    await page.waitForTimeout(2000);

    // Get all listing links
    const listingLinks = page.locator('a[href*="imovel/"]');
    const linkCount = await listingLinks.count();
    console.log(`Found ${linkCount} links on page`);

    for (let i = 0; i < linkCount; i++) {
      const link = listingLinks.nth(i);
      const href = await link.getAttribute('href');

      if (!href || !href.includes('imovel/')) continue;

      // Fix URL - ensure proper path separator
      let fullUrl;
      if (href.startsWith('http')) {
        fullUrl = href;
      } else if (href.startsWith('/')) {
        fullUrl = `https://www.vivaprimeimoveis.com.br${href}`;
      } else {
        fullUrl = `https://www.vivaprimeimoveis.com.br/${href}`;
      }

      if (seenUrls.has(fullUrl)) continue;
      seenUrls.add(fullUrl);

      // Extract property code from URL
      const parts = fullUrl.split('/');
      const propertyCode = parts[parts.length - 1];

      console.log(`  [${allListings.length + 1}] ${propertyCode} - ${fullUrl}`);

      allListings.push({
        url: fullUrl,
        propertyCode,
        page: pageNum
      });
    }

    console.log(`Progress: ${allListings.length}/${expectedTotal} listings collected`);

    // Check for "next" button (right arrow)
    const nextButton = page.locator('a.btn:has(i.fa-chevron-right)');
    const nextButtonExists = await nextButton.count() > 0;

    if (nextButtonExists) {
      try {
        console.log(`\nClicking next button...`);
        await nextButton.click();
        await page.waitForTimeout(3000);
        pageNum++;
      } catch (e) {
        console.log(`No more pages (next button not clickable)`);
        hasNextPage = false;
      }
    } else {
      console.log(`\nNo more pages (no next button found)`);
      hasNextPage = false;
    }
  }

  await browser.close();

  console.log(`\n\n✅ Collected ${allListings.length} unique listings`);
  console.log(`Expected: ${expectedTotal}`);
  console.log(`Difference: ${expectedTotal - allListings.length} missing\n`);

  // Save results
  const outputDir = path.join(process.cwd(), 'data', 'vivaprimeimoveis', 'listings');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const outputFile = path.join(outputDir, 'collected-urls.json');
  fs.writeFileSync(outputFile, JSON.stringify({
    collected_at: new Date().toISOString(),
    expected_total: expectedTotal,
    actual_collected: allListings.length,
    total_pages: totalPages,
    search_url: baseUrl,
    listings: allListings
  }, null, 2));

  console.log(`💾 Saved to: ${outputFile}\n`);

  process.exit(0);
})();
