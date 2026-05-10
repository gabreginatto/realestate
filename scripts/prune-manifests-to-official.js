'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const DATA_ROOT = path.join(REPO_ROOT, 'data');
const SELECTED_ROOT = path.join(REPO_ROOT, 'selected_for_matching');
const IMG_RE = /\.(jpe?g|png|webp)$/i;
const OUTDOOR = new Set(['pool', 'facade', 'garden']);

const SITES = {
  vivaprimeimoveis: {
    listingFile: 'vivaprimeimoveis_listings.json',
    cacheDir: path.join(DATA_ROOT, 'vivaprimeimoveis', 'cache'),
  },
  coelhodafonseca: {
    listingFile: 'coelhodafonseca_listings.json',
    cacheDir: path.join(DATA_ROOT, 'coelhodafonseca', 'cache'),
  },
};

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

function imageIndex(filename) {
  const match = String(filename).match(/^(\d+)\./);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

function isCanonicalGalleryFile(filename) {
  return /^\d+\.(jpe?g|png|webp)$/i.test(String(filename));
}

function byFilename(a, b) {
  return String(a.filename).localeCompare(String(b.filename), undefined, { numeric: true });
}

function selectPoolFirst(records, maxPool = 4, maxFacade = 2, maxGarden = 2) {
  const outdoorRecords = records.filter((r) => OUTDOOR.has(r.category));
  const pools = outdoorRecords.filter((r) => r.category === 'pool').slice(0, maxPool);
  const facades = outdoorRecords.filter((r) => r.category === 'facade').slice(0, maxFacade);
  const gardens = outdoorRecords.filter((r) => r.category === 'garden').slice(0, maxGarden);
  const selected = [...pools, ...facades, ...gardens];
  return selected.length > 0 ? selected : records.slice(0, 4);
}

function clearSelectedFiles(outDir) {
  if (!fs.existsSync(outDir)) return;
  for (const entry of fs.readdirSync(outDir)) {
    if (!entry.startsWith('_') && IMG_RE.test(entry)) {
      fs.unlinkSync(path.join(outDir, entry));
    }
  }
}

function officialCountsFor(compound, siteConfig) {
  const counts = new Map();
  const files = [
    path.join(DATA_ROOT, compound, 'listings', siteConfig.listingFile),
    path.join(DATA_ROOT, compound, siteConfig.listingFile.replace('_listings.json', ''), 'listings', 'all-listings.json'),
  ];
  for (const file of files) {
    for (const listing of readListings(file)) {
      const code = codeFor(listing);
      if (code && Array.isArray(listing.images) && listing.images.length > 0) {
        counts.set(code, listing.images.length);
      }
    }
  }
  return counts;
}

function pruneSite(compound, siteName) {
  const siteConfig = SITES[siteName];
  const officialCounts = officialCountsFor(compound, siteConfig);
  const selectedSiteDir = path.join(SELECTED_ROOT, siteName);
  if (!fs.existsSync(selectedSiteDir)) return { touched: 0, skipped: 0 };

  let touched = 0;
  let skipped = 0;
  for (const code of fs.readdirSync(selectedSiteDir).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
    const selectedDir = path.join(selectedSiteDir, code);
    const manifestPath = path.join(selectedDir, '_manifest.json');
    if (!fs.statSync(selectedDir).isDirectory() || !fs.existsSync(manifestPath)) continue;

    const officialCount = officialCounts.get(code);
    if (!officialCount) {
      skipped++;
      continue;
    }

    const manifest = readJson(manifestPath);
    const allCategories = (manifest.all_categories || manifest.selected || [])
      .filter((entry) => isCanonicalGalleryFile(entry.filename))
      .filter((entry) => imageIndex(entry.filename) <= officialCount)
      .sort(byFilename);

    if (allCategories.length === 0) {
      skipped++;
      continue;
    }

    const selected = selectPoolFirst(allCategories);
    clearSelectedFiles(selectedDir);
    for (const entry of selected) {
      const src = path.join(siteConfig.cacheDir, code, entry.filename);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(selectedDir, entry.filename));
      }
    }

    manifest.total_images = allCategories.length;
    manifest.selected_count = selected.length;
    manifest.selected = selected.map(({ filename, category }) => ({ filename, category }));
    manifest.all_categories = allCategories.map(({ filename, category }) => ({ filename, category }));
    manifest.pruned_to_official_images = {
      compound,
      official_count: officialCount,
      reason: 'Cache downloader previously included page-level/related-listing images.',
    };

    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`${siteName}/${code}: ${manifest.total_images} official images, ${manifest.selected_count} selected`);
    touched++;
  }

  return { touched, skipped };
}

function main() {
  const compound = process.argv[2] || 'alphaville-1';
  const siteArg = process.argv[3] || 'both';
  const siteNames = siteArg === 'both' ? Object.keys(SITES) : [siteArg];

  for (const siteName of siteNames) {
    if (!SITES[siteName]) {
      throw new Error(`Unknown site: ${siteName}`);
    }
    const result = pruneSite(compound, siteName);
    console.log(`${siteName}: ${result.touched} manifests pruned, ${result.skipped} skipped.`);
  }
}

main();
