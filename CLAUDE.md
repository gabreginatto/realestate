# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a real estate listings crawler system designed to scrape property data from multiple real estate websites, normalize the data, and store it in a database for analysis and comparison.

## Setup Commands

```bash
# Create and activate virtual environment
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Configure environment
cp .env.example .env
# Edit .env with appropriate configuration

# Initialize database
python scripts/init_db.py
```

## Development Commands

### Running Crawlers
```bash
# Run a specific site crawler
python -m src.crawlers.site_name

# Run all crawlers
python scripts/run_all_crawlers.py

# Run scheduler for periodic crawling
python scripts/scheduler.py
```

### Testing
```bash
# Run all tests
pytest

# Run specific test file
pytest tests/test_crawler_site_name.py

# Run tests with coverage
pytest --cov=src tests/

# Run single test
pytest tests/test_crawler_site_name.py::test_function_name
```

### Data Operations
```bash
# Export listings
python scripts/export_listings.py --days 7 --format csv

# Search properties
python scripts/search.py --location "New York" --max-price 500000
```

### Code Quality
```bash
# Format code
black src/ tests/

# Lint code
flake8 src/ tests/

# Type checking
mypy src/

# Sort imports
isort src/ tests/
```

## Architecture

### Three-Layer Architecture

1. **Crawlers Layer** (`src/crawlers/`)
   - Each real estate website has its own crawler module
   - Crawlers implement a common base interface but handle site-specific extraction logic
   - Responsible for navigation, pagination, and data extraction
   - Must handle rate limiting and respect robots.txt

2. **Models Layer** (`src/models/`)
   - Defines standardized data schemas that normalize listings from different sources
   - Core models: Property listings, Images/media, Listing history, Agent information
   - All extracted data flows through these models for validation and normalization

3. **Database Layer** (`src/database/`)
   - Handles all data persistence operations
   - Supports multiple backends: PostgreSQL, MongoDB, or SQLite (configured via `.env`)
   - Manages duplicate detection across sources
   - Tracks historical data for price changes and status updates

### Data Flow
```
Website → Crawler → Raw Data → Models (validation/normalization) → Database
                                                                      ↓
                                                            Scripts/Queries/API
```

## Core Data Schema

All crawlers must extract and map to these standardized fields:
- `id`, `source`, `url`, `title`, `address`, `price`
- `bedrooms`, `bathrooms`, `sqft`, `property_type`
- `description`, `images`, `listed_date`, `scraped_date`, `status`

## Adding a New Crawler

1. Create file in `src/crawlers/` (e.g., `zillow.py`)
2. Implement the base crawler interface
3. Add site-specific extraction logic with proper selectors
4. Register crawler in the crawler registry
5. Create corresponding test file in `tests/crawlers/`
6. Update crawler to handle pagination and rate limiting per site requirements

## Configuration

The project uses `.env` for all configuration:
- **Database**: Choose backend type and connection details
- **Crawling**: `CRAWL_DELAY`, `MAX_CONCURRENT_REQUESTS`, `REQUEST_TIMEOUT`
- **Rate Limiting**: `REQUESTS_PER_MINUTE`, `REQUESTS_PER_HOUR`
- **Logging**: Level and file path configuration
- **API Keys**: Platform-specific keys if required

## Legal/Ethical Requirements

When implementing crawlers:
- Always check and respect robots.txt
- Implement rate limiting (configured in `.env`)
- Review each site's Terms of Service
- Maintain source attribution in database records
- Use appropriate User-Agent headers

## Deployment

### Architecture Overview

The application has two deployment targets:
1. **Backend (Matching Server)**: GCP Cloud Run
2. **Frontend (Mobile/Web App)**: Firebase Hosting

```
Browser/Mobile → Firebase Hosting (property-matcher-139a4.web.app)
                      ↓ API calls
                 Cloud Run (property-matcher-376125120681.us-central1.run.app)
                      ↓
                 Express Server (matching-server.js)
                      ↓
                 Data Files (mosaics, JSON state)
```

### GCP Cloud Run Deployment (Backend)

**Service Name:** `property-matcher`
**Region:** `us-central1`
**Project:** `realestate-475615`
**Service URL:** https://property-matcher-376125120681.us-central1.run.app

#### Prerequisites
- Google Cloud SDK (`gcloud`) installed and authenticated
- Project access to `realestate-475615`

#### Deploy Command
```bash
cd /Users/gabrielreginatto/Desktop/Code/RealEstate/server-deploy
gcloud run deploy property-matcher \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --port 8080 \
  --platform managed \
  --project realestate-475615
```

