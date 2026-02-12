#!/usr/bin/env node
/**
 * Iterative Matcher
 *
 * Multi-pass deterministic matching system that progressively broadens
 * search criteria to find more candidate pairs.
 *
 * Features:
 * - Configurable pass criteria (price tolerance, area tolerance, etc.)
 * - Only matches remaining unmatched Viva listings
 * - Merges results with existing deterministic-matches.json
 * - Tracks pass metadata for audit trail
 *
 * Usage:
 *   node scripts/iterative-matcher.js --pass 1
 *   node scripts/iterative-matcher.js --pass 2
 *   node scripts/iterative-matcher.js --pass 3 --preview
 */

const fs = require('fs');
const path = require('path');
const MatchProgressManager = require('./human-loop/match-progress-manager');

// ============================================================================
// Configuration
// ============================================================================

const DATA_ROOT = process.env.DATA_ROOT || path.join(__dirname, '../data');
const LISTINGS_DIR = path.join(DATA_ROOT, 'listings');
const DETERMINISTIC_MATCHES_FILE = path.join(DATA_ROOT, 'deterministic-matches.json');

// Parse command line args
const args = process.argv.slice(2);
const passNumber = parseInt(args.find(a => a.startsWith('--pass='))?.split('=')[1] || args[args.indexOf('--pass') + 1] || '1');
const previewMode = args.includes('--preview') || args.includes('--dry-run');
const maxCandidates = parseInt(args.find(a => a.startsWith('--max='))?.split('=')[1] || '5');

// ============================================================================
// Pass Criteria Definitions
// ============================================================================

function getPassCriteria(passNum) {
  const criteria = {
    1: {
      name: 'strict',
      price_tolerance: 0.05,      // ±5%
      area_tolerance: 0.10,        // ±10%
      beds_tolerance: 0,           // exact match
      suites_tolerance: 0,         // exact match
      park_tolerance: 0            // exact match
    },
    2: {
      name: 'relaxed',
      price_tolerance: 0.10,       // ±10%
      area_tolerance: 0.15,        // ±15%
      beds_tolerance: 0,           // exact match
      suites_tolerance: 1,         // ±1
      park_tolerance: 999          // ignore
    },
    3: {
      name: 'broader',
      price_tolerance: 0.15,       // ±15%
      area_tolerance: 0.20,        // ±20%
      beds_tolerance: 1,           // ±1
      suites_tolerance: 999,       // ignore
      park_tolerance: 999          // ignore
    },
    4: {
      name: 'very_broad',
      price_tolerance: 0.25,       // ±25%
      area_tolerance: 0.30,        // ±30%
      beds_tolerance: 1,           // ±1
      suites_tolerance: 999,       // ignore
      park_tolerance: 999          // ignore
    },
    5: {
      name: 'exhaustive',
      price_tolerance: 0.40,       // ±40%
      area_tolerance: 0.50,        // ±50%
      beds_tolerance: 2,           // ±2
      suites_tolerance: 999,       // ignore
      park_tolerance: 999          // ignore
    }
  };

  return criteria[passNum] || criteria[5];
}

// ============================================================================
// Data Loading
// ============================================================================

function loadListings(site) {
  const listingsFile = path.join(LISTINGS_DIR, `${site}_listings.json`);

  if (!fs.existsSync(listingsFile)) {
    console.error(`❌ Error: ${listingsFile} not found!`);
    console.error(`   Please run the scrapers first to generate listings.`);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(listingsFile, 'utf-8'));
  return data.listings || [];
}

function loadExistingMatches() {
  if (fs.existsSync(DETERMINISTIC_MATCHES_FILE)) {
    return JSON.parse(fs.readFileSync(DETERMINISTIC_MATCHES_FILE, 'utf-8'));
  }

  return {
    generated_at: new Date().toISOString(),
    total_viva_listings: 0,
    listings_with_candidates: 0,
    total_candidate_pairs: 0,
    passes_completed: 0,
    candidate_pairs: []
  };
}

// ============================================================================
// Matching Logic
// ============================================================================

