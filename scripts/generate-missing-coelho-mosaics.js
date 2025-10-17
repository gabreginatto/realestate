const { generateMosaicForListing } = require('./mosaic-module');
const fs = require('fs');
const path = require('path');

(async () => {
  console.log('============================================================');
  console.log('🔧 GENERATING MISSING COELHO MOSAICS');
  console.log('============================================================\n');

  const coelhoData = JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), 'data', 'coelhodafonseca', 'listings', 'all-listings.json'),
      'utf-8'
    )
  );

  const missingCodes = ['628299', '358601', '395513', '671661', '670241'];

  console.log(`📊 Mosaics to generate: ${missingCodes.length}\n`);

  const results = [];

  for (let i = 0; i < missingCodes.length; i++) {
    const code = missingCodes[i];
    const listing = coelhoData.listings.find(l => l.propertyCode === code);

    if (!listing) {
      console.log(`[${i + 1}/${missingCodes.length}] ${code} - NOT FOUND IN DATA\n`);
      results.push({ code, success: false, error: 'Not found in data' });
      continue;
    }

    console.log(`[${i + 1}/${missingCodes.length}] Generating mosaic for Coelho ${code}...`);
    console.log(`   Images available: ${listing.images ? listing.images.length : 0}`);

    try {
      const result = await generateMosaicForListing(listing, 'coelho');

      if (result.mosaicPath) {
        console.log(`   ✅ SUCCESS: ${result.mosaicPath}\n`);
        results.push({ code, success: true, path: result.mosaicPath });
      } else {
        console.log(`   ❌ FAILED: ${result.stats.error}\n`);
        results.push({ code, success: false, error: result.stats.error });
      }
    } catch (error) {
      console.log(`   ❌ ERROR: ${error.message}\n`);
      results.push({ code, success: false, error: error.message });
    }
  }

  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;

  console.log('============================================================');
  console.log('📊 SUMMARY');
  console.log('============================================================');
  console.log(`✅ Successfully generated: ${successful}/${missingCodes.length}`);
  console.log(`❌ Failed: ${failed}/${missingCodes.length}`);
  console.log('============================================================\n');

  if (successful > 0) {
    console.log('Generated mosaics:');
    results.filter(r => r.success).forEach(r => {
      console.log(`  ✓ ${r.code}: ${r.path}`);
    });
  }

  if (failed > 0) {
    console.log('\nFailed mosaics:');
    results.filter(r => !r.success).forEach(r => {
      console.log(`  ✗ ${r.code}: ${r.error}`);
    });
  }
})();
