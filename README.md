# Real Estate Listing Matcher

A comprehensive system for scraping, processing, and matching real estate listings from multiple Brazilian real estate websites using visual AI and human-in-the-loop verification.

## Overview

This project provides an end-to-end pipeline for:
1. **Scraping** property listings from multiple real estate websites
2. **Processing** images with AI classification and deduplication
3. **Matching** listings across different sites using deterministic filters + visual AI
4. **Human verification** through an interactive web interface for final confirmation

## Features

### ✅ Completed Features

- **Multi-site Scraping**: Automated scraping of Vivaprimeimoveis and Coelho da Fonseca
- **Image Classification**: UFOID-based exterior/interior image classification
- **Duplicate Detection**: Fastdup-based near-duplicate image removal
- **Smart Filtering**: Multi-index deterministic filtering (price, area, bedrooms, suites, features)
- **Visual Mosaic Generation**: Automatic 2×4 grid mosaics for visual comparison
- **Human-in-the-Loop Matching**: Interactive web UI for manual verification
- **Session Management**: Resumable matching sessions with audit trails
- **Progress Tracking**: Real-time statistics and completion tracking

## Current Implementation Status

### Phase 1-4: Data Collection & Processing ✅
All data collection, image processing, and candidate filtering is complete.

### Phase 5: Human-in-the-Loop Matching Interface ✅
**Status:** Production-ready and deployed

**Files:**
- `scripts/human-loop/matching-server.js` - Express backend API (549 lines)
- `public/matcher.html` - Main UI interface
- `public/css/matcher.css` - Styling with light/dark mode
- `public/js/matcher-app.js` - Frontend application logic
- `public/js/components/mosaic-viewer.js` - Lightbox component

**Current Data:**
- 46 Viva listings ready for review
- 2-3 pre-filtered Coelho candidates per listing
- All mosaics generated and available
- Smart-compare V8 filtering applied

## Project Structure

```
RealEstate/
├── scripts/
│   ├── human-loop/
│   │   └── matching-server.js         # Backend API server
│   ├── collect-urls-*.spec.ts         # Homepage URL collection
│   ├── extract-*-details.js           # Full listing extraction
│   ├── run_ufoid.py                   # Image classification
│   ├── run_fastdup.py                 # Duplicate detection
│   ├── select_exteriors.py            # Best exterior selection
│   ├── mosaic-module.js               # Mosaic generation
│   └── smart-compare-V2.cjs           # Candidate filtering
├── public/
│   ├── matcher.html                   # Main matching interface
│   ├── css/matcher.css                # UI styling
│   └── js/
│       ├── matcher-app.js             # Frontend logic
│       └── components/
│           └── mosaic-viewer.js       # Lightbox component
├── data/
│   ├── vivaprimeimoveis/
│   │   ├── listings/all-listings.json # 68 Viva listings
│   │   └── images/                    # Downloaded images
│   ├── coelhodafonseca/
│   │   ├── listings/all-listings.json # 82 Coelho listings
│   │   └── images/                    # Downloaded images
│   ├── mosaics/
│   │   ├── viva/                      # 68 Viva mosaics
│   │   └── coelho/                    # 82 Coelho mosaics
│   ├── smart-matches.json             # Filtered candidate pairs
│   ├── manual-matches.json            # Human decisions
│   └── manual-matches.log.jsonl       # Audit log
├── selected_exteriors/                # Best exterior images (6-8 per listing)
├── HUMAN_LOOP_MATCHING_PLAN.md        # Detailed implementation plan
└── IMAGE-SELECTION-PIPELINE.md        # Image processing documentation

```

## Technology Stack

### Backend
- **Runtime**: Node.js 23.x
- **Server**: Express 5.x
- **APIs**: RESTful API with CORS support
- **Data**: JSON file-based storage with append-only audit logs

### Frontend
- **Pure JavaScript**: No frameworks, vanilla ES6+ modules
- **Styling**: CSS Variables with light/dark mode
- **Architecture**: Clean separation (State, API, UI, App layers)
- **Features**: Keyboard shortcuts, toast notifications, lightbox viewer

### Data Processing
- **Scraping**: Playwright (TypeScript)
- **Image AI**: UFOID (classification), Fastdup (deduplication)
- **Matching**: Custom multi-index filtering + Gemini vision API
- **Language**: Python 3.x (ML), Node.js (scraping/server)

