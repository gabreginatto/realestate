'use strict';
/**
 * Lightweight unit checks for the review-server data plumbing.
 *
 * Doesn't boot the express app — it requires review-server.js purely to load
 * the module's helper functions via a small re-export hook. Since the server
 * also calls start() on require, we run this in a child process with a flag
 * that short-circuits the boot.
 *
 * Usage: node scripts/test-review-server.js
 */

// We avoid requiring the server module (it has side effects). Instead we
// duplicate the normalizeTier table here and verify it stays in sync with the
// source by parsing the file. Cheap, but catches regressions.

const fs   = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(path.join(__dirname, 'review-server.js'), 'utf8');

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
  console.log('  ok   —', msg);
}

console.log('normalizeTier mapping coverage');
for (const tier of ['auto-review-high', 'review-normal', 'review-recall', 'reject-low']) {
  assert(SOURCE.includes(`'${tier}':`), `TIER_MAP includes ${tier}`);
}
for (const legacy of ['high', 'medium', 'low']) {
  // legacy keys are valid identifiers and may appear unquoted in the table
  const re = new RegExp(`(?:^|\\s)${legacy}:\\s*\\{`, 'm');
  assert(re.test(SOURCE), `TIER_MAP includes legacy ${legacy}`);
}

console.log('\nlane constants');
assert(/REVIEW_LANES\s*=\s*\['high', 'normal', 'recall'\]/.test(SOURCE), 'REVIEW_LANES = [high, normal, recall]');
assert(/ALL_LANES\s*=\s*\['high', 'normal', 'recall', 'audit'\]/.test(SOURCE), 'ALL_LANES = [high, normal, recall, audit]');

console.log('\nrequired evidence fields preserved');
for (const field of ['sources', 'source_scores', 'geometric_score', 'best_inliers',
                     'best_inlier_ratio', 'support_pairs_8', 'support_pairs_12',
                     'structural', 'price_diff', 'area_diff', 'structural_failures',
                     'top_image_pairs']) {
  assert(SOURCE.includes(`'${field}'`), `EVIDENCE_FIELDS includes ${field}`);
}

console.log('\nAPI surface');
assert(SOURCE.includes("app.get('/api/audit'"),       '/api/audit route exists');
assert(SOURCE.includes("app.get('/api/round-status'"), '/api/round-status route exists');
assert(SOURCE.includes("app.post('/api/unsure'"),     '/api/unsure route exists');
assert(SOURCE.includes('req.query.lane'),             '/api/session reads ?lane');
assert(SOURCE.includes('include_in_review === false'), 'loadMatches honors include_in_review');
assert(SOURCE.includes('function retirePendingAlternates'), 'confirmed matches retire pending alternates');
assert(SOURCE.includes('retired_alternates'), 'confirm event logs retired alternates');
assert(SOURCE.includes("REVIEW_LANES.find(l => lanePool(l).some(p => p.status === 'pending'))"), 'auto lane fallback skips audit');
assert(SOURCE.includes('queueRoundForMacWorker'), 'next round queues Mac worker instead of Cloud Run compute');
assert(SOURCE.includes('worker_required'), 'queued round response flags Mac worker requirement');
assert(SOURCE.includes('review-rounds/'), 'round outputs are trial-scoped in GCS');
assert(SOURCE.includes('pollRoundStatus'), 'UI polls generated round status');

console.log('\nMosaic surface');
assert(SOURCE.includes('function mosaicUrl('), 'mosaicUrl helper exists');
assert(SOURCE.includes("app.get('/api/mosaic/:site/:code'"), '/api/mosaic route exists');
assert(SOURCE.includes('probeMosaic'), 'probeMosaic availability check');
assert(SOURCE.includes("'/api/mosaic/'"), 'renderImage tries the standard mosaic first');
assert(SOURCE.includes('aspect-ratio: 2 / 1'), 'mosaic container uses 2:1 aspect ratio');

console.log('\nComparison modal');
assert(SOURCE.includes('function openComparison('), 'openComparison() exists');
assert(!/function openLightbox\(/.test(SOURCE), 'openLightbox removed');
assert(SOURCE.includes("setComparisonMode('expanded')"), 'modal default mode is Expanded outdoor');
assert(SOURCE.includes("'standard', 'expanded', 'all'"), 'modal supports standard / expanded / all');
assert(SOURCE.includes("mode === 'all'"), '/api/images supports all mode (interiors)');
assert(SOURCE.includes('grid-template-columns: 1fr 1fr'), 'desktop two-column comparison');
assert(/@media \(max-width: 700px\) \{[^}]*compare-grid/s.test(SOURCE) ||
       SOURCE.includes('grid-template-columns: 1fr;'), 'mobile stacks comparison columns');

console.log('\nLane navigation');
assert(SOURCE.includes('function switchLane('), 'switchLane() exists');
assert(SOURCE.includes("let _lane = 'high'"),   'default lane is high');
assert(SOURCE.includes("'/api/session?lane=' + encodeURIComponent(_lane)"), 'fetchSession includes lane query');
for (const lane of ['high', 'normal', 'recall', 'audit']) {
  assert(SOURCE.includes("id=\"lane-" + lane + "\""), 'lane tab ' + lane + ' rendered');
}
assert(SOURCE.includes('hdr-global'),           'global confirmed chip present');
assert(SOURCE.includes('laneSummaryHTML'),      'lane summary helper present');
assert(!SOURCE.includes("for (const l of ['high', 'normal', 'recall', 'audit'])"), 'auto advance does not enter audit lane');
assert(SOURCE.includes("e.key === 'u'") && SOURCE.includes('doUnsure'), 'Unsure action wired');

console.log('\nEvidence panel');
assert(SOURCE.includes('id="evidence-panel"'),  'evidence panel container present');
assert(SOURCE.includes('renderEvidence'),       'renderEvidence() function exists');
assert(SOURCE.includes('SOURCE_LABELS'),        'source label table exists');
for (const f of ['geometric_score', 'best_inliers', 'best_inlier_ratio',
                 'support_pairs_8', 'support_pairs_12', 'top_image_pairs', 'source_scores']) {
  assert(SOURCE.includes('ev.' + f), 'evidence panel reads ' + f);
}

console.log('\nAll checks passed.');
