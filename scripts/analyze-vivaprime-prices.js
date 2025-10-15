const data = require('../data/vivaprimeimoveis/listings/all-listings.json');

console.log('\n📊 VIVAPRIME PAGE 6 LISTINGS (The missing 10):\n');

const page6 = data.listings.filter(l => l.page === 6);

page6.forEach(l => {
  console.log(`  ${l.propertyCode}: ${l.price || 'No price'}`);
});

console.log('\n\n📊 ALL VIVAPRIME PRICES SUMMARY:\n');

// Parse prices and get range
const prices = data.listings
  .map(l => l.price)
  .filter(p => p && p.includes('R$'))
  .map(p => {
    const match = p.match(/R\$\s*([\d.,]+)/);
    if (match) {
      return parseFloat(match[1].replace(/\./g, '').replace(',', '.'));
    }
    return null;
  })
  .filter(p => p !== null);

const min = Math.min(...prices);
const max = Math.max(...prices);

console.log(`  Lowest: R$ ${min.toLocaleString('pt-BR')}`);
console.log(`  Highest: R$ ${max.toLocaleString('pt-BR')}`);
console.log(`  Total with prices: ${prices.length}/70`);

// Show expensive ones (>= 4M)
const expensive = data.listings.filter(l => {
  if (!l.price) return false;
  const match = l.price.match(/R\$\s*([\d.,]+)/);
  if (match) {
    const price = parseFloat(match[1].replace(/\./g, '').replace(',', '.'));
    return price >= 4000000;
  }
  return false;
});

console.log('\n\n📊 PROPERTIES >= R$ 4M:\n');
expensive.forEach(l => {
  console.log(`  ${l.propertyCode} (page ${l.page}): ${l.price}`);
});
console.log(`\nTotal: ${expensive.length} properties\n`);