## Quick Start

### Prerequisites
- Node.js 18+ and npm
- Python 3.8+ with venv
- Git

### Installation

```bash
# 1. Clone repository
git clone <repository-url>
cd RealEstate

# 2. Install Node.js dependencies
npm install

# 3. Set up Python environment (for image processing)
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt

# 4. Configure environment
cp .env.example .env
# Edit .env with your Gemini API key (for visual matching)
```

### Running the Matching Interface

```bash
# Start the matching server
node scripts/human-loop/matching-server.js

# Open in browser
open http://localhost:3000/matcher.html
```

The server will:
- Load 46 Viva listings with pre-filtered candidates
- Serve the interactive matching interface
- Auto-save all decisions to `data/manual-matches.json`
- Maintain an audit trail in `data/manual-matches.log.jsonl`

## Full Pipeline Execution

### Step 1: Scrape Listings

```bash
# Collect homepage URLs
npx playwright test scripts/collect-urls-coelhodafonseca.spec.ts
npx playwright test scripts/collect-urls-vivaprime.spec.ts

# Extract full listing details + download images
npx playwright test scripts/extract-details-coelhodafonseca.spec.ts
node scripts/extract-vivaprime-details.js
```

**Output:**
- `data/{site}/listings/all-listings.json`
- `data/{site}/images/{propertyCode}/` (all images)

### Step 2: Process Images

```bash
source venv/bin/activate

# Classify images (exterior, interior, floorplan, etc.)
python scripts/run_ufoid.py

# Detect near-duplicates within each listing
python scripts/run_fastdup.py

# Select best 6-8 exterior images per listing
python scripts/select_exteriors.py
```

**Output:**
- `data/{site}/images/{propertyCode}/ufoid_results.json`
- `data/{site}/images/{propertyCode}/fastdup_results.json`
- `selected_exteriors/{site}/{propertyCode}/` (best exteriors)

### Step 3: Generate Mosaics

```bash
# Create 2×4 grid mosaics for visual comparison
node scripts/mosaic-module.js both
```

**Output:**
- `data/mosaics/viva/{propertyCode}.png` (68 mosaics)
- `data/mosaics/coelho/{propertyCode}.png` (82 mosaics)

### Step 4: Filter Candidates

```bash
# Run smart-compare V8 (deterministic filtering)
node scripts/smart-compare-V2.cjs
```

**Output:**
- `data/smart-matches.json` (46 Viva listings with 2-3 candidates each)

**Filtering Strategy:**
- Multi-index blocking: structural, area+parking, feature signatures, exact price, ratios
- Proportional tolerances: ±8% area, ±10% price
- Suite filtering: ±1 suite difference
- Composite scoring with hard rejection rules
- Result: 5,670 possible pairs → 46 listings with 138 candidates (97.5% reduction)

### Step 5: Human Verification

```bash
# Start matching server
node scripts/human-loop/matching-server.js

# Open interface
open http://localhost:3000/matcher.html
```

**Workflow:**
1. Review Viva property mosaic (top)
2. Compare with Coelho candidate mosaics (below)
3. Click "✓ Match" if properties are identical
4. Click "⊘ Skip" if no candidates match
5. Progress auto-saved after each decision

**Keyboard Shortcuts:**
- `1-9` - Select candidate #1-9 as match
- `S` - Skip listing (no matches)
- `U` - Undo last decision
- `?` - Show help modal
- `Esc` - Close lightbox/modals

**Features:**
- Real-time progress tracking
- Price & area delta percentages with color-coding
- AI confidence scores displayed
- Time-spent tracking per decision
- Fully resumable sessions
- Complete audit trail with timestamps

## Data Schema

### Viva Listings (`data/vivaprimeimoveis/listings/all-listings.json`)
```json
{
  "total_listings": 68,
  "listings": [
    {
      "propertyCode": "1034",
      "url": "https://www.vivaprimeimoveis.com.br/imovel/...",
      "title": "Casa com 4 Quartos...",
      "price": "R$ 9.500.000,00",
      "detailedData": {
        "specs": {
          "dormitorios": 4,
          "suites": 4,
          "banheiros": 4,
          "vagas": 3,
          "area_construida": "523.57m²",
          "area_total": "571.67m²"
        },
        "description": "...",
        "gallery": ["url1", "url2", ...]
      }
    }
  ]
}
```

