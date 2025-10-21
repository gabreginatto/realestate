#!/usr/bin/env python3
"""
Smart Compare with Geometric Verification

Two-Phase Hybrid Property Matching System:

Phase 1: Deterministic Filtering (V8 improvements)
- Uses structured data (price, area, beds, features)
- Multi-block indexing with denoised features
- Creates small candidate set (~75 pairs)
- Fast and cheap

Phase 2: Geometric Verification (NEW - Replaces Gemini)
- Uses local feature matching (ORB) + RANSAC
- Compares individual images from listings
- Returns hard inlier count (deterministic)
- Fast, free, accurate

This approach is SUPERIOR to vector embeddings because it verifies
geometric identity, not perceptual similarity.
"""

import json
import sys
from pathlib import Path
from typing import List, Dict, Tuple
import typer
from rich.console import Console
from rich.progress import track

# Import our geometric matcher
from geometric_matcher import GeometricMatcher

console = Console()
app = typer.Typer()


def load_listings(json_path: str) -> List[Dict]:
    """Load listings from JSON file."""
    with open(json_path, 'r') as f:
        data = json.load(f)
    return data.get('listings', [])


def get_listing_images(listing: Dict, site: str, max_images: int = 10) -> List[str]:
    """
    Get image paths for a listing.

    Uses the fastdup-selected exteriors for best quality.
    Falls back to cache if needed.
    """
    code = listing.get('propertyCode') or listing.get('code')
    if not code:
        return []

    # Map site names
    site_dir = 'vivaprimeimoveis' if site == 'viva' else 'coelhodafonseca'

    # Try fastdup-selected exteriors first (best 12 images)
    fastdup_dir = Path(f"selected_exteriors/{site_dir}/{code}")
    if fastdup_dir.exists():
        images = sorted([str(p) for p in fastdup_dir.glob("*.jpg") if not p.name.startswith('_')])
        if images:
            return images[:max_images]

    # Fallback to cache
    cache_dir = Path(f"data/{site_dir}/cache/{code}")
    if cache_dir.exists():
        images = sorted([str(p) for p in cache_dir.glob("*.jpg")])
        return images[:max_images]

    return []


# ============================================================================
# PHASE 1: DETERMINISTIC FILTERING (V8 - From smart-compare-V2.cjs)
# ============================================================================
# Note: For this Python version, we'll implement simplified filtering
# The full V8 logic is in smart-compare-V2.cjs
# Here we focus on the geometric verification integration

def simple_candidate_filter(viva_listing: Dict, coelho_listings: List[Dict]) -> List[Dict]:
    """
    Simple candidate filtering based on price and area.

    For full V8 filtering (denoised features, exact price index, ratio index),
    use smart-compare-V2.cjs and export candidates, then run this script.

    This is a simplified version for demonstration.
    """
    candidates = []

    viva_price = parse_price(viva_listing.get('price'))
    viva_area = parse_area(viva_listing.get('detailedData', {}).get('specs', {}).get('area_construida'))

    if not viva_price or not viva_area:
        return []

    for coelho in coelho_listings:
        coelho_price = parse_price(coelho.get('price'))
        coelho_area = parse_area(coelho.get('features', ''))

        if not coelho_price or not coelho_area:
            continue

        # Simple filters
        price_diff = abs(viva_price - coelho_price) / max(viva_price, coelho_price)
        area_diff = abs(viva_area - coelho_area) / max(viva_area, coelho_area)

        if price_diff <= 0.10 and area_diff <= 0.08:
            candidates.append(coelho)

    return candidates


def parse_price(price_str) -> float:
    """Parse price from Brazilian format."""
    if not price_str:
        return None
    try:
        cleaned = str(price_str).replace('.', '').replace(',', '.')
        return float(''.join(c for c in cleaned if c.isdigit() or c == '.'))
    except:
        return None


def parse_area(area_str) -> float:
    """Parse area from m² format."""
    if not area_str:
        return None
    try:
        import re
        match = re.search(r'(\d+(?:[.,]\d+)?)\s*m²', str(area_str))
        if match:
            num = match.group(1).replace(',', '.')
            return float(num)
    except:
        pass
    return None


# ============================================================================
# PHASE 2: GEOMETRIC VERIFICATION
# ============================================================================

