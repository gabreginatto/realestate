# Mosaic Image Comparison - Implementation Plan

## Overview
Add visual verification using 3×2 photo mosaics to improve matching accuracy and reduce false positives/negatives.

## Goals
1. **Verify positive matches** - Use mosaic comparison as final check before confirming matches
2. **Find ghost listing matches** - Visual search for properties where text/metadata failed
3. **Reduce API costs** - Only compare images for near-ties and uncertain cases

---

## Phase 1: Update Scrapers to Collect Images ✓

### Step 1.1: Update VIVA Scraper
- [ ] Modify scraper to collect all property image URLs
- [ ] Store images array in listing JSON structure
- [ ] Test with sample listings
- [ ] Re-run scraper for all 70 VIVA listings

**Files to modify:**
- `scripts/extract-vivaprime-details.js` (or equivalent)
- `data/vivaprimeimoveis/listings/all-listings.json` (output)

**Expected structure:**
```json
{
  "propertyCode": "17232",
  "url": "...",
  "price": "...",
  "images": [
    "https://www.vivaprimeimoveis.com.br/image1.jpg",
    "https://www.vivaprimeimoveis.com.br/image2.jpg",
    ...
  ],
  "detailedData": { ... }
}
```

### Step 1.2: Update Coelho da Fonseca Scraper
- [ ] Modify scraper to collect all property image URLs
- [ ] Store images array in listing JSON structure
- [ ] Test with sample listings
- [ ] Re-run scraper for all 81 Coelho listings

**Files to modify:**
- `scripts/extract-details-coelhodafonseca.spec.ts` (or equivalent)
- `data/coelhodafonseca/listings/all-listings.json` (output)

**Expected structure:**
```json
{
  "propertyCode": "674139",
  "url": "...",
  "price": "...",
  "images": [
    "https://www.coelhodafonseca.com.br/image1.jpg",
    "https://www.coelhodafonseca.com.br/image2.jpg",
    ...
  ],
  "features": "...",
  "description": "..."
}
```

---

## Phase 2: Build Mosaic Module ✓

### Step 2.1: Install Dependencies
```bash
npm install axios sharp imghash
```

Dependencies:
- `axios` - Download images from URLs
- `sharp` - Image processing (resize, compose, etc.)
- `imghash` - Perceptual hashing for duplicate detection
- `@google/generative-ai` - Already installed

### Step 2.2: Create Mosaic Module
- [ ] Create `scripts/mosaic-module.js`
- [ ] Implement image download with caching
- [ ] Implement photo selection (pHash + exterior detection)
- [ ] Implement mosaic builder (3×2 grid)
- [ ] Implement Gemini mosaic comparison
- [ ] Test with sample listings

**Key functions:**
- `selectForMosaic(urls, maxN=6)` - Pick 6 diverse photos
- `makeMosaicFromUrls(urls, outPath)` - Build 3×2 PNG
- `ensureMosaicForListing(listing, side)` - Get or create mosaic
- `compareMosaics(pngA, pngB)` - Gemini comparison
- `imageMosaicTieBreak(vivaNorm, coelhoTop)` - Blend scores

### Step 2.3: Create Test Script
- [ ] Create `scripts/test-mosaic.js`
- [ ] Test with 2-3 known matches
- [ ] Verify mosaics are generated correctly
- [ ] Verify Gemini comparison works
- [ ] Check cache directories created

---

## Phase 3: Integrate into Comparison Pipeline ✓

### Step 3.1: Modify smart-compare.cjs
Add mosaic verification for **positive matches only** (final check):

**Location:** After Gemini text comparison finds a match

```javascript
// After AI confirms match, do visual verification
if (matches.length > 0) {
  console.log(`  ✓ Text match found - verifying with mosaics...`);

  const vivaNorm = { raw: viva, s: item._scored[0].score };
  const matchedCoelho = matches.map(m => ({
    raw: candidates[m.index],
    s: item._scored[m.index].score
  }));

  const visualVerif = await imageMosaicTieBreak(vivaNorm, matchedCoelho);

  // If visual score is very low, flag for manual review
  if (visualVerif[0].imgScore < 0.3) {
    console.log(`  ⚠️  Visual mismatch! (score: ${visualVerif[0].imgScore.toFixed(2)})`);
    // Move to manual review instead of auto-match
  } else {
    console.log(`  ✓ Visual verified (score: ${visualVerif[0].imgScore.toFixed(2)})`);
  }
}
```

**Changes needed:**
- [ ] Import mosaic module at top
- [ ] Add visual verification after text match
- [ ] Track visual scores in output JSON
- [ ] Flag low-visual-score matches for review

### Step 3.2: Create Manual Review Queue
- [ ] Create `data/manual-review.json` for flagged matches
- [ ] Include both text and visual scores
- [ ] Include mosaic paths for easy viewing

