const { generateMosaicForListing } = require('./mosaic-module');
const fs = require('fs');
const path = require('path');

/**
 * Regenerate mosaics for specific property codes
 */
async function regenerateSpecificMosaics() {
  // Load listings data
  const vivaData = JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), 'data', 'vivaprimeimoveis', 'listings', 'all-listings.json'),
      'utf-8'
    )
  );

  const coelhoData = JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), 'data', 'coelhodafonseca', 'listings', 'all-listings.json'),
      'utf-8'
    )
  );

  // Pairs to regenerate
  const pairs = [
    { viva: '12252', coelho: '681867' },
    { viva: '16117', coelho: '628299' },
    { viva: '7597', coelho: '358601' },
    { viva: '6930', coelho: '395513' }
  ];

  console.log('============================================================');
  console.log('🔄 REGENERATING MOSAICS WITH 3×3 GRID & POOL DETECTION');
  console.log('============================================================\n');

  for (const pair of pairs) {
    console.log(`\n📌 Pair: VIVA ${pair.viva} ↔ Coelho ${pair.coelho}`);
    console.log('─'.repeat(60));

    // Find VIVA listing
    const vivaListing = vivaData.listings.find(l => l.propertyCode === pair.viva);
    if (vivaListing) {
      // Delete existing mosaic to force regeneration
      const vivaMosaicPath = path.join(process.cwd(), 'data', 'mosaics', 'viva', `${pair.viva}.png`);
      if (fs.existsSync(vivaMosaicPath)) {
        fs.unlinkSync(vivaMosaicPath);
        console.log(`  🗑️  Deleted old VIVA mosaic`);
      }

      await generateMosaicForListing(vivaListing, 'viva');
    } else {
      console.log(`  ❌ VIVA listing ${pair.viva} not found`);
    }

    // Find Coelho listing
    const coelhoListing = coelhoData.listings.find(l => l.propertyCode === pair.coelho);
    if (coelhoListing) {
      // Delete existing mosaic to force regeneration
      const coelhoMosaicPath = path.join(process.cwd(), 'data', 'mosaics', 'coelho', `${pair.coelho}.png`);
      if (fs.existsSync(coelhoMosaicPath)) {
        fs.unlinkSync(coelhoMosaicPath);
        console.log(`  🗑️  Deleted old Coelho mosaic`);
      }

      await generateMosaicForListing(coelhoListing, 'coelho');
    } else {
      console.log(`  ❌ Coelho listing ${pair.coelho} not found`);
    }
  }

  console.log('\n============================================================');
  console.log('✅ REGENERATION COMPLETE');
  console.log('============================================================');
  console.log('\nNew mosaics are 3×3 grids (900x900px) with 2-3 pool photos prioritized.\n');
}

regenerateSpecificMosaics().catch(console.error);
