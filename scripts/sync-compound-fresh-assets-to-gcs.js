#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { Storage } = require('@google-cloud/storage');

const REPO_ROOT = path.resolve(__dirname, '..');
const DATA_ROOT = path.join(REPO_ROOT, 'data');

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
        && (fs.existsSync(path.join(dir, 'fresh-listings'))
          || fs.existsSync(path.join(dir, 'live-listing-inventory'))
          || fs.existsSync(path.join(dir, 'pipeline-state.json')));
    })
    .sort((a, b) => a.localeCompare(b));
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

async function mapLimit(items, limit, worker) {
  let next = 0;
  const results = [];
  async function run() {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

function collectUploadPlan(compound, prefix, groups) {
  const compoundDir = path.join(DATA_ROOT, compound);
  const scopedPrefix = `${prefix}/${safeSegment(compound)}`;
  const dirs = [
    ['live-listing-inventory', path.join(compoundDir, 'live-listing-inventory')],
    ['fresh-listings', path.join(compoundDir, 'fresh-listings')],
    ['fresh-images', path.join(compoundDir, 'fresh-images')],
    ['selected-for-matching-fresh', path.join(compoundDir, 'selected-for-matching-fresh')],
    ['fresh-mosaics', path.join(compoundDir, 'fresh-mosaics')],
  ];
  const allowed = groups ? new Set(groups) : null;
  const files = [];
  for (const [name, root] of dirs) {
    if (allowed && !allowed.has(name)) continue;
    for (const file of walkFiles(root)) {
      const rel = path.relative(root, file).split(path.sep).join('/');
      files.push({
        local: file,
        destination: `${scopedPrefix}/${name}/${rel}`,
        group: name,
      });
    }
  }
  return { scopedPrefix, files };
}

function countByGroup(files) {
  return files.reduce((acc, file) => {
    acc[file.group] = (acc[file.group] || 0) + 1;
    return acc;
  }, {});
}

async function deleteExtra(bucket, prefix, keepSet, dryRun) {
  const [files] = await bucket.getFiles({ prefix: `${prefix}/` });
  const extra = files.filter((file) => !keepSet.has(file.name));
  if (dryRun) return extra.map((file) => file.name);
  await mapLimit(extra, 16, async (file) => file.delete({ ignoreNotFound: true }));
  return extra.map((file) => file.name);
}

async function main() {
  const args = process.argv.slice(2);
  const compoundArg = argValue(args, '--compound', 'all');
  const bucketName = normalizeBucket(argValue(args, '--bucket', process.env.GCS_BUCKET || 'realestate-475615-data'));
  const prefix = argValue(args, '--prefix', 'compounds').replace(/^\/+|\/+$/g, '');
  const concurrency = Number(argValue(args, '--concurrency', '16'));
  const groupsArg = argValue(args, '--groups', '');
  const groups = groupsArg
    ? groupsArg.split(',').map((value) => value.trim()).filter(Boolean)
    : null;
  const deleteExtraFiles = hasFlag(args, '--delete-extra');
  const dryRun = hasFlag(args, '--dry-run');
  const compounds = listCompounds(compoundArg);

  if (!Number.isFinite(concurrency) || concurrency < 1) throw new Error('--concurrency must be positive');
  if (!compounds.length) throw new Error(`No compounds found for ${compoundArg}`);

  const storage = new Storage();
  const bucket = storage.bucket(bucketName);
  const report = {
    generated_at: new Date().toISOString(),
    bucket: bucketName,
    prefix,
    groups: groups || 'all',
    dry_run: dryRun,
    delete_extra: deleteExtraFiles,
    compounds: {},
  };

  for (const compound of compounds) {
    const plan = collectUploadPlan(compound, prefix, groups);
    const keepSet = new Set(plan.files.map((file) => file.destination));
    console.log(`\n${compound}: ${plan.files.length} file(s) -> gs://${bucketName}/${plan.scopedPrefix}/`);

    if (!dryRun) {
      await mapLimit(plan.files, concurrency, async (file) => {
        await bucket.upload(file.local, { destination: file.destination });
      });
    }

    let deleted = [];
    if (deleteExtraFiles) {
      const deletePrefixes = groups
        ? groups.map((group) => `${plan.scopedPrefix}/${group}`)
        : [plan.scopedPrefix];
      for (const deletePrefix of deletePrefixes) {
        deleted = deleted.concat(await deleteExtra(bucket, deletePrefix, keepSet, dryRun));
      }
    }

    const manifest = {
      generated_at: new Date().toISOString(),
      compound,
      bucket: bucketName,
      prefix: plan.scopedPrefix,
      files: plan.files.length,
      counts: countByGroup(plan.files),
      deleted_extra_files: deleted.length,
    };
    const manifestLocal = path.join(DATA_ROOT, compound, 'fresh-gcs-sync-manifest.json');
    fs.writeFileSync(manifestLocal, `${JSON.stringify(manifest, null, 2)}\n`);
    const manifestDest = `${plan.scopedPrefix}/fresh-gcs-sync-manifest.json`;
    if (!dryRun) await bucket.upload(manifestLocal, { destination: manifestDest });

    report.compounds[compound] = {
      prefix: plan.scopedPrefix,
      files: plan.files.length,
      counts: countByGroup(plan.files),
      deleted_extra_files: deleted.length,
      manifest: manifestDest,
    };
    console.log(`  uploaded=${dryRun ? 0 : plan.files.length}, delete_extra=${deleted.length}`);
  }

  const reportFile = path.join(DATA_ROOT, 'compound-fresh-gcs-sync-report.json');
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nWrote ${path.relative(REPO_ROOT, reportFile)}`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