#### What Gets Deployed
- `matching-server.js` - Express API server
- `public/` - Static assets (HTML, CSS, JS for desktop web app)
- `data/` - Listings data and mosaics
- `package.json` - Dependencies (Express, CORS)
- `Dockerfile` - Container build instructions (Node 20-slim)

#### Environment Variables (set in Dockerfile)
- `PORT=8080` - Cloud Run standard port
- `HOST=0.0.0.0` - Bind to all interfaces

#### Post-Deployment Verification
```bash
# Check service status
gcloud run services describe property-matcher --region us-central1 --project realestate-475615

# Test API
curl https://property-matcher-376125120681.us-central1.run.app/api/session

# Test desktop web app
open https://property-matcher-376125120681.us-central1.run.app/matcher.html
```

### Firebase Hosting Deployment (Frontend)

**Project ID:** `property-matcher-139a4`
**Hosting URL:** https://property-matcher-139a4.web.app

#### Prerequisites
- Firebase CLI (`firebase`) installed
- Authenticated to Firebase project `property-matcher-139a4`

#### Deploy Commands
```bash
cd /Users/gabrielreginatto/Desktop/Code/RealEstate/matcher-mobile

# Build Expo web export
npx expo export --platform web

# Deploy to Firebase Hosting
npx firebase deploy --only hosting --project property-matcher-139a4
```

#### What Gets Deployed
- `dist/` - Compiled React Native web bundle
  - `index.html` - Entry point
  - `_expo/static/js/web/entry-*.js` - Application JavaScript bundle
  - Assets (fonts, icons)
  - `metadata.json` - Expo metadata

#### Firebase Configuration
**File:** `matcher-mobile/firebase.json`
```json
{
  "hosting": {
    "public": "dist",
    "ignore": ["firebase.json", "**/.*", "**/node_modules/**"],
    "rewrites": [{ "source": "**", "destination": "/index.html" }],
    "headers": [
      {
        "source": "**/*.@(html)",
        "headers": [{ "key": "Cache-Control", "value": "no-cache, no-store, must-revalidate" }]
      },
      {
        "source": "**/*.@(js|css)",
        "headers": [{ "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }]
      }
    ]
  }
}
```

**File:** `matcher-mobile/.firebaserc`
```json
{
  "projects": {
    "default": "property-matcher-139a4"
  }
}
```

#### Post-Deployment Verification
```bash
# Open deployed app
open https://property-matcher-139a4.web.app

# Check Firebase deployment status
firebase hosting:channel:list --project property-matcher-139a4
```

### Full Deployment Workflow (Both Targets)

When deploying both backend and frontend after changes:

```bash
# 1. Deploy backend first (API changes)
cd /Users/gabrielreginatto/Desktop/Code/RealEstate/server-deploy
gcloud run deploy property-matcher \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --port 8080 \
  --platform managed \
  --project realestate-475615

# 2. Then deploy frontend (UI changes)
cd /Users/gabrielreginatto/Desktop/Code/RealEstate/matcher-mobile
npx expo export --platform web
npx firebase deploy --only hosting --project property-matcher-139a4
```

### Rollback Procedures

#### Rollback Cloud Run
```bash
# List recent revisions
gcloud run revisions list --service property-matcher --region us-central1 --project realestate-475615

# Route traffic to previous revision
gcloud run services update-traffic property-matcher \
  --to-revisions REVISION_NAME=100 \
  --region us-central1 \
  --project realestate-475615
```

#### Rollback Firebase
```bash
# List deployment history
firebase hosting:channel:list --project property-matcher-139a4

# Firebase doesn't support direct rollback, redeploy previous version from git:
git checkout <previous-commit>
cd matcher-mobile
npx expo export --platform web
npx firebase deploy --only hosting --project property-matcher-139a4
git checkout main
```

### Monitoring & Logs

#### Cloud Run Logs
```bash
# Stream logs
gcloud run services logs tail property-matcher --region us-central1 --project realestate-475615

# View in console
open https://console.cloud.google.com/run/detail/us-central1/property-matcher/logs?project=realestate-475615
```

#### Firebase Hosting Logs
```bash
# View in Firebase console
open https://console.firebase.google.com/project/property-matcher-139a4/hosting/sites
```

### Common Issues

**Cloud Run Issues:**
- **502 Bad Gateway**: Server crashed on startup. Check logs for Node.js errors.
- **Timeout**: Cold start taking too long. Increase timeout or add min instances.
- **Out of Memory**: Increase memory allocation in deploy command with `--memory 512Mi`

**Firebase Issues:**
- **404 on routes**: Ensure rewrites in `firebase.json` are correct for SPA routing
- **Stale cache**: Clear CDN cache or update cache headers in `firebase.json`
- **Build fails**: Check `npx expo export` runs successfully before deploying
