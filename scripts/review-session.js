'use strict';
/**
 * review-session.js — session state for human review loop
 *
 * Sessions live in data/review-sessions/pass-N.json
 * Schema:
 *   {
 *     "pass": 1,
 *     "pairs": [{ "viva_code", "coelho_code", "similarity", "status" }],
 *     "confirmed": [...],
 *     "incorrect_pool": []
 *   }
 */

const fs   = require('fs');
const path = require('path');

const SESSIONS_DIR = path.join(__dirname, '..', 'data', 'review-sessions');

function sessionPath(passN) {
  return path.join(SESSIONS_DIR, `pass-${passN}.json`);
}

function loadSession(passN) {
  const p = sessionPath(passN);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function saveSession(passN, state) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.writeFileSync(sessionPath(passN), JSON.stringify(state, null, 2));
}

/**
 * Build pass-1 session from an auto-matches output file.
 * matchesFile: path to data/auto-matches.json
 */
function buildSession(matchesFile, passN = 1) {
  const raw = JSON.parse(fs.readFileSync(matchesFile, 'utf8'));
  const pairs = (raw.matches || []).map(m => ({
    viva_code:    String(m.viva_code),
    coelho_code:  String(m.coelho_code),
    similarity:   m.similarity_score ?? m.similarity ?? 0,
    confidence_score: m.confidence_score ?? m.similarity_score ?? m.similarity ?? 0,
    tier:         m.confidence ?? 'medium',
    pool_rank:    m.pool_rank ?? null,
    facade_rank:  m.facade_rank ?? null,
    status:       'pending',   // pending | confirmed | skipped
  }));

  // Sort by confidence_score (composite) so best candidates come first
  pairs.sort((a, b) => b.confidence_score - a.confidence_score);

  const state = {
    pass:           passN,
    created_at:     new Date().toISOString(),
    pairs,
    confirmed:      [],
    incorrect_pool: [],
  };

  saveSession(passN, state);
  return state;
}

/**
 * Build a subsequent-pass session from an auto-matches output file.
 * Carries forward confirmed pairs from all previous passes.
 */
function buildNextSession(autoMatchesFile, passN, previousConfirmed) {
  const raw = JSON.parse(fs.readFileSync(autoMatchesFile, 'utf8'));
  const pairs = (raw.matches || []).map(m => ({
    viva_code:   String(m.viva_code),
    coelho_code: String(m.coelho_code),
    similarity:  m.similarity_score ?? m.similarity ?? 0,
    status:      'pending',
  }));
  pairs.sort((a, b) => b.similarity - a.similarity);

  const state = {
    pass:           passN,
    created_at:     new Date().toISOString(),
    pairs,
    confirmed:      previousConfirmed,
    incorrect_pool: [],
  };

  saveSession(passN, state);
  return state;
}

/** Return the first pair with status === 'pending', or null */
function currentPair(state) {
  return state.pairs.find(p => p.status === 'pending') ?? null;
}

/** How many pairs are done (confirmed or skipped) */
function doneCount(state) {
  return state.pairs.filter(p => p.status !== 'pending').length;
}

/** Confirm the pair with the given codes → move to confirmed array */
function confirmPair(state, vivaCode, coelhoCode) {
  const pair = state.pairs.find(
    p => p.viva_code === vivaCode && p.coelho_code === coelhoCode
  );
  if (!pair) throw new Error(`Pair not found: ${vivaCode}/${coelhoCode}`);
  pair.status       = 'confirmed';
  pair.confirmed_at = new Date().toISOString();
  state.confirmed.push({ ...pair });
  saveSession(state.pass, state);
}

/** Skip the pair → move to incorrect_pool */
function skipPair(state, vivaCode, coelhoCode) {
  const pair = state.pairs.find(
    p => p.viva_code === vivaCode && p.coelho_code === coelhoCode
  );
  if (!pair) throw new Error(`Pair not found: ${vivaCode}/${coelhoCode}`);
  pair.status    = 'skipped';
  pair.skipped_at = new Date().toISOString();
  state.incorrect_pool.push({ ...pair });
  saveSession(state.pass, state);
}

/** Find the highest pass number that has a session file */
function latestPassN() {
  if (!fs.existsSync(SESSIONS_DIR)) return null;
  const files = fs.readdirSync(SESSIONS_DIR).filter(f => /^pass-\d+\.json$/.test(f));
  if (!files.length) return null;
  return Math.max(...files.map(f => parseInt(f.match(/\d+/)[0])));
}

module.exports = {
  loadSession,
  saveSession,
  buildSession,
  buildNextSession,
  currentPair,
  doneCount,
  confirmPair,
  skipPair,
  latestPassN,
  SESSIONS_DIR,
};
