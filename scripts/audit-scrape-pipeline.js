'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const DATA_ROOT = path.join(REPO_ROOT, 'data');
const SELECTED_ROOT = path.join(REPO_ROOT, 'selected_for_matching');
const IMG_RE = /\.(jpe?g|png|webp)$/i;

const SITE_CONFIGS = [
  {
    key: 'viva',
    fullSite: 'vivaprimeimoveis',
    listingFile: 'vivaprimeimoveis_listings.json',
  },
  {
    key: 'coelho',
    fullSite: 'coelhodafonseca',
    listingFile: 'coelhodafonseca_listings.json',
  },
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readListings(file) {
  if (!fs.existsSync(file)) return [];
  const data = readJson(file);
  return Array.isArray(data) ? data : (data.listings || []);
}

function listDirs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => fs.statSync(path.join(dir, name)).isDirectory())
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function countImages(dir) {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((name) => IMG_RE.test(name)).length;
}

function listingCode(listing) {
  return String(listing.propertyCode || listing.code || listing.id || '').trim();
}

function officialImageCount(listing) {
  return Array.isArray(listing.images) ? listing.images.length : 0;
}

function summarizeSelected(fullSite, officialCounts) {
  const selectedSiteDir = path.join(SELECTED_ROOT, fullSite);
  const dirs = listDirs(selectedSiteDir);
  let manifestCount = 0;
  let selectedImageCount = 0;
  const manifestOverOfficial = [];
  let officialManifests = 0;
  let officialSelectedImages = 0;

  for (const code of dirs) {
    const manifestPath = path.join(selectedSiteDir, code, '_manifest.json');
    if (!fs.existsSync(manifestPath)) continue;
    manifestCount++;
    const manifest = readJson(manifestPath);
    const imageCount = countImages(path.join(selectedSiteDir, code));
    selectedImageCount += imageCount;
    const totalImages = Number(manifest.total_images || (manifest.all_categories || []).length || 0);
    const official = officialCounts.get(code) || 0;
    if (official > 0) {
      officialManifests++;
      officialSelectedImages += imageCount;
    }
    if (official > 0 && totalImages > official) {
      manifestOverOfficial.push({
        code,
        official,
        manifest_total: totalImages,
        extra: totalImages - official,
      });
    }
  }

  manifestOverOfficial.sort((a, b) => b.extra - a.extra);
  return {
    listing_dirs: dirs.length,
    manifests: manifestCount,
    official_manifests: officialManifests,
    missing_official_manifests: Math.max(0, officialCounts.size - officialManifests),
    selected_images: selectedImageCount,
    official_selected_images: officialSelectedImages,
    manifests_over_official: manifestOverOfficial,
  };
}

function summarizeMosaics(compoundDir, siteKey, officialCodes = new Set()) {
  const mosaicDir = path.join(compoundDir, 'mosaics', siteKey);
  if (!fs.existsSync(mosaicDir)) {
    return { standard: 0, expanded: 0, official_standard: 0, official_expanded: 0, extra_standard: 0, extra_expanded: 0 };
  }
  const files = fs.readdirSync(mosaicDir).filter((name) => name.endsWith('.png'));
  const standardCodes = new Set(
    files.filter((name) => !name.endsWith('_full.png')).map((name) => name.replace(/\.png$/, ''))
  );
  const expandedCodes = new Set(
    files.filter((name) => name.endsWith('_full.png')).map((name) => name.replace(/_full\.png$/, ''))
  );
  const officialStandard = [...officialCodes].filter((code) => standardCodes.has(code)).length;
  const officialExpanded = [...officialCodes].filter((code) => expandedCodes.has(code)).length;
  return {
    standard: standardCodes.size,
    expanded: expandedCodes.size,
    official_standard: officialStandard,
    official_expanded: officialExpanded,
    extra_standard: Math.max(0, standardCodes.size - officialStandard),
    extra_expanded: Math.max(0, expandedCodes.size - officialExpanded),
  };
}

function listingFilesFor(compoundDir, site) {
  return [
    path.join(compoundDir, 'listings', site.listingFile),
    path.join(compoundDir, site.fullSite, 'listings', 'all-listings.json'),
  ];
}

function primaryListingFile(compoundDir, site) {
  return listingFilesFor(compoundDir, site).find((file) => readListings(file).length > 0)
    || listingFilesFor(compoundDir, site)[0];
}

