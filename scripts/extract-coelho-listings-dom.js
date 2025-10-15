const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // Navigate to search results page
  const searchUrl = 'https://www.coelhodafonseca.com.br/search?transaction=Residencial&indicators=Comprar&work_phase=Prontos%20para%20morar&is_release_or_slam=false&region=Alphaville%20%2F%20Tambor%C3%A9&kind_of=Casa%20em%20Condom%C3%ADnio&enterprises=Alphaville%201';

  await page.goto(searchUrl);
  await page.waitForTimeout(3000);

  // Get the full HTML
  const html = await page.content();

  // Create output directory
  const outDir = path.join(process.cwd(), 'data', 'coelhodafonseca', 'listings');
  fs.mkdirSync(outDir, { recursive: true });

  // Save HTML
  fs.writeFileSync(path.join(outDir, 'listings-page.html'), html);

  // Take a screenshot
  await page.screenshot({
    path: path.join(outDir, 'listings-page.png'),
    fullPage: true
  });

  // Extract listing card selectors
  const selectors = await page.evaluate(() => {
    // Find all property cards using the main container class
    const cards = document.querySelectorAll('section.property_display_main__3gOwW');

    if (cards.length === 0) {
      return { error: 'No property cards found', html: document.body.innerHTML.substring(0, 1000) };
    }

    // Analyze first card structure
    const firstCard = cards[0];

    // Find property link (numeric ID)
    const firstLink = firstCard.querySelector('a[href^="/"]');
    const firstLinkHref = firstLink ? firstLink.href : null;

    // Find images
    const imgElement = firstCard.querySelector('img');
    const imgSrc = imgElement ? imgElement.src : null;

    // Find price element
    const priceElement = firstCard.querySelector('.property_display_priceValue__1isrv');
    const priceText = priceElement ? priceElement.textContent.trim() : null;

    // Find location/title (h2 element)
    const titleElement = firstCard.querySelector('.property_display_headerName__1UlVa');
    const titleText = titleElement ? titleElement.textContent.trim() : null;

    // Find property code
    const codeElement = firstCard.querySelector('.property_display_headerCod__3YLSH');
    const codeText = codeElement ? codeElement.textContent.trim() : null;

    // Find property type
    const kindElement = firstCard.querySelector('.property_display_headerKindOf__3uaI7');
    const kindText = kindElement ? kindElement.textContent.trim() : null;

    // Find features (bedrooms, suites, area, etc.)
    const featuresElement = firstCard.querySelector('.property_display_contentFeatures__1AP_O');
    const featuresText = featuresElement ? featuresElement.textContent.trim() : null;

    // Find description
    const descElement = firstCard.querySelector('.property_display_contentDescription__3FMMt');
    const descText = descElement ? descElement.textContent.trim().substring(0, 100) : null;

    // Collect all property URLs
    const allUrls = [];
    cards.forEach(card => {
      const link = card.querySelector('a[href^="/"]');
      if (link && link.pathname) {
        // Extract numeric ID from pathname like "/663777"
        const id = link.pathname.replace('/', '');
        if (id && !isNaN(id)) {
          allUrls.push(`https://www.coelhodafonseca.com.br${link.pathname}`);
        }
      }
    });

    return {
      totalCards: cards.length,
      allPropertyUrls: allUrls,
      cardSelector: {
        strategy: 'css',
        value: 'section.property_display_main__3gOwW',
        playwright: 'page.locator("section.property_display_main__3gOwW").all()',
        why: 'Main property card container',
        count: cards.length
      },
      link: {
        found: firstLink !== null,
        href: firstLinkHref,
        selector: 'a[href^="/"]'
      },
      image: {
        found: imgElement !== null,
        src: imgSrc,
        selector: 'img'
      },
      price: {
        found: priceElement !== null,
        text: priceText,
        selector: '.property_display_priceValue__1isrv'
      },
      title: {
        found: titleElement !== null,
        text: titleText,
        selector: '.property_display_headerName__1UlVa'
      },
      code: {
        found: codeElement !== null,
        text: codeText,
        selector: '.property_display_headerCod__3YLSH'
      },
      kind: {
        found: kindElement !== null,
        text: kindText,
        selector: '.property_display_headerKindOf__3uaI7'
      },
      features: {
        found: featuresElement !== null,
        text: featuresText,
        selector: '.property_display_contentFeatures__1AP_O'
      },
      description: {
        found: descElement !== null,
        text: descText,
        selector: '.property_display_contentDescription__3FMMt'
      },
      pagination: {
        // Look for pagination elements
        nextButton: document.querySelector('[class*="next"], [aria-label*="next"]') !== null,
        pageNumbers: document.querySelectorAll('[class*="page"]').length
      }
    };
  });

  // Save selectors
  fs.writeFileSync(
    path.join(outDir, 'selectors_listings.json'),
    JSON.stringify(selectors, null, 2)
  );

  console.log('✅ Extracted listings page HTML and selectors');
  console.log(`📁 Saved to: ${outDir}`);
  console.log(`📊 Found ${selectors.totalCards || 0} listing cards`);

  await browser.close();
})();
