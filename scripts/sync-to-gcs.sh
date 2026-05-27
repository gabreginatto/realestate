#!/bin/bash
# sync-to-gcs.sh
#
# Push local Mac results to GCS after every matcher run.
# Run from the repo root:
#   ./scripts/sync-to-gcs.sh
#   ./scripts/sync-to-gcs.sh --matches data/auto-matches-round-2.json --reset-session --skip-assets
#
# What gets synced:
#   data/{site}/listings/all-listings.json  → gs://BUCKET/listings/{site}.json
#   newest data/auto-matches*.json          → gs://BUCKET/matches/auto-matches.json
#     override with --matches for an exact pass/round file
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
SKIP_ASSETS=false
MATCHES_FILE=""
MATCHES_ARCHIVE_FILE=""

while [[ $# -gt 0 ]]; do
  arg="$1"
  case "$arg" in
    --reset-session) RESET_SESSION=true; shift ;;
    --skip-assets) SKIP_ASSETS=true; shift ;;
    --matches)
      if [[ $# -lt 2 ]]; then
        echo "--matches requires a file path" >&2
        exit 2
      fi
      MATCHES_FILE="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: ./scripts/sync-to-gcs.sh [--matches data/auto-matches-round-2.json] [--reset-session] [--skip-assets]" >&2
      exit 2
      ;;
  esac
done

log() { echo "[$(date '+%H:%M:%S')] $*"; }

pick_default_matches_file() {
  local newest=""
  local candidate
  for candidate in "$DATA_ROOT"/auto-matches-round-*.json \
                   "$DATA_ROOT"/auto-matches-tiered.json \
                   "$DATA_ROOT"/auto-matches.json; do
    [[ -f "$candidate" ]] || continue
    if [[ -z "$newest" || "$candidate" -nt "$newest" ]]; then
      newest="$candidate"
    fi
  done
  [[ -n "$newest" ]] && printf '%s\n' "$newest"
}

gcs_cp() {
  gcloud storage cp "$1" "$2" --quiet
}

gcs_rsync() {
  gcloud storage rsync "$1" "$2" --recursive --quiet
}

gcs_rsync_mirror() {
  gcloud storage rsync "$1" "$2" --recursive --quiet --delete-unmatched-destination-objects
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
if [[ -n "$MATCHES_FILE" ]]; then
  if [[ "$MATCHES_FILE" != /* ]]; then
    MATCHES_FILE="$REPO_ROOT/$MATCHES_FILE"
  fi
  if [[ ! -f "$MATCHES_FILE" ]]; then
    echo "Match file not found: $MATCHES_FILE" >&2
    exit 2
  fi
  match_name="$(basename "$MATCHES_FILE")"
  gcs_cp "$MATCHES_FILE" "$BUCKET/matches/auto-matches.json"
  gcs_cp "$MATCHES_FILE" "$BUCKET/matches/$match_name"
  MATCHES_ARCHIVE_FILE="$MATCHES_FILE"
  log "  $match_name → $BUCKET/matches/auto-matches.json and $BUCKET/matches/$match_name"
else
  default_matches="$(pick_default_matches_file || true)"
  if [[ -n "$default_matches" ]]; then
    match_name="$(basename "$default_matches")"
    gcs_cp "$default_matches" "$BUCKET/matches/auto-matches.json"
    gcs_cp "$default_matches" "$BUCKET/matches/$match_name"
    MATCHES_ARCHIVE_FILE="$default_matches"
    log "  $match_name → $BUCKET/matches/auto-matches.json and $BUCKET/matches/$match_name"
  else
    log "  No match file found — skipping."
  fi
fi

if [[ -n "$MATCHES_ARCHIVE_FILE" && "$(basename "$MATCHES_ARCHIVE_FILE")" == auto-matches-round-*.json ]]; then
  log "Archiving round artifacts in GCS ..."
  node scripts/sync-round-to-gcs.js --matches "$MATCHES_ARCHIVE_FILE" --bucket "${BUCKET#gs://}" || \
    log "  Could not archive round artifacts with sync-round-to-gcs.js"
fi

if [[ "$SKIP_ASSETS" == true ]]; then
  log "Skipping image, selected-image, and mosaic assets."
else

# ── 3. Full image cache (data/{site}/cache/) ──────────────────────────────────
log "Syncing image cache (this may take a while on first run) ..."
for site in "${SITES[@]}"; do
  cache_dir="$DATA_ROOT/$site/cache"
  if [[ -d "$cache_dir" ]]; then
    gcs_rsync "$cache_dir" "$BUCKET/images/$site"
    log "  $site cache → $BUCKET/images/$site"
  fi
done

# ── 3b. Compound-scoped full images override stale global cache entries ───────
log "Syncing compound-scoped image folders ..."
compound_root="$DATA_ROOT/alphaville-1"
for site in "${SITES[@]}"; do
  image_dir="$compound_root/$site/images"
  if [[ -d "$image_dir" ]]; then
    gcs_rsync "$image_dir" "$BUCKET/images/$site"
    log "  alphaville-1/$site images → $BUCKET/images/$site"
  fi
done

# ── 4. CLIP-selected images (selected_for_matching/) ─────────────────────────
log "Syncing selected_for_matching/ ..."
sfm_dir="$REPO_ROOT/selected_for_matching"
if [[ -d "$sfm_dir" ]]; then
  for site in "${SITES[@]}"; do
    if [[ -d "$sfm_dir/$site" ]]; then
      gcs_rsync_mirror "$sfm_dir/$site" "$BUCKET/selected/$site"
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
      gcs_rsync_mirror "$mosaic_root/$site" "$BUCKET/mosaics/$site"
      log "  mosaics/$site → $BUCKET/mosaics/$site"
    fi
  done
else
  log "  No $mosaic_root found — skipping."
fi

fi

# ── 6. Optional session reset ────────────────────────────────────────────────
if [[ "$RESET_SESSION" == true ]]; then
  log "Resetting current review session ..."
  gcloud storage rm "$BUCKET/review-sessions/current.json" --quiet 2>/dev/null || true
  log "  removed $BUCKET/review-sessions/current.json if it existed"
fi

log "Sync complete. Public base URL: https://storage.googleapis.com/realestate-475615-data"
