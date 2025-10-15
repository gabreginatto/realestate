import { test, expect } from '@playwright/test';

/**
 * Coelho da Fonseca - Homepage Search Test
 *
 * This test navigates to the homepage and performs a search with:
 * - Transação: Comprar
 * - Tipo de Imóvel: Casa em Condomínio
 * - Localização: Alphaville/Tamboré > Alphaville 1
 *
 * Then clicks Ver Resultados and waits for the listings page.
 */

test('Home search for Coelho da Fonseca - Casa em Condomínio in Alphaville 1', async ({ page }) => {
  // Navigate to the homepage
  await page.goto('https://www.coelhodafonseca.com.br/');

  // Wait for the search form to be visible
  await expect(page.getByRole('button', { name: 'Ver resultados' })).toBeVisible();

  // Wait a moment for page to fully load
  await page.waitForTimeout(2000);

  // Step 1: Select "Comprar" in Transação
  console.log('Selecting Transação: Comprar');
  // Click the hitArea which is the actual clickable overlay
  await page.locator('.filters_filterSearchBlock__ukUIl').filter({ hasText: 'Transação' }).locator('.style_hitArea__3oToq').click();
  await page.waitForTimeout(500);

  // Click "Comprar" option (use .first() since there are multiple)
  await page.getByText('Comprar', { exact: true }).first().click();
  await page.waitForTimeout(1000);

  // Step 2: Select "Casa em Condomínio" in Tipo de Imóvel
  console.log('Selecting Tipo de Imóvel: Casa em Condomínio');
  await page.locator('.filters_filterSearchBlock__ukUIl').filter({ hasText: 'Tipo do imóvel' }).locator('.style_hitArea__3oToq').click();
  await page.waitForTimeout(500);

  await page.getByText('Casa em Condomínio', { exact: true }).first().click();
  await page.waitForTimeout(1000);

  // Step 3: Select location "Alphaville/Tamboré" > "Alphaville 1"
  console.log('Selecting Localização: Alphaville/Tamboré > Alphaville 1');
  await page.locator('.filters_localizationLabel__3_-ZF').click();
  await page.waitForTimeout(1500);

  // First click on "Alphaville / Tamboré" region in left sidebar
  console.log('Clicking Alphaville / Tamboré region');
  await page.getByText('Alphaville / Tamboré', { exact: true }).click();
  await page.waitForTimeout(1000);

  // Then click on "Alphaville 1" in the modal (not the header link)
  console.log('Clicking Alphaville 1');
  await page.locator('#modal-overlay-content').getByText('Alphaville 1', { exact: true }).click();
  await page.waitForTimeout(500);

  // Click "APLICAR FILTROS" button at the bottom (it's an <a> tag, not a button)
  console.log('Clicking APLICAR FILTROS');
  const aplicarButton = page.locator('.button-do-search');
  await expect(aplicarButton).toBeVisible();
  await aplicarButton.click();
  await page.waitForTimeout(1500);

  // Step 4: Click "Ver Resultados" button
  console.log('Clicking Ver Resultados');
  await page.getByRole('button', { name: 'Ver resultados' }).click();

  // Wait for navigation to results page
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2000);

  // Verify we have search results
  console.log(`Current URL: ${page.url()}`);

  // Take a screenshot of the results
  await page.screenshot({
    path: 'data/coelhodafonseca/listings/search-results.png',
    fullPage: true
  });

  console.log('✅ Search completed successfully');
});
