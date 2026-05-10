#!/bin/bash
# Generate and publish the next review round from the latest finalized session.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROUND="2"
SUMMARY_URL=""
SUMMARY_FILE=""
MEGALOC_THRESHOLD=""
PATCH_VLAD_THRESHOLD=""
HIGH_SCORE=""
HIGH_INLIERS=""
RESET_SESSION=false
REFRESH_CACHE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --round) ROUND="$2"; shift 2 ;;
    --summary-url) SUMMARY_URL="$2"; shift 2 ;;
    --summary) SUMMARY_FILE="$2"; shift 2 ;;
    --megaloc-threshold) MEGALOC_THRESHOLD="$2"; shift 2 ;;
    --patch-vlad-threshold) PATCH_VLAD_THRESHOLD="$2"; shift 2 ;;
    --high-score) HIGH_SCORE="$2"; shift 2 ;;
    --high-inliers) HIGH_INLIERS="$2"; shift 2 ;;
    --reset-session) RESET_SESSION=true; shift ;;
    --refresh-cache) REFRESH_CACHE=true; shift ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: ./scripts/run-next-review-round.sh --summary-url URL [--round 2] [--reset-session]" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$SUMMARY_URL" && -z "$SUMMARY_FILE" ]]; then
  echo "Provide --summary-url or --summary." >&2
  exit 2
fi

cd "$REPO_ROOT"

if [[ -z "$MEGALOC_THRESHOLD" ]]; then
  case "$ROUND" in
    1) MEGALOC_THRESHOLD="0.525" ;;
    2) MEGALOC_THRESHOLD="0.450" ;;
    3) MEGALOC_THRESHOLD="0.400" ;;
    *) MEGALOC_THRESHOLD="0.350" ;;
  esac
fi

if [[ -z "$PATCH_VLAD_THRESHOLD" ]]; then
  case "$ROUND" in
    1) PATCH_VLAD_THRESHOLD="0.425" ;;
    2) PATCH_VLAD_THRESHOLD="0.350" ;;
    3) PATCH_VLAD_THRESHOLD="0.300" ;;
    *) PATCH_VLAD_THRESHOLD="0.250" ;;
  esac
fi

if [[ -z "$HIGH_SCORE" ]]; then
  case "$ROUND" in
    1) HIGH_SCORE="0.760" ;;
    2) HIGH_SCORE="0.700" ;;
    3) HIGH_SCORE="0.620" ;;
    *) HIGH_SCORE="0.550" ;;
  esac
fi

if [[ -z "$HIGH_INLIERS" ]]; then
  case "$ROUND" in
    1) HIGH_INLIERS="20" ;;
    2) HIGH_INLIERS="14" ;;
    3) HIGH_INLIERS="10" ;;
    *) HIGH_INLIERS="8" ;;
  esac
fi

output="data/auto-matches-round-${ROUND}.json"
report="data/review-round-${ROUND}-plan.json"
round_dir="data/review-rounds/pass-${ROUND}"
filtered_root="$round_dir/input"
exclusions="$round_dir/exclusions.json"
megaloc_output="$round_dir/auto-matches-megaloc.json"
patch_vlad_output="$round_dir/auto-matches-patch-vlad.json"
geometric_output="$round_dir/auto-matches-geometric-rerank.json"

prepare_args=(scripts/prepare-next-review-round.js --round "$ROUND" --filtered-data-root "$filtered_root" --exclusions "$exclusions" --report "$report")
if [[ -n "$SUMMARY_URL" ]]; then
  prepare_args+=(--summary-url "$SUMMARY_URL")
else
  prepare_args+=(--summary "$SUMMARY_FILE")
fi

node "${prepare_args[@]}"

megaloc_args=(
  scripts/megaloc-matcher.py
  --data-root "$filtered_root" \
  --cache data/embedding-cache-megaloc.pkl \
  --threshold "$MEGALOC_THRESHOLD" \
  --output "$megaloc_output"
)
if [[ "$REFRESH_CACHE" == true ]]; then
  megaloc_args+=(--refresh-cache)
fi
MEGALOC_DEVICE="${MEGALOC_DEVICE:-cpu}" python3 "${megaloc_args[@]}"

patch_vlad_args=(
  scripts/patch-vlad-matcher.py
  --data-root "$filtered_root" \
  --cache data/embedding-cache-patch-vlad.pkl \
  --threshold "$PATCH_VLAD_THRESHOLD" \
  --output "$patch_vlad_output"
)
if [[ "$REFRESH_CACHE" == true ]]; then
  patch_vlad_args+=(--refresh-cache)
fi
python3 "${patch_vlad_args[@]}"

python3 scripts/geometric-reranker.py \
  --inputs "$megaloc_output" "$patch_vlad_output" \
  --output "$geometric_output"

tiered_args=(
  scripts/tiered-matcher.py
  --geometric "$geometric_output"
  --output "$output"
  --exclusions "$exclusions"
  --round "$ROUND"
  --high-score "$HIGH_SCORE"
  --high-inliers "$HIGH_INLIERS"
)
if [[ -n "$SUMMARY_FILE" ]]; then
  tiered_args+=(--exclude-summary "$SUMMARY_FILE")
fi
python3 "${tiered_args[@]}"

sync_args=(./scripts/sync-to-gcs.sh --matches "$output" --skip-assets)
if [[ "$RESET_SESSION" == true ]]; then
  sync_args+=(--reset-session)
fi
"${sync_args[@]}"

echo "Round $ROUND uploaded. Return to the review app and click Preparar Rodada $ROUND."