### Coelho Listings (`data/coelhodafonseca/listings/all-listings.json`)
```json
{
  "total_listings": 82,
  "listings": [
    {
      "propertyCode": "379860",
      "url": "https://www.coelhodafonseca.com.br/379860",
      "title": "Casa à venda...",
      "price": "R$10.000.000",
      "features": "4 dorms / 4 suítes / 4 vagas / 500 m² construída / 600 m² do terreno",
      "description": "...",
      "images": ["url1", "url2", ...]
    }
  ]
}
```

### Smart Matches (`data/smart-matches.json`)
```json
{
  "generated_at": "2025-11-01T21:09:54.685Z",
  "total_viva_listings": 68,
  "listings_with_candidates": 46,
  "matches": [
    {
      "viva": { /* full viva listing */ },
      "coelhoCandidates": [
        { /* coelho candidate 1 */ },
        { /* coelho candidate 2 */ }
      ],
      "_scored": [
        { "code": "379860", "score": 0.431 },
        { "code": "660536", "score": 0.266 }
      ]
    }
  ]
}
```

### Manual Matches (`data/manual-matches.json`)
```json
{
  "session_started": "2025-11-01T22:03:58.275Z",
  "last_updated": "2025-11-01T22:03:58.276Z",
  "version": 0,
  "stats": {
    "total_viva_listings": 46,
    "matched": 0,
    "rejected": 0,
    "skipped": 0,
    "pending": 46
  },
  "matches": [
    {
      "viva_code": "1034",
      "coelho_code": "379860",
      "matched_at": "2025-11-01T22:15:00.000Z",
      "reviewer": "gabriel",
      "time_spent_sec": 45,
      "ai_score": 0.431,
      "confidence": "manual_confirmed"
    }
  ],
  "skipped": [
    {
      "viva_code": "2075",
      "reason": "no_good_candidates",
      "skipped_at": "2025-11-01T22:20:00.000Z",
      "reviewer": "gabriel"
    }
  ]
}
```

## API Reference

### Matching Server Endpoints

All endpoints are RESTful and return JSON.

#### `GET /api/session`
Get current session information and statistics.

**Response:**
```json
{
  "session_name": "default",
  "session_started": "2025-11-01T22:03:58.275Z",
  "last_updated": "2025-11-01T22:03:58.276Z",
  "version": 0,
  "stats": {
    "total_viva_listings": 46,
    "matched": 0,
    "rejected": 0,
    "skipped": 0,
    "pending": 46,
    "in_progress": 0
  },
  "read_only": false
}
```

#### `GET /api/next`
Get the next Viva listing to review.

**Query Params:**
- `reviewer` (optional): Reviewer name

**Response:**
```json
{
  "viva_code": "1034",
  "viva": { /* full listing object */ },
  "remaining_candidates": 2,
  "mosaic_path": "/mosaics/viva/1034.png"
}
```

#### `GET /api/candidates/:vivaCode`
Get candidates for a specific Viva listing.

**Response:**
```json
{
  "viva_code": "1034",
  "candidates": [
    {
      "code": "379860",
      "candidate": { /* full listing */ },
      "ai_score": 0.431,
      "deltas": {
        "price_viva": 9500000,
        "price_coelho": 10000000,
        "price_delta_pct": 5.26,
        "area_viva": 523.57,
        "area_coelho": 500,
        "area_delta_pct": -4.50
      },
      "mosaic_path": "/mosaics/coelho/379860.png"
    }
  ],
  "total_candidates": 2
}
```

#### `POST /api/match`
Record a confirmed match.

**Body:**
```json
{
  "viva_code": "1034",
  "coelho_code": "379860",
  "reviewer": "gabriel",
  "time_spent_sec": 45,
  "notes": "Pool and facade match perfectly"
}
```

**Response:**
```json
{
  "success": true,
  "match": { /* match record */ },
  "remaining": 45
}
```

#### `POST /api/skip`
Skip a Viva listing (no matches found).

**Body:**
```json
{
  "viva_code": "1034",
  "reviewer": "gabriel",
  "reason": "no_good_candidates"
}
```

#### `POST /api/undo`
Undo the last decision by the current reviewer.

**Body:**
```json
{
  "reviewer": "gabriel"
}
```

