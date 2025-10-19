# V3 Filter Improvements - Tighter Candidate Selection

## Changes Made

### 1. **Adaptive Area Tolerance** (Addresses Dense Clustering)

**Before (v2):**
```javascript
const areaOK = Math.abs(v.built - c.built) / Math.max(v.built, c.built) <= 0.18; // 18% for all
```

**After (v3):**
```javascript
const areaTolerance = (v.built && v.built >= 300) ? 0.12 : 0.18;
const areaOK = Math.abs(v.built - c.built) / Math.max(v.built, c.built) <= areaTolerance;
```

**Why:** Larger properties (≥300m²) cluster more densely in Alphaville. A 18% tolerance on a 400m² property is ±72m², which lets through too many mismatches. Tightening to 12% (±48m²) improves precision.

### 2. **Suite Count Filter** (Eliminates Obvious Mismatches)

**New in v3:**
```javascript
const suiteFiltered = tightened.filter(i => {
  const c = coelhoN[i];
  if (v.suites == null || c.suites == null) return true; // keep if missing
  return Math.abs(v.suites - c.suites) <= 1; // allow ±1 difference
});
```

**Why:** Suite count is a fundamental property characteristic. VIVA 17232 (2 suites) should never be compared to properties with 4 suites. This filter runs BEFORE scoring, saving expensive composite score calculations.

### 3. **Top-K Selection** (Already Implemented in v2)

The scoring and Top-K selection was already correct in v2 - it properly ranks candidates by composite score and selects the best K=3.

## Expected Impact

### Example: VIVA 17232 (2 suites, 397m²)

**v2 Behavior:**
- Area tolerance: 18% → accepts 340-466m² range
- No suite filter
- Result: Coelho 661974 (4 suites, 450m²) and 674139 (4 suites, 457m²) both passed filters
- Score: 0.329 and 0.300 (low due to suite mismatch)
- **Wasted 1 API call** on obvious non-matches

**v3 Behavior:**
- Area tolerance: 12% (397m² ≥ 300m²) → accepts 350-444m² range
- Suite filter: 2 suites ± 1 → accepts 1-3 suites only
- Result: **Both candidates rejected before scoring** (4 suites too different)
- **Saved 1 API call**

### Projected Savings

Based on the ghost listing analysis:
- ~36 API calls went to candidates with obvious mismatches
- Suite filter should eliminate ~40-50% of these (estimate 15-18 API calls saved)
- Tighter area tolerance should eliminate another ~20% (estimate 7-10 API calls saved)
- **Total estimated savings: 22-28 API calls out of 65 (34-43% reduction)**

## Metrics to Track

Run the new v3 and compare:

| Metric | v2 | v3 (expected) |
|--------|-----|---------------|
| API calls made | 65 | 37-43 |
| Total matches | 24 | 24-26 |
| Ghost listings (API rejected) | 36 | 20-25 |
| Suite mismatches sent to API | ~15 | 0 |
| Avg candidate score | 0.45 | 0.55+ |

## Running V3

```bash
node scripts/smart-compare.cjs
```

The output will now show:
```
  Block search: 45 initial candidates
  After numeric filters (area ≤12%): 28 candidates
  After suite filter (±1): 12 candidates (removed 16 suite mismatches)
  After scoring: 10 candidates (removed 2 hard rejects)
  ✓ Top 3 candidates (scores: 0.768, 0.564, 0.450) → queuing for AI
```

## Notes

- The suite filter is conservative (±1 tolerance) to avoid eliminating borderline cases where listing data might be slightly off
- Area tolerance breakpoint at 300m² was chosen based on the data distribution (most properties in dataset are 300-800m²)
- These filters run BEFORE expensive composite scoring, saving computation
- Top-K selection ensures only the BEST candidates reach the AI, regardless of pool size

## Next Steps

After running v3:
1. Compare API call count (should be ~40 vs 65 in v2)
2. Check if ghost listings decreased
3. Verify no true positives were filtered out (check matches found)
4. Analyze any remaining ghost listings with high scores but no AI match