function summarizeSite(compoundSlug, compoundDir, site) {
  const listingFile = primaryListingFile(compoundDir, site);
  const listings = readListings(listingFile);
  const codes = listings.map(listingCode).filter(Boolean);
  const uniqueCodes = new Set(codes);
  const officialCounts = new Map();
  for (const listing of listings) {
    const code = listingCode(listing);
    if (code) officialCounts.set(code, officialImageCount(listing));
  }

  const imageRoot = path.join(compoundDir, site.fullSite, 'images');
  const localImageDirs = listDirs(imageRoot);
  const localImageCount = localImageDirs.reduce(
    (sum, code) => sum + countImages(path.join(imageRoot, code)),
    0
  );

  const rootCacheDir = path.join(DATA_ROOT, site.fullSite, 'cache');
  const cacheDirs = listDirs(rootCacheDir);
  const cacheOverOfficial = [];
  const missingOfficialImages = [];

  for (const [code, official] of officialCounts.entries()) {
    const cached = countImages(path.join(rootCacheDir, code));
    if (official > 0 && cached > official) {
      cacheOverOfficial.push({ code, official, cached, extra: cached - official });
    }
    const local = countImages(path.join(imageRoot, code));
    if (official > 0 && local > 0 && local < official) {
      missingOfficialImages.push({ code, official, local, missing: official - local });
    }
  }

  cacheOverOfficial.sort((a, b) => b.extra - a.extra);
  missingOfficialImages.sort((a, b) => b.missing - a.missing);

  const legacyListings = readListings(path.join(DATA_ROOT, site.fullSite, 'listings', 'all-listings.json'));
  const pipelineStateFile = path.join(compoundDir, 'pipeline-state.json');
  const pipelineState = fs.existsSync(pipelineStateFile) ? readJson(pipelineStateFile) : {};
  const stateKey = site.key === 'viva' ? 'viva_codes' : 'coelho_codes';
  const stateCodes = Array.isArray(pipelineState[stateKey]) ? pipelineState[stateKey] : [];

  return {
    listing_file: path.relative(REPO_ROOT, listingFile),
    listings: listings.length,
    unique_codes: uniqueCodes.size,
    duplicate_codes: codes.length - uniqueCodes.size,
    pipeline_state_codes: stateCodes.length,
    delta_vs_pipeline_state: uniqueCodes.size - stateCodes.length,
    legacy_root_listings: legacyListings.length,
    delta_vs_legacy_root: uniqueCodes.size - legacyListings.length,
    official_gallery_images: Array.from(officialCounts.values()).reduce((a, b) => a + b, 0),
    local_image_dirs: localImageDirs.length,
    local_images: localImageCount,
    root_cache_dirs: cacheDirs.length,
    cache_over_official_count: cacheOverOfficial.length,
    cache_over_official_top: cacheOverOfficial.slice(0, 12),
    missing_official_images_count: missingOfficialImages.length,
    missing_official_images_top: missingOfficialImages.slice(0, 12),
    selected_for_matching: summarizeSelected(site.fullSite, officialCounts),
    mosaics: summarizeMosaics(compoundDir, site.key, uniqueCodes),
  };
}

function findCompounds() {
  return fs.readdirSync(DATA_ROOT)
    .map((name) => ({ name, dir: path.join(DATA_ROOT, name) }))
    .filter(({ dir }) => fs.statSync(dir).isDirectory())
    .filter(({ dir }) => fs.existsSync(path.join(dir, 'listings')) || fs.existsSync(path.join(dir, 'pipeline-state.json')))
    .filter(({ name }) => !['vivaprimeimoveis', 'coelhodafonseca', 'review-rounds'].includes(name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function main() {
  const compounds = findCompounds();
  const report = {
    generated_at: new Date().toISOString(),
    compounds: {},
  };

  for (const { name, dir } of compounds) {
    report.compounds[name] = {};
    for (const site of SITE_CONFIGS) {
      report.compounds[name][site.fullSite] = summarizeSite(name, dir, site);
    }
  }

  const outputFile = process.argv[2] || path.join(DATA_ROOT, 'pipeline-audit.json');
  fs.writeFileSync(outputFile, JSON.stringify(report, null, 2) + '\n');

  for (const [compound, sites] of Object.entries(report.compounds)) {
    console.log(`\n${compound}`);
    for (const [siteName, summary] of Object.entries(sites)) {
      console.log(
        `  ${siteName}: listings=${summary.listings}, unique=${summary.unique_codes}, ` +
        `state_delta=${summary.delta_vs_pipeline_state}, legacy_delta=${summary.delta_vs_legacy_root}, ` +
        `cache_over_official=${summary.cache_over_official_count}, ` +
        `selected=${summary.selected_for_matching.official_manifests}/${summary.unique_codes}, ` +
        `manifest_over_official=${summary.selected_for_matching.manifests_over_official.length}, ` +
        `mosaics=${summary.mosaics.official_standard}/${summary.mosaics.official_expanded}` +
        ` official (${summary.mosaics.extra_standard}/${summary.mosaics.extra_expanded} extra)`
      );
    }
  }
  console.log(`\nWrote ${path.relative(REPO_ROOT, outputFile)}`);
}

main();
