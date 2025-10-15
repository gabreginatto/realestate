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
