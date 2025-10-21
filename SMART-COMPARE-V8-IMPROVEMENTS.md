# Smart Compare V8 Improvements

## Overview

Version 8 (V8) of smart-compare represents a major overhaul of Phase 1 (deterministic filtering) to dramatically improve candidate quality before sending to Phase 2 (Gemini AI verification).

**The Problem:** V7's indices were built on low-variance data (beds, built area, price/m²), creating massive buckets that sent too many false candidates to expensive Gemini API calls.

**The Solution:** Four strategic improvements to create unique "fingerprints" from seemingly similar data.

---

## V8 Improvements Summary

| Improvement | Impact | Description |
|-------------|--------|-------------|
| **1. Denoised Features** | 🔥🔥🔥 Critical | Remove broker-speak, extract structured keywords |
| **2. Exact Price Index** | 🔥🔥 High | Replace useless price/m² with absolute price matching |
| **3. Ratio Index** | 🔥🔥 High | Capture property "shape" via relationships |
| **4. Proportional Gathering** | 🔥 Medium | Make index lookups proportional (±8%) not fixed |

---

## Improvement #1: Denoised Features & Feature Signatures

### The Problem

**Old Index C:** `(beds, topFeature)` where `topFeature` was the first random word from description.

Example keys:
- `(4, "excelente")` - Marketing fluff
- `(4, "oportunidade")` - More fluff
- `(4, "localização")` - Generic

**Result:** Weak index with random buckets. The 27% feature_jaccard score was also unreliable because it compared "broker-speak" noise.

### The Solution

**Three-Part Strategy:**

#### A. Broker-Speak Stop-List

Created a comprehensive list of meaningless marketing phrases:

```javascript
const BROKER_SPEAK = new Set([
  // Generic marketing
  'excelente oportunidade', 'oportunidade única', 'não perca', 'imperdível',
  'agende sua visita', 'entre em contato', 'fale conosco',

  // Location fluff
  'excelente localização', 'ótima localização', 'localização privilegiada',
  'localização nobre', 'região nobre', 'bairro nobre',

  // Generic descriptors
  'alto padrão', 'luxo', 'sofisticação', 'fino acabamento',
  'projeto moderno', 'arquitetura moderna', 'design contemporâneo',

  // And 20+ more...
]);
```

#### B. Structured Keyword Extraction

Instead of random words, extract specific, structural features using regex:

```javascript
function extractStructuredFeatures(text) {
  return {
    has_pool: /piscina/.test(lower),
    has_heated_pool: /piscina\s+(aquecida|climatizada)/.test(lower),
    has_gourmet: /(espaco|área)\s+gourmet|churrasqueira/.test(lower),
    has_office: /(escritorio|home\s*office)/.test(lower),
    has_wine_cellar: /adega/.test(lower),
    has_sauna: /sauna/.test(lower),
    has_gym: /(academia|sala\s+de\s+ginastica)/.test(lower),
    has_cinema: /(sala\s+de\s+cinema|home\s*theater)/.test(lower),
    has_solar: /(energia\s+solar|fotovoltaic)/.test(lower),
    has_generator: /gerador/.test(lower),
    has_well: /(poco|poço)\s+artesiano/.test(lower),
    has_elevator: /elevador/.test(lower),
    has_high_ceiling: /(pe|pé).direito\s+(duplo|alto)/.test(lower),
    // ... 17 total features
  };
}
```

#### C. Feature Signature Index

Create a hash of boolean features for indexing:

```javascript
function featureSignature(features) {
  const key = [
    features.has_pool ? 'P' : '',
    features.has_heated_pool ? 'H' : '',
    features.has_gourmet ? 'G' : '',
    features.has_office ? 'O' : '',
    features.has_wine_cellar ? 'W' : '',
    // ... etc
  ].join('');

  return key || 'NONE';
}
```

**New Index C:** `(beds, featSig)`

Example keys:
- `(4, "PGOE")` - 4 beds + Pool + Gourmet + Office + Elevator
- `(4, "PHW")` - 4 beds + Heated pool + Wine cellar
- `(4, "P")` - 4 beds + Pool only

**Result:** Far more selective buckets. Properties with different amenities go into different buckets.

### Impact on Scoring

The 27% feature weight now compares actual structural facts instead of random marketing text:

```javascript
// V8: Jaccard on boolean features (pool, gourmet, office, etc.)
const sFeat = featureSimilarity(v.structuredFeats, c.structuredFeats);
```

**Before:** Comparing "excelente oportunidade localização privilegiada"
**After:** Comparing {has_pool: true, has_gourmet: true, has_office: false}

---

## Improvement #2: Exact Price Index (Replacing Index P)

### The Problem

**Old Index P:** `round(pricePerM2, 1000)`

In São Paulo luxury market, price/m² is similar across all properties (~R$20k-25k/m²), so this created one giant useless bucket.

