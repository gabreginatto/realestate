#!/usr/bin/env node
/**
 * Validate Matches - Cross-references matches against listings
 *
 * Usage:
 *   node scripts/validate-matches.js
 */
const fs = require('fs');
const path = require('path');

const DATA_ROOT = path.join(__dirname, '..', 'data');
// Also check scripts/human-loop/data as fallback
const HL_DATA_ROOT = path.join(__dirname, 'human-loop', 'data');

function findDataRoot() {
  // Check for listings in either location
  if (fs.existsSync(path.join(DATA_ROOT, 'listings'))) return DATA_ROOT;
  if (fs.existsSync(path.join(HL_DATA_ROOT, 'listings'))) return HL_DATA_ROOT;
  console.error('Could not find data directory with listings');
  process.exit(1);
}

const dataRoot = findDataRoot();

// Load listings
function loadListings(site) {
  const listingsFile = path.join(dataRoot, 'listings', `${site}_listings.json`);
  if (!fs.existsSync(listingsFile)) {
    console.error(`Listings file not found: ${listingsFile}`);
    return [];
  }
  try {
    const data = JSON.parse(fs.readFileSync(listingsFile, 'utf-8'));
    return data.listings || [];
  } catch (error) {
    console.error(`Error loading ${listingsFile}: ${error.message}`);
    return [];
  }
}

// Load manual matches
function loadMatches() {
  const matchesFile = path.join(dataRoot, 'manual-matches.json');
  if (!fs.existsSync(matchesFile)) {
    console.error(`Manual matches file not found: ${matchesFile}`);
    process.exit(1);
  }
  try {
    const data = JSON.parse(fs.readFileSync(matchesFile, 'utf-8'));
    return data.matches || [];
  } catch (error) {
    console.error(`Error loading manual matches: ${error.message}`);
    process.exit(1);
  }
}

const vivaListings = loadListings('vivaprimeimoveis');
const coelhoListings = loadListings('coelhodafonseca');
const matches = loadMatches();

console.log(`Loaded ${vivaListings.length} Viva listings`);
console.log(`Loaded ${coelhoListings.length} Coelho listings`);
console.log(`Loaded ${matches.length} matches to validate`);
console.log('');

// Build lookup sets and maps
const vivaCodeSet = new Set(vivaListings.map(l => l.code || l.propertyCode));
const coelhoCodeSet = new Set(coelhoListings.map(l => l.code || l.propertyCode));

const vivaMap = new Map();
for (const l of vivaListings) {
  vivaMap.set(l.code || l.propertyCode, l);
}
const coelhoMap = new Map();
for (const l of coelhoListings) {
  coelhoMap.set(l.code || l.propertyCode, l);
}

// Validate matches
const valid = [];
const invalid = [];
const duplicates = [];

const vivaMatchCount = {};
const coelhoMatchCount = {};

for (const match of matches) {
  const vivaExists = vivaCodeSet.has(match.viva_code);
  const coelhoExists = coelhoCodeSet.has(match.coelho_code);

  if (!vivaExists) {
    invalid.push({ match, reason: `viva_code '${match.viva_code}' not found in listings` });
  } else if (!coelhoExists) {
    invalid.push({ match, reason: `coelho_code '${match.coelho_code}' not found in listings` });
  } else {
    valid.push(match);
  }

  vivaMatchCount[match.viva_code] = (vivaMatchCount[match.viva_code] || 0) + 1;
  coelhoMatchCount[match.coelho_code] = (coelhoMatchCount[match.coelho_code] || 0) + 1;
}

// Detect duplicates
for (const [code, count] of Object.entries(vivaMatchCount)) {
  if (count > 1) {
    duplicates.push({
      code,
      type: 'viva',
      matches: matches.filter(m => m.viva_code === code)
    });
  }
}
for (const [code, count] of Object.entries(coelhoMatchCount)) {
  if (count > 1) {
    duplicates.push({
      code,
      type: 'coelho',
      matches: matches.filter(m => m.coelho_code === code)
    });
  }
}

// Print report
console.log('========================================');
console.log(' Match Validation Report');
console.log('========================================');
console.log(`Total matches: ${matches.length}`);
console.log(`Valid: ${valid.length}`);
console.log(`Invalid: ${invalid.length}`);
console.log(`Duplicates: ${duplicates.length}`);
console.log('');

if (invalid.length > 0) {
  console.log('INVALID MATCHES:');
  for (const entry of invalid) {
    console.log(`  - ${entry.match.viva_code} <-> ${entry.match.coelho_code}: ${entry.reason}`);
  }
  console.log('');
}

if (duplicates.length > 0) {
  console.log('DUPLICATE MATCHES:');
  for (const dup of duplicates) {
    const codes = dup.matches.map(m => dup.type === 'viva' ? m.coelho_code : m.viva_code).join(', ');
    console.log(`  - ${dup.type.toUpperCase()} ${dup.code} matched ${dup.matches.length} times (with: ${codes})`);
  }
  console.log('');
}

// Build enriched export data (only valid matches)
const enrichedMatches = valid.map(match => {
  const vivaListing = vivaMap.get(match.viva_code);
  const coelhoListing = coelhoMap.get(match.coelho_code);

  return {
    viva: vivaListing ? {
      code: match.viva_code,
      price: vivaListing.price,
      address: vivaListing.address,
      url: vivaListing.url,
      beds: vivaListing.beds,
      suites: vivaListing.suites,
      built: vivaListing.built,
      park: vivaListing.park
    } : { code: match.viva_code, error: 'listing not found' },
    coelho: coelhoListing ? {
      code: match.coelho_code,
      price: coelhoListing.price,
      address: coelhoListing.address,
      url: coelhoListing.url,
      beds: coelhoListing.beds,
      suites: coelhoListing.suites,
      built: coelhoListing.built,
      park: coelhoListing.park
    } : { code: match.coelho_code, error: 'listing not found' },
    matched_at: match.matched_at,
    reviewer: match.reviewer,
    ai_score: match.ai_score,
    confidence: match.confidence
  };
});

const outputFile = path.join(dataRoot, 'final-matches.json');
const exportData = {
  exported_at: new Date().toISOString(),
  total_matches: enrichedMatches.length,
  matches: enrichedMatches
};

console.log('ENRICHED DATA:');
console.log(`  Writing final-matches.json with ${enrichedMatches.length} valid matches...`);
fs.writeFileSync(outputFile, JSON.stringify(exportData, null, 2));
console.log('  Done!');