#### `GET /api/progress`
Get detailed completion statistics.

**Response:**
```json
{
  "total_viva_listings": 46,
  "matched": 5,
  "skipped": 3,
  "pending": 38,
  "in_progress": 0,
  "completed": 8,
  "progress_pct": 17.4
}
```

#### `GET /api/audit`
Stream complete decision history (audit log).

**Response:**
```json
{
  "entries": [
    {
      "id": "uuid",
      "timestamp": "2025-11-01T22:15:00.000Z",
      "session": "default",
      "action": "match",
      "payload": { /* action details */ },
      "hash": "abc123..."
    }
  ],
  "total": 10
}
```

## Architecture

### Smart-Compare V8 Algorithm

**Multi-Index Blocking:**
1. **Index A** (Structural): `(beds, suites, round(built_area, 10))`
2. **Index B** (Area+Parking): `(beds, round(built_area, 25), parking)`
3. **Index C** (Features): `(beds, feature_signature)` - Pool, gourmet, office, etc.
4. **Index E** (Exact Price): `(price, round(built_area, 20))` - ±5% price variation
5. **Index R** (Ratios): `(beds/baths_ratio, built/lot_ratio)` - Geometric proportions

**Proportional Gathering:**
- ±8% area tolerance (was fixed ±50m²)
- ±10% price tolerance
- ±1 suite difference

**Composite Scoring:**
```javascript
score = 0.25 * built_area_sim
      + 0.03 * lot_area_sim
      + 0.21 * price_per_m2_sim
      + 0.10 * bedrooms_sim
      + 0.08 * suites_sim
      + 0.06 * parking_sim
      + 0.27 * feature_sim  // Structured features (not text)
```

**Hard Rejection Rules:**
- Price difference > 10%
- Area difference > 8% AND feature similarity < 0.3

**Result:** 97.5% reduction (5,670 → 138 candidate pairs)

### Human-in-the-Loop Interface

**State Management:**
- Single source of truth in `data/manual-matches.json`
- Optimistic updates with version tracking
- Append-only audit log for tamper-evidence
- ETags for concurrency control

**Session Lifecycle:**
1. Load smart-matches.json (46 Viva listings)
2. Build task queue (filter already decided)
3. Present listings one-by-one
4. Save decision → Update state → Rebuild queue
5. Continue until all reviewed

**Resume Support:**
- Close browser anytime
- Reopen → Loads last state
- Continue from where you left off
- Full decision history preserved

## Development

### Running in Development Mode

```bash
# Start server with auto-reload
npm run dev  # (if configured)

# Or manually with nodemon
npx nodemon scripts/human-loop/matching-server.js

# Read-only mode (no writes)
node scripts/human-loop/matching-server.js --read-only

# Custom port
node scripts/human-loop/matching-server.js --port=3001
```

### Server Configuration

Environment variables (optional):
```bash
MATCHING_PORT=3000          # Server port
DATA_ROOT=./data            # Data directory
SESSION_NAME=default        # Session identifier
```

CLI flags:
```bash
--port=3001                 # Custom port
--read-only                 # Disable all writes
```

### Testing

```bash
# Test server data loading
node -e "const data = require('./data/smart-matches.json'); console.log('Listings:', data.matches.length);"

# Test API endpoints
curl http://localhost:3000/api/session
curl http://localhost:3000/api/progress
curl http://localhost:3000/api/next

# Check server status
lsof -i :3000
ps aux | grep matching-server
```

### Adding New Features

**Backend (matching-server.js):**
- All endpoints in one file for simplicity
- State management functions at top
- Express routes in middle
- Server startup at bottom

**Frontend (matcher-app.js):**
- Clean architecture: State → API → UI → App
- ES6 modules with class-based design
- Separation of concerns throughout

**Styling (matcher.css):**
- CSS Variables for theming
- Light/dark mode support
- Responsive breakpoints: 1440px, 768px

## Matching Strategy Rationale

### Why Human-in-the-Loop?

**Automated approaches tried:**
- Vector embeddings (CLIP) - Poor for architectural details
- Gemini visual comparison - Expensive, slow, false positives
- Geometric hashing - Complex, brittle

**Human-in-the-loop advantages:**
- 100% accuracy on visual confirmation
- Fast: 2-3 minutes per listing
- Explainable decisions
- Can handle edge cases
- Training data for future ML

