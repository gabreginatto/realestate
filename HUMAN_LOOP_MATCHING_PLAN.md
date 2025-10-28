# DETAILED PLAN: Human-Assisted Listing Matching System

**Philosophy**: Automated matching (vectors, Gemini, geometric) will never match human visual accuracy. This system uses automation to filter candidates, then lets humans make final matching decisions through a visual interface.

---

## **Phase 1: Data Collection & Preparation** (Existing Scripts)

### Step 1.1: Scrape Homepages
```bash
# Get listing URLs from homepages
npx playwright test scripts/home-coelhodafonseca.spec.ts
npx playwright test scripts/home-vivaprimeimoveis.spec.ts
```
**Output**: `listing-urls.txt` for each site

### Step 1.2: Scrape All Listings
```bash
# Get basic listing data from listings pages
npx playwright test scripts/listings-coelhodafonseca.spec.ts
npx playwright test scripts/listings-vivaprimeimoveis.spec.ts
```
**Output**: `listings.html` and basic JSON data

### Step 1.3: Extract Full Details & Images
```bash
# Extract complete specs and download all images
npx playwright test scripts/extract-details-coelhodafonseca.spec.ts
node scripts/extract-vivaprime-details.js
```
**Output**:
- `data/coelhodafonseca/listings/all-listings.json` (81 listings)
- `data/vivaprimeimoveis/listings/all-listings.json` (70 listings)
- All images downloaded to `data/{site}/images/{propertyCode}/`

---

## **Phase 2: Image Classification & Filtering** (Existing Scripts)

### Step 2.1: Run UFOID (Image Classification)
```bash
source .venv/bin/activate
python scripts/run_ufoid.py
```
**Purpose**: Classify each image (exterior, interior, floorplan, etc.)
**Output**: `data/{site}/images/{propertyCode}/ufoid_results.json`

### Step 2.2: Run Fastdup (Duplicate Detection)
```bash
source .venv/bin/activate
python scripts/run_fastdup.py
```
**Purpose**: Find near-duplicate images within each listing
**Output**: `data/{site}/images/{propertyCode}/fastdup_results.json`

### Step 2.3: Select Exterior Images
```bash
source .venv/bin/activate
python scripts/select_exteriors.py
```
**Purpose**: Filter to best 6-8 exterior images per listing
**Output**:
- `selected_exteriors/coelhodafonseca/{propertyCode}/` (6-8 images)
- `selected_exteriors/vivaprimeimoveis/{propertyCode}/` (6-8 images)

---

## **Phase 3: Generate Listing Mosaics** (Existing Script)

### Step 3.1: Create Mosaics for All Listings
```bash
node scripts/mosaic-module.js both
```
**Purpose**: Create one mosaic image per listing (2 rows × 4 columns grid)
**Output**:
- `mosaics/coelhodafonseca/{propertyCode}.png` (81 mosaics)
- `mosaics/vivaprimeimoveis/{propertyCode}.png` (70 mosaics)

---

## **Phase 4: Generate Candidate Pairs** (Existing Script)

### Step 4.1: Run Smart Compare V2
```bash
node scripts/smart-compare-V2.cjs
```
**Purpose**: Filter candidates by price (±15%), area (±15%), beds/suites
**Output**:
- `data/smart-matches.json`
- Contains ~265 candidate pairs (instead of 5,670 total combinations)
- Each Viva listing has 3-5 potential Coelho matches

---

## **Phase 5: Build Manual Matching Interface** (NEW - To Be Built)

### Step 5.1: Backend API (Node.js/Express)
**File**: `scripts/matching-server.js`

**Features**:
- Load smart-matches.json
- Track match state (matched, rejected, pending)
- Serve listing data + mosaic images
- Save user decisions to `data/manual-matches.json`

**API Endpoints**:
```javascript
GET  /api/session          // Get current matching session
GET  /api/listing/:id      // Get next Viva listing to review
GET  /api/candidates/:id   // Get Coelho candidates for Viva listing
POST /api/match            // Record a confirmed match
POST /api/reject           // Record a rejected pair
POST /api/skip             // Skip to next Viva listing
GET  /api/progress         // Get completion stats
```

### Step 5.2: Frontend Interface (HTML + Vanilla JS)
**File**: `public/matcher.html`

**Layout**:
```
┌─────────────────────────────────────────────────────────┐
│  VIVA LISTING #17116                    [10/70 reviewed]│
│  ┌─────────────────────────────────────────────────┐    │
│  │                                                   │    │
│  │         [VIVA MOSAIC - 8 exterior images]        │    │
│  │                                                   │    │
│  └─────────────────────────────────────────────────┘    │
│                                                          │
│  Price: R$ 4.900.000 | 457m² | 4 beds | 4 suites       │
│  ──────────────────────────────────────────────────────│
│                                                          │
│  POTENTIAL MATCHES (3 candidates)                       │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ Coelho #674139│  │ Coelho #123456│  │ Coelho #789012│  │
│  │ [MOSAIC]      │  │ [MOSAIC]      │  │ [MOSAIC]      │  │
│  │ R$ 4.9M       │  │ R$ 4.8M       │  │ R$ 5.1M       │  │
│  │ 457m² 4bd 4su │  │ 450m² 4bd 3su │  │ 470m² 4bd 4su │  │
│  │               │  │               │  │               │  │
│  │ [✓ MATCH]     │  │ [✓ MATCH]     │  │ [✓ MATCH]     │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
│                                                          │
│  [← PREVIOUS]  [SKIP - NO MATCH]  [NEXT →]             │
└─────────────────────────────────────────────────────────┘
```

