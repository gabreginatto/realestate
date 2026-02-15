#!/usr/bin/env node
/**
 * Matching Report Generator
 *
 * Generates comprehensive reports on matching progress across all passes.
 *
 * Features:
 * - Matching funnel visualization (pass 1 → pass 2 → pass 3...)
 * - Per-pass statistics
 * - Final match export for database
 * - Unmatched listings report
 *
 * Usage:
 *   node scripts/human-loop/matching-report.js
 *   node scripts/human-loop/matching-report.js --format json
 *   node scripts/human-loop/matching-report.js --export
 */

const fs = require('fs');
const path = require('path');
const MatchProgressManager = require('./match-progress-manager');

// ============================================================================
// Configuration
// ============================================================================

const DATA_ROOT = process.env.DATA_ROOT || path.join(__dirname, '../../data');
const MANUAL_MATCHES_FILE = path.join(DATA_ROOT, 'manual-matches.json');
const DETERMINISTIC_MATCHES_FILE = path.join(DATA_ROOT, 'deterministic-matches.json');
const PROGRESS_FILE = path.join(DATA_ROOT, 'matching-progress.json');
const FINAL_MATCHES_FILE = path.join(DATA_ROOT, 'final-matches.json');
const UNMATCHED_REPORT_FILE = path.join(DATA_ROOT, 'unmatched-report.json');

const args = process.argv.slice(2);
const format = args.find(a => a.startsWith('--format='))?.split('=')[1] || 'text';
const shouldExport = args.includes('--export');

// ============================================================================
// Report Generation
// ============================================================================

class MatchingReporter {
  constructor() {
    this.manager = new MatchProgressManager();
  }

  generateTextReport() {
    const stats = this.manager.getStats();
    const progress = this.manager.progress;

    let report = '\n' + '='.repeat(70) + '\n';
    report += 'PROPERTY MATCHING PROGRESS REPORT\n';
    report += '='.repeat(70) + '\n\n';

    // Overall Summary
    report += '📊 OVERALL SUMMARY\n';
    report += '-'.repeat(70) + '\n';
    report += `Total Viva Listings:        ${stats.total_viva_listings}\n`;
    report += `✅ Successfully Matched:     ${stats.matched} (${stats.match_rate}%)\n`;
    report += `⊘ Skipped (No Match):       ${stats.skipped}\n`;
    report += `⏳ Remaining to Review:      ${stats.remaining}\n`;
    report += `❌ Never Had Candidates:     ${stats.no_candidates_ever}\n\n`;

    // Pass-by-Pass Breakdown
    if (progress.passes && progress.passes.length > 0) {
      report += '🔄 MATCHING FUNNEL (BY PASS)\n';
      report += '-'.repeat(70) + '\n\n';

      for (const pass of progress.passes) {
        report += `Pass ${pass.pass_number} (${pass.criteria?.name || 'unknown'}):\n`;
        report += `  Date:              ${new Date(pass.completed_at).toLocaleString()}\n`;
        report += `  Criteria:          Price ±${(pass.criteria.price_tolerance * 100).toFixed(0)}%, `;
        report += `Area ±${(pass.criteria.area_tolerance * 100).toFixed(0)}%\n`;
        report += `  Target Listings:   ${pass.results.total_viva || 0}\n`;
        report += `  Found Candidates:  ${pass.results.with_candidates || 0} listings, `;
        report += `${pass.results.total_pairs || 0} pairs\n`;
        report += `  Human Matched:     ${pass.results.matched || 0}\n`;
        report += `  Human Rejected:    ${pass.results.rejected || 0}\n`;
        report += `  Success Rate:      ${pass.results.with_candidates > 0 ?
          ((pass.results.matched / pass.results.with_candidates) * 100).toFixed(1) : 0}%\n\n`;
      }
    }

    // Recommendations
    report += '💡 RECOMMENDATIONS\n';
    report += '-'.repeat(70) + '\n';

    if (stats.remaining > 0) {
      const nextPass = stats.current_pass + 1;
      report += `➤ ${stats.remaining} listings still need matches\n`;
      report += `  Run Pass ${nextPass} with broader criteria:\n`;
      report += `  $ node scripts/iterative-matcher.js --pass ${nextPass}\n\n`;
    } else if (stats.no_candidates_ever > 0) {
      report += `⚠️  ${stats.no_candidates_ever} listings never found candidates\n`;
      report += `  These may be:\n`;
      report += `  - Not listed on Coelho site\n`;
      report += `  - Recently sold/delisted\n`;
      report += `  - Data quality issues\n`;
      report += `  Review: node scripts/human-loop/matching-report.js --export\n\n`;
    } else {
      report += `🎉 All possible matches have been attempted!\n`;
      report += `  Export final results:\n`;
      report += `  $ node scripts/human-loop/matching-report.js --export\n\n`;
    }

    report += '='.repeat(70) + '\n\n';

    return report;
  }

