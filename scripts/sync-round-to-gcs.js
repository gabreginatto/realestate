#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { Storage } = require('@google-cloud/storage');

function argValue(args, name, fallback = null) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}

async function main() {
  const args = process.argv.slice(2);
  const matches = argValue(args, '--matches');
  const bucketName = argValue(args, '--bucket', process.env.GCS_BUCKET || 'realestate-475615-data');
  if (!matches) throw new Error('Provide --matches <file>');
  if (!fs.existsSync(matches)) throw new Error(`Match file not found: ${matches}`);

  const storage = new Storage();
  const bucket = storage.bucket(bucketName);
  const basename = path.basename(matches);
  await bucket.upload(matches, { destination: 'matches/auto-matches.json' });
  await bucket.upload(matches, { destination: `matches/${basename}` });
  console.log(`Uploaded ${basename} to gs://${bucketName}/matches/auto-matches.json`);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
