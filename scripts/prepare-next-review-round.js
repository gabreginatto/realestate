#!/usr/bin/env node
'use strict';

/**
 * Build the next human-review round from the previous review summary.
 *
 * This script does not run new vision inference. It turns the existing candidate
 * pools into a focused next-round queue by removing confirmed matches and pairs
 * already reviewed in the previous round.
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

function hasArg(args, name) {
  return args.includes(name);
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

  const defaults = [
    path.join(DATA_ROOT, 'review-final-summary.json'),
    path.join(DATA_ROOT, 'trial-summary.json'),
    path.join(DATA_ROOT, 'review-round-1-summary.json'),
  ];
  for (const f of defaults) {
    if (fs.existsSync(f)) return readJson(f);
  }
  throw new Error('Provide --summary <file> or --summary-url <url>.');
}

function listingCodes(file) {
  const raw = readJson(file);
  return new Set((raw.listings || []).map(l => String(l.propertyCode)));
}

function rawMatchesFromFile(file) {
  const raw = readJson(file);
  const items = [];
  if (Array.isArray(raw.all_candidates)) items.push(...raw.all_candidates);
  if (Array.isArray(raw.matches)) items.push(...raw.matches);
  if (raw.matches && !Array.isArray(raw.matches)) {
    for (const [viva_code, value] of Object.entries(raw.matches)) {
      items.push({ viva_code, ...value });
    }
  }
  return items.map(m => ({ ...m, _candidate_source_file: path.basename(file) }));
}

function candidateFiles(outputFile) {
  const outputBase = path.basename(outputFile);
  return fs.readdirSync(DATA_ROOT)
    .filter(name => /^auto-matches.*\.json$/.test(name))
    .filter(name => name !== outputBase)
    .filter(name => !/^auto-matches-round-\d+\.json$/.test(name))
    .map(name => path.join(DATA_ROOT, name));
}

function numeric(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function scoreCandidate(m) {
  const scores = [
    numeric(m.confidence_score),
    numeric(m.similarity_score),
    numeric(m.similarity),
    numeric(m.confidence),
    numeric(m.geometric_score),
  ];
  if (m.source_scores && typeof m.source_scores === 'object') {
    for (const v of Object.values(m.source_scores)) scores.push(numeric(v));
  }
  return Math.max(0, ...scores.filter(v => v !== null));
}

function normalizeCandidate(m, round) {
  const score = scoreCandidate(m);
  const sources = new Set(Array.isArray(m.sources) ? m.sources : []);
  if (m.reviewer) sources.add(m.reviewer);
  if (m._candidate_source_file) sources.add(m._candidate_source_file.replace(/^auto-matches-/, '').replace(/\.json$/, ''));

  const geo = numeric(m.geometric_score) || 0;
  const hasMegaLoc = sources.has('megaloc') || !!(m.source_scores && m.source_scores.megaloc != null);
  let tier = 'review-recall';
  if ((hasMegaLoc && geo >= 0.55) || (score >= 0.82 && geo >= 0.35)) tier = 'auto-review-high';
  else if (hasMegaLoc || geo >= 0.30 || score >= 0.45) tier = 'review-normal';

  return {
    ...m,
    viva_code: String(m.viva_code || ''),
    coelho_code: String(m.coelho_code || ''),
    sources: [...sources].filter(Boolean).sort(),
    similarity: m.similarity ?? m.similarity_score ?? m.confidence_score ?? score,
    confidence_score: m.confidence_score ?? score,
    tier,
    include_in_review: true,
    round,
    reviewer: 'round-recall-generator',
    matched_at: new Date().toISOString(),
    round_candidate_score: score,
  };
}

function mergeCandidate(existing, next) {
  const best = (next.round_candidate_score || 0) > (existing.round_candidate_score || 0) ? next : existing;
  const sources = new Set([...(existing.sources || []), ...(next.sources || [])]);
  const sourceScores = { ...(existing.source_scores || {}), ...(next.source_scores || {}) };
  return {
    ...best,
    sources: [...sources].filter(Boolean).sort(),
    source_scores: Object.keys(sourceScores).length ? sourceScores : best.source_scores,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const round = Number(argValue(args, '--round', '2'));
  const topK = Number(argValue(args, '--top-k', '3'));
  const minScore = Number(argValue(args, '--min-score', '0.08'));
  const output = path.resolve(argValue(args, '--output', path.join(DATA_ROOT, `auto-matches-round-${round}.json`)));
  const reportPath = path.resolve(argValue(args, '--report', path.join(DATA_ROOT, `review-round-${round}-plan.json`)));
  const dryRun = hasArg(args, '--dry-run');

  const summary = await loadSummary(args);
  const vivaCodes = listingCodes(path.join(DATA_ROOT, 'vivaprimeimoveis/listings/all-listings.json'));
  const coelhoCodes = listingCodes(path.join(DATA_ROOT, 'coelhodafonseca/listings/all-listings.json'));

  const confirmedViva = new Set((summary.confirmed_matches || []).map(p => String(p.viva_code)));
  const confirmedCoelho = new Set((summary.confirmed_matches || []).map(p => String(p.coelho_code)));
  const reviewedPairs = new Set([
    ...(summary.confirmed_matches || []),
    ...(summary.viva_without_confirmed_coelho || []).map(p => ({
      viva_code: p.viva_code,
      coelho_code: p.attempted_coelho_code,
    })),
  ].filter(p => p.viva_code && p.coelho_code).map(p => `${p.viva_code}::${p.coelho_code}`));

  const pendingViva = [...vivaCodes].filter(code => !confirmedViva.has(code)).sort((a, b) => Number(a) - Number(b));
  const availableCoelho = new Set([...coelhoCodes].filter(code => !confirmedCoelho.has(code)));

  const dedup = new Map();
  for (const file of candidateFiles(output)) {
    for (const raw of rawMatchesFromFile(file)) {
      const candidate = normalizeCandidate(raw, round);
      if (!pendingViva.includes(candidate.viva_code)) continue;
      if (!availableCoelho.has(candidate.coelho_code)) continue;
      if (reviewedPairs.has(`${candidate.viva_code}::${candidate.coelho_code}`)) continue;
      if ((candidate.round_candidate_score || 0) < minScore) continue;
      const key = `${candidate.viva_code}::${candidate.coelho_code}`;
      dedup.set(key, dedup.has(key) ? mergeCandidate(dedup.get(key), candidate) : candidate);
    }
  }

  const byViva = new Map();
  for (const candidate of dedup.values()) {
    if (!byViva.has(candidate.viva_code)) byViva.set(candidate.viva_code, []);
    byViva.get(candidate.viva_code).push(candidate);
  }

  const matches = [];
  for (const vivaCode of pendingViva) {
    const candidates = (byViva.get(vivaCode) || [])
      .sort((a, b) => (b.round_candidate_score || 0) - (a.round_candidate_score || 0))
      .slice(0, topK)
      .map((m, i) => ({ ...m, pool_rank: i + 1 }));
    matches.push(...candidates);
  }

  const coveredViva = new Set(matches.map(m => m.viva_code));
  const report = {
    generated_at: new Date().toISOString(),
    source_trial_run_id: summary.trial_run_id || null,
    source_pass: summary.pass || null,
    round,
    top_k_per_viva: topK,
    min_score: minScore,
    total_viva: vivaCodes.size,
    total_coelho: coelhoCodes.size,
    confirmed_from_previous_rounds: confirmedViva.size,
    pending_viva: pendingViva.length,
    pending_viva_with_candidates: coveredViva.size,
    pending_viva_without_candidates: pendingViva.length - coveredViva.size,
    reviewed_unmatched_from_previous_round: (summary.viva_without_confirmed_coelho || []).length,
    emitted_candidate_pairs: matches.length,
    straggler_viva_codes: pendingViva.filter(code => !coveredViva.has(code)),
  };

  const outputJson = {
    session_started: new Date().toISOString(),
    session_name: `alphaville-1-round-${round}`,
    strategy: 'next-round-recall-from-unreviewed-candidate-pool',
    round,
    source_trial_run_id: summary.trial_run_id || null,
    policy: {
      confirmed_viva_removed: true,
      confirmed_coelho_removed: true,
      previously_reviewed_pairs_removed: true,
      top_k_per_pending_viva: topK,
      min_score: minScore,
    },
    matches,
    stats: report,
  };

  if (!dryRun) {
    writeJson(output, outputJson);
    writeJson(reportPath, report);
  }

  console.log(JSON.stringify(report, null, 2));
  if (!matches.length) process.exitCode = 3;
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
