#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# Real Estate Image Processing Pipeline - Full Execution Script
###############################################################################
#
# This script runs the complete 5-stage pipeline:
#   1. Web Scraping (manual - Playwright)
#   2. UFOID Deduplication (per site)
#   3. Reorganization (restore per-listing folders)
#   4. Fastdup Analysis (quality + clustering)
#   5. Exterior Photo Selection (best 12 per listing)
#
# Usage:
#   bash scripts/run_full_pipeline.sh [--skip-scraping] [--skip-ufoid]
#
# Options:
#   --skip-scraping   Skip Stage 1 (assume data already scraped)
#   --skip-ufoid      Skip Stage 2 (assume UFOID already run)
#
###############################################################################

SKIP_SCRAPING=false
SKIP_UFOID=false

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --skip-scraping)
      SKIP_SCRAPING=true
      shift
      ;;
    --skip-ufoid)
      SKIP_UFOID=true
      shift
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: $0 [--skip-scraping] [--skip-ufoid]"
      exit 1
      ;;
  esac
done

echo "================================================================================"
echo "Real Estate Image Processing Pipeline"
echo "================================================================================"
echo ""

###############################################################################
# Stage 1: Web Scraping (Playwright)
###############################################################################

if [ "$SKIP_SCRAPING" = false ]; then
  echo "Stage 1: Web Scraping"
  echo "--------------------------------------------------------------------------------"
  echo "⚠️  Manual step required:"
  echo ""
  echo "  1. Run Playwright scraper for Coelho da Fonseca:"
  echo "     npx playwright test scripts/extract-details-coelhodafonseca.spec.ts"
  echo ""
  echo "  2. Run Playwright scraper for Viva Prime Imóveis (if exists)"
  echo ""
  echo "  Press Enter when scraping is complete..."
  read -r
else
  echo "Stage 1: Web Scraping [SKIPPED]"
  echo "--------------------------------------------------------------------------------"
fi

echo ""

###############################################################################
# Stage 2: UFOID Deduplication
###############################################################################

if [ "$SKIP_UFOID" = false ]; then
  echo "Stage 2: UFOID Deduplication"
  echo "--------------------------------------------------------------------------------"

  # Check if UFOID exists
  if [ ! -d "ufoid" ]; then
    echo "❌ Error: ufoid/ directory not found!"
    echo "   Please clone UFOID: git clone https://github.com/JPBM135/UFOID ufoid"
    exit 1
  fi

  # Activate Python 3.9 environment for UFOID
  if [ ! -d ".venv39" ]; then
    echo "❌ Error: .venv39/ not found!"
    echo "   Please create Python 3.9 environment:"
    echo "   python3.9 -m venv .venv39"
    echo "   source .venv39/bin/activate"
    echo "   pip install -r ufoid/requirements.txt"
    exit 1
  fi

  source .venv39/bin/activate

  # Process Coelho da Fonseca
  echo ""
  echo "Processing Coelho da Fonseca..."
  cd ufoid

  # Update config for Coelho
  cat > config/config.yaml <<EOF
num_processes: 8
chunk_length: 20000
distance_threshold: 10

new_paths:
  - "data/coelhodafonseca/cache"

old_paths: []

check_with_itself: true
check_with_old_data: false

csv_output: true
csv_output_file: "ufoid_output/coelho_duplicates.csv"

delete_duplicates: false
create_folder_with_no_duplicates: true
new_folder: "ufoid_output/coelho_clean"
EOF

  python ufoid.py

  # Process Viva Prime Imóveis
  echo ""
  echo "Processing Viva Prime Imóveis..."

  # Update config for Viva
  cat > config/config.yaml <<EOF
num_processes: 8
chunk_length: 20000
distance_threshold: 10

new_paths:
  - "data/vivaprimeimoveis/cache"

old_paths: []

check_with_itself: true
check_with_old_data: false

csv_output: true
csv_output_file: "ufoid_output/viva_duplicates.csv"

delete_duplicates: false
create_folder_with_no_duplicates: true
new_folder: "ufoid_output/viva_clean"
EOF

  python ufoid.py

  cd ..
  deactivate

  echo "✓ UFOID deduplication complete!"
else
  echo "Stage 2: UFOID Deduplication [SKIPPED]"
  echo "--------------------------------------------------------------------------------"
fi

echo ""

###############################################################################
# Stage 3: Reorganization
###############################################################################

echo "Stage 3: Reorganization"
echo "--------------------------------------------------------------------------------"

# Activate main Python environment
if [ ! -d ".venv" ]; then
  echo "❌ Error: .venv/ not found!"
  echo "   Please create Python environment:"
  echo "   python3 -m venv .venv"
  echo "   source .venv/bin/activate"
  echo "   pip install rich typer"
  exit 1
fi

source .venv/bin/activate

# Run reorganization script
python scripts/reorganize_ufoid_output.py

echo "✓ Reorganization complete!"
echo ""

###############################################################################
# Stage 4: Fastdup Analysis
###############################################################################

echo "Stage 4: Fastdup Analysis"
echo "--------------------------------------------------------------------------------"

# Check if fastdup is installed
if ! python -c "import fastdup" 2>/dev/null; then
  echo "❌ Error: fastdup not installed!"
  echo "   Please install: pip install fastdup"
  exit 1
fi

# Run fastdup
bash scripts/run_fastdup.sh

echo "✓ Fastdup analysis complete!"
echo ""

###############################################################################
# Stage 5: Exterior Photo Selection
###############################################################################

echo "Stage 5: Exterior Photo Selection"
echo "--------------------------------------------------------------------------------"

# Select best 12 photos for Coelho
echo "Selecting exterior photos for Coelho da Fonseca..."
python scripts/select_exteriors.py coelhodafonseca

# Select best 12 photos for Viva
echo ""
echo "Selecting exterior photos for Viva Prime Imóveis..."
python scripts/select_exteriors.py vivaprimeimoveis

deactivate

echo ""
echo "✓ Exterior photo selection complete!"
echo ""

###############################################################################
# Summary
###############################################################################

echo "================================================================================"
echo "Pipeline Execution Complete!"
echo "================================================================================"
echo ""
echo "Final Output:"
echo "  selected_exteriors/coelhodafonseca/    - Best 12 exterior photos per listing"
echo "  selected_exteriors/vivaprimeimoveis/   - Best 12 exterior photos per listing"
echo ""
echo "Next Steps:"
echo "  1. Review selection quality: ls selected_exteriors/coelhodafonseca/"
echo "  2. Check manifests: cat selected_exteriors/coelhodafonseca/*//_manifest.json"
echo "  3. Use selected photos for property matching"
echo ""
echo "See PIPELINE.md for detailed documentation."
echo "================================================================================"
