#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const { Storage } = require('@google-cloud/storage');

const REPO_ROOT = path.resolve(__dirname, '..');
const DATA_ROOT = path.join(REPO_ROOT, 'data');
const MATCHING_LOCK_PATH = path.join(DATA_ROOT, '.local-matching-run.json');
const SITES = ['vivaprimeimoveis', 'coelhodafonseca'];
const MOSAIC_SITE = { vivaprimeimoveis: 'viva', coelhodafonseca: 'coelho' };
const COMMUNITY_NAMES = {
  'alphaville-1': 'Alphaville 1',
  'tambore-xi': 'Tambore XI',
};

function argValue(args, name, fallback = '') {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}

function hasFlag(args, name) {
  return args.includes(name);
}

function normalizeBucket(value) {
  return String(value || '').replace(/^gs:\/\//, '').replace(/\/+$/, '');
}

function safeSegment(value, fallback = 'no-session') {
  return String(value || fallback).replace(/[^A-Za-z0-9._-]/g, '_');
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function writeLocalLock(compound, round) {
  writeJson(MATCHING_LOCK_PATH, {
    state: 'running',
    source: 'run-community-matching',
    compound,
    round,
    pid: process.pid,
    label: `Run matching (${COMMUNITY_NAMES[compound] || compound})`,
    started_at: new Date().toISOString(),
  });
}

function clearLocalLock() {
  const lock = readJson(MATCHING_LOCK_PATH, null);
  if (lock?.pid === process.pid) {
    try { fs.unlinkSync(MATCHING_LOCK_PATH); } catch (_) {}
  }
}

function listingCode(listing) {
  return String(listing.propertyCode || listing.code || '');
}

function run(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    console.log(`$ ${[command, ...args].join(' ')}`);
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      env: { ...process.env, ...env },
    });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    lib.get(url, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode} from ${url}`));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch (err) { reject(new Error(`Could not parse JSON from ${url}: ${err.message}`)); }
      });
    }).on('error', reject);
  });
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.request(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode} from ${url}: ${text.slice(0, 300)}`));
          return;
        }
        try { resolve(text ? JSON.parse(text) : {}); }
        catch (_) { resolve({}); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function mapLimit(items, limit, worker) {
  let next = 0;
  async function runNext() {
    while (next < items.length) {
      const index = next++;
      await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
}

function walkFiles(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(file);
      else if (entry.isFile()) out.push(file);
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

async function uploadFile(bucket, localPath, destination, uploaded) {
  if (!fs.existsSync(localPath)) return;
  await bucket.upload(localPath, { destination });
  uploaded.push(destination);
}

async function uploadDirectory(bucket, localDir, destinationPrefix, uploaded, concurrency) {
  const files = walkFiles(localDir);
  await mapLimit(files, concurrency, async (file) => {
    const rel = path.relative(localDir, file).split(path.sep).join('/');
    const destination = `${destinationPrefix}/${rel}`;
    await bucket.upload(file, { destination });
    uploaded.push(destination);
  });
}

async function readGcsJson(bucket, gcsPath) {
  const [contents] = await bucket.file(gcsPath).download();
  return JSON.parse(contents.toString());
}

async function writeStatus(bucket, gcsPath, patch) {
  if (!gcsPath) return;
  let previous = {};
  try { previous = await readGcsJson(bucket, gcsPath); }
  catch (_) { previous = {}; }
  await bucket.file(gcsPath).save(JSON.stringify({
    ...previous,
    ...patch,
    updated_at: new Date().toISOString(),
  }, null, 2), { contentType: 'application/json' });
}

async function loadSummary(args, bucket) {
  const summaryPath = argValue(args, '--summary');
  const summaryUrl = argValue(args, '--summary-url');
  const summaryGcsPath = argValue(args, '--summary-gcs-path');
  if (summaryPath) return readJson(path.resolve(summaryPath));
  if (summaryGcsPath) return readGcsJson(bucket, summaryGcsPath);
  if (summaryUrl) return fetchJson(summaryUrl);
  return null;
}

function loadCommunityPayload(compound, site) {
  const candidates = [
    path.join(DATA_ROOT, compound, 'fresh-listings', `${site}.json`),
    path.join(DATA_ROOT, compound, 'live-listing-inventory', `${site}.json`),
    path.join(DATA_ROOT, compound, site, 'listings', 'all-listings.json'),
  ];
  for (const file of candidates) {
    const payload = readJson(file);
    if (payload && Array.isArray(payload.listings)) {
      return { file, payload, listings: payload.listings };
    }
  }
  throw new Error(`No listings found for ${compound}/${site}`);
}

function reviewedPairsFromSummary(summary) {
  const pairs = new Set();
  for (const item of summary?.confirmed_matches || []) {
    if (item.viva_code && item.coelho_code) {
      pairs.add(`${item.viva_code}::${item.coelho_code}`);
    }
  }
  for (const item of summary?.viva_without_confirmed_coelho || []) {
    if (item.viva_code && item.attempted_coelho_code) {
      pairs.add(`${item.viva_code}::${item.attempted_coelho_code}`);
    }
  }
  return pairs;
}

function prepareInput({ compound, round, summary, runRoot }) {
  const inputRoot = path.join(runRoot, 'input');
  const viva = loadCommunityPayload(compound, 'vivaprimeimoveis');
  const coelho = loadCommunityPayload(compound, 'coelhodafonseca');
  const confirmedViva = new Set((summary?.confirmed_matches || []).map(p => String(p.viva_code)));
  const confirmedCoelho = new Set((summary?.confirmed_matches || []).map(p => String(p.coelho_code)));
  const reviewedPairs = reviewedPairsFromSummary(summary);
  const filteredViva = viva.listings.filter(l => !confirmedViva.has(listingCode(l)));
  const filteredCoelho = coelho.listings.filter(l => !confirmedCoelho.has(listingCode(l)));

  writeJson(
    path.join(inputRoot, 'vivaprimeimoveis', 'listings', 'all-listings.json'),
    { ...viva.payload, listings: filteredViva }
  );
  writeJson(
    path.join(inputRoot, 'coelhodafonseca', 'listings', 'all-listings.json'),
    { ...coelho.payload, listings: filteredCoelho }
  );

  const exclusionsPath = path.join(runRoot, 'exclusions.json');
  writeJson(exclusionsPath, {
    generated_at: new Date().toISOString(),
    compound,
    source_trial_run_id: summary?.trial_run_id || null,
    source_pass: summary?.pass || null,
    round,
    confirmed_viva_codes: [...confirmedViva].sort(),
    confirmed_coelho_codes: [...confirmedCoelho].sort(),
    reviewed_pair_keys: [...reviewedPairs].sort(),
  });

  const reportPath = path.join(runRoot, `review-round-${round}-plan.json`);
  const report = {
    generated_at: new Date().toISOString(),
    compound,
    community_name: COMMUNITY_NAMES[compound] || compound,
    round,
    mode: summary ? 'community-filtered-rerun' : 'community-first-pass',
    filtered_data_root: inputRoot,
    exclusions_file: exclusionsPath,
    total_viva: viva.listings.length,
    total_coelho: coelho.listings.length,
    confirmed_from_previous_rounds: confirmedViva.size,
    reviewed_pair_exclusions: reviewedPairs.size,
    remaining_viva: filteredViva.length,
    remaining_coelho: filteredCoelho.length,
    source_files: {
      vivaprimeimoveis: path.relative(REPO_ROOT, viva.file),
      coelhodafonseca: path.relative(REPO_ROOT, coelho.file),
    },
  };
  writeJson(reportPath, report);

  if (!filteredViva.length || !filteredCoelho.length) {
    throw new Error(`Nothing to match for ${compound}: ${filteredViva.length} Viva and ${filteredCoelho.length} Coelho remaining`);
  }

  return { inputRoot, exclusionsPath, reportPath, report, viva, coelho };
}

function thresholdFor(round, kind) {
  const n = Number(round);
  const table = {
    megaloc: { 1: '0.525', 2: '0.450', 3: '0.400', default: '0.350' },
    patch: { 1: '0.425', 2: '0.350', 3: '0.300', default: '0.250' },
    highScore: { 1: '0.760', 2: '0.700', 3: '0.620', default: '0.550' },
    highInliers: { 1: '20', 2: '14', 3: '10', default: '8' },
  };
  return table[kind][n] || table[kind].default;
}

function annotateOutput(file, meta) {
  const payload = readJson(file, {});
  payload.compound = meta.compound;
  payload.community_name = COMMUNITY_NAMES[meta.compound] || meta.compound;
  payload.round = meta.round;
  payload.generated_for = 'community-review';
  payload.selected_root = path.relative(REPO_ROOT, meta.selectedRoot);
  payload.matches = (payload.matches || []).map(match => ({
    ...match,
    compound: meta.compound,
    community_name: COMMUNITY_NAMES[meta.compound] || meta.compound,
  }));
  writeJson(file, payload);
}

async function publishArtifacts({ args, bucket, bucketName, compound, round, runRoot, output, input, uploaded }) {
  const concurrency = Number(argValue(args, '--upload-concurrency', '16'));
  const trialRunId = argValue(args, '--trial-run-id');
  const artifactPrefix = argValue(args, '--artifact-prefix')
    || (trialRunId ? `review-rounds/${safeSegment(trialRunId)}/pass-${round}` : '');
  const communityPrefix = `compounds/${safeSegment(compound)}/review-rounds/pass-${round}`;

  await uploadFile(bucket, output, 'matches/auto-matches.json', uploaded);
  await uploadFile(bucket, output, `matches/auto-matches-round-${round}.json`, uploaded);
  await uploadFile(bucket, output, `${communityPrefix}/auto-matches-round-${round}.json`, uploaded);
  await uploadFile(bucket, input.reportPath, `${communityPrefix}/review-round-${round}-plan.json`, uploaded);
  await uploadFile(bucket, input.exclusionsPath, `${communityPrefix}/exclusions.json`, uploaded);
  await uploadDirectory(bucket, runRoot, `${communityPrefix}/artifacts`, uploaded, concurrency);

  if (artifactPrefix) {
    await uploadFile(bucket, output, `${artifactPrefix}/auto-matches-round-${round}.json`, uploaded);
    await uploadDirectory(bucket, runRoot, `${artifactPrefix}/artifacts`, uploaded, concurrency);
  }

  for (const site of SITES) {
    await uploadFile(
      bucket,
      path.join(DATA_ROOT, compound, 'fresh-listings', `${site}.json`),
      `listings/${site}.json`,
      uploaded
    );
  }

  if (!hasFlag(args, '--skip-assets')) {
    for (const site of SITES) {
      const freshImages = path.join(DATA_ROOT, compound, 'fresh-images', site);
      const selected = path.join(DATA_ROOT, compound, 'selected-for-matching-fresh', site);
      await uploadDirectory(bucket, freshImages, `images/${site}`, uploaded, concurrency);
      await uploadDirectory(bucket, selected, `selected/${site}`, uploaded, concurrency);
    }
    for (const [site, shortName] of Object.entries(MOSAIC_SITE)) {
      const freshMosaics = path.join(DATA_ROOT, compound, 'fresh-mosaics', shortName);
      const legacyMosaics = path.join(DATA_ROOT, compound, 'mosaics', shortName);
      await uploadDirectory(
        bucket,
        fs.existsSync(freshMosaics) ? freshMosaics : legacyMosaics,
        `mosaics/${shortName}`,
        uploaded,
        concurrency
      );
    }
  }

  const manifest = {
    generated_at: new Date().toISOString(),
    compound,
    community_name: COMMUNITY_NAMES[compound] || compound,
    round,
    bucket: bucketName,
    output: path.relative(REPO_ROOT, output),
    community_prefix: communityPrefix,
    artifact_prefix: artifactPrefix || null,
    uploaded_count: uploaded.length,
    uploaded_paths: uploaded,
  };
  const manifestPath = path.join(runRoot, 'manifest.json');
  writeJson(manifestPath, manifest);
  await uploadFile(bucket, manifestPath, `${communityPrefix}/manifest.json`, uploaded);
  if (artifactPrefix) await uploadFile(bucket, manifestPath, `${artifactPrefix}/manifest.json`, uploaded);
  return { artifactPrefix, communityPrefix, manifest };
}

async function maybeReloadReview({ args, bucket, compound, round }) {
  const reviewUrl = argValue(args, '--reload-url').replace(/\/+$/, '');
  if (!reviewUrl) return null;
  if (hasFlag(args, '--reset-review-session')) {
    await bucket.file('review-sessions/current.json').delete({ ignoreNotFound: true }).catch(() => {});
  }
  return postJson(`${reviewUrl}/api/reload`, {
    reset: hasFlag(args, '--reset-review-session'),
    compound,
    round,
    source: 'local-community-matcher',
  });
}

async function main() {
  const args = process.argv.slice(2);
  const compound = argValue(args, '--compound');
  if (!compound) throw new Error('Provide --compound <slug>');

  const bucketName = normalizeBucket(argValue(args, '--bucket', process.env.GCS_BUCKET || 'realestate-475615-data'));
  const storage = new Storage();
  const bucket = storage.bucket(bucketName);
  const summary = await loadSummary(args, bucket);
  const round = Number(argValue(args, '--round', summary?.pass ? String(Number(summary.pass) + 1) : '1'));
  if (!Number.isFinite(round) || round < 1) throw new Error('--round must be a positive number');
  writeLocalLock(compound, round);

  const statusPath = argValue(args, '--status-path');
  await writeStatus(bucket, statusPath, {
    state: 'running',
    round,
    compute_target: 'mac',
    message: `Running ${COMMUNITY_NAMES[compound] || compound} round ${round} on this Mac`,
    started_at: new Date().toISOString(),
  });

  const runRoot = path.join(DATA_ROOT, compound, 'review-rounds', `pass-${round}`);
  const selectedRoot = path.join(DATA_ROOT, compound, 'selected-for-matching-fresh');
  const input = prepareInput({ compound, round, summary, runRoot });
  const megalocOutput = path.join(runRoot, 'auto-matches-megaloc.json');
  const patchOutput = path.join(runRoot, 'auto-matches-patch-vlad.json');
  const geometricOutput = path.join(runRoot, 'auto-matches-geometric-rerank.json');
  const output = path.join(DATA_ROOT, compound, `auto-matches-round-${round}.json`);
  const refreshArgs = hasFlag(args, '--refresh-cache') ? ['--refresh-cache'] : [];

  try {
    await run('python3', [
      'scripts/megaloc-matcher.py',
      '--data-root', input.inputRoot,
      '--selected-root', selectedRoot,
      '--cache', path.join(DATA_ROOT, compound, 'embedding-cache-megaloc.pkl'),
      '--threshold', argValue(args, '--megaloc-threshold', thresholdFor(round, 'megaloc')),
      '--output', megalocOutput,
      ...refreshArgs,
    ], {
      MEGALOC_DEVICE: process.env.MEGALOC_DEVICE || 'cpu',
    });

    await run('python3', [
      'scripts/patch-vlad-matcher.py',
      '--data-root', input.inputRoot,
      '--selected-root', selectedRoot,
      '--cache', path.join(DATA_ROOT, compound, 'embedding-cache-patch-vlad.pkl'),
      '--threshold', argValue(args, '--patch-vlad-threshold', thresholdFor(round, 'patch')),
      '--output', patchOutput,
      ...(argValue(args, '--patch-device') ? ['--device', argValue(args, '--patch-device')] : []),
      ...refreshArgs,
    ]);

    await run('python3', [
      'scripts/geometric-reranker.py',
      '--inputs', megalocOutput, patchOutput,
      '--selected-root', selectedRoot,
      '--output', geometricOutput,
    ]);

    await run('python3', [
      'scripts/tiered-matcher.py',
      '--geometric', geometricOutput,
      '--output', output,
      '--exclusions', input.exclusionsPath,
      '--round', String(round),
      '--data-root', input.inputRoot,
      '--high-score', argValue(args, '--high-score', thresholdFor(round, 'highScore')),
      '--high-inliers', argValue(args, '--high-inliers', thresholdFor(round, 'highInliers')),
    ]);

    annotateOutput(output, { compound, round, selectedRoot });

    const uploaded = [];
    if (!hasFlag(args, '--no-publish')) {
      const published = await publishArtifacts({
        args,
        bucket,
        bucketName,
        compound,
        round,
        runRoot,
        output,
        input,
        uploaded,
      });
      await writeStatus(bucket, statusPath, {
        state: 'ready',
        round,
        trial_run_id: argValue(args, '--trial-run-id') || summary?.trial_run_id || null,
        matches_path: published.artifactPrefix
          ? `${published.artifactPrefix}/auto-matches-round-${round}.json`
          : `${published.communityPrefix}/auto-matches-round-${round}.json`,
        legacy_matches_path: `matches/auto-matches-round-${round}.json`,
        latest_matches_path: 'matches/auto-matches.json',
        artifact_prefix: published.artifactPrefix || published.communityPrefix,
        manifest_path: `${published.communityPrefix}/manifest.json`,
        message: `${COMMUNITY_NAMES[compound] || compound} round ${round} is ready for review`,
      });
      const reload = await maybeReloadReview({ args, bucket, compound, round });
      if (reload) console.log(`Review UI reloaded: ${JSON.stringify(reload)}`);
      console.log(`Published ${uploaded.length} object(s) to gs://${bucketName}`);
    }

    console.log(`Saved ${path.relative(REPO_ROOT, output)}`);
  } catch (err) {
    await writeStatus(bucket, statusPath, {
      state: 'failed',
      round,
      message: err.message,
      failed_at: new Date().toISOString(),
    });
    throw err;
  }
}

main().then(() => {
  clearLocalLock();
}).catch(err => {
  clearLocalLock();
  console.error(err.stack || err.message);
  process.exit(1);
});