function parsePrice(priceStr) {
  if (!priceStr) return 0;
  // Handle Brazilian format: R$ 4.900.000,00
  return parseFloat(String(priceStr).replace(/R\$\s*/g, '').replace(/\./g, '').replace(/,/g, '.'));
}

function scoreCandidate(viva, coelho, criteria) {
  let score = 1.0;

  // Price check
  const vivaPrice = parsePrice(viva.price);
  const coelhoPrice = parsePrice(coelho.price);

  if (vivaPrice === 0 || coelhoPrice === 0) return 0;

  const priceDiff = Math.abs(vivaPrice - coelhoPrice) / vivaPrice;
  if (priceDiff > criteria.price_tolerance) return 0;  // hard cutoff
  score *= (1 - priceDiff / criteria.price_tolerance);  // closer = higher score

  // Area check
  if (viva.built && coelho.built) {
    const areaDiff = Math.abs(viva.built - coelho.built) / viva.built;
    if (areaDiff > criteria.area_tolerance) return 0;
    score *= (1 - areaDiff / criteria.area_tolerance);
  }

  // Beds check
  if (viva.beds && coelho.beds) {
    const bedsDiff = Math.abs(viva.beds - coelho.beds);
    if (bedsDiff > criteria.beds_tolerance) return 0;
    score *= bedsDiff === 0 ? 1.0 : 0.8;
  }

  // Suites check
  if (viva.suites && coelho.suites && criteria.suites_tolerance < 999) {
    const suitesDiff = Math.abs(viva.suites - coelho.suites);
    if (suitesDiff > criteria.suites_tolerance) return 0;
    score *= suitesDiff === 0 ? 1.0 : 0.9;
  }

  // Parking check
  if (viva.park && coelho.park && criteria.park_tolerance < 999) {
    const parkDiff = Math.abs(viva.park - coelho.park);
    if (parkDiff > criteria.park_tolerance) return 0;
    score *= parkDiff === 0 ? 1.0 : 0.95;
  }

  return score;
}

function findCandidatesForViva(viva, coelhoListings, criteria, maxCandidates) {
  const candidates = [];

  for (const coelho of coelhoListings) {
    const score = scoreCandidate(viva, coelho, criteria);

    if (score > 0) {
      candidates.push({
        ...coelho,
        score: parseFloat(score.toFixed(3))
      });
    }
  }

  // Sort by score (highest first) and take top N
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, maxCandidates);
}

// ============================================================================
// Main Matching Process
// ============================================================================

function runMatchingPass(passNum, remainingVivaCodes, criteria) {
  console.log(`\n🔄 Running Matching Pass ${passNum} (${criteria.name})`);
  console.log(`   Criteria: Price ±${(criteria.price_tolerance * 100).toFixed(0)}%, Area ±${(criteria.area_tolerance * 100).toFixed(0)}%`);
  console.log(`   Target: ${remainingVivaCodes.length} remaining Viva listings\n`);

  // Load listings
  const vivaListings = loadListings('vivaprimeimoveis');
  const coelhoListings = loadListings('coelhodafonseca');

  console.log(`✓ Loaded ${vivaListings.length} Viva listings`);
  console.log(`✓ Loaded ${coelhoListings.length} Coelho listings\n`);

  // Filter to only remaining Viva codes
  const remainingSet = new Set(remainingVivaCodes);
  const targetVivaListings = vivaListings.filter(v => remainingSet.has(v.code));

  console.log(`📍 Matching ${targetVivaListings.length} remaining Viva listings...\n`);

  // Find candidates for each remaining Viva listing
  const newPairs = [];
  let listingsWithCandidates = 0;
  let totalCandidatesFound = 0;

  for (const viva of targetVivaListings) {
    const candidates = findCandidatesForViva(viva, coelhoListings, criteria, maxCandidates);

    if (candidates.length > 0) {
      newPairs.push({
        viva: viva,
        candidates: candidates,
        pass_number: passNum,
        criteria: criteria.name
      });

      listingsWithCandidates++;
      totalCandidatesFound += candidates.length;

      console.log(`   ✓ ${viva.code}: Found ${candidates.length} candidates (best score: ${candidates[0].score.toFixed(3)})`);
    }
  }

  console.log(`\n📊 Pass ${passNum} Results:`);
  console.log(`   Viva listings with candidates: ${listingsWithCandidates} / ${targetVivaListings.length}`);
  console.log(`   Total candidate pairs: ${totalCandidatesFound}`);
  console.log(`   Average candidates per listing: ${listingsWithCandidates > 0 ? (totalCandidatesFound / listingsWithCandidates).toFixed(1) : 0}`);

  return {
    newPairs,
    stats: {
      target_viva: targetVivaListings.length,
      with_candidates: listingsWithCandidates,
      total_pairs: totalCandidatesFound
    }
  };
}