**Hybrid approach:**
1. Automated filtering reduces 5,670 → 138 pairs (97.5%)
2. Human reviews only the 138 candidates (~2-3 hours total)
3. Best of both worlds: speed + accuracy

### Smart-Compare V8 Improvements

**From V7 → V8:**
1. **Denoised text** - Removed broker marketing speak
2. **Structured features** - Boolean flags (pool, gourmet, etc.) instead of text tokens
3. **Exact price index** - Replaced fuzzy price/m² with exact price blocks
4. **Ratio index** - Geometric proportions (beds/baths, built/lot)
5. **Proportional gathering** - ±8% area instead of fixed ±50m²

**Result:** Better precision without sacrificing recall.

## Legal and Ethical Considerations

- **Robots.txt**: All scraping respects robots.txt directives
- **Rate Limiting**: Configurable delays between requests
- **Data Usage**: For analysis and comparison only, not republication
- **Attribution**: Source URLs maintained in all records
- **Privacy**: No personal data (agents, sellers) is stored

## Future Enhancements

### Optional (Not Yet Implemented)

From `HUMAN_LOOP_MATCHING_PLAN.md`:

- [ ] `scripts/human-loop/export-manual-matches.js` - Export final results to CSV/reports
- [ ] `scripts/human-loop/review-health-check.js` - Detect stale tasks, missing mosaics
- [ ] Confidence ratings - Mark "high confidence" vs "uncertain" matches
- [ ] Notes field - Add comments for each match
- [ ] Multi-reviewer support - Parallel review with consensus workflow
- [ ] WebSocket live dashboard - Real-time progress monitoring
- [ ] Second-reviewer QA - Spot-check 10% of matches
- [ ] ML training export - Use confirmed matches as training data

### Potential Improvements

- [ ] Automated price tracking over time
- [ ] Email alerts for new matches
- [ ] Mobile-responsive interface
- [ ] Batch operations (approve multiple)
- [ ] Advanced filters in UI
- [ ] Export to spreadsheet directly from UI
- [ ] Integration with real estate APIs

## Performance

### Current Stats

- **Listings**: 68 Viva + 82 Coelho = 150 total
- **Images downloaded**: ~1,200 images
- **Mosaics generated**: 150 mosaics
- **Candidate pairs**: 138 (from 5,670 possible)
- **Review time**: ~2-3 hours for 46 listings
- **Server memory**: ~50 MB
- **Page load time**: <500ms

### Scaling Considerations

For larger datasets:
- Consider PostgreSQL instead of JSON files
- Add pagination to task queue
- Implement worker pools for image processing
- Use CDN for mosaic delivery
- Add caching layer (Redis)

## Troubleshooting

### Server won't start

```bash
# Check if port is in use
lsof -i :3000

# Kill existing process
kill $(lsof -ti:3000)

# Check logs
cat server.log
```

### Missing mosaics

```bash
# Regenerate specific mosaic
node scripts/mosaic-module.js viva 1034
node scripts/mosaic-module.js coelho 379860

# Regenerate all
node scripts/mosaic-module.js both
```

### Data format mismatch

The server supports both formats:
- Old: `viva.detailedData.specs.area_construida`
- New: `viva.specs.area_construida`

If issues persist, check `calculateDeltas()` function in matching-server.js.

### Session state corrupted

```bash
# Backup current state
cp data/manual-matches.json data/manual-matches.backup.json

# Reset session (WARNING: loses progress)
rm data/manual-matches.json
rm data/manual-matches.log.jsonl

# Restart server - will create fresh session
node scripts/human-loop/matching-server.js
```

## Git Workflow

Current branch: `Human_Loop_V2`

```bash
# Create new branch
git checkout -b Human_Loop_V2

# Commit changes
git add .
git commit -m "Complete human-in-the-loop matching system"

# Push to remote
git push -u origin Human_Loop_V2
```

## Contact

For questions or issues, please open a GitHub issue.

## Acknowledgments

- **UFOID** - Image classification model
- **Fastdup** - Near-duplicate detection
- **Playwright** - Web scraping automation
- **Google Gemini** - Visual AI for smart-compare (future use)
- **Express.js** - Web server framework

## License

[To be determined]

## Disclaimer

This tool is for research and analysis purposes. Users are responsible for ensuring compliance with all applicable laws and website terms of service.