@app.command()
def run(
    viva_json: str = typer.Option(
        "data/vivaprimeimoveis/listings/all-listings.json",
        help="Path to Viva listings JSON"
    ),
    coelho_json: str = typer.Option(
        "data/coelhodafonseca/listings/all-listings.json",
        help="Path to Coelho listings JSON"
    ),
    output: str = typer.Option(
        "data/smart-matches-geometric.json",
        help="Output JSON file"
    ),
    min_inliers: int = typer.Option(30, help="Minimum inliers for geometric match"),
    max_images: int = typer.Option(10, help="Max images to use per listing"),
    max_candidates: int = typer.Option(5, help="Max candidates to verify per Viva listing")
):
    """
    Run smart property matching with geometric verification.

    Phase 1: Filter candidates using price/area
    Phase 2: Verify with geometric feature matching (ORB+RANSAC)
    """
    console.print("\n[bold cyan]🔷 Smart Compare with Geometric Verification[/bold cyan]\n")

    # Load listings
    console.print("📁 Loading listings...")
    viva_listings = load_listings(viva_json)
    coelho_listings = load_listings(coelho_json)

    console.print(f"  Viva: {len(viva_listings)} listings")
    console.print(f"  Coelho: {len(coelho_listings)} listings\n")

    # Initialize geometric matcher
    matcher = GeometricMatcher(min_inliers=min_inliers)

    # Results
    all_matches = []
    all_rejections = []
    stats = {
        "total_viva": len(viva_listings),
        "total_coelho": len(coelho_listings),
        "viva_with_candidates": 0,
        "total_geometric_comparisons": 0,
        "matches_found": 0,
        "rejected": 0
    }

    # Process each Viva listing
    console.print("[bold]Phase 1: Candidate Filtering[/bold]\n")

    for idx, viva in enumerate(track(viva_listings, description="Filtering candidates")):
        viva_code = viva.get('propertyCode') or viva.get('code')

        # Phase 1: Get candidates
        candidates = simple_candidate_filter(viva, coelho_listings)

        if not candidates:
            continue

        # Limit candidates
        candidates = candidates[:max_candidates]
        stats["viva_with_candidates"] += 1

        console.print(f"\n[bold]Viva {viva_code}[/bold]: {len(candidates)} candidates")

        # Get Viva images
        viva_images = get_listing_images(viva, 'viva', max_images)
        if not viva_images:
            console.print("  ⚠️  No images found, skipping")
            continue

        console.print(f"  Loaded {len(viva_images)} images")

        # Phase 2: Geometric verification
        console.print(f"\n[bold]Phase 2: Geometric Verification[/bold]")

        for coelho in candidates:
            coelho_code = coelho.get('propertyCode') or coelho.get('code')
            stats["total_geometric_comparisons"] += 1

            # Get Coelho images
            coelho_images = get_listing_images(coelho, 'coelho', max_images)
            if not coelho_images:
                console.print(f"  ⚠️  No images for Coelho {coelho_code}, skipping")
                continue

            console.print(f"\n  Testing: Viva {viva_code} ↔ Coelho {coelho_code}")
            console.print(f"    Viva: {len(viva_images)} images")
            console.print(f"    Coelho: {len(coelho_images)} images")

            # GEOMETRIC MATCHING
            result = matcher.match_listing_pair(viva_images, coelho_images, max_images)

            console.print(f"    Comparisons: {result['total_comparisons']}")
            console.print(f"    Best inliers: {result['best_inliers']}")
            console.print(f"    Avg inliers: {result['avg_inliers']:.1f}")

            if result['is_match']:
                console.print(f"    [bold green]✅ GEOMETRIC MATCH[/bold green]")
                stats["matches_found"] += 1

                match_data = {
                    "viva": {
                        "code": viva_code,
                        "url": viva.get('url'),
                        "price": viva.get('price'),
                        "specs": viva.get('detailedData', {}).get('specs', {})
                    },
                    "coelho": {
                        "code": coelho_code,
                        "url": coelho.get('url'),
                        "price": coelho.get('price'),
                        "features": coelho.get('features')
                    },
                    "geometric_verification": {
                        "best_inliers": result['best_inliers'],
                        "avg_inliers": result['avg_inliers'],
                        "total_comparisons": result['total_comparisons'],
                        "best_match": result['best_match']
                    }
                }
                all_matches.append(match_data)

            else:
                console.print(f"    [bold red]❌ No geometric match[/bold red]")
                stats["rejected"] += 1

                rejection_data = {
                    "viva": {
                        "code": viva_code,
                        "price": viva.get('price')
                    },
                    "coelho": {
                        "code": coelho_code,
                        "price": coelho.get('price')
                    },
                    "geometric_verification": {
                        "best_inliers": result['best_inliers'],
                        "avg_inliers": result['avg_inliers']
                    }
                }
                all_rejections.append(rejection_data)

    # Summary
    console.print("\n" + "="*70)
    console.print("\n[bold cyan]📊 FINAL RESULTS[/bold cyan]\n")
    console.print(f"Total Viva listings: {stats['total_viva']}")
    console.print(f"Viva with candidates: {stats['viva_with_candidates']}")
    console.print(f"Geometric comparisons: {stats['total_geometric_comparisons']}")
    console.print(f"\n[bold green]✅ Matches found: {stats['matches_found']}[/bold green]")
    console.print(f"[bold red]❌ Rejected: {stats['rejected']}[/bold red]\n")

    # Save results
    output_data = {
        "generated_at": "2025-10-21",
        "approach": "Two-phase: V8 filtering + Geometric verification (ORB+RANSAC)",
        "parameters": {
            "min_inliers": min_inliers,
            "max_images_per_listing": max_images,
            "max_candidates_per_viva": max_candidates
        },
        "statistics": stats,
        "matches": all_matches,
        "rejections": all_rejections
    }

    with open(output, 'w') as f:
        json.dump(output_data, f, indent=2)

    console.print(f"💾 Results saved to: {output}\n")

    # Display matches
    if all_matches:
        console.print("[bold]Matched Properties:[/bold]\n")
        for match in all_matches:
            console.print(f"✓ Viva {match['viva']['code']} ↔ Coelho {match['coelho']['code']}")
            console.print(f"  Inliers: {match['geometric_verification']['best_inliers']}")
            console.print(f"  Viva: {match['viva']['price']}")
            console.print(f"  Coelho: {match['coelho']['price']}\n")


if __name__ == "__main__":
    app()
