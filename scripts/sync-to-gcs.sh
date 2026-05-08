#!/bin/bash
# sync-to-gcs.sh
#
# Push local Mac results to GCS after every matcher run.
# Run from the repo root:
#   ./scripts/sync-to-gcs.sh
#
# What gets synced:
#   data/{site}/listings/all-listings.json  → gs://BUCKET/listings/{site}.json
#   data/auto-matches-tiered.json           → gs://BUCKET/matches/auto-matches.json
#     fallback: data/auto-matches.json
#   data/{site}/cache/{code}/*.jpg          → gs://BUCKET/images/{site}/{code}/
#   selected_for_matching/{site}/{code}/    → gs://BUCKET/selected/{site}/{code}/
#   data/alphaville-1/mosaics/{site}/*.png  → gs://BUCKET/mosaics/{site}/

set -euo pipefail

BUCKET="gs://realestate-475615-data"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_ROOT="$REPO_ROOT/data"
SITES=("vivaprimeimoveis" "coelhodafonseca")
MOSAIC_SITES=("viva" "coelho")
RESET_SESSION=false

for arg in "$@"; do
  case "$arg" in
    --reset-session) RESET_SESSION=true ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: ./scripts/sync-to-gcs.sh [--reset-session]" >&2
      exit 2
      ;;
  esac
done

log() { echo "[$(date '+%H:%M:%S')] $*"; }

gcs_cp() {
  gcloud storage cp "$1" "$2" --quiet
}

gcs_rsync() {
  gcloud storage rsync "$1" "$2" --recursive --quiet
}

# ── 1. Listings JSON ──────────────────────────────────────────────────────────
log "Syncing listings JSON ..."
for site in "${SITES[@]}"; do
  src="$DATA_ROOT/$site/listings/all-listings.json"
  if [[ -f "$src" ]]; then
    gcs_cp "$src" "$BUCKET/listings/$site.json"
    log "  $site listings → $BUCKET/listings/$site.json"
  fi
done

# ── 2. auto-matches.json ──────────────────────────────────────────────────────
log "Syncing review matches ..."
if [[ -f "$DATA_ROOT/auto-matches-tiered.json" ]]; then
  gcs_cp "$DATA_ROOT/auto-matches-tiered.json" "$BUCKET/matches/auto-matches.json"
  gcs_cp "$DATA_ROOT/auto-matches-tiered.json" "$BUCKET/matches/auto-matches-tiered.json"
  log "  auto-matches-tiered.json → $BUCKET/matches/auto-matches.json"
elif [[ -f "$DATA_ROOT/auto-matches.json" ]]; then
  gcs_cp "$DATA_ROOT/auto-matches.json" "$BUCKET/matches/auto-matches.json"
  log "  auto-matches.json → $BUCKET/matches/auto-matches.json"
else
  log "  No match file found — skipping."
fi

# ── 3. Full image cache (data/{site}/cache/) ──────────────────────────────────
log "Syncing image cache (this may take a while on first run) ..."
for site in "${SITES[@]}"; do
  cache_dir="$DATA_ROOT/$site/cache"
  if [[ -d "$cache_dir" ]]; then
    gcs_rsync "$cache_dir" "$BUCKET/images/$site"
    log "  $site cache → $BUCKET/images/$site"
  fi
done

# ── 4. CLIP-selected images (selected_for_matching/) ─────────────────────────
log "Syncing selected_for_matching/ ..."
sfm_dir="$REPO_ROOT/selected_for_matching"
if [[ -d "$sfm_dir" ]]; then
  for site in "${SITES[@]}"; do
    if [[ -d "$sfm_dir/$site" ]]; then
      gcs_rsync "$sfm_dir/$site" "$BUCKET/selected/$site"
      log "  selected/$site → $BUCKET/selected/$site"
    fi
  done
else
  log "  No selected_for_matching/ found — skipping."
fi

# ── 5. Generated outdoor mosaics ─────────────────────────────────────────────
log "Syncing generated mosaics ..."
mosaic_root="$DATA_ROOT/alphaville-1/mosaics"
if [[ -d "$mosaic_root" ]]; then
  for site in "${MOSAIC_SITES[@]}"; do
    if [[ -d "$mosaic_root/$site" ]]; then
      gcs_rsync "$mosaic_root/$site" "$BUCKET/mosaics/$site"
      log "  mosaics/$site → $BUCKET/mosaics/$site"
    fi
  done
else
  log "  No $mosaic_root found — skipping."
fi

# ── 6. Optional session reset ────────────────────────────────────────────────
if [[ "$RESET_SESSION" == true ]]; then
  log "Resetting current review session ..."
  gcloud storage rm "$BUCKET/review-sessions/current.json" --quiet 2>/dev/null || true
  log "  removed $BUCKET/review-sessions/current.json if it existed"
fi

log "Sync complete. Public base URL: https://storage.googleapis.com/realestate-475615-data"
