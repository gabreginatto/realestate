#!/bin/bash
set -euo pipefail

echo "=========================================="
echo " Pipeline Cloud Job - Starting"
echo " $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "=========================================="

# Step 1: Download existing state from GCS
echo ""
echo "[1/6] Downloading existing state from GCS..."
node scripts/pipeline-cloud/gcs-sync.js download

# Step 2: Run the pipeline (scrape -> fastdup -> select exteriors -> mosaics -> match)
echo ""
echo "[2/6] Running pipeline..."
node scripts/pipeline-runner.js 2>&1 || {
  echo "Pipeline failed with exit code $?"
  echo "Uploading partial results anyway..."
}

# Step 3: Clean up large intermediate files
echo ""
echo "[3/6] Cleaning up intermediate files..."

IMAGES_VIVA=$(du -sh data/vivaprimeimoveis/images/ 2>/dev/null | cut -f1 || echo "0")
IMAGES_COELHO=$(du -sh data/coelhodafonseca/images/ 2>/dev/null | cut -f1 || echo "0")
WORK_FASTDUP=$(du -sh work_fastdup/ 2>/dev/null | cut -f1 || echo "0")
SELECTED_EXT=$(du -sh selected_exteriors/ 2>/dev/null | cut -f1 || echo "0")

echo "  Removing raw images: Viva=${IMAGES_VIVA}, Coelho=${IMAGES_COELHO}"
rm -rf data/vivaprimeimoveis/images/ data/coelhodafonseca/images/

echo "  Removing fastdup work: ${WORK_FASTDUP}"
rm -rf work_fastdup/

echo "  Removing selected exteriors: ${SELECTED_EXT}"
rm -rf selected_exteriors/

echo "  Cleanup complete — keeping only mosaics + JSON"

# Step 4: Prepare server-deploy data
echo ""
echo "[4/6] Preparing server-deploy data..."
mkdir -p server-deploy/data/mosaics
mkdir -p server-deploy/data/listings
cp data/deterministic-matches.json server-deploy/data/ 2>/dev/null || true
rsync -a --delete data/mosaics/ server-deploy/data/mosaics/ 2>/dev/null || true
# Copy raw listings so the backend can download them from GCS
cp data/vivaprimeimoveis/listings/all-listings.json server-deploy/data/listings/vivaprimeimoveis_listings.json 2>/dev/null || true
cp data/coelhodafonseca/listings/all-listings.json server-deploy/data/listings/coelhodafonseca_listings.json 2>/dev/null || true

# Step 5: Upload results to GCS
echo ""
echo "[5/6] Uploading results to GCS..."
node scripts/pipeline-cloud/gcs-sync.js upload

# Step 6: Summary
echo ""
echo "[6/6] Pipeline complete!"
echo "=========================================="
echo " Results Summary"
echo "=========================================="
echo " Viva listings: $(cat data/vivaprimeimoveis/listings/all-listings.json 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d.get("listings",[])))' 2>/dev/null || echo 'N/A')"
echo " Coelho listings: $(cat data/coelhodafonseca/listings/all-listings.json 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d.get("listings",[])))' 2>/dev/null || echo 'N/A')"
echo " Viva mosaics: $(ls data/mosaics/viva/ 2>/dev/null | wc -l)"
echo " Coelho mosaics: $(ls data/mosaics/coelho/ 2>/dev/null | wc -l)"
echo " Matches: $(cat data/deterministic-matches.json 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d.get("candidate_pairs",[])))' 2>/dev/null || echo 'N/A')"
echo "=========================================="
