#!/bin/bash
# Pull the current lightweight matcher inputs from GCS before a Mac worker run.

set -euo pipefail

BUCKET="gs://realestate-475615-data"
WITH_RAW_IMAGES=false
SKIP_SELECTED=false
SKIP_MOSAICS=false

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_ROOT="$REPO_ROOT/data"
SITES=("vivaprimeimoveis" "coelhodafonseca")
MOSAIC_SITES=("viva" "coelho")

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bucket) BUCKET="$2"; shift 2 ;;
    --with-raw-images) WITH_RAW_IMAGES=true; shift ;;
    --skip-selected) SKIP_SELECTED=true; shift ;;
    --skip-mosaics) SKIP_MOSAICS=true; shift ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: ./scripts/sync-gcs-to-local.sh [--bucket gs://bucket] [--with-raw-images] [--skip-selected] [--skip-mosaics]" >&2
      exit 2
      ;;
  esac
done

if [[ "$BUCKET" != gs://* ]]; then
  BUCKET="gs://$BUCKET"
fi

log() { echo "[$(date '+%H:%M:%S')] $*"; }

gcs_cp_if_present() {
  local src="$1"
  local dest="$2"
  mkdir -p "$(dirname "$dest")"
  if gcloud storage cp "$src" "$dest" --quiet 2>/dev/null; then
    log "  $src -> $dest"
  else
    log "  missing or inaccessible: $src"
  fi
}

gcs_rsync_if_present() {
  local src="$1"
  local dest="$2"
  mkdir -p "$dest"
  if gcloud storage rsync "$src" "$dest" --recursive --quiet 2>/dev/null; then
    log "  $src -> $dest"
  else
    log "  missing or inaccessible: $src"
  fi
}

log "Syncing listing JSON from $BUCKET ..."
for site in "${SITES[@]}"; do
  gcs_cp_if_present "$BUCKET/listings/$site.json" "$DATA_ROOT/$site/listings/all-listings.json"
done

if [[ "$SKIP_SELECTED" != true ]]; then
  log "Syncing selected matcher images ..."
  for site in "${SITES[@]}"; do
    gcs_rsync_if_present "$BUCKET/selected/$site" "$REPO_ROOT/selected_for_matching/$site"
  done
fi

if [[ "$SKIP_MOSAICS" != true ]]; then
  log "Syncing mosaics for local inspection ..."
  for site in "${MOSAIC_SITES[@]}"; do
    gcs_rsync_if_present "$BUCKET/mosaics/$site" "$DATA_ROOT/alphaville-1/mosaics/$site"
  done
fi

if [[ "$WITH_RAW_IMAGES" == true ]]; then
  log "Syncing raw image cache ..."
  for site in "${SITES[@]}"; do
    gcs_rsync_if_present "$BUCKET/images/$site" "$DATA_ROOT/$site/cache"
  done
fi

log "GCS input sync complete."
