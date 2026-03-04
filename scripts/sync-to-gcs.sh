#!/bin/bash
# sync-to-gcs.sh
#
# Push local Mac results to GCS after every matcher run.
# Run from the repo root:
#   ./scripts/sync-to-gcs.sh
#
# What gets synced:
#   data/{site}/listings/all-listings.json  → gs://BUCKET/listings/{site}.json
#   data/auto-matches.json                  → gs://BUCKET/matches/auto-matches.json
#   data/{site}/cache/{code}/*.jpg          → gs://BUCKET/images/{site}/{code}/
#   selected_for_matching/{site}/{code}/    → gs://BUCKET/selected/{site}/{code}/

set -euo pipefail

BUCKET="gs://realestate-475615-data"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_ROOT="$REPO_ROOT/data"
SITES=("vivaprimeimoveis" "coelhodafonseca")

log() { echo "[$(date '+%H:%M:%S')] $*"; }

# ── 1. Listings JSON ──────────────────────────────────────────────────────────
log "Syncing listings JSON ..."
for site in "${SITES[@]}"; do
  src="$DATA_ROOT/$site/listings/all-listings.json"
  if [[ -f "$src" ]]; then
    gsutil -q cp "$src" "$BUCKET/listings/$site.json"
    log "  $site listings → $BUCKET/listings/$site.json"
  fi
done

# ── 2. auto-matches.json ──────────────────────────────────────────────────────
log "Syncing auto-matches.json ..."
if [[ -f "$DATA_ROOT/auto-matches.json" ]]; then
  gsutil -q cp "$DATA_ROOT/auto-matches.json" "$BUCKET/matches/auto-matches.json"
  log "  auto-matches.json → $BUCKET/matches/auto-matches.json"
fi

# ── 3. Full image cache (data/{site}/cache/) ──────────────────────────────────
log "Syncing image cache (this may take a while on first run) ..."
for site in "${SITES[@]}"; do
  cache_dir="$DATA_ROOT/$site/cache"
  if [[ -d "$cache_dir" ]]; then
    gsutil -m -q rsync -r "$cache_dir" "$BUCKET/images/$site"
    log "  $site cache → $BUCKET/images/$site"
  fi
done

# ── 4. CLIP-selected images (selected_for_matching/) ─────────────────────────
log "Syncing selected_for_matching/ ..."
sfm_dir="$REPO_ROOT/selected_for_matching"
if [[ -d "$sfm_dir" ]]; then
  for site in "${SITES[@]}"; do
    if [[ -d "$sfm_dir/$site" ]]; then
      gsutil -m -q rsync -r "$sfm_dir/$site" "$BUCKET/selected/$site"
      log "  selected/$site → $BUCKET/selected/$site"
    fi
  done
else
  log "  No selected_for_matching/ found — skipping."
fi

log "Sync complete. Public base URL: https://storage.googleapis.com/realestate-475615-data"
