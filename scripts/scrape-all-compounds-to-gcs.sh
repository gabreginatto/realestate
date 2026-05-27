#!/bin/bash
# Scrape every configured compound, download galleries, build fresh mosaics,
# upload compound-scoped assets to GCS, and verify the result.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

COMPOUND="all"
SITE="both"
BUCKET="${GCS_BUCKET:-realestate-475615-data}"
MAX_PAGES=20
DETAIL_DELAY_MS=150
IMAGE_DELAY_MS=50
IMAGE_CONCURRENCY=8
SYNC_CONCURRENCY=16
LIMIT=0
FORCE_IMAGES=false
SKIP_DINO=false
SKIP_MOSAICS=false
SKIP_GCS=false
SKIP_VERIFY=false
DELETE_EXTRA=true
DRY_RUN=false

usage() {
  cat <<'EOF'
Usage: ./scripts/scrape-all-compounds-to-gcs.sh [options]

Options:
  --compound <slug|all>       Compound to process (default: all)
  --site <viva|coelho|both>   Site to process (default: both)
  --bucket <bucket>           GCS bucket name or gs:// URL
  --max-pages <n>             Search pagination safety cap (default: 20)
  --detail-delay-ms <n>       Delay between detail pages (default: 150)
  --image-delay-ms <n>        Delay between listing image batches (default: 50)
  --image-concurrency <n>     Concurrent image downloads per listing (default: 8)
  --sync-concurrency <n>      Concurrent GCS uploads (default: 16)
  --limit <n>                 Testing only: limit listings per site (default: all)
  --force-images              Re-download existing local images
  --skip-dino                 Skip fresh exterior selection
  --skip-mosaics              Skip fresh mosaic generation
  --skip-gcs                  Do not upload to GCS
  --skip-verify               Do not run final verifier
  --keep-extra-gcs            Do not delete stale files under compounds/<compound>/
  --dry-run                   Print planned commands without running them
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --compound) COMPOUND="$2"; shift 2 ;;
    --site) SITE="$2"; shift 2 ;;
    --bucket) BUCKET="${2#gs://}"; shift 2 ;;
    --max-pages) MAX_PAGES="$2"; shift 2 ;;
    --detail-delay-ms) DETAIL_DELAY_MS="$2"; shift 2 ;;
    --image-delay-ms) IMAGE_DELAY_MS="$2"; shift 2 ;;
    --image-concurrency) IMAGE_CONCURRENCY="$2"; shift 2 ;;
    --sync-concurrency) SYNC_CONCURRENCY="$2"; shift 2 ;;
    --limit) LIMIT="$2"; shift 2 ;;
    --force-images) FORCE_IMAGES=true; shift ;;
    --skip-dino) SKIP_DINO=true; shift ;;
    --skip-mosaics) SKIP_MOSAICS=true; shift ;;
    --skip-gcs) SKIP_GCS=true; shift ;;
    --skip-verify) SKIP_VERIFY=true; shift ;;
    --keep-extra-gcs) DELETE_EXTRA=false; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

log() { echo "[$(date '+%H:%M:%S')] $*"; }

run() {
  printf '+'
  printf ' %q' "$@"
  printf '\n'
  if [[ "$DRY_RUN" != true ]]; then
    "$@"
  fi
}

compounds_json() {
  node - "$COMPOUND" <<'NODE'
const fs = require('fs');
const path = require('path');
const dataRoot = path.join(process.cwd(), 'data');
const requested = process.argv[2];
const ignored = new Set(['vivaprimeimoveis', 'coelhodafonseca', 'review-rounds', 'legacy', 'raw', 'processed']);
const compounds = requested === 'all'
  ? fs.readdirSync(dataRoot)
      .filter((name) => {
        const dir = path.join(dataRoot, name);
        return fs.statSync(dir).isDirectory()
          && !ignored.has(name)
          && (fs.existsSync(path.join(dir, 'listings'))
            || fs.existsSync(path.join(dir, 'pipeline-state.json'))
            || fs.existsSync(path.join(dir, 'live-listing-inventory')));
      })
      .sort((a, b) => a.localeCompare(b))
  : [requested];
process.stdout.write(JSON.stringify(compounds));
NODE
}

