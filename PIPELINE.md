# Real Estate Image Processing Pipeline

Complete end-to-end pipeline for scraping real estate listings and processing images to select the best 12 exterior photos per property.

## Overview

This pipeline extracts real estate listings from websites, downloads property images, removes duplicates, analyzes image quality, and selects the best exterior photos for property matching and comparison.

**Sites Supported:**
- Coelho da Fonseca (`coelhodafonseca`)
- Viva Prime Imóveis (`vivaprimeimoveis`)

---

## Pipeline Stages

### Stage 1: Web Scraping & Listing Extraction

**Script:** `scripts/extract-details-coelhodafonseca.spec.ts` (Playwright)

**What it does:**
- Navigates to real estate website
- Searches for properties in target location
- Extracts listing URLs from search results pages
- Visits each listing page
- Extracts property details (price, area, bedrooms, etc.)
- Downloads all property images

**Output:**
```
data/{site}/cache/{listing_id}/
  ├── 0_image1.jpg
  ├── 1_image2.jpg
  ├── ...
  └── raw/
      └── listing.json  # Property metadata
```

**How to run:**
```bash
# Coelho da Fonseca
npx playwright test scripts/extract-details-coelhodafonseca.spec.ts

# Viva Prime Imóveis
# (Similar Playwright script would be created)
```

**Typical output:**
- 81 listings for Coelho da Fonseca
- 69 listings for Viva Prime Imóveis
- 20-50 images per listing

---

### Stage 2: UFOID - Exact Duplicate Removal

**Script:** `ufoid` tool with `ufoid/config/config.yaml`

**What it does:**
- Uses perceptual hashing (pHash) to find exact and near-exact duplicates
- Removes duplicate images **within each site separately**
- Preserves cross-site duplicates (important for property matching)
- Distance threshold: 10 (recommended for exact + slight modifications)

**Configuration:**
```yaml
# ufoid/config/config.yaml
distance_threshold: 10
new_paths:
  - "data/coelhodafonseca/cache"  # Or "data/vivaprimeimoveis/cache"
check_with_itself: true
create_folder_with_no_duplicates: true
new_folder: "ufoid_output/coelho_clean"  # Or "ufoid_output/viva_clean"
```

**How to run:**
```bash
# Coelho da Fonseca
source .venv39/bin/activate
python ufoid.py

# Then update config.yaml for Viva and run again
```

**Output:**
```
ufoid_output/
├── coelho_clean/          # Deduplicated images (flat directory)
│   ├── 0_10297030.jpg
│   ├── 1_10297036.jpg
│   └── ...
├── coelho_duplicates.csv  # Duplicate pairs found
├── viva_clean/
└── viva_duplicates.csv
```

**Typical results:**
- Coelho: 3,248 original → 2,139 cleaned (34% duplicates removed)
- Viva: 2,544 original → 2,030 cleaned (20% duplicates removed)

---

### Stage 3: Reorganization - Restore Per-Listing Structure

**Script:** `scripts/reorganize_ufoid_output.py`

**What it does:**
- UFOID outputs flat directory, but fastdup needs per-listing folders
- Maps each cleaned image back to its original listing ID
- Creates per-listing folder structure for fastdup processing

**How to run:**
```bash
source .venv/bin/activate
python scripts/reorganize_ufoid_output.py
```

**Output:**
```
data_clean/
├── coelhodafonseca/
│   ├── 302330/
│   │   ├── 0_10297030.jpg
│   │   ├── 10_10297052.jpg
│   │   └── ...
│   ├── 352803/
│   └── ...
└── vivaprimeimoveis/
    ├── 1034/
    ├── 1060/
    └── ...
```

**Typical results:**
- Successfully reorganizes 4,169 images (2,139 Coelho + 2,030 Viva)
- Preserves per-listing folder structure

---

### Stage 4: Fastdup - Quality Analysis & Clustering

**Script:** `scripts/run_fastdup.sh`

**What it does:**
- Runs fastdup **separately for each site** (no cross-site processing)
- Analyzes each listing independently
- Computes image quality metrics (blur, brightness, contrast)
- Identifies visual clusters (near-duplicates within listing)
- Generates similarity scores between images

**Key settings:**
- Threshold: 0.90 (high similarity = same cluster)
- Processes each listing in isolation
- Minimum 10 images required per listing

**How to run:**
```bash
source .venv/bin/activate
bash scripts/run_fastdup.sh
```

**Output:**
```
work_fastdup/
├── coelhodafonseca/
│   ├── 302330/
│   │   └── fastdup/
│   │       ├── atrain_stats.csv       # Quality metrics (blur, brightness, etc.)
│   │       ├── atrain_features.dat.csv # Filename index mapping
│   │       ├── similarity.csv         # Near-duplicate pairs
│   │       ├── connected_components.csv # Cluster assignments
│   │       └── ...
│   ├── 352803/
│   └── ...
└── vivaprimeimoveis/
    └── ...
```

