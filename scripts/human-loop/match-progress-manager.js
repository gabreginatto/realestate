#!/usr/bin/env node
/**
 * Match Progress Manager
 *
 * Tracks matching progress across multiple passes and manages state
 * for the iterative matching workflow.
 *
 * Responsibilities:
 * - Load and merge manual-matches.json (human decisions)
 * - Track which Viva listings are still unmatched
 * - Record pass metadata and criteria
 * - Generate progress statistics
 *
 * Usage:
 *   node scripts/human-loop/match-progress-manager.js analyze
 *   node scripts/human-loop/match-progress-manager.js remaining
 *   node scripts/human-loop/match-progress-manager.js stats
 */

const fs = require('fs');
const path = require('path');

// ============================================================================
// Configuration
// ============================================================================

const DATA_ROOT = process.env.DATA_ROOT || path.join(__dirname, '../../data');
const MANUAL_MATCHES_FILE = path.join(DATA_ROOT, 'manual-matches.json');
const DETERMINISTIC_MATCHES_FILE = path.join(DATA_ROOT, 'deterministic-matches.json');
const PROGRESS_FILE = path.join(DATA_ROOT, 'matching-progress.json');

// ============================================================================
// Progress State Management
// ============================================================================

class MatchProgressManager {
  constructor() {
    this.manualMatches = this.loadManualMatches();
    this.deterministicMatches = this.loadDeterministicMatches();
    this.progress = this.loadProgress();
  }

  loadManualMatches() {
    try {
      if (fs.existsSync(MANUAL_MATCHES_FILE)) {
        const data = JSON.parse(fs.readFileSync(MANUAL_MATCHES_FILE, 'utf-8'));
        console.log(`✓ Loaded manual-matches.json: ${data.matches?.length || 0} confirmed matches`);
        return data;
      }
    } catch (error) {
      console.warn(`⚠️  Error loading manual-matches.json: ${error.message}`);
    }
    return { matches: [], rejected: [], skipped: [] };
  }

  loadDeterministicMatches() {
    try {
      if (fs.existsSync(DETERMINISTIC_MATCHES_FILE)) {
        const data = JSON.parse(fs.readFileSync(DETERMINISTIC_MATCHES_FILE, 'utf-8'));
        console.log(`✓ Loaded deterministic-matches.json: ${data.candidate_pairs?.length || 0} pairs`);
        return data;
      }
    } catch (error) {
      console.warn(`⚠️  Error loading deterministic-matches.json: ${error.message}`);
    }
    return { candidate_pairs: [] };
  }

  loadProgress() {
    try {
      if (fs.existsSync(PROGRESS_FILE)) {
        const data = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
        console.log(`✓ Loaded matching-progress.json: Pass ${data.current_pass || 1}`);
        return data;
      }
    } catch (error) {
      console.warn(`⚠️  Error loading matching-progress.json: ${error.message}`);
    }

    // Initialize new progress file
    return {
      created_at: new Date().toISOString(),
      last_updated: new Date().toISOString(),
      current_pass: 1,
      passes: [],
      total_viva_listings: this.deterministicMatches.total_viva_listings || 0,
      matched_pairs: [],
      remaining_viva_codes: []
    };
  }

  saveProgress() {
    try {
      this.progress.last_updated = new Date().toISOString();
      fs.writeFileSync(PROGRESS_FILE, JSON.stringify(this.progress, null, 2));
      console.log(`✓ Saved matching-progress.json`);
    } catch (error) {
      console.error(`❌ Error saving matching-progress.json: ${error.message}`);
    }
  }

  // ============================================================================
  // Matching State Analysis
  // ============================================================================

  getAllVivaListings() {
    // Get all unique Viva codes from deterministic matches
    const vivaCodes = new Set();

    if (this.deterministicMatches.candidate_pairs) {
      for (const pair of this.deterministicMatches.candidate_pairs) {
        const code = pair.viva?.code || pair.viva?.propertyCode;
        if (code) vivaCodes.add(code);
      }
    }

    return Array.from(vivaCodes);
  }

  getMatchedVivaListings() {
    // Get Viva codes that have been matched by human
    const matched = new Set();

    if (this.manualMatches.matches) {
      for (const match of this.manualMatches.matches) {
        matched.add(match.viva_code);
      }
    }

    return Array.from(matched);
  }

  getSkippedVivaListings() {
    // Get Viva codes that were skipped (no match found)
    const skipped = new Set();

    if (this.manualMatches.skipped) {
      for (const skip of this.manualMatches.skipped) {
        skipped.add(skip.viva_code);
      }
    }

    return Array.from(skipped);
  }

  getRemainingVivaListings() {
    // Get Viva codes that still need matches
    const allViva = this.getAllVivaListings();
    const matched = new Set(this.getMatchedVivaListings());

    // For now, include skipped listings as "remaining" for next pass
    // (they might find matches with broader criteria)

    return allViva.filter(code => !matched.has(code));
  }

