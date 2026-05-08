#!/bin/bash
# Generate and publish the next review round from the latest finalized session.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROUND="2"
SUMMARY_URL=""
SUMMARY_FILE=""
TOP_K="3"
MIN_SCORE="0.08"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --round) ROUND="$2"; shift 2 ;;
    --summary-url) SUMMARY_URL="$2"; shift 2 ;;
    --summary) SUMMARY_FILE="$2"; shift 2 ;;
    --top-k) TOP_K="$2"; shift 2 ;;
    --min-score) MIN_SCORE="$2"; shift 2 ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: ./scripts/run-next-review-round.sh --summary-url URL [--round 2] [--top-k 3] [--min-score 0.08]" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$SUMMARY_URL" && -z "$SUMMARY_FILE" ]]; then
  echo "Provide --summary-url or --summary." >&2
  exit 2
fi

cd "$REPO_ROOT"

output="data/auto-matches-round-${ROUND}.json"
report="data/review-round-${ROUND}-plan.json"

args=(scripts/prepare-next-review-round.js --round "$ROUND" --top-k "$TOP_K" --min-score "$MIN_SCORE" --output "$output" --report "$report")
if [[ -n "$SUMMARY_URL" ]]; then
  args+=(--summary-url "$SUMMARY_URL")
else
  args+=(--summary "$SUMMARY_FILE")
fi

node "${args[@]}"
./scripts/sync-to-gcs.sh --matches "$output" --skip-assets

echo "Round $ROUND uploaded. Return to the review app and click Preparar Rodada $ROUND."
