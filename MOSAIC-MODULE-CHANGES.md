# Mosaic Module Changes - Using Fastdup Rankings

## Overview

The `mosaic-module.js` has been updated to use the best-ranked images from the fastdup selection process instead of performing its own image scoring and selection.

## What Changed

### Before
- Downloaded images from URLs
- Performed custom scoring (exterior score, pool score, outdoor score)
- De-duplicated using pHash
- Selected images based on internal criteria
- Built 2x3 mosaics

### After
- **Loads pre-selected images** from `selected_exteriors/{site}/{listing_id}/`
- **Uses fastdup rankings** from `_manifest.json`
- **Takes top 6 images** (for 2x3 grid) by `rank_score`
- Builds mosaics using the best fastdup-ranked images

## How It Works

### 1. Image Selection
The new `loadFromFastdupSelection()` function:
- Reads `selected_exteriors/{site}/{listing_id}/_manifest.json`
- Sorts images by `rank_score` (descending - best first)
- Takes the top 6 images for a 2x3 mosaic
- Returns the file paths of the selected images

### 2. Ranking Criteria (from fastdup)
Images are already ranked by `select_exteriors.py` using:
- **50% Exterior score** - HSV-based detection (sky, vegetation)
- **35% Sharpness** - Laplacian variance
- **15% Brightness** - Gaussian preference for mid-brightness

### 3. Mosaic Generation
- Uses the same `makeMosaic()` function as before
- Supports 'contain' (letterbox) or 'cover' fit modes
- Configurable grid size, cell dimensions, and background color

## Prerequisites

**IMPORTANT:** The fastdup pipeline must be run before generating mosaics!

See `PIPELINE.md` for the complete workflow:
1. Web scraping (Playwright)
2. UFOID deduplication
3. Reorganization
4. Fastdup analysis
5. **Exterior photo selection** ← Must complete this step first!
6. Mosaic generation ← This module

## Usage

```bash
# Generate mosaics for Viva Prime Imóveis
node scripts/mosaic-module.js viva

# Generate mosaics for Coelho da Fonseca
node scripts/mosaic-module.js coelho

# Generate for both sites
node scripts/mosaic-module.js both

# Custom grid size (e.g., 3x2 = 6 images)
node scripts/mosaic-module.js viva --grid=3x2

# Custom cell dimensions
node scripts/mosaic-module.js viva --cellw=400 --cellh=400

# Use 'cover' fit instead of 'contain' (letterbox)
node scripts/mosaic-module.js viva --fit=cover
```

## Expected Directory Structure

```
selected_exteriors/
├── vivaprimeimoveis/
│   ├── 1034/
│   │   ├── 0_image1.jpg        # Top-ranked image
│   │   ├── 1_image2.jpg        # 2nd ranked
│   │   ├── ...                 # (up to 12 images)
│   │   └── _manifest.json      # Rankings and metadata
│   └── ...
└── coelhodafonseca/
    ├── 302330/
    │   ├── 0_image1.jpg
    │   ├── ...
    │   └── _manifest.json
    └── ...
```

## Output

Mosaics are saved to:
```
data/mosaics/
├── viva/
│   ├── 1034.png
│   ├── 1060.png
│   └── ...
└── coelho/
    ├── 302330.png
    ├── 352803.png
    └── ...
```

## Manifest Example

The `_manifest.json` contains ranking information:

```json
{
  "site": "vivaprimeimoveis",
  "listing_id": "1034",
  "total_images": 35,
  "selected_count": 12,
  "selected": [
    {
      "filename": "data_clean/vivaprimeimoveis/1034/0_image.jpg",
      "rank_score": 0.849,
      "ext_n": 1.0,        // Normalized exterior score
      "sharp_n": 0.729,    // Normalized sharpness
      "bright_n": 0.892,   // Normalized brightness
      "cluster": 0         // Visual cluster ID
    },
    // ... 11 more images
  ]
}
```

The mosaic module takes the top 6 images from this ranked list.

## Benefits

1. **Consistent quality** - Uses the same scoring across all tools
2. **Better performance** - No need to re-score images
3. **Reproducible** - Mosaics use the same images as other analysis tools
4. **Simpler code** - Removed complex scoring and selection logic
5. **Pipeline integration** - Works seamlessly with the fastdup workflow

## Backward Compatibility

The old functions (`downloadAndCache`, `selectForMosaic`) are still available in the module exports for any legacy code that might need them, but the main workflow now uses `loadFromFastdupSelection()`.

## Troubleshooting

### Error: "No fastdup selection found"
**Problem:** The `selected_exteriors` directory doesn't exist or is empty

**Solution:** Run the fastdup pipeline first:
```bash
source .venv/bin/activate
python scripts/select_exteriors.py vivaprimeimoveis
python scripts/select_exteriors.py coelhodafonseca
```

### Error: "No images available from fastdup selection"
**Problem:** The listing doesn't have a `_manifest.json` or no images passed the selection criteria

**Solution:** Check the listing directory in `selected_exteriors/{site}/{listing_id}/` to verify images exist

### Mosaic uses fewer than 6 images
**Problem:** The listing had fewer than 6 images to begin with

**Solution:** This is expected - the mosaic will use all available images (up to 6)

## Code Changes Summary

### New Function
- `loadFromFastdupSelection(listing, side, maxN)` - Loads top N ranked images from fastdup selection

### Modified Function
- `generateMosaicForListing(listing, side)` - Now uses fastdup selection instead of downloading/scoring

### Updated Constants
- `FASTDUP_SELECTED_DIR` - Path to fastdup selection output

### Updated Documentation
- File header comments
- CLI usage instructions
- Module exports

---

**Last Updated:** 2025-10-21
**Version:** V2 (Fastdup Integration)