  getListingsWithNoCandidates() {
    // Get Viva codes that never got any candidates in any pass
    const allViva = this.getAllVivaListings();
    const withCandidates = new Set();

    if (this.deterministicMatches.candidate_pairs) {
      for (const pair of this.deterministicMatches.candidate_pairs) {
        if (pair.candidates && pair.candidates.length > 0) {
          const code = pair.viva?.code || pair.viva?.propertyCode;
          withCandidates.add(code);
        }
      }
    }

    return allViva.filter(code => !withCandidates.has(code));
  }

  // ============================================================================
  // Statistics & Reporting
  // ============================================================================

  getStats() {
    const allViva = this.getAllVivaListings();
    const matched = this.getMatchedVivaListings();
    const skipped = this.getSkippedVivaListings();
    const remaining = this.getRemainingVivaListings();
    const noCandidates = this.getListingsWithNoCandidates();

    return {
      total_viva_listings: allViva.length,
      matched: matched.length,
      skipped: skipped.length,
      remaining: remaining.length,
      no_candidates_ever: noCandidates.length,
      match_rate: allViva.length > 0 ? (matched.length / allViva.length * 100).toFixed(1) : 0,
      current_pass: this.progress.current_pass
    };
  }

  analyze() {
    console.log('\n' + '='.repeat(60));
    console.log('MATCHING PROGRESS ANALYSIS');
    console.log('='.repeat(60));

    const stats = this.getStats();

    console.log(`\n📊 Overall Statistics:`);
    console.log(`   Total Viva Listings: ${stats.total_viva_listings}`);
    console.log(`   ✅ Matched: ${stats.matched} (${stats.match_rate}%)`);
    console.log(`   ⊘ Skipped: ${stats.skipped}`);
    console.log(`   ⏳ Remaining: ${stats.remaining}`);
    console.log(`   ❌ No Candidates Ever: ${stats.no_candidates_ever}`);

    console.log(`\n🔄 Current Status:`);
    console.log(`   Pass Number: ${stats.current_pass}`);

    if (this.progress.passes && this.progress.passes.length > 0) {
      console.log(`\n📈 Pass History:`);
      for (const pass of this.progress.passes) {
        console.log(`\n   Pass ${pass.pass_number}:`);
        console.log(`     Criteria: Price ±${(pass.criteria.price_tolerance * 100).toFixed(0)}%, Area ±${(pass.criteria.area_tolerance * 100).toFixed(0)}%`);
        console.log(`     Results: ${pass.results.with_candidates} listings with candidates`);
        console.log(`     Human: ${pass.results.matched} matched, ${pass.results.rejected} rejected`);
      }
    }

    if (stats.remaining > 0) {
      console.log(`\n💡 Recommendation:`);
      console.log(`   Run Pass ${stats.current_pass + 1} with broader criteria`);
      console.log(`   Command: node scripts/iterative-matcher.js --pass ${stats.current_pass + 1}`);
    } else {
      console.log(`\n🎉 All listings processed!`);
    }

    console.log('\n' + '='.repeat(60) + '\n');
  }

  showRemaining() {
    const remaining = this.getRemainingVivaListings();

    console.log(`\n📋 Remaining Viva Listings (${remaining.length}):\n`);

    if (remaining.length === 0) {
      console.log('   ✅ All listings processed!\n');
    } else {
      remaining.sort().forEach((code, idx) => {
        console.log(`   ${(idx + 1).toString().padStart(3)}. ${code}`);
      });
      console.log();
    }
  }

  updatePassResults(passNumber, criteria, results) {
    // Record results from a matching pass
    const passData = {
      pass_number: passNumber,
      completed_at: new Date().toISOString(),
      criteria: criteria,
      results: results
    };

    // Update or add pass data
    const existingIdx = this.progress.passes.findIndex(p => p.pass_number === passNumber);
    if (existingIdx >= 0) {
      this.progress.passes[existingIdx] = passData;
    } else {
      this.progress.passes.push(passData);
    }

    this.progress.current_pass = passNumber;
    this.progress.remaining_viva_codes = this.getRemainingVivaListings();

    this.saveProgress();
  }
}

// ============================================================================
// CLI Interface
// ============================================================================

function main() {
  const command = process.argv[2] || 'analyze';

  const manager = new MatchProgressManager();

  switch (command) {
    case 'analyze':
      manager.analyze();
      break;

    case 'remaining':
      manager.showRemaining();
      break;

    case 'stats':
      const stats = manager.getStats();
      console.log(JSON.stringify(stats, null, 2));
      break;

    default:
      console.log(`
Usage: node match-progress-manager.js [command]

Commands:
  analyze    - Show detailed matching progress analysis
  remaining  - List remaining unmatched Viva codes
  stats      - Output statistics as JSON

Examples:
  node match-progress-manager.js analyze
  node match-progress-manager.js remaining > remaining-codes.txt
      `);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

// Export for use in other scripts
module.exports = MatchProgressManager;