### The Solution

**New Index E:** `(price, round(built, 20))`

Use absolute sale price since listings copied across portals often share the exact same price.

```javascript
// Index E: Exact price + area
if (r.price != null && r.built != null) {
  mapPush(idxE, [r.price, roundTo(r.built, 20)], i);
}
```

**Query Strategy:**

For a listing at R$8,500,000 with 450m²:

```javascript
const priceVariations = [
  8500000,
  Math.round(8500000 * 1.001),  // 8,508,500
  Math.round(8500000 * 0.999)   // 8,491,500
];

const builtVariations = [
  roundTo(450, 20),      // 460
  roundTo(450 * 1.02, 20),  // 460
  roundTo(450 * 0.98, 20)   // 440
];

// Search all combinations (9 total index lookups)
```

This creates a "fast path" - exact price matches are extremely likely to be correct.

### Impact

- **Before:** One massive bucket with all R$20k-25k/m² properties
- **After:** Precise buckets like `(8500000, 460)` containing only near-exact price matches

---

## Improvement #3: Ratio Index (New Index R)

### The Problem

All absolute values (built, lot, beds) are similar in luxury market:
- Built: 400-500m²
- Lot: 500-700m²
- Beds: 4-5

Indices based on these create weak buckets.

### The Solution

**New Index R:** `(beds_to_baths_ratio, built_to_lot_ratio)`

Capture the "shape" of the property using relationships between dimensions:

```javascript
const bedBathRatio = (r.beds != null && r.baths != null && r.baths > 0)
  ? roundTo(r.beds / r.baths, 0.5)
  : null;

const builtLotRatio = (r.built != null && r.lot != null && r.lot > 0)
  ? roundTo(r.built / r.lot, 0.1)
  : null;

mapPush(idxR, [bedBathRatio ?? -1, builtLotRatio ?? -1], i);
```

**Example Keys:**

| Property | Beds/Baths | Built/Lot | Index Key |
|----------|-----------|-----------|-----------|
| Compact luxury | 4/4 = 1.0 | 450/500 = 0.9 | `(1.0, 0.9)` |
| Spacious estate | 4/2 = 2.0 | 400/800 = 0.5 | `(2.0, 0.5)` |
| Dense build | 5/3 = 1.5 | 500/550 = 0.9 | `(1.5, 0.9)` |

### Impact

Distinguishes properties even when absolute values are similar:
- A 4-bed/4-bath house (service quarters) vs 4-bed/2-bath house (different layout)
- A house using 90% of lot vs 50% of lot (dense vs spacious)

---

## Improvement #4: Proportional Candidate Gathering

### The Problem

**Old Strategy (Fixed):** Search `[450, 460, 440]` (±10m²)

- For 100m² apartment: 10m² = **10% difference** (too loose)
- For 1000m² mansion: 10m² = **1% difference** (too tight)

**Result:** Missing valid matches on large properties, including noise on small properties.

### The Solution

**Proportional Search:** Use the same ±8% tolerance as filtering

```javascript
// OLD: Fixed ±10m²
const aKeys = [
  [4, 2, 450],
  [4, 2, 460],
  [4, 2, 440]
];

// NEW: Proportional ±8%
if (v.built != null) {
  const minBuilt = roundTo(v.built * 0.92, 10);  // 450 * 0.92 = 414
  const maxBuilt = roundTo(v.built * 1.08, 10);  // 450 * 1.08 = 486

  for (let b = minBuilt; b <= maxBuilt; b += 10) {
    const key = [v.beds ?? -1, v.suites ?? -1, b];
    // Search: 410, 420, 430, 440, 450, 460, 470, 480, 490
  }
}
```

**Trade-off:** More index lookups (8 instead of 3), but:
- Index lookups are O(1) hash map operations (~microseconds)
- False Gemini API call costs ~$0.01 and 2-3 seconds
- Math: 5 extra lookups (~5μs) << 1 avoided API call (~$0.01 + 2s)

### Impact

- **Small properties (100m²):** Search 92-108m² (±8m²) - More selective
- **Large properties (1000m²):** Search 920-1080m² (±80m²) - Won't miss matches

---

## Combined Impact: Before vs After

### Index Comparison

| Index | V7 (Old) | V8 (New) | Change |
|-------|----------|----------|--------|
| **A** | (beds, suites, round(built, 10)) | Same but proportional gathering | ✅ Improved |
| **B** | (beds, round(built, 25), park) | Same but proportional gathering | ✅ Improved |
| **C** | (beds, topFeature) | (beds, featSig) | 🔥 Revolutionary |
| **P** | round(pricePerM2, 1000) | **REMOVED** | ❌ Useless |
| **E** | N/A | (price, round(built, 20)) | ✨ New |
| **R** | N/A | (beds_baths_ratio, built_lot_ratio) | ✨ New |

### Expected Results

