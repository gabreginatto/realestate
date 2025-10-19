#!/usr/bin/env bash
set -euo pipefail

# Run fastdup separately for each site to avoid cross-site deduplication
# This preserves duplicates between Coelho and Viva for property matching

# Sites to process (IMPORTANT: process separately!)
SITES=("coelhodafonseca" "vivaprimeimoveis")

for SITE in "${SITES[@]}"; do
  echo "=================================================="
  echo "Processing site: $SITE"
  echo "=================================================="

  IN_ROOT="data_clean/$SITE"
  OUT_ROOT="work_fastdup/$SITE"

  if [ ! -d "$IN_ROOT" ]; then
    echo "Warning: $IN_ROOT does not exist, skipping..."
    continue
  fi

  # Count total listings
  TOTAL=$(find "$IN_ROOT" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')
  echo "Found $TOTAL listings in $SITE"

  CURRENT=0

  # Process each listing
  for LISTING_DIR in "$IN_ROOT"/*; do
    if [ ! -d "$LISTING_DIR" ]; then
      continue
    fi

    LISTING_ID=$(basename "$LISTING_DIR")
    CURRENT=$((CURRENT + 1))

    OUT_DIR="$OUT_ROOT/$LISTING_ID/fastdup"
    mkdir -p "$OUT_DIR"

    # Count images in this listing
    IMG_COUNT=$(find "$LISTING_DIR" -maxdepth 1 -type f \( -iname "*.jpg" -o -iname "*.jpeg" -o -iname "*.png" \) | wc -l | tr -d ' ')

    echo "[$CURRENT/$TOTAL] Processing $SITE/$LISTING_ID ($IMG_COUNT images)..."

    # Run fastdup using Python API
    python3 -c "
import os, sys, fastdup
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '3'  # Suppress TensorFlow warnings
in_dir = '$LISTING_DIR'
out_dir = '$OUT_DIR'

try:
    fd = fastdup.create(input_dir=in_dir, work_dir=out_dir)
    fd.run(threshold=0.90, verbose=0)
except Exception as e:
    print(f'  Warning: fastdup failed for $LISTING_ID: {e}', file=sys.stderr)
    sys.exit(0)  # Continue processing other listings
" 2>&1 | grep -v "TensorFlow" | grep -v "WARNING" || true

  done

  echo ""
  echo "Completed fastdup for $SITE ($TOTAL listings)"
  echo ""
done

echo "=================================================="
echo "Fastdup processing complete!"
echo "=================================================="