site_full_names() {
  case "$SITE" in
    both) echo "vivaprimeimoveis coelhodafonseca" ;;
    viva) echo "vivaprimeimoveis" ;;
    coelho) echo "coelhodafonseca" ;;
    *) echo "Unknown --site $SITE" >&2; exit 2 ;;
  esac
}

site_short_arg() {
  case "$SITE" in
    both) echo "both" ;;
    viva) echo "viva" ;;
    coelho) echo "coelho" ;;
  esac
}

COMPOUNDS_JSON="$(compounds_json)"
read -r -a COMPOUNDS <<<"$(node -e "console.log(JSON.parse(process.argv[1]).join(' '))" "$COMPOUNDS_JSON")"
if [[ "${#COMPOUNDS[@]}" -eq 0 ]]; then
  echo "No compounds found." >&2
  exit 1
fi

log "Compounds: ${COMPOUNDS[*]}"
log "Bucket: gs://$BUCKET"

audit_args=(node scripts/audit-live-listing-counts.js --compound "$COMPOUND" --site "$SITE" --max-pages "$MAX_PAGES")
run "${audit_args[@]}"

detail_args=(node scripts/scrape-live-listing-details.js --compound "$COMPOUND" --site "$SITE" --delay-ms "$DETAIL_DELAY_MS")
if [[ "$LIMIT" != "0" ]]; then detail_args+=(--limit "$LIMIT"); fi
run "${detail_args[@]}"

run node scripts/compare-fresh-listings.js --compound "$COMPOUND"

image_args=(node scripts/download-fresh-listing-images.js --compound "$COMPOUND" --site "$SITE" --delay-ms "$IMAGE_DELAY_MS" --concurrency "$IMAGE_CONCURRENCY")
if [[ "$LIMIT" != "0" ]]; then image_args+=(--limit "$LIMIT"); fi
if [[ "$FORCE_IMAGES" == true ]]; then image_args+=(--force); fi
run "${image_args[@]}"

if [[ "$SKIP_DINO" != true ]]; then
  for compound in "${COMPOUNDS[@]}"; do
    selected_root="data/$compound/selected-for-matching-fresh"
    dino_args=(
      python3 scripts/dino-select-exteriors.py
      --source-type fresh-images
      --source-root data
      --compound "$compound"
      --sites $(site_full_names)
      --output-dir "$selected_root"
      --only-listed
      --clean-extra-output
      --skip-existing
    )
    for site in $(site_full_names); do
      dino_args+=(--official-listings "data/$compound/fresh-listings/$site.json")
    done
    run "${dino_args[@]}"
  done
fi

if [[ "$SKIP_MOSAICS" != true ]]; then
  for compound in "${COMPOUNDS[@]}"; do
    run node scripts/make-fresh-mosaics.js "$(site_short_arg)" \
      --compound "$compound" \
      --selected-root "data/$compound/selected-for-matching-fresh" \
      --force \
      --clean-extra
  done
fi

verify_args=(node scripts/verify-compound-fresh-assets.js --compound "$COMPOUND")
if [[ "$SKIP_DINO" != true ]]; then verify_args+=(--require-selected); fi
if [[ "$SKIP_MOSAICS" != true ]]; then verify_args+=(--require-mosaics); fi
if [[ "$SKIP_VERIFY" != true ]]; then
  run "${verify_args[@]}"
fi

if [[ "$SKIP_GCS" != true ]]; then
  sync_args=(node scripts/sync-compound-fresh-assets-to-gcs.js --compound "$COMPOUND" --bucket "$BUCKET" --concurrency "$SYNC_CONCURRENCY")
  if [[ "$DELETE_EXTRA" == true ]]; then sync_args+=(--delete-extra); fi
  run "${sync_args[@]}"
fi

if [[ "$SKIP_VERIFY" != true && "$SKIP_GCS" != true ]]; then
  verify_gcs_args=(node scripts/verify-compound-fresh-assets.js --compound "$COMPOUND" --bucket "$BUCKET" --require-gcs)
  if [[ "$SKIP_DINO" != true ]]; then verify_gcs_args+=(--require-selected); fi
  if [[ "$SKIP_MOSAICS" != true ]]; then verify_gcs_args+=(--require-mosaics); fi
  run "${verify_gcs_args[@]}"
fi

log "All compound scrape/sync stages completed."
