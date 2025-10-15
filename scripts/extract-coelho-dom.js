const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.goto('https://www.coelhodafonseca.com.br/');
  await page.waitForTimeout(2000);

  // Get the full HTML
  const html = await page.content();

  // Save HTML
  const outDir = path.join(process.cwd(), 'data', 'coelhodafonseca', 'home');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'homepage.html'), html);

  // Extract search form selectors
  const selectors = await page.evaluate(() => {
    const form = document.querySelector('form');
    if (!form) return { error: 'No form found' };

    return {
      form: {
        strategy: 'css',
        value: 'form',
        playwright: 'page.locator("form")',
        why: 'Main search form element'
      },
      transacao: {
        strategy: 'placeholder',
        value: 'Selecione a transação',
        playwright: 'page.getByPlaceholder("Selecione a transação")',
        why: 'Transaction type dropdown (Compra/Venda)'
      },
      localizacao: {
        strategy: 'placeholder',
        value: 'Selecione o bairro / localização',
        playwright: 'page.getByPlaceholder("Selecione o bairro / localização")',
        why: 'Location/neighborhood selector'
      },
      tipoImovel: {
        strategy: 'placeholder',
        value: 'Selecione o tipo de imóvel',
        playwright: 'page.getByPlaceholder("Selecione o tipo de imóvel")',
        why: 'Property type dropdown'
      },
      searchButton: {
        strategy: 'text',
        value: 'VER RESULTADOS',
        playwright: 'page.getByRole("button", { name: "VER RESULTADOS" })',
        why: 'Search submit button'
      }
    };
  });

  // Save selectors
  fs.writeFileSync(
    path.join(outDir, 'selectors_home.json'),
    JSON.stringify(selectors, null, 2)
  );

  console.log('✅ Extracted homepage HTML and selectors');
  console.log(`📁 Saved to: ${outDir}`);

  await browser.close();
})();
