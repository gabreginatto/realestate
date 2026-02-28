import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';

/**
 * Viva Prime Imóveis — Full Image Cache Downloader
 *
 * Reads data/vivaprimeimoveis/listings/all-listings.json (already scraped).
 * Visits each listing page and downloads ALL gallery images to:
 *   data/vivaprimeimoveis/cache/{propertyCode}/01.jpg, 02.jpg, ...
 *
 * Skips listings whose cache directory already has images (resumable).
 *
 * Run:
 *   npx playwright test scripts/cache-images-viva.spec.ts --project=chromium --workers=1
 */

async function downloadImage(url: string, filepath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(filepath);
    protocol.get(url, (response) => {
      if (response.statusCode && response.statusCode >= 400) {
        file.close();
        fs.unlink(filepath, () => {});
        resolve(false);
        return;
      }
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(true); });
    }).on('error', () => {
      fs.unlink(filepath, () => {});
      resolve(false);
    });
  });
}

test('Download all images for every Viva listing', async ({ page }) => {
  test.setTimeout(0); // no timeout — scraping 70+ listings takes as long as it takes

  const listingsFile = path.join(process.cwd(), 'data', 'vivaprimeimoveis', 'listings', 'all-listings.json');
  if (!fs.existsSync(listingsFile)) {
    throw new Error(`Listings file not found: ${listingsFile}\nRun the listings scraper first.`);
  }

  const data = JSON.parse(fs.readFileSync(listingsFile, 'utf-8'));
  const listings: Array<{ url: string; propertyCode: string }> = data.listings ?? data;

  const cacheRoot = path.join(process.cwd(), 'data', 'vivaprimeimoveis', 'cache');
  fs.mkdirSync(cacheRoot, { recursive: true });

  let totalDownloaded = 0;
  let totalSkipped = 0;

  for (let i = 0; i < listings.length; i++) {
    const listing = listings[i];
    const code = listing.propertyCode || listing.url.split('/').pop() || String(i);
    const listingUrl = listing.url;

    const outDir = path.join(cacheRoot, code);

    // Skip if already cached
    if (fs.existsSync(outDir)) {
      const existing = fs.readdirSync(outDir).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f));
      if (existing.length > 0) {
        console.log(`[${i + 1}/${listings.length}] ${code} — skipping (${existing.length} images cached)`);
        totalSkipped++;
        continue;
      }
    }

    console.log(`\n[${i + 1}/${listings.length}] ${code}`);
    console.log(`  URL: ${listingUrl}`);

    try {
      await page.goto(listingUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);

      // Scroll to trigger lazy loading
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
      await page.waitForTimeout(500);

      // Collect all image URLs from multiple sources
      const imgUrls: Set<string> = new Set();

      // Strategy 1: src attribute on img elements matching viva domain
      const srcs = await page.$$eval(
        'img[src*="vivaprimeimoveis"], img[src*="cdn"], img[src*="storage"]',
        (imgs) => imgs
          .map((img) => (img as HTMLImageElement).src || img.getAttribute('data-src') || '')
          .filter(Boolean)
      );
      srcs.forEach((s) => { if (!s.startsWith('data:')) imgUrls.add(s); });

      // Strategy 2: data-src / data-lazy-src (carousel lazy loading)
      const dataSrcs = await page.$$eval(
        'img[data-src], img[data-lazy-src], img[data-original]',
        (imgs) => imgs.flatMap((img) => [
          img.getAttribute('data-src'),
          img.getAttribute('data-lazy-src'),
          img.getAttribute('data-original'),
        ]).filter(Boolean) as string[]
      );
      dataSrcs.forEach((s) => { if (!s.startsWith('data:')) imgUrls.add(s); });

      // Strategy 3: background-image in style attributes (some carousels use this)
      const bgImgs = await page.$$eval(
        '[style*="background-image"]',
        (els) => els.map((el) => {
          const style = (el as HTMLElement).style.backgroundImage;
          const m = style.match(/url\(["']?(.+?)["']?\)/);
          return m ? m[1] : '';
        }).filter(Boolean)
      );
      bgImgs.forEach((s) => { if (!s.startsWith('data:')) imgUrls.add(s); });

      // Filter to only property photo URLs (skip logos, icons, thumbnails < 200px)
      const validUrls = Array.from(imgUrls).filter((u) => {
        const lower = u.toLowerCase();
        return (
          !lower.includes('logo') &&
          !lower.includes('icon') &&
          !lower.includes('favicon') &&
          !lower.includes('thumb') &&
          !lower.includes('avatar') &&
          !lower.includes('placeholder')
        );
      });

      console.log(`  Found ${validUrls.length} candidate image URLs`);

      if (validUrls.length === 0) {
        console.log('  ⚠️  No images found — skipping');
        continue;
      }

      fs.mkdirSync(outDir, { recursive: true });

      let saved = 0;
      for (const imgUrl of validUrls) {
        const ext = (imgUrl.split('?')[0].split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z]/g, '') || 'jpg';
        const filename = `${String(saved + 1).padStart(2, '0')}.${ext}`;
        const filepath = path.join(outDir, filename);

        const ok = await downloadImage(imgUrl, filepath);
        if (ok) {
          saved++;
          console.log(`  ⬇️  ${filename} ← ${imgUrl.substring(0, 80)}`);
        }
      }

      console.log(`  ✅ Saved ${saved} images to cache/${code}/`);
      totalDownloaded += saved;

    } catch (err) {
      console.log(`  ❌ Error: ${err}`);
    }

    await page.waitForTimeout(500);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Done. ${totalDownloaded} images downloaded, ${totalSkipped} listings skipped (already cached).`);
  console.log(`Cache: ${cacheRoot}`);
});
