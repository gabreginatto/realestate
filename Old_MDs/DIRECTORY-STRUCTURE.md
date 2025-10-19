# Directory Structure - Real Estate Comparison System

## Overview

This document describes the directory structure for image collection, caching, and mosaic generation.

## Current Structure (After Phase 1)

```
data/
├── vivaprimeimoveis/
│   ├── listings/
│   │   ├── all-listings.json          # Contains listing.images[] with URLs
│   │   └── collected-urls.json         # Initial URL collection
│   └── images/                         # ⚠️ OLD - from previous scraper (can delete)
│
├── coelhodafonseca/
│   ├── listings/
│   │   ├── all-listings.json          # Contains listing.images[] with URLs
│   │   └── collected-urls.json         # Initial URL collection
│   └── images/                         # ⚠️ OLD - from previous scraper (can delete)
│
└── smart-matches.json                  # Current comparison results
```

## Target Structure (After Phase 2 - Mosaic Module)

```
data/
├── vivaprimeimoveis/
│   ├── listings/
│   │   └── all-listings.json          # Listing data with images[] array
│   │
│   └── cache/                          # 🆕 Downloaded images cache
│       ├── 17116/                      # One folder per property
│       │   ├── 0_il92b39zhO3H1Q3b1S4_171166749e32d6ad52.jpg
│       │   ├── 1_il92b39zhO3H1Q3b1S4_171166749e368bbb93.jpg
│       │   └── ... (up to 47 images)
│       │
│       └── 17232/
│           ├── 0_i9M7b4l3hR6L6X8FIF4_1723267b87e13f1596.jpg
│           └── ... (up to 24 images)
│
├── coelhodafonseca/
│   ├── listings/
│   │   └── all-listings.json          # Listing data with images[] array
│   │
│   └── cache/                          # 🆕 Downloaded images cache
│       ├── 661974/                     # One folder per property
│       │   ├── 0_10493317.jpg
│       │   ├── 1_10493282.jpg
│       │   └── ... (up to 20 images)
│       │
│       └── 674139/
│           └── ...
│
└── mosaics/                            # 🆕 Generated 3×2 mosaics (900x600px)
    ├── viva/
    │   ├── 17116.png                   # Mosaic for VIVA listing 17116
    │   ├── 17232.png
    │   └── ... (70 mosaics total)
    │
    └── coelho/
        ├── 661974.png                  # Mosaic for Coelho listing 661974
        ├── 674139.png
        └── ... (81 mosaics total)
```

## Mosaic Module Workflow

### 1. Image Download & Caching

```javascript
// Function: downloadAndCache(listing, side)
// Downloads images from listing.images[] URLs to cache directory

Input:  listing.images = ["https://www.vivaprimeimoveis.com.br/fotos/17116/img1.jpg", ...]
Cache:  data/vivaprimeimoveis/cache/17116/
Output: ["0_img1.jpg", "1_img2.jpg", ...] (local file paths)
```

**Caching Rules:**
- Images are downloaded **once** and reused
- Filename format: `{index}_{originalFilename}.jpg`
- Index preserves order from listing.images[]
- Cache persists across runs (no re-downloading)

### 2. Image Selection for Mosaic

```javascript
// Function: selectForMosaic(imagePaths, maxN=6)
// Selects 6 diverse, high-quality images

Input:  ["0_img1.jpg", "1_img2.jpg", ..., "46_img47.jpg"]
Logic:
  - Skip duplicates (perceptual hash)
  - Prefer exterior photos (sky/green detection)
  - Prefer high resolution
  - Distribute selection across image set
Output: ["0_img1.jpg", "5_img6.jpg", "12_img13.jpg", "20_img21.jpg", "35_img36.jpg", "45_img46.jpg"]
```

### 3. Mosaic Generation

```javascript
// Function: makeMosaic(selectedImages, outputPath, options)
// Creates 3×2 grid mosaic

Input:  6 selected image paths
Layout:
  ┌───────┬───────┬───────┐
  │ img1  │ img2  │ img3  │  Row 1: 300x300 each
  ├───────┼───────┼───────┤
  │ img4  │ img5  │ img6  │  Row 2: 300x300 each
  └───────┴───────┴───────┘
Output: data/mosaics/viva/17116.png (900x600px)
```

**Mosaic Specifications:**
- Dimensions: 900x600 pixels (3×2 grid)
- Cell size: 300x300 pixels each
- Format: PNG (lossless for Gemini comparison)
- Images are resized/cropped to fit cells

## API Usage & Cost Management

### Caching Benefits

**Without caching (re-downloading every run):**
- 70 VIVA + 81 Coelho = 151 listings
- ~30 images/listing average
- **~4,530 image downloads** per run
- Bandwidth: ~450MB per run

**With caching:**
- First run: 4,530 downloads
- Subsequent runs: **0 downloads** ✅
- Disk space: ~450MB (one-time)

### Mosaic Generation

**Generated on-demand:**
- Check if `data/mosaics/viva/17116.png` exists
- If exists: reuse ✅
- If missing: generate from cache

**Regeneration triggers:**
- Manual deletion of mosaic file
- Changes to selection algorithm
- New scraper run with updated images

## File Naming Conventions

### Cache Images

Format: `{index}_{originalFilename}.ext`

Examples:
- `0_il92b39zhO3H1Q3b1S4_171166749e32d6ad52.jpg`
- `15_10493317.jpg`

**Benefits:**
- Index preserves order from listing
- Original filename helps debugging
- Easy to trace back to source URL

### Mosaics

Format: `{propertyCode}.png`

Examples:
- `17116.png` (VIVA listing)
- `661974.png` (Coelho listing)

**Benefits:**
- Simple lookup by property code
- No ambiguity across sites (different folders)

## Cleanup & Maintenance

### Safe to Delete

- `data/vivaprimeimoveis/images/` (old scraper downloads)
- `data/coelhodafonseca/images/` (old scraper downloads)
- `data/mosaics/` (can regenerate from cache)

### Important to Keep

- `data/*/listings/*.json` (listing data with URLs)
- `data/*/cache/` (downloaded images - expensive to re-download)

### Storage Estimates

| Directory | Size | Count |
|-----------|------|-------|
| VIVA cache | ~280MB | ~2,100 images |
| Coelho cache | ~200MB | ~1,600 images |
| VIVA mosaics | ~35MB | 70 mosaics |
| Coelho mosaics | ~40MB | 81 mosaics |
| **Total** | **~555MB** | - |

## Error Handling

### Missing Images

If image download fails:
```javascript
{
  propertyCode: "17116",
  images: [...],
  imageStats: {
    totalUrls: 47,
    downloaded: 45,    // 2 failed
    failed: [
      { url: "...", error: "404 Not Found" },
      { url: "...", error: "Timeout" }
    ]
  }
}
```

### Insufficient Images

If < 3 images available:
- Skip mosaic generation
- Flag in results: `"insufficient_images": true`
- Fall back to text-only comparison

## Next Steps

1. ✅ Phase 1 Complete: Scrapers collect image URLs
2. ⏳ Phase 2: Create cache directories and mosaic module
3. ⏳ Phase 3: Integrate mosaic comparison into smart-compare.cjs
4. ⏳ Phase 4: Visual search for ghost listings