function mergeResults(existingMatches, newPairs, passNum) {
  // Merge new pairs with existing deterministic-matches.json
  const merged = { ...existingMatches };

  // Update metadata
  merged.generated_at = new Date().toISOString();
  merged.passes_completed = Math.max(merged.passes_completed || 0, passNum);

  // Get existing Viva codes
  const existingVivaCodes = new Set(
    (merged.candidate_pairs || []).map(p => p.viva?.code || p.viva?.propertyCode)
  );

  // Add only new pairs (avoid duplicates)
  for (const pair of newPairs) {
    const vivaCode = pair.viva?.code || pair.viva?.propertyCode;
    if (!existingVivaCodes.has(vivaCode)) {
      merged.candidate_pairs.push(pair);
    }
  }

  // Update counts
  merged.total_viva_listings = merged.candidate_pairs.length;
  merged.listings_with_candidates = merged.candidate_pairs.filter(p => p.candidates && p.candidates.length > 0).length;
  merged.total_candidate_pairs = merged.candidate_pairs.reduce((sum, p) => sum + (p.candidates?.length || 0), 0);

  return merged;
}

// ============================================================================
// Main Execution
// ============================================================================

function main() {
  console.log('\n' + '='.repeat(70));
  console.log('ITERATIVE DETERMINISTIC MATCHER');
  console.log('='.repeat(70));

  // Initialize progress manager
  const manager = new MatchProgressManager();
  const remainingVivaCodes = manager.getRemainingVivaListings();

  if (remainingVivaCodes.length === 0) {
    console.log('\n✅ All Viva listings have been matched!');
    console.log('   No further matching passes needed.\n');
    process.exit(0);
  }

  // Get criteria for this pass
  const criteria = getPassCriteria(passNumber);

  // Run matching pass
  const { newPairs, stats } = runMatchingPass(passNumber, remainingVivaCodes, criteria);

  if (newPairs.length === 0) {
    console.log(`\n⚠️  No new candidates found in Pass ${passNumber}`);
    console.log(`   Consider running Pass ${passNumber + 1} with broader criteria.\n`);
    process.exit(0);
  }

  if (previewMode) {
    console.log(`\n👁️  PREVIEW MODE - No files modified`);
    console.log(`   To apply changes, run without --preview flag\n`);
    process.exit(0);
  }

  // Load existing matches and merge
  const existingMatches = loadExistingMatches();
  const merged = mergeResults(existingMatches, newPairs, passNumber);

  // Save updated deterministic-matches.json
  fs.writeFileSync(DETERMINISTIC_MATCHES_FILE, JSON.stringify(merged, null, 2));
  console.log(`\n✅ Updated ${DETERMINISTIC_MATCHES_FILE}`);

  // Update progress tracking
  manager.updatePassResults(passNumber, criteria, {
    total_viva: stats.target_viva,
    with_candidates: stats.with_candidates,
    total_pairs: stats.total_pairs,
    matched: 0,  // Will be updated after human review
    rejected: 0  // Will be updated after human review
  });

  console.log(`\n💡 Next Steps:`);
  console.log(`   1. Review new candidates in matching interface:`);
  console.log(`      node scripts/human-loop/matching-server.js`);
  console.log(`      Open http://localhost:3000/matcher.html`);
  console.log(`   2. After human review, run Pass ${passNumber + 1}:`);
  console.log(`      node scripts/iterative-matcher.js --pass ${passNumber + 1}`);

  console.log('\n' + '='.repeat(70) + '\n');
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = { getPassCriteria, scoreCandidate, findCandidatesForViva };
