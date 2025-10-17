const { generateMosaicForListing } = require('./mosaic-module');
const fs = require('fs');
const path = require('path');

(async () => {
  console.log('\n🧪 Testing mosaic generation with single listing\n');

  try {
    // Load VIVA listings
    const vivaData = JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), 'data', 'vivaprimeimoveis', 'listings', 'all-listings.json'),
        'utf-8'
      )
    );

    // Get first listing with images
    const listing = vivaData.listings.find(l => l.images && l.images.length > 0);

    if (!listing) {
      console.log('❌ No listing with images found');
      process.exit(1);
    }

    console.log(`📋 Testing with listing: ${listing.propertyCode}`);
    console.log(`📸 Total images: ${listing.images.length}\n`);

    // Generate mosaic
    const result = await generateMosaicForListing(listing, 'viva');

    if (result.mosaicPath) {
      console.log(`\n✅ SUCCESS!`);
      console.log(`   Mosaic path: ${result.mosaicPath}`);
      console.log(`   Stats:`, JSON.stringify(result.stats, null, 2));
    } else {
      console.log(`\n❌ FAILED`);
      console.log(`   Stats:`, JSON.stringify(result.stats, null, 2));
    }

    console.log('\n✅ Test complete!\n');
  } catch (error) {
    console.error(`\n❌ Error: ${error.message}\n`);
    console.error(error.stack);
    process.exit(1);
  }
})();