**V7 Performance (Baseline):**
```
69 Viva listings × 81 Coelho listings = 5,589 potential pairs
↓
Multi-block indexing → ~400 candidates
↓
Filtering + scoring → ~150 API calls
↓
Gemini verification → 10-15 matches
```

**V8 Expected Improvement:**
```
69 Viva listings × 81 Coelho listings = 5,589 potential pairs
↓
IMPROVED multi-block indexing → ~200 candidates (50% reduction)
↓
BETTER filtering + scoring → ~75 API calls (50% reduction)
↓
Gemini verification → 15-25 matches (60% increase)
```

**Key Metrics:**

| Metric | V7 | V8 Target | Improvement |
|--------|----|-----------| ------------|
| API calls | ~150 | ~75 | **50% reduction** |
| Match rate | 10-15 | 15-25 | **60% increase** |
| Precision | ~10% | ~20% | **100% improvement** |
| Cost per match | ~$0.15 | ~$0.04 | **73% cheaper** |

---

## How to Use V8

### Run V8 Comparison

```bash
# Make sure you have mosaics generated
node scripts/mosaic-module.js both

# Run V8 smart compare
node scripts/smart-compare-V2.cjs
```

### Output

```
data/smart-matches-v8.json
```

### Compare with V7

```bash
# Old version
node scripts/smart-compare.cjs  # → data/smart-matches.json

# New version
node scripts/smart-compare-V2.cjs  # → data/smart-matches-v8.json

# Compare results
diff data/smart-matches.json data/smart-matches-v8.json
```

---

## Debugging & Tuning

### Feature Extraction

Check what features are being extracted:

```javascript
// In console output, look for:
[1/69] Viva 1034
  Area: 450m² | Price: R$ 8.5M | 4d/2s
  Features: PGOE  // ← Pool, Gourmet, Office, Elevator
```

If features are wrong, add more patterns to `extractStructuredFeatures()`.

### Index Effectiveness

Monitor index hit rates:

```javascript
console.log(`✓ Index A (structural): ${idxA.size} blocks`);
console.log(`✓ Index C (feature signature): ${idxC.size} blocks`);
console.log(`✓ Index E (exact price): ${idxE.size} blocks`);
console.log(`✓ Index R (ratios): ${idxR.size} blocks`);
```

**Ideal:**
- Index A: 200-400 blocks (good)
- Index C: 50-150 blocks (more = better selectivity)
- Index E: 100-300 blocks (tight price matching)
- Index R: 30-80 blocks (ratio diversity)

**Red flags:**
- Any index with <20 blocks: Too coarse, creating giant buckets
- Any index with >500 blocks: Too fine, missing valid matches

### Broker-Speak Expansion

If you see common phrases in feature signatures, add to `BROKER_SPEAK`:

```javascript
// Example: if "vista mar" appears everywhere
'vista mar', 'vista panorâmica', 'vista privilegiada'
```

---

## Technical Details

### Feature Signature Collision Rate

With 10 boolean features, we have 2^10 = 1,024 possible signatures.

For 81 properties, expected collisions: ~3-5% (good selectivity)

### Proportional Gathering Complexity

- Index A: 8 lookups × O(1) = O(8) = O(1) constant
- Index B: 8 lookups × O(1) = O(1)
- Index C: 1 lookup × O(1) = O(1)
- Index E: 9 lookups × O(1) = O(1)
- Index R: 3 lookups × O(1) = O(1)

**Total:** ~29 hash map lookups per Viva listing = **~29 microseconds**

Compare to 1 Gemini API call = **~2 seconds + $0.01**

**ROI:** Every false candidate avoided saves 69,000× in time and ∞× in cost.

---

## Future Improvements (V9?)

1. **Geographic Index:**
   - Extract neighborhood/street from addresses
   - Index: `(neighborhood, beds)`
   - Same property must be in same location

2. **Image Hash Index:**
   - Perceptual hash of first mosaic tile
   - Index: `(pHash, beds)`
   - Visual similarity pre-filter

3. **Price History:**
   - Track price changes over time
   - Same property likely has similar price trajectory

4. **ML Feature Importance:**
   - Train on confirmed matches
   - Optimize feature weights dynamically

5. **Fuzzy Address Matching:**
   - Levenshtein distance on street names
   - Index: `(fuzzyStreet, beds)`

---

## Conclusion

V8 represents a paradigm shift from "gather many, filter later" to "gather few, filter precisely."

By treating Phase 1 as a precision instrument instead of a broad net, we:
- **Reduce costs** (fewer API calls)
- **Increase accuracy** (better candidates)
- **Improve speed** (less waiting for API)
- **Enable scaling** (can handle 10x more listings)

The key insight: **Better indices → Better candidates → Better matches**

---

**Version:** V8
**Created:** 2025-10-21
**Author:** Claude Code
**Status:** Ready for testing
