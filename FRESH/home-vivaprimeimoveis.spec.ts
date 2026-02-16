import { test, expect } from '@playwright/test';

/**
 * Viva Prime Imóveis - Homepage Search Test
 *
 * This test navigates to the homepage, performs a search with the following filters:
 * - Tipo: Casa
 * - Empreendimento: Alphaville 01
 *
 * Then clicks the search button and waits for results.
 */

test('Home search for vivaprimeimoveis - Casa in Alphaville 01', async ({ page }) => {
  // Navigate to the homepage
  await page.goto('https://www.vivaprimeimoveis.com.br/');

  // Wait for the page to load and handle cookie consent if present
  const cookieButton = page.getByRole('button', { name: 'Aceitar Cookies' });
  if (await cookieButton.isVisible({ timeout: 5000 }).catch(() => false)) {
    await cookieButton.click();
  }

  // Wait for the search form to be visible
  await expect(page.getByRole('button', { name: 'Buscar' })).toBeVisible();

  // Step 1: Select property type "Casa"
  // Click the "Tipo" dropdown button
  await page.getByRole('button', { name: 'Tipo' }).click();

  // Wait for dropdown to open and select "Casa" from the visible dropdown menu
  await page.locator('.dropdown-item').filter({ hasText: /^Casa$/ }).click();

  // Wait a moment for the selection to register
  await page.waitForTimeout(500);

  // Step 2: Select empreendimento "Alphaville 01"
  // Click the "Empreendimento" dropdown button
  await page.getByRole('button', { name: 'Empreendimento' }).click();

  // Wait for dropdown to open and select "Alphaville 01"
  await page.locator('.dropdown-item').filter({ hasText: /^Alphaville 01$/ }).click();

  // Wait a moment for the selection to register
  await page.waitForTimeout(500);

  // Step 3: Click the search button (use .first() to get the visible Venda search button)
  await page.locator('button.btn-search').filter({ hasText: 'Buscar' }).first().click();

  // Wait for navigation to results page or results to load
  // The URL should change or new content should appear
  await page.waitForURL(/imoveis|venda/, { timeout: 10000 }).catch(async () => {
    // If URL doesn't change, wait for results content to appear
    await page.waitForSelector('a[href*="/imovel/"]', { timeout: 10000 });
  });

  // Verify we have search results
  const listingLinks = page.locator('a[href*="/imovel/"]');
  await expect(listingLinks.first()).toBeVisible();

  // Optional: Log the number of results found
  const count = await listingLinks.count();
  console.log(`Found ${count} property listings`);

  // Take a screenshot of the results for verification
  await page.screenshot({ path: 'data/vivaprimeimoveis/home/search-results.png', fullPage: true });
});
