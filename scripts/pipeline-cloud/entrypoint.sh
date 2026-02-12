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
node scripts/pipeline-runner.js --all 2>&1 || {
  echo "Pipeline failed with exit code $?"
  echo "Uploading partial results anyway..."
}

# Step 3: Clean up large intermediate files
echo ""
echo "[3/6] Cleaning up intermediate files..."

for compound in $(node -e "const c=require('./config/compounds.json'); console.log(Object.keys(c.compounds).join(' '))"); do
  IMAGES_VIVA=$(du -sh "data/$compound/vivaprimeimoveis/images/" 2>/dev/null | cut -f1 || echo "0")
  IMAGES_COELHO=$(du -sh "data/$compound/coelhodafonseca/images/" 2>/dev/null | cut -f1 || echo "0")
  echo "  Removing raw images for $compound: Viva=${IMAGES_VIVA}, Coelho=${IMAGES_COELHO}"
  rm -rf "data/$compound/vivaprimeimoveis/images/" "data/$compound/coelhodafonseca/images/"
done

WORK_FASTDUP=$(du -sh work_fastdup/ 2>/dev/null | cut -f1 || echo "0")
SELECTED_EXT=$(du -sh selected_exteriors/ 2>/dev/null | cut -f1 || echo "0")
echo "  Removing fastdup work: ${WORK_FASTDUP}"
rm -rf work_fastdup/
echo "  Removing selected exteriors: ${SELECTED_EXT}"
rm -rf selected_exteriors/
echo "  Cleanup complete — keeping only mosaics + JSON"

# Step 4: Prepare server-deploy data
echo ""
echo "[4/6] Preparing server-deploy data..."

for compound in $(node -e "const c=require('./config/compounds.json'); console.log(Object.keys(c.compounds).join(' '))"); do
  echo "  Preparing data for $compound..."
  mkdir -p "server-deploy/data/$compound/mosaics"
  mkdir -p "server-deploy/data/$compound/listings"
  cp "data/$compound/deterministic-matches.json" "server-deploy/data/$compound/" 2>/dev/null || true
  rsync -a "data/$compound/mosaics/" "server-deploy/data/$compound/mosaics/" 2>/dev/null || true
  cp "data/$compound/vivaprimeimoveis/listings/all-listings.json" "server-deploy/data/$compound/listings/vivaprimeimoveis_listings.json" 2>/dev/null || true
  cp "data/$compound/coelhodafonseca/listings/all-listings.json" "server-deploy/data/$compound/listings/coelhodafonseca_listings.json" 2>/dev/null || true
done

cp config/compounds.json server-deploy/ 2>/dev/null || true

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
for compound in $(node -e "const c=require('./config/compounds.json'); console.log(Object.keys(c.compounds).join(' '))"); do
  echo " --- $compound ---"
  echo "  Viva listings: $(cat "data/$compound/vivaprimeimoveis/listings/all-listings.json" 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d.get("listings",[])))' 2>/dev/null || echo 'N/A')"
  echo "  Coelho listings: $(cat "data/$compound/coelhodafonseca/listings/all-listings.json" 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d.get("listings",[])))' 2>/dev/null || echo 'N/A')"
  echo "  Viva mosaics: $(ls "data/$compound/mosaics/viva/" 2>/dev/null | wc -l)"
  echo "  Coelho mosaics: $(ls "data/$compound/mosaics/coelho/" 2>/dev/null | wc -l)"
  echo "  Matches: $(cat "data/$compound/deterministic-matches.json" 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d.get("candidate_pairs",[])))' 2>/dev/null || echo 'N/A')"
done
echo "=========================================="
