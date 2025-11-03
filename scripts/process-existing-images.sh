#!/bin/bash
# Process existing downloaded images to select best 12 exteriors per listing
# Runs fastdup directly on original images (read-only), then selects best exteriors

echo "🔬 Processing Existing Images"
echo "=============================="
echo ""

# Directories
COELHO_IMAGES="data/coelhodafonseca/images"
VIVA_IMAGES="data/vivaprimeimoveis/images"
WORK_DIR="work_fastdup"
OUTPUT_DIR="selected_exteriors"

# Create work directories
mkdir -p "$WORK_DIR"
mkdir -p "$OUTPUT_DIR"

echo "Step 1: Running fastdup on original images (read-only analysis)..."
echo ""

# Run fastdup using the Python script
echo "🔬 Running fastdup analysis..."
python3 scripts/process-images-fastdup.py

echo ""
echo "Step 2: Selecting best 12 exterior images per listing..."
echo ""

# Run select_exteriors on Coelho
echo "📸 Selecting exteriors for Coelho da Fonseca..."
python3 scripts/select_exteriors.py coelhodafonseca \
  --cache-root data \
  --work-root "$WORK_DIR" \
  --out-root "$OUTPUT_DIR" \
  --images-subdir images

echo ""

# Run select_exteriors on Viva
echo "📸 Selecting exteriors for Viva Prime Imóveis..."
python3 scripts/select_exteriors.py vivaprimeimoveis \
  --cache-root data \
  --work-root "$WORK_DIR" \
  --out-root "$OUTPUT_DIR" \
  --images-subdir images

echo ""
echo "=============================="
echo "✅ PROCESSING COMPLETE!"
echo "=============================="
echo ""
echo "Original images (untouched):"
echo "  - $COELHO_IMAGES"
echo "  - $VIVA_IMAGES"
echo ""
echo "Fastdup analysis results:"
echo "  - $WORK_DIR/coelhodafonseca"
echo "  - $WORK_DIR/vivaprimeimoveis"
echo ""
echo "Selected best 12 exteriors:"
echo "  - $OUTPUT_DIR/coelhodafonseca"
echo "  - $OUTPUT_DIR/vivaprimeimoveis"
echo ""