**Typical processing time:**
- 81 Coelho listings: ~20 minutes
- 69 Viva listings: ~15 minutes
- Some listings with <10 images will skip (fastdup minimum requirement)

---

### Stage 5: Exterior Photo Selection

**Script:** `scripts/select_exteriors.py`

**What it does:**
- Selects **exactly 12 best exterior-leaning photos** per listing (or all if <12)
- Uses fastdup quality metrics + custom exterior heuristics
- De-duplicates by selecting best photo from each visual cluster
- Creates manifest with selection rationale

**Ranking algorithm:**
- **50% Exterior score** - HSV-based detection (sky blue, vegetation green)
- **35% Sharpness** - Laplacian variance
- **15% Brightness** - Gaussian preference for mid-brightness (~130/255)

**De-duplication:**
- Groups images into visual clusters (from fastdup)
- Selects only the best-ranked image from each cluster
- Ensures diversity in final selection

**How to run:**
```bash
# Coelho da Fonseca
source .venv/bin/activate
python scripts/select_exteriors.py coelhodafonseca

# Viva Prime Imóveis
python scripts/select_exteriors.py vivaprimeimoveis
```

**Output:**
```
selected_exteriors/
├── coelhodafonseca/
│   ├── 302330/
│   │   ├── 0_10297030.jpg       # Selected photo 1
│   │   ├── 33_9550860.jpg       # Selected photo 2
│   │   ├── ...                  # (12 photos total)
│   │   └── _manifest.json       # Selection details
│   ├── 352803/
│   └── ...
└── vivaprimeimoveis/
    ├── 1034/
    │   ├── 0_i166f391...jpg
    │   ├── 1_i166f391...jpg
    │   ├── ...
    │   └── _manifest.json
    └── ...
```

**Manifest format:**
```json
{
  "site": "coelhodafonseca",
  "listing_id": "302330",
  "total_images": 35,
  "valid_images": 35,
  "selected_count": 12,
  "target_count": 12,
  "selected": [
    {
      "filename": "data_clean/coelhodafonseca/302330/0_10297030.jpg",
      "rank_score": 0.749,
      "ext_n": 1.0,        // Exterior score (0-1)
      "sharp_n": 0.329,    // Sharpness (0-1)
      "bright_n": 0.892,   // Brightness (0-1)
      "cluster": 0         // Visual cluster ID
    },
    // ... 11 more photos
  ]
}
```

**Typical results:**
- **Coelho:** 960 images selected (78 listings × 12 + 3 with <12)
- **Viva:** 800 images selected (64 listings × 12 + 5 with <12)

---

## Complete Pipeline Execution

### Full Pipeline (from scratch):

```bash
# 1. Web Scraping (Playwright)
npx playwright test scripts/extract-details-coelhodafonseca.spec.ts

# 2. UFOID Deduplication (Coelho)
source .venv39/bin/activate
cd ufoid
# Edit config.yaml for coelhodafonseca
python ufoid.py
cd ..

# 3. UFOID Deduplication (Viva)
cd ufoid
# Edit config.yaml for vivaprimeimoveis
python ufoid.py
cd ..

# 4. Reorganize UFOID Output
source .venv/bin/activate
python scripts/reorganize_ufoid_output.py

# 5. Run Fastdup Analysis
bash scripts/run_fastdup.sh

# 6. Select Best 12 Exterior Photos
python scripts/select_exteriors.py coelhodafonseca
python scripts/select_exteriors.py vivaprimeimoveis
```

### Re-running Selection Only:

If you want to change selection criteria without re-running everything:

```bash
# Delete previous selection
rm -rf selected_exteriors/

# Adjust weights in select_exteriors.py (lines 174-176):
# df["rank_score"] = 0.50 * df["ext_n"] + 0.35 * df["sharp_n"] + 0.15 * df["bright_n"]

# Re-run selection
source .venv/bin/activate
python scripts/select_exteriors.py coelhodafonseca
python scripts/select_exteriors.py vivaprimeimoveis
```

---

## Data Flow Summary

```
┌─────────────────────────────────────────────────────────────────┐
│ Stage 1: Web Scraping                                           │
│ Input:  Real estate website URLs                                │
│ Output: data/{site}/cache/{listing_id}/*.jpg                    │
│         ~20-50 images per listing                               │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ Stage 2: UFOID Deduplication (per site)                         │
│ Input:  data/{site}/cache/{listing_id}/*.jpg                    │
│ Output: ufoid_output/{site}_clean/*.jpg (flat)                  │
│         ~30-35% duplicates removed                              │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ Stage 3: Reorganization                                         │
│ Input:  ufoid_output/{site}_clean/*.jpg (flat)                  │
│ Output: data_clean/{site}/{listing_id}/*.jpg (per-listing)      │
│         Structure restored for fastdup                          │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ Stage 4: Fastdup Analysis (per listing)                         │
│ Input:  data_clean/{site}/{listing_id}/*.jpg                    │
│ Output: work_fastdup/{site}/{listing_id}/fastdup/*.csv          │
│         Quality metrics + clustering                            │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ Stage 5: Exterior Photo Selection                               │
│ Input:  data_clean/{site}/{listing_id}/*.jpg                    │
│         + work_fastdup/{site}/{listing_id}/fastdup/*.csv        │
│ Output: selected_exteriors/{site}/{listing_id}/                 │
│         Exactly 12 best exterior photos + _manifest.json        │
└─────────────────────────────────────────────────────────────────┘
```

