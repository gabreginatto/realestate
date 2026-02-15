const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

/**
 * Download images for Viva listings from all-listings.json
 */

// Helper function to download image (follows redirects)
async function downloadImage(url, filepath, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error('Too many redirects'));
      return;
    }

    const protocol = url.startsWith('https') ? https : http;

    protocol.get(url, (response) => {
      // Follow redirects
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        const redirectUrl = response.headers.location;
        // Make sure the redirect URL is absolute
        const finalUrl = redirectUrl.startsWith('http') ? redirectUrl : `https:${redirectUrl}`;
        downloadImage(finalUrl, filepath, redirectCount + 1).then(resolve).catch(reject);
        return;
      }

      // Check if response is OK
      if (response.statusCode !== 200) {
        fs.unlink(filepath, () => {});
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }

      const file = fs.createWriteStream(filepath);
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
      file.on('error', (err) => {
        fs.unlink(filepath, () => {});
        reject(err);
      });
    }).on('error', (err) => {
      fs.unlink(filepath, () => {});
      reject(err);
    });
  });
}

(async () => {
  console.log('\n📥 DOWNLOADING VIVA IMAGES');
  console.log('='.repeat(60) + '\n');

  // Load listings data
  const listingsFile = path.join(process.cwd(), 'data', 'vivaprimeimoveis', 'listings', 'all-listings.json');
  const data = JSON.parse(fs.readFileSync(listingsFile, 'utf8'));
  const listings = data.listings || [];

  console.log(`📊 Found ${listings.length} listings\n`);

  const imagesBaseDir = path.join(process.cwd(), 'data', 'vivaprimeimoveis', 'images');
  fs.mkdirSync(imagesBaseDir, { recursive: true });

  let totalDownloaded = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (let i = 0; i < listings.length; i++) {
    const listing = listings[i];
    const imageUrls = listing.images || [];

    if (imageUrls.length === 0) {
      console.log(`[${i + 1}/${listings.length}] ${listing.propertyCode}: No images`);
      continue;
    }

    console.log(`\n[${i + 1}/${listings.length}] ${listing.propertyCode}: ${imageUrls.length} images`);

    // Create property-specific folder
    const propertyDir = path.join(imagesBaseDir, listing.propertyCode);
    fs.mkdirSync(propertyDir, { recursive: true });

    let downloaded = 0;
    let skipped = 0;
    let failed = 0;

    for (let j = 0; j < imageUrls.length; j++) {
      const url = imageUrls[j];

      // Extract filename from URL
      const urlParts = url.split('/');
      const filename = urlParts[urlParts.length - 1] || `image_${j}.jpg`;
      const filepath = path.join(propertyDir, filename);

      // Skip if already exists
      if (fs.existsSync(filepath)) {
        const stats = fs.statSync(filepath);
        // Skip if file size is reasonable (not an error page)
        if (stats.size > 1000) {
          skipped++;
          continue;
        } else {
          // Delete small files (likely error pages)
          fs.unlinkSync(filepath);
        }
      }

      try {
        await downloadImage(url, filepath);
        downloaded++;
        process.stdout.write(`  ⬇️  [${j + 1}/${imageUrls.length}] ${filename}\r`);
      } catch (err) {
        failed++;
        console.log(`  ❌ [${j + 1}/${imageUrls.length}] Failed: ${err.message}`);
      }
    }

    console.log(`  ✅ ${downloaded} downloaded, ${skipped} cached, ${failed} failed`);
    totalDownloaded += downloaded;
    totalSkipped += skipped;
    totalFailed += failed;
  }

  console.log('\n' + '='.repeat(60));
  console.log('✅ DOWNLOAD COMPLETE');
  console.log('='.repeat(60));
  console.log(`Images downloaded: ${totalDownloaded}`);
  console.log(`Images cached: ${totalSkipped}`);
  console.log(`Images failed: ${totalFailed}`);
  console.log('='.repeat(60) + '\n');

  process.exit(0);
})();