  generateJSONReport() {
    const stats = this.manager.getStats();
    const progress = this.manager.progress;
    const manual = this.manager.manualMatches;

    return {
      generated_at: new Date().toISOString(),
      summary: stats,
      passes: progress.passes || [],
      matches: manual.matches || [],
      skipped: manual.skipped || [],
      rejected: manual.rejected || []
    };
  }

  exportFinalMatches() {
    console.log('\n📦 Exporting Final Matches...\n');

    const matches = this.manager.manualMatches.matches || [];
    const skipped = this.manager.manualMatches.skipped || [];
    const remaining = this.manager.getRemainingVivaListings();

    // Prepare final matches for database
    const finalMatches = {
      exported_at: new Date().toISOString(),
      total_matched: matches.length,
      matches: matches.map(m => ({
        viva_code: m.viva_code,
        coelho_code: m.coelho_code,
        matched_at: m.matched_at,
        reviewer: m.reviewer,
        confidence: m.confidence,
        ai_score: m.ai_score,
        time_spent_sec: m.time_spent_sec
      })),
      statistics: {
        total_viva_listings: this.manager.getAllVivaListings().length,
        matched: matches.length,
        skipped: skipped.length,
        remaining: remaining.length,
        match_rate: (matches.length / this.manager.getAllVivaListings().length * 100).toFixed(1) + '%'
      }
    };

    fs.writeFileSync(FINAL_MATCHES_FILE, JSON.stringify(finalMatches, null, 2));
    console.log(`✅ Exported ${matches.length} matches to:`);
    console.log(`   ${FINAL_MATCHES_FILE}\n`);

    // Export unmatched listings
    this.exportUnmatched();
  }

  exportUnmatched() {
    const remaining = this.manager.getRemainingVivaListings();
    const noCandidates = this.manager.getListingsWithNoCandidates();

    const unmatchedReport = {
      generated_at: new Date().toISOString(),
      total_unmatched: remaining.length,
      never_had_candidates: noCandidates,
      remaining_codes: remaining,
      recommendations: {
        next_pass: this.manager.progress.current_pass + 1,
        suggested_action: remaining.length > 0
          ? 'Run next pass with broader criteria'
          : 'Manual research for remaining listings'
      }
    };

    fs.writeFileSync(UNMATCHED_REPORT_FILE, JSON.stringify(unmatchedReport, null, 2));
    console.log(`✅ Exported ${remaining.length} unmatched listings to:`);
    console.log(`   ${UNMATCHED_REPORT_FILE}\n`);
  }
}

// ============================================================================
// Main Execution
// ============================================================================

function main() {
  const reporter = new MatchingReporter();

  if (shouldExport) {
    reporter.exportFinalMatches();
    return;
  }

  if (format === 'json') {
    const report = reporter.generateJSONReport();
    console.log(JSON.stringify(report, null, 2));
  } else {
    const report = reporter.generateTextReport();
    console.log(report);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = MatchingReporter;