**User Interactions**:
1. Click "✓ MATCH" on a Coelho mosaic → Confirm match
2. Click "SKIP - NO MATCH" → None of the candidates match
3. Click on mosaic to zoom/inspect
4. Navigate with PREVIOUS/NEXT buttons
5. Progress bar shows completion

### Step 5.3: Match State Management
**File**: `data/manual-matches.json`

```json
{
  "session_started": "2025-10-27T10:30:00Z",
  "last_updated": "2025-10-27T11:15:00Z",
  "total_viva_listings": 70,
  "reviewed": 15,
  "matched": 9,
  "skipped": 6,
  "pending": 55,
  "matches": [
    {
      "viva_code": "17116",
      "coelho_code": "674139",
      "matched_at": "2025-10-27T10:35:00Z",
      "confidence": "manual_confirmed"
    }
  ],
  "rejected": [
    {
      "viva_code": "17116",
      "coelho_code": "123456",
      "rejected_at": "2025-10-27T10:35:00Z"
    }
  ],
  "skipped": [
    {
      "viva_code": "17232",
      "reason": "no_good_candidates",
      "skipped_at": "2025-10-27T10:40:00Z"
    }
  ]
}
```

---

## **Phase 6: Implementation Steps**

### 6.1: Create Backend Server
**Create**: `scripts/matching-server.js`
- Express server on port 3000
- Load smart-matches.json
- Serve static files from `public/`
- API endpoints for match state
- Auto-save after each decision

### 6.2: Create Frontend Interface
**Create**: `public/matcher.html`
- Single-page application
- Display Viva mosaic at top
- Display candidate mosaics below
- Click handlers for match/skip
- Keyboard shortcuts (1-9 for candidates, N for next, S for skip)
- Progress indicator

### 6.3: Create Mosaic Viewer Component
**Enhancement**: Add zoom/lightbox functionality
- Click mosaic → Open full-size view
- View individual images within mosaic
- Compare side-by-side

---

## **Phase 7: Workflow Execution**

### 7.1: Start Matching Session
```bash
# Start server
node scripts/matching-server.js

# Open browser
open http://localhost:3000/matcher.html
```

### 7.2: Manual Matching Process
1. Review Viva listing mosaic
2. Compare with 3-5 Coelho candidate mosaics
3. Click "✓ MATCH" if visually identical
4. Click "SKIP" if no matches
5. Repeat for all 70 Viva listings

**Time Estimate**:
- ~2-3 minutes per listing
- Total: 2-4 hours to review all 70 listings

### 7.3: Export Final Results
```bash
# Generate final report
node scripts/export-manual-matches.js

# Creates:
# - data/final-matches.json (confirmed matches)
# - reports/manual-matching-summary.md (statistics)
# - matched_mosaics_manual/ (side-by-side comparison mosaics)
```

---

## **Key Advantages of This Approach**

1. **No Complex ML**: Just image classification (UFOID) + duplicate detection (Fastdup)
2. **Human Accuracy**: Visual matching by human eye = 100% accuracy
3. **Efficient**: Smart-compare filters 5,670 → 265 pairs (95% reduction)
4. **Fast Review**: Mosaics make comparison instant (2-3 min/listing)
5. **Iterative**: Remove matched listings from pool automatically
6. **Resumable**: Save progress, come back later
7. **Auditable**: Track all decisions with timestamps

---

## **Required Scripts (Already Exist)**

1. ✅ `scripts/home-coelhodafonseca.spec.ts` - Scrape homepage
2. ✅ `scripts/home-vivaprimeimoveis.spec.ts` - Scrape homepage
3. ✅ `scripts/listings-coelhodafonseca.spec.ts` - Scrape listings page
4. ✅ `scripts/listings-vivaprimeimoveis.spec.ts` - Scrape listings page
5. ✅ `scripts/extract-details-coelhodafonseca.spec.ts` - Extract full details + images
6. ✅ `scripts/extract-vivaprime-details.js` - Extract full details + images
7. ✅ `scripts/run_ufoid.py` - Image classification
8. ✅ `scripts/run_fastdup.py` - Duplicate detection
9. ✅ `scripts/select_exteriors.py` - Select best exterior images
10. ✅ `scripts/mosaic-module.js` - Generate listing mosaics
11. ✅ `scripts/smart-compare-V2.cjs` - Filter candidate pairs

---

## **Files to Create (NEW)**

1. ❌ `scripts/matching-server.js` - Backend API server
2. ❌ `public/matcher.html` - Frontend matching interface
3. ❌ `scripts/export-manual-matches.js` - Final export script

---

## **Data Flow Summary**

```
1. Scrape websites
   ↓
2. Download all images
   ↓
3. Run UFOID (classify images)
   ↓
4. Run Fastdup (detect duplicates)
   ↓
5. Select best exteriors (6-8 per listing)
   ↓
6. Generate mosaics (one per listing)
   ↓
7. Run smart-compare (filter to ~265 candidate pairs)
   ↓
8. Human reviews mosaics and confirms matches
   ↓
9. Export final matched pairs
```

---

## **Expected Results**

- **Input**: 70 Viva + 81 Coelho = 151 listings
- **All possible pairs**: 5,670
- **After smart-compare filtering**: ~265 pairs (95% reduction)
- **Expected true matches**: 10-20 pairs (based on market overlap)
- **Human review time**: 2-4 hours total
- **Accuracy**: 100% (human visual confirmation)

---

## **Future Enhancements**

1. **Keyboard shortcuts**: Speed up navigation
2. **Confidence ratings**: Mark "high confidence" vs "uncertain" matches
3. **Notes field**: Add comments for each match
4. **Batch mode**: Review multiple candidates at once
5. **Mobile support**: Review on tablet/phone
6. **Multi-user**: Multiple reviewers can work in parallel
7. **ML training**: Use confirmed matches to train better automated filters
