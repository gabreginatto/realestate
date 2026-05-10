#!/usr/bin/env node
'use strict';

/**
 * Prepare a Pass N review run using the same matcher stack as Pass 1.
 *
 * This script does not build a loose recall queue. It creates a filtered data
 * root containing only listings still eligible for matching. run-next-review-round.sh
 * then reruns the matcher stack with progressively relaxed thresholds.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const REPO_ROOT = path.resolve(__dirname, '..');
const DATA_ROOT = path.join(REPO_ROOT, 'data');

function argValue(args, name, fallback = null) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    lib.get(url, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode} from ${url}`));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`Could not parse JSON from ${url}: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

async function loadSummary(args) {
  const summaryPath = argValue(args, '--summary');
  const summaryUrl = argValue(args, '--summary-url');
  if (summaryPath) return readJson(path.resolve(summaryPath));
  if (summaryUrl) return fetchJson(summaryUrl);
  throw new Error('Provide --summary <file> or --summary-url <url>.');
}

function listingCode(listing) {
  return String(listing.propertyCode);
}

function loadListings(site) {
  const file = path.join(DATA_ROOT, site, 'listings', 'all-listings.json');
  const raw = readJson(file);
  return {
    file,
    payload: raw,
    listings: raw.listings || [],
  };
}

function pairKey(vivaCode, coelhoCode) {
  return `${vivaCode}::${coelhoCode}`;
}

function reviewedPairsFromSummary(summary) {
  const pairs = new Set();

  for (const p of summary.confirmed_matches || []) {
    if (p.viva_code && p.coelho_code) pairs.add(pairKey(String(p.viva_code), String(p.coelho_code)));
  }

  for (const p of summary.viva_without_confirmed_coelho || []) {
    if (p.viva_code && p.attempted_coelho_code) {
      pairs.add(pairKey(String(p.viva_code), String(p.attempted_coelho_code)));
    }
  }

  return pairs;
}

async function main() {
  const args = process.argv.slice(2);
  const round = Number(argValue(args, '--round', '2'));
  const filteredRoot = path.resolve(
    argValue(args, '--filtered-data-root', path.join(DATA_ROOT, 'review-rounds', `pass-${round}`, 'input'))
  );
  const reportPath = path.resolve(
    argValue(args, '--report', path.join(DATA_ROOT, `review-round-${round}-plan.json`))
  );
  const exclusionsPath = path.resolve(
    argValue(args, '--exclusions', path.join(DATA_ROOT, 'review-rounds', `pass-${round}`, 'exclusions.json'))
  );

  const summary = await loadSummary(args);
  const viva = loadListings('vivaprimeimoveis');
  const coelho = loadListings('coelhodafonseca');

  const confirmedViva = new Set((summary.confirmed_matches || []).map(p => String(p.viva_code)));
  const confirmedCoelho = new Set((summary.confirmed_matches || []).map(p => String(p.coelho_code)));
  const reviewedPairs = reviewedPairsFromSummary(summary);

  const filteredViva = viva.listings.filter(l => !confirmedViva.has(listingCode(l)));
  const filteredCoelho = coelho.listings.filter(l => !confirmedCoelho.has(listingCode(l)));

  writeJson(
    path.join(filteredRoot, 'vivaprimeimoveis', 'listings', 'all-listings.json'),
    { ...viva.payload, listings: filteredViva }
  );
  writeJson(
    path.join(filteredRoot, 'coelhodafonseca', 'listings', 'all-listings.json'),
    { ...coelho.payload, listings: filteredCoelho }
  );

  const exclusions = {
    generated_at: new Date().toISOString(),
    source_trial_run_id: summary.trial_run_id || null,
    source_pass: summary.pass || null,
    round,
    confirmed_viva_codes: [...confirmedViva].sort(),
    confirmed_coelho_codes: [...confirmedCoelho].sort(),
    reviewed_pair_keys: [...reviewedPairs].sort(),
  };
  writeJson(exclusionsPath, exclusions);

  const report = {
    generated_at: new Date().toISOString(),
    source_trial_run_id: summary.trial_run_id || null,
    source_pass: summary.pass || null,
    round,
    mode: 'progressive-filtered-rerun',
    filtered_data_root: filteredRoot,
    exclusions_file: exclusionsPath,
    total_viva: viva.listings.length,
    total_coelho: coelho.listings.length,
    confirmed_from_previous_rounds: confirmedViva.size,
    reviewed_pair_exclusions: reviewedPairs.size,
    remaining_viva: filteredViva.length,
    remaining_coelho: filteredCoelho.length,
  };
  writeJson(reportPath, report);
  console.log(JSON.stringify(report, null, 2));

  if (!filteredViva.length || !filteredCoelho.length) process.exitCode = 3;
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
