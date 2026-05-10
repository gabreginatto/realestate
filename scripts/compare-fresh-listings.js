'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const DATA_ROOT = path.join(REPO_ROOT, 'data');
const SITES = [
  { key: 'viva', fullSite: 'vivaprimeimoveis', listingFile: 'vivaprimeimoveis_listings.json' },
  { key: 'coelho', fullSite: 'coelhodafonseca', listingFile: 'coelhodafonseca_listings.json' },
];

function parseArgs(argv) {
  const args = {
    compound: 'all',
    output: path.join(DATA_ROOT, 'fresh-listing-comparison.json'),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--compound') args.compound = argv[++i];
    else if (arg === '--output') args.output = path.resolve(argv[++i]);
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node scripts/compare-fresh-listings.js [options]

Compare fresh live detail scrapes in data/<compound>/fresh-listings/ with the
previous local listing JSON files.

Options:
  --compound <slug|all>  Compound to compare (default: all)
  --output <file>        Report path (default: data/fresh-listing-comparison.json)
`);
      process.exit(0);
    }
  }
  return args;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readListings(file) {
  if (!fs.existsSync(file)) return [];
  const data = readJson(file);
  return Array.isArray(data) ? data : (data.listings || []);
}

function codeFor(listing) {
  return String(listing.propertyCode || listing.code || listing.id || '').trim();
}

function listCompounds() {
  return fs.readdirSync(DATA_ROOT)
    .filter((name) => fs.existsSync(path.join(DATA_ROOT, name, 'fresh-listings')))
    .sort((a, b) => a.localeCompare(b));
}

function canonicalListingFiles(compound, site) {
  return [
    path.join(DATA_ROOT, compound, 'listings', site.listingFile),
    path.join(DATA_ROOT, compound, site.fullSite, 'listings', 'all-listings.json'),
  ];
}

function canonicalListings(compound, site) {
  for (const file of canonicalListingFiles(compound, site)) {
    const listings = readListings(file);
    if (listings.length > 0) return { file, listings };
  }
  return { file: null, listings: [] };
}

function imageStats(listings) {
  const counts = listings.map((listing) => Array.isArray(listing.images) ? listing.images.length : 0);
  const total = counts.reduce((sum, count) => sum + count, 0);
  return {
    total_images: total,
    with_images: counts.filter((count) => count > 0).length,
    min_images: counts.length ? Math.min(...counts) : 0,
    max_images: counts.length ? Math.max(...counts) : 0,
    avg_images: counts.length ? Number((total / counts.length).toFixed(2)) : 0,
  };
}

function compareSite(compound, site) {
  const freshFile = path.join(DATA_ROOT, compound, 'fresh-listings', `${site.fullSite}.json`);
  const freshListings = readListings(freshFile);
  const old = canonicalListings(compound, site);

  const oldCodes = new Set(old.listings.map(codeFor).filter(Boolean));
  const freshCodes = new Set(freshListings.map(codeFor).filter(Boolean));
  const newOnLive = [...freshCodes].filter((code) => !oldCodes.has(code)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const missingFromLive = [...oldCodes].filter((code) => !freshCodes.has(code)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  return {
    previous_file: old.file ? path.relative(REPO_ROOT, old.file) : null,
    fresh_file: path.relative(REPO_ROOT, freshFile),
    previous_count: oldCodes.size,
    fresh_count: freshCodes.size,
    delta_fresh_vs_previous: freshCodes.size - oldCodes.size,
    new_on_live_count: newOnLive.length,
    missing_from_live_count: missingFromLive.length,
    new_on_live: newOnLive,
    missing_from_live: missingFromLive,
    previous_images: imageStats(old.listings),
    fresh_images: imageStats(freshListings),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const compounds = args.compound === 'all' ? listCompounds() : [args.compound];
  const report = {
    generated_at: new Date().toISOString(),
    compounds: {},
  };

  for (const compound of compounds) {
    report.compounds[compound] = {};
    console.log(`\n${compound}`);
    for (const site of SITES) {
      const freshFile = path.join(DATA_ROOT, compound, 'fresh-listings', `${site.fullSite}.json`);
      if (!fs.existsSync(freshFile)) continue;
      const summary = compareSite(compound, site);
      report.compounds[compound][site.fullSite] = summary;
      console.log(
        `  ${site.fullSite}: previous=${summary.previous_count}, fresh=${summary.fresh_count}, ` +
        `delta=${summary.delta_fresh_vs_previous}, new=${summary.new_on_live_count}, ` +
        `missing=${summary.missing_from_live_count}, avg_images=${summary.fresh_images.avg_images}`
      );
    }
  }

  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nWrote ${path.relative(REPO_ROOT, args.output)}`);
}

main();
