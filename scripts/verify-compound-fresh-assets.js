#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { Storage } = require('@google-cloud/storage');

const REPO_ROOT = path.resolve(__dirname, '..');
const DATA_ROOT = path.join(REPO_ROOT, 'data');
const IMG_RE = /\.(jpe?g|png|webp)$/i;
const SITES = [
  { key: 'viva', short: 'viva', fullSite: 'vivaprimeimoveis' },
  { key: 'coelho', short: 'coelho', fullSite: 'coelhodafonseca' },
];

function argValue(args, name, fallback = null) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}

function hasFlag(args, name) {
  return args.includes(name);
}

function normalizeBucket(value) {
  return String(value || '').replace(/^gs:\/\//, '').replace(/\/+$/, '');
}

function safeSegment(value) {
  return String(value || '').replace(/[^A-Za-z0-9._-]/g, '_');
}

function listCompounds(compoundArg) {
  if (compoundArg !== 'all') return [compoundArg];
  return fs.readdirSync(DATA_ROOT)
    .filter((name) => {
      const dir = path.join(DATA_ROOT, name);
      return fs.statSync(dir).isDirectory()
        && !['vivaprimeimoveis', 'coelhodafonseca', 'review-rounds', 'legacy', 'raw', 'processed'].includes(name)
        && fs.existsSync(path.join(dir, 'fresh-listings'));
    })
    .sort((a, b) => a.localeCompare(b));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function listingCode(listing) {
  return String(listing.propertyCode || listing.code || listing.id || '').trim();
}

function imageFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => IMG_RE.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function walkFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(file);
      else if (entry.isFile()) files.push(file);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function fileSize(file) {
  try { return fs.statSync(file).size; }
  catch (_) { return 0; }
}

async function gcsExists(bucket, name) {
  const [exists] = await bucket.file(name).exists();
  return exists;
}

async function verifyGcsFiles(bucket, files) {
  const missing = [];
  await mapLimit(files, 24, async (file) => {
    if (!(await gcsExists(bucket, file))) missing.push(file);
  });
  return missing.sort();
}

async function mapLimit(items, limit, worker) {
  let next = 0;
  async function run() {
    while (next < items.length) {
      const index = next++;
      await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

function siteExpectedFiles(compound, site, options) {
  const compoundDir = path.join(DATA_ROOT, compound);
  const listingFile = path.join(compoundDir, 'fresh-listings', `${site.fullSite}.json`);
  const issues = [];
  const expectedLocal = [];
  const expectedGcs = [];
  const listings = fs.existsSync(listingFile) ? (readJson(listingFile).listings || []) : [];

  if (!fs.existsSync(listingFile)) {
    issues.push({ severity: 'error', code: null, type: 'missing_listing_file', path: path.relative(REPO_ROOT, listingFile) });
    return { listings, issues, expectedLocal, expectedGcs };
  }

  expectedLocal.push(listingFile);
  expectedGcs.push(`${options.prefix}/${safeSegment(compound)}/fresh-listings/${site.fullSite}.json`);

  for (const listing of listings) {
    const code = listingCode(listing);
    const declaredImages = Array.isArray(listing.images) ? listing.images.length : 0;
    if (!code) {
      issues.push({ severity: 'error', code: null, type: 'missing_code' });
      continue;
    }
    if (declaredImages < 1) {
      issues.push({ severity: 'error', code, type: 'listing_has_no_scraped_image_urls' });
    }

    const imageDir = path.join(compoundDir, 'fresh-images', site.fullSite, code);
    const images = imageFiles(imageDir);
    if (images.length < declaredImages) {
      issues.push({
        severity: 'error',
        code,
        type: 'missing_local_images',
        expected: declaredImages,
        actual: images.length,
        dir: path.relative(REPO_ROOT, imageDir),
      });
    }
    for (const image of images) {
      const local = path.join(imageDir, image);
      expectedLocal.push(local);
      expectedGcs.push(`${options.prefix}/${safeSegment(compound)}/fresh-images/${site.fullSite}/${code}/${image}`);
      if (fileSize(local) < 1) {
        issues.push({ severity: 'error', code, type: 'zero_byte_image', path: path.relative(REPO_ROOT, local) });
      }
    }

    if (options.requireSelected) {
      const selectedDir = path.join(compoundDir, 'selected-for-matching-fresh', site.fullSite, code);
      const manifest = path.join(selectedDir, '_manifest.json');
      if (!fs.existsSync(manifest)) {
        issues.push({ severity: 'error', code, type: 'missing_selected_manifest', path: path.relative(REPO_ROOT, manifest) });
      } else {
        for (const selectedFile of walkFiles(selectedDir)) {
          const rel = path.relative(selectedDir, selectedFile).split(path.sep).join('/');
          expectedLocal.push(selectedFile);
          expectedGcs.push(`${options.prefix}/${safeSegment(compound)}/selected-for-matching-fresh/${site.fullSite}/${code}/${rel}`);
          if (fileSize(selectedFile) < 1) {
            issues.push({ severity: 'error', code, type: 'zero_byte_selected_asset', path: path.relative(REPO_ROOT, selectedFile) });
          }
        }
      }
    }

    if (options.requireMosaics) {
      for (const suffix of ['', '_full']) {
        const mosaic = path.join(compoundDir, 'fresh-mosaics', site.short, `${code}${suffix}.png`);
        if (!fs.existsSync(mosaic)) {
          issues.push({ severity: 'error', code, type: `missing_${suffix ? 'expanded' : 'standard'}_mosaic`, path: path.relative(REPO_ROOT, mosaic) });
        } else {
          expectedLocal.push(mosaic);
          expectedGcs.push(`${options.prefix}/${safeSegment(compound)}/fresh-mosaics/${site.short}/${code}${suffix}.png`);
        }
      }
    }
  }

  return { listings, issues, expectedLocal, expectedGcs };
}

async function main() {
  const args = process.argv.slice(2);
  const compoundArg = argValue(args, '--compound', 'all');
  const bucketName = normalizeBucket(argValue(args, '--bucket', process.env.GCS_BUCKET || 'realestate-475615-data'));
  const prefix = argValue(args, '--prefix', 'compounds').replace(/^\/+|\/+$/g, '');
  const requireGcs = hasFlag(args, '--require-gcs');
  const requireSelected = hasFlag(args, '--require-selected');
  const requireMosaics = hasFlag(args, '--require-mosaics');
  const compounds = listCompounds(compoundArg);
  const storage = new Storage();
  const bucket = storage.bucket(bucketName);
  const report = {
    generated_at: new Date().toISOString(),
    bucket: bucketName,
    prefix,
    require_gcs: requireGcs,
    require_selected: requireSelected,
    require_mosaics: requireMosaics,
    compounds: {},
    totals: {
      listings: 0,
      local_expected_files: 0,
      gcs_expected_files: 0,
      issues: 0,
      missing_gcs_files: 0,
    },
  };

  for (const compound of compounds) {
    report.compounds[compound] = {};
    console.log(`\n${compound}`);
    for (const site of SITES) {
      const summary = siteExpectedFiles(compound, site, { prefix, requireSelected, requireMosaics });
      let missingGcs = [];
      if (requireGcs) {
        missingGcs = await verifyGcsFiles(bucket, summary.expectedGcs);
      }
      const siteReport = {
        listings: summary.listings.length,
        local_expected_files: summary.expectedLocal.length,
        gcs_expected_files: summary.expectedGcs.length,
        issues: summary.issues,
        missing_gcs_files: missingGcs,
      };
      report.compounds[compound][site.fullSite] = siteReport;
      report.totals.listings += siteReport.listings;
      report.totals.local_expected_files += siteReport.local_expected_files;
      report.totals.gcs_expected_files += siteReport.gcs_expected_files;
      report.totals.issues += siteReport.issues.length;
      report.totals.missing_gcs_files += siteReport.missing_gcs_files.length;
      console.log(
        `  ${site.fullSite}: listings=${siteReport.listings}, ` +
        `local_files=${siteReport.local_expected_files}, issues=${siteReport.issues.length}, ` +
        `missing_gcs=${siteReport.missing_gcs_files.length}`
      );
    }
  }

  const output = argValue(args, '--output', path.join(DATA_ROOT, 'compound-fresh-assets-verification.json'));
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nWrote ${path.relative(REPO_ROOT, output)}`);

  if (report.totals.issues || report.totals.missing_gcs_files) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
