# Real Estate Listings Comparison Analysis

**Date:** October 15, 2025
**Datasets Compared:**
- Vivaprimeimoveis: 60 listings
- Coelho da Fonseca: 81 listings

## Executive Summary

❌ **No matches found** between the two datasets due to non-overlapping price ranges.

## Detailed Analysis

### Price Range Comparison

| Dataset | Price Range | Market Segment |
|---------|-------------|----------------|
| **Vivaprimeimoveis** | R$ 1.0M - R$ 2.0M | Entry-level luxury |
| **Coelho da Fonseca** | R$ 4.9M - R$ 44M | High-end luxury |

**Gap:** R$ 2.9M minimum difference between the highest Vivaprime listing and lowest Coelho listing.

### Data Structure Comparison

#### Vivaprimeimoveis
- ✅ Price ranges provided
- ❌ Missing detailed specs (bedrooms, sqft fields are empty)
- ✅ Features array available (Piscina, Churrasqueira, etc.)
- ✅ 2 images per property downloaded

#### Coelho da Fonseca
- ✅ Exact prices provided
- ✅ Detailed specs in features string (e.g., "5 dorms / 5 suítes / 8 vagas")
- ✅ Rich property descriptions
- ✅ Amenities array with property details
- ✅ 2 images per property downloaded

### Why No Matches Were Found

1. **Different Market Segments**: The agencies target different buyer segments
2. **Price Non-Overlap**: Zero overlap in price ranges makes matching impossible
3. **Different Inventory**: They likely represent different properties entirely

## Recommendations

### Option 1: Re-scrape with Adjusted Parameters

**For Vivaprimeimoveis:**
```
Adjust search filters to include:
- Price range: R$ 4M - R$ 50M
- Or remove price filters entirely
```

**For Coelho da Fonseca:**
```
Adjust search filters to include:
- Price range: R$ 1M - R$ 5M
- Focus on entry-level segment
```

### Option 2: Image Similarity Analysis

Even with different price ranges, we could implement image-based comparison:

**Benefits:**
- Detects same physical property regardless of price
- Can identify data quality issues
- Reveals if agencies misreprice properties

**Implementation:**
- Use image hashing (pHash, dHash)
- Compare all 120 images from Vivaprime against 162 from Coelho
- Threshold: 90%+ similarity = potential match

**Libraries to use:**
- `sharp` for image processing
- `image-hash` for perceptual hashing
- `sharp-phash` for pHash implementation

### Option 3: Enhance Vivaprime Scraper

The Vivaprime data lacks detailed specs. We should:
1. Extract more data from detail pages
2. Parse property descriptions for specs
3. Get actual prices instead of ranges

## Next Steps

**Recommended Action:** Implement **Option 2 (Image Similarity)** first.

This will:
1. Verify if any properties appear on both sites (unlikely but possible)
2. Validate that our comparison logic works correctly
3. Provide a baseline for future comparisons

If no matches found via images, then:
→ Re-scrape Vivaprime with higher price ranges (Option 1)

## Files Generated

- `/scripts/compare-listings.js` - Main comparison script
- `/data/comparison-results.json` - Results output (0 matches)
- `/data/vivaprimeimoveis/images/*.jpg` - 120 images (60 properties × 2)
- `/data/coelhodafonseca/images/*.jpg` - 162 images (81 properties × 2)

## Technical Notes

### Comparison Methodology Used

1. **Price Matching**: Check if Coelho exact price falls within Viva range ❌ Failed
2. **Amenity Similarity**: Calculate Jaccard similarity of amenities ⚠️  Not reached
3. **Spec Comparison**: Compare bedrooms, parking, sqft ⚠️  Not reached (Viva data incomplete)
4. **Image Similarity**: Not yet implemented 🔄 Recommended next step

### Confidence Scoring

Match confidence calculated as:
```
- Price match: 40 points
- Amenity similarity: 60 points (weighted by overlap percentage)
- Minimum threshold: 50 points
```

Current results: 0 listings exceeded 50-point threshold.
