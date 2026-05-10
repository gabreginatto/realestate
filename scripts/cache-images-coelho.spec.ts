import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';

type CoelhoListing = {
  url: string;
  propertyCode?: string;
  code?: string | number;
  images?: string[];
};

/**
 * Coelho da Fonseca — Full Image Cache Downloader
 *
 * Reads data/coelhodafonseca/listings/all-listings.json (already scraped).
 * If the Alphaville listing snapshot has explicit gallery URLs, those are used
 * as the source of truth. The rendered page includes related-listing and chrome
 * images, so broad DOM scraping is only a fallback.
 * Visits each listing page and downloads ALL gallery images to:
 *   data/coelhodafonseca/cache/{propertyCode}/01.jpg, 02.jpg, ...
 *
 * Skips listings whose cache directory already has images (resumable).
 *
 * Run:
 *   npx playwright test scripts/cache-images-coelho.spec.ts --project=chromium --workers=1
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

test('Download all images for every Coelho listing', async ({ page }) => {
  test.setTimeout(0); // no timeout — scraping 80+ listings takes as long as it takes

  const listingsFile = path.join(process.cwd(), 'data', 'coelhodafonseca', 'listings', 'all-listings.json');
  if (!fs.existsSync(listingsFile)) {
    throw new Error(`Listings file not found: ${listingsFile}\nRun the listings scraper first.`);
  }

  const data = JSON.parse(fs.readFileSync(listingsFile, 'utf-8'));
  const listings: CoelhoListing[] = data.listings ?? data;

  const officialImagesByCode = new Map<string, string[]>();
  const compound = process.env.COMPOUND || 'alphaville-1';
  const officialListingsFile = [
    path.join(process.cwd(), 'data', compound, 'listings', 'coelhodafonseca_listings.json'),
    path.join(process.cwd(), 'data', compound, 'coelhodafonseca', 'listings', 'all-listings.json'),
  ].find((file) => fs.existsSync(file));
  if (officialListingsFile) {
    const officialData = JSON.parse(fs.readFileSync(officialListingsFile, 'utf-8'));
    const officialListings: CoelhoListing[] = officialData.listings ?? officialData;
    for (const official of officialListings) {
      const officialCode = String(official.propertyCode || official.code || '').trim();
      if (officialCode && Array.isArray(official.images) && official.images.length > 0) {
        officialImagesByCode.set(officialCode, official.images);
      }
    }
  }

  const cacheRoot = path.join(process.cwd(), 'data', 'coelhodafonseca', 'cache');
  fs.mkdirSync(cacheRoot, { recursive: true });

  let totalDownloaded = 0;
  let totalSkipped = 0;

  for (let i = 0; i < listings.length; i++) {
    const listing = listings[i];
    const code = listing.propertyCode || listing.url.split('/').pop() || String(i);
    const listingUrl = listing.url.startsWith('http')
      ? listing.url
      : `https://www.coelhodafonseca.com.br${listing.url}`;

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
      const officialUrls = officialImagesByCode.get(code);
      let validUrls = officialUrls ? Array.from(new Set(officialUrls)) : [];

      if (validUrls.length > 0) {
        console.log(`  Using ${validUrls.length} official gallery URLs`);
      } else {
        await page.goto(listingUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2000);

        // Scroll to trigger lazy loading
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
        await page.waitForTimeout(500);

        // Collect only image URLs scoped to this listing when possible.
        const imgUrls: Set<string> = new Set();

        const srcs = await page.$$eval(
          `img[src*="/${code}/"], img[data-src*="/${code}/"], img[data-lazy-src*="/${code}/"], img[data-original*="/${code}/"], img[src*="/original/"]`,
          (imgs) => imgs.flatMap((img) => [
            (img as HTMLImageElement).src,
            img.getAttribute('data-src'),
            img.getAttribute('data-lazy-src'),
            img.getAttribute('data-original'),
          ]).filter(Boolean) as string[]
        );
        srcs.forEach((s) => {
          const full = s.startsWith('http') ? s : `https://www.coelhodafonseca.com.br${s}`;
          if (!full.startsWith('data:')) imgUrls.add(full);
        });

        const bgImgs = await page.$$eval(
          `[style*="/${code}/"], [style*="/original/"]`,
          (els) => els.map((el) => {
            const style = (el as HTMLElement).style.backgroundImage;
            const m = style.match(/url\(["']?(.+?)["']?\)/);
            return m ? m[1] : '';
          }).filter(Boolean)
        );
        bgImgs.forEach((s) => {
          const full = s.startsWith('http') ? s : `https://www.coelhodafonseca.com.br${s}`;
          if (!full.startsWith('data:')) imgUrls.add(full);
        });

        // Filter out non-photo URLs
        validUrls = Array.from(imgUrls).filter((u) => {
          const lower = u.toLowerCase();
          return (
            !lower.includes('logo') &&
            !lower.includes('icon') &&
            !lower.includes('favicon') &&
            !lower.includes('thumb') &&
            !lower.includes('avatar') &&
            !lower.includes('placeholder') &&
            !lower.includes('sprite')
          );
        });
      }

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