**Structure:**
```json
{
  "flagged_matches": [
    {
      "viva": { "code": "...", "url": "..." },
      "coelho": { "code": "...", "url": "..." },
      "text_confidence": 0.85,
      "visual_score": 0.25,
      "reason": "Text metadata matches but visual mismatch",
      "viva_mosaic": "data/mosaics/viva/17232.png",
      "coelho_mosaic": "data/mosaics/coelho/674139.png"
    }
  ]
}
```

---

## Phase 4: Visual Search for Ghost Listings ✓

### Step 4.1: Create Ghost Listing Visual Search
- [ ] Create `scripts/ghost-visual-search.js`
- [ ] For each ghost listing, compare its mosaic against ALL Coelho mosaics
- [ ] Use a lower threshold (0.5+) since we're searching broadly
- [ ] Rank by visual score
- [ ] Output top 3 visual candidates per ghost listing

**Algorithm:**
```javascript
for (const ghostViva of ghostListings) {
  const vivaMosaic = await ensureMosaicForListing(ghostViva, 'viva');
  const visualMatches = [];

  for (const coelho of allCoelhoListings) {
    const coelhoMosaic = await ensureMosaicForListing(coelho, 'coelho');
    const { score } = await compareMosaics(vivaMosaic, coelhoMosaic);

    if (score >= 0.5) {
      visualMatches.push({ coelho, score });
    }
  }

  visualMatches.sort((a,b) => b.score - a.score);
  // Output top 3 for manual review
}
```

**Optimization:**
- Pre-generate all mosaics first (batch)
- Compare in parallel (with rate limiting)
- Cache results

### Step 4.2: Create Visual Search Results Document
- [ ] Output `GHOST-VISUAL-MATCHES.md`
- [ ] Show VIVA ghost listing with top 3 visual candidates
- [ ] Include URLs and visual scores
- [ ] Include mosaic image paths for manual verification

---

## Phase 5: Testing & Validation ✓

### Step 5.1: Test Known Matches
- [ ] Run mosaic comparison on all 22 confirmed matches
- [ ] Verify visual scores are high (>0.6)
- [ ] Document any false negatives

### Step 5.2: Test Known Non-Matches
- [ ] Create sample of obviously different properties
- [ ] Verify visual scores are low (<0.4)
- [ ] Document any false positives

### Step 5.3: Test Ghost Listings
- [ ] Run visual search on 5 ghost listings
- [ ] Manually verify top candidates
- [ ] Check if visual search found matches text missed

### Step 5.4: Performance Testing
- [ ] Measure mosaic generation time
- [ ] Measure Gemini comparison time
- [ ] Calculate total cost (API calls)
- [ ] Optimize if needed

---

## Phase 6: Documentation & Deployment ✓

### Step 6.1: Update Documentation
- [ ] Document mosaic module usage
- [ ] Document cache directories
- [ ] Document tuning parameters
- [ ] Add examples and troubleshooting

### Step 6.2: Create Run Scripts
- [ ] `npm run compare-with-mosaics` - Full comparison with visual
- [ ] `npm run ghost-visual-search` - Visual search for ghosts
- [ ] `npm run build-mosaics` - Pre-generate all mosaics

### Step 6.3: Commit & Deploy
- [ ] Commit all changes
- [ ] Update README with new features
- [ ] Push to repository

---

## Expected Outcomes

### Metrics to Track
| Metric | Before | Target After |
|--------|--------|--------------|
| False Positives | Unknown | 0-1 |
| False Negatives (ghosts) | 32 | 20-25 |
| Manual Review Queue | 0 | 5-10 |
| API Cost per Run | $0.61 | $0.75-0.85 |
| Total Time per Run | 2 min | 4-6 min |

### Success Criteria
1. ✅ All 22+ matches have visual score >0.6
2. ✅ At least 5-10 ghost listings get visual candidates >0.5
3. ✅ No confirmed matches get flagged as visual mismatches
4. ✅ Manual review queue has <10 items

---

## Risk Mitigation

### Risk 1: Poor Image Quality
**Mitigation:**
- Skip listings with <3 images
- Use "no image" placeholder in mosaic
- Flag "insufficient images" in results

### Risk 2: API Cost Explosion
**Mitigation:**
- Only compare near-ties (within 0.07 score)
- Batch ghost searches with delays
- Set daily API budget cap

### Risk 3: False Visual Matches (similar houses)
**Mitigation:**
- Use conservative threshold (0.6+)
- Require text metadata alignment FIRST
- Always include human review option

### Risk 4: Scraper Changes Break Image Collection
**Mitigation:**
- Add error handling for missing images
- Log scraper errors
- Test scrapers before full runs

---

## Timeline

| Phase | Estimated Time | Priority |
|-------|----------------|----------|
| Phase 1 | 2-3 hours | HIGH |
| Phase 2 | 2-3 hours | HIGH |
| Phase 3 | 1-2 hours | HIGH |
| Phase 4 | 1-2 hours | MEDIUM |
| Phase 5 | 1-2 hours | MEDIUM |
| Phase 6 | 1 hour | LOW |

**Total: 8-13 hours**

---

## Next Steps

Start with Phase 1, Step 1.1: Update VIVA scraper to collect images.

Once image collection is working, we'll move to building the mosaic module.
