#!/bin/bash
# Process existing downloaded images to select best 12 exteriors per listing

echo "🔬 Processing Existing Images"
echo "=============================="
echo ""

# Directories
COELHO_IMAGES="data/coelhodafonseca/images"
VIVA_IMAGES="data/vivaprimeimoveis/images"
COELHO_PROCESSED="data/coelhodafonseca/images_processed"
VIVA_PROCESSED="data/vivaprimeimoveis/images_processed"
WORK_DIR="work_fastdup"
OUTPUT_DIR="selected_exteriors"

# Create directories
mkdir -p "$COELHO_PROCESSED"
mkdir -p "$VIVA_PROCESSED"
mkdir -p "$WORK_DIR"
mkdir -p "$OUTPUT_DIR"

echo "Step 1: Copying images to processing folders (originals stay untouched)..."
echo ""

# Copy Coelho images
echo "📦 Copying Coelho da Fonseca images..."
if [ -d "$COELHO_IMAGES" ]; then
  cp -r "$COELHO_IMAGES"/* "$COELHO_PROCESSED"/ 2>/dev/null || true
  echo "✓ Coelho images copied"
else
  echo "⚠️  No Coelho images found at $COELHO_IMAGES"
fi

# Copy Viva images
echo "📦 Copying Viva Prime images..."
if [ -d "$VIVA_IMAGES" ]; then
  cp -r "$VIVA_IMAGES"/* "$VIVA_PROCESSED"/ 2>/dev/null || true
  echo "✓ Viva images copied"
else
  echo "⚠️  No Viva images found at $VIVA_IMAGES"
fi

echo ""
echo "Step 2: Running fastdup on processed images..."
echo ""

# Run fastdup on Coelho
echo "🔬 Running fastdup on Coelho da Fonseca..."
python3 scripts/run_fastdup.py process-all "$COELHO_PROCESSED" --target 12

echo ""

# Run fastdup on Viva
echo "🔬 Running fastdup on Viva Prime Imóveis..."
python3 scripts/run_fastdup.py process-all "$VIVA_PROCESSED" --target 12

echo ""
echo "Step 3: Selecting best 12 exterior images per listing..."
echo ""

# Run select_exteriors on Coelho
echo "📸 Selecting exteriors for Coelho da Fonseca..."
python3 scripts/select_exteriors.py coelhodafonseca \
  --cache-root data \
  --work-root "$WORK_DIR" \
  --out-root "$OUTPUT_DIR"

echo ""

# Run select_exteriors on Viva
echo "📸 Selecting exteriors for Viva Prime Imóveis..."
python3 scripts/select_exteriors.py vivaprimeimoveis \
  --cache-root data \
  --work-root "$WORK_DIR" \
  --out-root "$OUTPUT_DIR"

echo ""
echo "=============================="
echo "✅ PROCESSING COMPLETE!"
echo "=============================="
echo ""
echo "Original images (untouched):"
echo "  - $COELHO_IMAGES"
echo "  - $VIVA_IMAGES"
echo ""
echo "Processed images:"
echo "  - $COELHO_PROCESSED"
echo "  - $VIVA_PROCESSED"
echo ""
echo "Selected best 12 exteriors:"
echo "  - $OUTPUT_DIR/coelhodafonseca"
echo "  - $OUTPUT_DIR/vivaprimeimoveis"
echo ""