---

## Important Design Decisions

### 1. Separate Processing Per Site

**Why:** We intentionally run UFOID and fastdup separately for each site to **preserve cross-site duplicates**. When the same property appears on both Coelho and Viva, we WANT those duplicate photos because they help us match properties across sites.

### 2. Two-Stage Deduplication

**Stage 1 (UFOID):** Removes exact/near-exact duplicates within site
- Distance threshold: 10
- Catches watermarked versions, slight edits, re-compressions

**Stage 2 (Fastdup):** Removes visual similarity within listing
- Threshold: 0.90
- Catches similar angles, sequential photos, minor variations

### 3. Exterior Heuristics

Simple HSV-based detection works well:
- **Sky detection:** H≈90-140° (blue), S>40, V>80
- **Vegetation:** H≈35-85° (green), S>40, V>40
- **Indoor penalty:** H≈0-15°/165-180° (warm tones), S>40, V>40

This captures outdoor architecture shots while filtering indoor rooms.

### 4. Cluster-Based Selection

Instead of just ranking all photos:
1. Group into visual clusters (fastdup)
2. Pick BEST photo from each cluster
3. Sort clusters by rank score
4. Select top 12 clusters

This ensures diversity - we don't select 12 nearly-identical photos of the front door.

---

## Troubleshooting

### Fastdup fails with "Insufficient images"
**Problem:** Listing has <10 images (fastdup minimum requirement)
**Solution:** Script continues processing other listings. These will be handled in Stage 5 without fastdup metrics.

### "Module not found" errors
**Problem:** Wrong Python environment
**Solution:**
- UFOID requires Python 3.9: `source .venv39/bin/activate`
- Other scripts use main env: `source .venv/bin/activate`

### Selection returns <12 photos for most listings
**Problem:** Too many images in same cluster, or insufficient quality diversity
**Solution:** Lower fastdup threshold in `run_fastdup.sh` (e.g., 0.85 instead of 0.90)

### UFOID removes too many images
**Problem:** Distance threshold too high
**Solution:** Lower threshold in `ufoid/config/config.yaml` (e.g., 5 instead of 10)

---

## Configuration Files

### UFOID Config: `ufoid/config/config.yaml`

```yaml
num_processes: 8
chunk_length: 20000
distance_threshold: 10

new_paths:
  - "data/coelhodafonseca/cache"  # Change for each site

check_with_itself: true
check_with_old_data: false

csv_output: true
csv_output_file: "ufoid_output/coelho_duplicates.csv"

delete_duplicates: false
create_folder_with_no_duplicates: true
new_folder: "ufoid_output/coelho_clean"
```

### Fastdup Threshold: `scripts/run_fastdup.sh`

```bash
# Line 55:
fd.run(threshold=0.90, verbose=0)  # 0.90 = high similarity required
```

### Selection Weights: `scripts/select_exteriors.py`

```python
# Lines 174-176:
df["rank_score"] = (
    0.50 * df["ext_n"] +      # Exterior score
    0.35 * df["sharp_n"] +    # Sharpness
    0.15 * df["bright_n"]     # Brightness
)
```

---

## Performance Metrics

### Typical Processing Times (2024 MacBook):

| Stage | Coelho (81 listings) | Viva (69 listings) |
|-------|---------------------|-------------------|
| Web Scraping | ~15 minutes | ~12 minutes |
| UFOID | ~3 minutes | ~2 minutes |
| Reorganization | <1 minute | <1 minute |
| Fastdup | ~20 minutes | ~15 minutes |
| Selection | ~1.5 minutes | ~15 seconds |
| **Total** | **~40 minutes** | **~30 minutes** |

### Storage Requirements:

| Stage | Disk Usage |
|-------|-----------|
| Original cache | ~850 MB |
| UFOID cleaned | ~550 MB |
| Fastdup work dir | ~1.2 GB |
| Final selection | ~200 MB |

---

## Next Steps / Future Improvements

1. **Property Matching:** Use the 12 selected exterior photos to match properties across Coelho and Viva sites
2. **Automated Pipeline:** Create single shell script to run entire pipeline
3. **Quality Dashboard:** Visualize selection statistics and photo quality distributions
4. **ML Enhancement:** Train classifier to detect exterior photos instead of HSV heuristics
5. **Incremental Updates:** Only process new/changed listings instead of full pipeline

---

## References

- **UFOID:** https://github.com/JPBM135/UFOID
- **Fastdup:** https://github.com/visual-layer/fastdup
- **Playwright:** https://playwright.dev/

---

Last Updated: 2025-01-19
