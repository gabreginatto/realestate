const coelhoData = require('../data/coelhodafonseca/listings/all-listings.json');

console.log('📊 COELHO DA FONSECA AREA DATA ANALYSIS\n');
console.log(`Total listings: ${coelhoData.total_listings}\n`);

let withArea = 0;
let withoutArea = 0;
const missingAreaListings = [];

coelhoData.listings.forEach(listing => {
  // Check if features contains constructed area pattern
  const hasArea = /(\d+(?:\.\d+)?)\s*m²\s*construída/i.test(listing.features);

  if (hasArea) {
    withArea++;
  } else {
    withoutArea++;
    missingAreaListings.push({
      code: listing.propertyCode,
      price: listing.price,
      features: listing.features
    });
  }
});

console.log(`✓ Listings WITH constructed area: ${withArea} (${(withArea/coelhoData.total_listings*100).toFixed(1)}%)`);
console.log(`✗ Listings WITHOUT constructed area: ${withoutArea} (${(withoutArea/coelhoData.total_listings*100).toFixed(1)}%)\n`);

if (withoutArea > 0) {
  console.log(`\n⚠️  Listings missing constructed area data:\n`);
  missingAreaListings.slice(0, 10).forEach(l => {
    console.log(`   - ${l.code}: ${l.price}`);
    console.log(`     Features: ${l.features}\n`);
  });

  if (missingAreaListings.length > 10) {
    console.log(`   ... and ${missingAreaListings.length - 10} more\n`);
  }
}

console.log(`\n📊 Summary:`);
console.log(`   Coelho has ${coelhoData.total_listings} listings`);
console.log(`   Only ${withArea} are indexed by area (${withoutArea} excluded from comparison)`);
console.log(`   This means ${withoutArea} Coelho listings cannot be matched even if they're identical!\n`);
