'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const DATA_ROOT = path.join(REPO_ROOT, 'data');
const SITES = [
  { key: 'viva', fullSite: 'vivaprimeimoveis' },
  { key: 'coelho', fullSite: 'coelhodafonseca' },
];

function parseArgs(argv) {
  const args = {
    compound: 'all',
    site: 'both',
    limit: 0,
    force: false,
    delayMs: 50,
    concurrency: 8,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--compound') args.compound = argv[++i];
    else if (arg === '--site') args.site = argv[++i];
    else if (arg === '--limit') args.limit = Number(argv[++i]);
    else if (arg === '--delay-ms') args.delayMs = Number(argv[++i]);
    else if (arg === '--concurrency') args.concurrency = Number(argv[++i]);
    else if (arg === '--force') args.force = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node scripts/download-fresh-listing-images.js [options]

Download images from data/<compound>/fresh-listings/*.json into
data/<compound>/fresh-images/<site>/<code>/ using canonical 01.jpg filenames.

Options:
  --compound <slug|all>       Compound to process (default: all)
  --site <viva|coelho|both>   Site to process (default: both)
  --limit <n>                 Process first n listings per site (default: all)
  --delay-ms <n>              Delay between image fetches (default: 50)
  --concurrency <n>           Concurrent image downloads per listing (default: 8)
  --force                     Re-download existing files
`);
      process.exit(0);
    }
  }
  if (!Number.isFinite(args.limit) || args.limit < 0) throw new Error('--limit must be zero or positive');
  if (!Number.isFinite(args.delayMs) || args.delayMs < 0) throw new Error('--delay-ms must be zero or positive');
  if (!Number.isFinite(args.concurrency) || args.concurrency < 1) throw new Error('--concurrency must be positive');
  return args;
}

function siteList(siteArg) {
  if (siteArg === 'both') return SITES;
  const site = SITES.find((item) => item.key === siteArg || item.fullSite === siteArg);
  if (!site) throw new Error(`Unknown site: ${siteArg}`);
  return [site];
}

function compoundsList(compoundArg) {
  if (compoundArg !== 'all') return [compoundArg];
  return fs.readdirSync(DATA_ROOT)
    .filter((name) => fs.existsSync(path.join(DATA_ROOT, name, 'fresh-listings')))
    .sort((a, b) => a.localeCompare(b));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function extFromUrl(url) {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) return ext === '.jpeg' ? '.jpg' : ext;
  } catch {
    // fall through
  }
  return '.jpg';
}

function canonicalName(index, url) {
  return `${String(index + 1).padStart(2, '0')}${extFromUrl(url)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function download(url, outputFile, force) {
  if (!force && fs.existsSync(outputFile) && fs.statSync(outputFile).size > 0) {
    return 'cached';
  }
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36',
      accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, bytes);
  return 'downloaded';
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, run);
  await Promise.all(workers);
  return results;
}

async function processSite(compound, site, args) {
  const listingFile = path.join(DATA_ROOT, compound, 'fresh-listings', `${site.fullSite}.json`);
  if (!fs.existsSync(listingFile)) return null;
  const payload = readJson(listingFile);
  const listings = args.limit > 0 ? payload.listings.slice(0, args.limit) : payload.listings;

  let downloaded = 0;
  let cached = 0;
  let failed = 0;
  const failures = [];
  console.log(`  ${site.fullSite}: downloading images for ${listings.length}/${payload.listings.length} listing(s)`);

  for (let i = 0; i < listings.length; i++) {
    const listing = listings[i];
    const code = String(listing.propertyCode || listing.code || '').trim();
    const images = Array.isArray(listing.images) ? listing.images : [];
    const results = await mapLimit(images, args.concurrency, async (image, j) => {
      const outputFile = path.join(DATA_ROOT, compound, 'fresh-images', site.fullSite, code, canonicalName(j, image));
      try {
        const status = await download(image, outputFile, args.force);
        return { status };
      } catch (err) {
        return { status: 'failed', error: err.message, image };
      }
    });

    let listingDownloaded = 0;
    let listingCached = 0;
    let listingFailed = 0;
    for (const result of results) {
      if (result.status === 'downloaded') {
        downloaded++;
        listingDownloaded++;
      } else if (result.status === 'cached') {
        cached++;
        listingCached++;
      } else {
        failed++;
        listingFailed++;
        failures.push({ code, image: result.image, error: result.error });
      }
    }
    if (args.delayMs > 0 && i + 1 < listings.length) await sleep(args.delayMs);
    console.log(
      `    [${i + 1}/${listings.length}] ${code}: ` +
      `${images.length} image(s), downloaded=${listingDownloaded}, cached=${listingCached}, failed=${listingFailed}`
    );
  }

  return {
    listings: listings.length,
    downloaded,
    cached,
    failed,
    failures,
    output_dir: path.relative(REPO_ROOT, path.join(DATA_ROOT, compound, 'fresh-images', site.fullSite)),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = {
    generated_at: new Date().toISOString(),
    compounds: {},
  };

  for (const compound of compoundsList(args.compound)) {
    console.log(`\n${compound}`);
    report.compounds[compound] = {};
    for (const site of siteList(args.site)) {
      const summary = await processSite(compound, site, args);
      if (!summary) continue;
      report.compounds[compound][site.fullSite] = summary;
      console.log(
        `  ${site.fullSite}: downloaded=${summary.downloaded}, cached=${summary.cached}, failed=${summary.failed}`
      );
    }
  }

  const reportFile = path.join(DATA_ROOT, 'fresh-image-download-report.json');
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nWrote ${path.relative(REPO_ROOT, reportFile)}`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
