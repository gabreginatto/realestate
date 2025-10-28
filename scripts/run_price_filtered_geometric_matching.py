#!/usr/bin/env python3
"""
Price-Filtered Geometric Matching

This script combines smart filtering with geometric verification:
1. Load listing data from JSON files
2. Pre-filter pairs by price/area/bedrooms (like smart-compare-V2.cjs)
3. Run geometric matching ONLY on filtered candidates
4. Log detailed progress

This reduces from 5,589 pairs to ~100-300, making it practical (~10-30 min instead of 16+ hours).
"""

import os
import json
import sys
from pathlib import Path
from typing import List, Dict, Tuple, Optional
import cv2
import numpy as np
from rich.console import Console
from rich.progress import Progress, SpinnerColumn, BarColumn, TextColumn, TimeElapsedColumn, TimeRemainingColumn
import time
from datetime import datetime
import re

console = Console()

class ProgressLogger:
    """Logger for tracking matching progress."""

    def __init__(self, log_file="geometric_progress_filtered.log"):
        self.log_file = log_file
        self.start_time = time.time()

        # Initialize log file
        with open(self.log_file, 'w') as f:
            f.write(f"=== PRICE-FILTERED GEOMETRIC MATCHING LOG ===\n")
            f.write(f"Started: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
            f.write(f"=" * 60 + "\n\n")

    def log(self, message):
        """Write message to log file with timestamp."""
        elapsed = time.time() - self.start_time
        timestamp = f"[{elapsed/60:6.1f}m]"
        with open(self.log_file, 'a') as f:
            f.write(f"{timestamp} {message}\n")
            f.flush()  # Force write to disk

    def log_progress(self, pairs_done, total_pairs, matches_found, avg_time_per_pair):
        """Log progress update."""
        pct = (pairs_done / total_pairs) * 100
        remaining_pairs = total_pairs - pairs_done
        eta_seconds = remaining_pairs * avg_time_per_pair

        msg = (
            f"Progress: {pairs_done:,}/{total_pairs:,} ({pct:5.1f}%) | "
            f"Matches: {matches_found} | "
            f"Avg: {avg_time_per_pair*1000:6.0f}ms/pair | "
            f"ETA: {eta_seconds/60:5.1f}min"
        )
        self.log(msg)

    def log_pair(self, coelho_id, viva_id, result, time_taken):
        """Log individual pair comparison."""
        match_str = "MATCH!" if result["is_match"] else "no match"
        msg = (
            f"  [{coelho_id} vs {viva_id}] "
            f"{match_str} | "
            f"best_inliers: {result['best_inliers']:3d} | "
            f"time: {time_taken*1000:6.0f}ms"
        )
        self.log(msg)


class GeometricMatcher:
    """ORB+RANSAC geometric matcher."""

    def __init__(self, num_features=2000, min_inliers=30, ransac_threshold=5.0):
        self.num_features = num_features
        self.min_inliers = min_inliers
        self.ransac_threshold = ransac_threshold
        self.orb = cv2.ORB_create(nfeatures=num_features)
        self.bf_matcher = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=False)

    def match_images(self, img1_path: str, img2_path: str) -> int:
        """
        Match two images using ORB+RANSAC.

        Returns:
            Number of RANSAC inliers (geometrically consistent matches)
        """
        img1 = cv2.imread(img1_path, cv2.IMREAD_GRAYSCALE)
        img2 = cv2.imread(img2_path, cv2.IMREAD_GRAYSCALE)

        if img1 is None or img2 is None:
            return 0

        # Detect ORB keypoints and descriptors
        kp1, des1 = self.orb.detectAndCompute(img1, None)
        kp2, des2 = self.orb.detectAndCompute(img2, None)

        if des1 is None or des2 is None or len(kp1) < 4 or len(kp2) < 4:
            return 0

        # Match descriptors
        matches = self.bf_matcher.knnMatch(des1, des2, k=2)

        # Lowe's ratio test
        good_matches = []
        for m_n in matches:
            if len(m_n) == 2:
                m, n = m_n
                if m.distance < 0.75 * n.distance:
                    good_matches.append(m)

        if len(good_matches) < 4:
            return 0

        # RANSAC geometric verification
        src_pts = np.float32([kp1[m.queryIdx].pt for m in good_matches]).reshape(-1, 1, 2)
        dst_pts = np.float32([kp2[m.trainIdx].pt for m in good_matches]).reshape(-1, 1, 2)

        try:
            _, mask = cv2.findHomography(src_pts, dst_pts, cv2.RANSAC, self.ransac_threshold)
            if mask is None:
                return 0
            inliers = np.sum(mask)
            return int(inliers)
        except:
            return 0

    def match_listings(self, listing1_dir: str, listing2_dir: str, max_images: int = 12) -> Dict:
        """
        Match two listings by comparing all image pairs.

        Returns:
            Dict with best_inliers, avg_inliers, is_match
        """
        # Get images
        images1 = sorted([f for f in os.listdir(listing1_dir) if f.endswith(('.jpg', '.jpeg', '.png'))])[:max_images]
        images2 = sorted([f for f in os.listdir(listing2_dir) if f.endswith(('.jpg', '.jpeg', '.png'))])[:max_images]

        if not images1 or not images2:
            return {"best_inliers": 0, "avg_inliers": 0.0, "is_match": False, "comparisons": 0}

        inlier_counts = []
        best_inliers = 0

        # Compare all image pairs
        for img1 in images1:
            for img2 in images2:
                img1_path = os.path.join(listing1_dir, img1)
                img2_path = os.path.join(listing2_dir, img2)

                inliers = self.match_images(img1_path, img2_path)
                inlier_counts.append(inliers)

                if inliers > best_inliers:
                    best_inliers = inliers

                # Early termination if we found a strong match
                if best_inliers >= self.min_inliers:
                    break

            if best_inliers >= self.min_inliers:
                break

        avg_inliers = np.mean(inlier_counts) if inlier_counts else 0.0
        is_match = best_inliers >= self.min_inliers

        return {
            "best_inliers": best_inliers,
            "avg_inliers": float(avg_inliers),
            "is_match": is_match,
            "comparisons": len(inlier_counts)
        }


# ============================================================================
# DATA LOADING & NORMALIZATION (from smart-compare-V2.cjs)
# ============================================================================

def parse_price_brl(price_str: str) -> Optional[float]:
    """Parse Brazilian price format: R$ 4.900.000,00 or R$32.000.000"""
    if not price_str:
        return None
    # Remove R$ and currency symbols
    cleaned = re.sub(r'[R$\s]', '', price_str)
    # Remove dots (thousands separator) and replace comma with dot
    cleaned = cleaned.replace('.', '').replace(',', '.')
    try:
        return float(cleaned)
    except:
        return None


def parse_area_m2(area_str: str) -> Optional[float]:
    """Parse area from string: '450 m²' or '450m²'"""
    if not area_str:
        return None
    match = re.search(r'(\d+(?:[.,]\d+)?)\s*m²', str(area_str))
    if match:
        num = match.group(1).replace(',', '.')
        try:
            return float(num)
        except:
            return None
    return None


def extract_from_features(features_str: str, pattern: str) -> Optional[int]:
    """Extract numeric value from features string."""
    if not features_str:
        return None
    match = re.search(pattern, features_str, re.IGNORECASE)
    if match:
        try:
            return int(match.group(1))
        except:
            return None
    return None


def normalize_viva_listing(listing: Dict) -> Dict:
    """Normalize a Viva listing for comparison."""
    specs = listing.get('detailedData', {}).get('specs', {})

    price = parse_price_brl(listing.get('price', ''))
    built = parse_area_m2(specs.get('area_construida', ''))
    lot = parse_area_m2(specs.get('area_total', ''))
    beds = specs.get('dormitorios')
    suites = specs.get('suites')
    baths = specs.get('banheiros')
    park = specs.get('vagas')

    # Convert string numbers to int if needed
    if isinstance(beds, str):
        beds = int(beds) if beds.isdigit() else None
    if isinstance(suites, str):
        suites = int(suites) if suites.isdigit() else None
    if isinstance(baths, str):
        baths = int(baths) if baths.isdigit() else None
    if isinstance(park, str):
        park = int(park) if park.isdigit() else None

    return {
        'code': listing['propertyCode'],
        'url': listing['url'],
        'price': price,
        'built': built,
        'lot': lot,
        'beds': beds,
        'suites': suites,
        'baths': baths,
        'park': park,
        'raw': listing
    }


def normalize_coelho_listing(listing: Dict) -> Dict:
    """Normalize a Coelho listing for comparison."""
    price = parse_price_brl(listing.get('price', ''))

    features = listing.get('features', '')
    built = parse_area_m2(features)
    beds = extract_from_features(features, r'(\d+)\s*dorms?')
    suites = extract_from_features(features, r'(\d+)\s*su[ií]tes?')
    park = extract_from_features(features, r'(\d+)\s*vagas?')

    # Extract lot area from features
    lot_match = re.search(r'(\d+(?:[.,]\d+)?)\s*m²\s*do\s+terreno', features)
    lot = float(lot_match.group(1).replace(',', '.')) if lot_match else None

    return {
        'code': listing['propertyCode'],
        'url': listing['url'],
        'price': price,
        'built': built,
        'lot': lot,
        'beds': beds,
        'suites': suites,
        'baths': None,  # Not in Coelho features
        'park': park,
        'raw': listing
    }


def filter_candidate_pairs(viva_listings: List[Dict], coelho_listings: List[Dict],
                          price_tolerance: float = 0.15,
                          area_tolerance: float = 0.15) -> List[Tuple[Dict, Dict]]:
    """
    Filter listing pairs by price and area similarity.

    Returns list of (viva, coelho) tuples that should be compared geometrically.
    """
    candidates = []

    for viva in viva_listings:
        if not viva['price'] or not viva['built']:
            continue

        for coelho in coelho_listings:
            if not coelho['price'] or not coelho['built']:
                continue

            # Price filter (within tolerance)
            price_diff = abs(viva['price'] - coelho['price']) / max(viva['price'], coelho['price'])
            if price_diff > price_tolerance:
                continue

            # Area filter (within tolerance)
            area_diff = abs(viva['built'] - coelho['built']) / max(viva['built'], coelho['built'])
            if area_diff > area_tolerance:
                continue

            # Bedroom filter (optional, ±1 bedroom)
            if viva['beds'] and coelho['beds']:
                if abs(viva['beds'] - coelho['beds']) > 1:
                    continue

            # Suite filter (optional, ±1 suite)
            if viva['suites'] and coelho['suites']:
                if abs(viva['suites'] - coelho['suites']) > 1:
                    continue

            candidates.append((viva, coelho))

    return candidates


def main():
    console.print("\n[bold cyan]🔍 Price-Filtered Geometric Matching[/bold cyan]\n")

    # Paths
    viva_json = "data/vivaprimeimoveis/listings/all-listings.json"
    coelho_json = "data/coelhodafonseca/listings/all-listings.json"
    coelho_dir = "selected_exteriors/coelhodafonseca"
    viva_dir = "selected_exteriors/vivaprimeimoveis"
    output_file = "geometric_matches_filtered.json"

    # Initialize logger
    logger = ProgressLogger("geometric_progress_filtered.log")

    # Load listing data
    console.print("📊 Loading listing data...\n")

    with open(viva_json) as f:
        viva_data = json.load(f)
    with open(coelho_json) as f:
        coelho_data = json.load(f)

    # Normalize listings
    viva_listings = [normalize_viva_listing(x) for x in viva_data['listings']]
    coelho_listings = [normalize_coelho_listing(x) for x in coelho_data['listings']]

    console.print(f"Viva listings: {len(viva_listings)}")
    console.print(f"Coelho listings: {len(coelho_listings)}")
    console.print(f"Total possible pairs: {len(viva_listings) * len(coelho_listings):,}\n")

    logger.log(f"Viva listings: {len(viva_listings)}")
    logger.log(f"Coelho listings: {len(coelho_listings)}")
    logger.log(f"Total possible pairs: {len(viva_listings) * len(coelho_listings):,}")
    logger.log("")

    # Filter by price/area/beds
    console.print("🔍 Filtering candidates by price, area, and bedrooms...\n")
    console.print("Filters:")
    console.print("  • Price tolerance: ±15%")
    console.print("  • Area tolerance: ±15%")
    console.print("  • Bedroom difference: ±1")
    console.print("  • Suite difference: ±1\n")

    candidate_pairs = filter_candidate_pairs(viva_listings, coelho_listings,
                                            price_tolerance=0.15,
                                            area_tolerance=0.15)

    console.print(f"[bold green]✓ Filtered to {len(candidate_pairs)} candidate pairs[/bold green]\n")
    console.print(f"Reduction: {len(viva_listings) * len(coelho_listings):,} → {len(candidate_pairs)} "
                 f"({100 * len(candidate_pairs) / (len(viva_listings) * len(coelho_listings)):.1f}%)\n")

    logger.log(f"After price/area/bed filtering: {len(candidate_pairs)} pairs")
    logger.log(f"Reduction: {(1 - len(candidate_pairs) / (len(viva_listings) * len(coelho_listings))) * 100:.1f}%")
    logger.log("")

    if len(candidate_pairs) == 0:
        console.print("[yellow]⚠️  No candidate pairs found. Try increasing tolerances.[/yellow]\n")
        return

    # Estimate time
    avg_time_per_pair = 0.15  # seconds (optimistic)
    estimated_minutes = (len(candidate_pairs) * avg_time_per_pair) / 60
    console.print(f"Estimated time: ~{estimated_minutes:.1f} minutes\n")

    console.print("Parameters:")
    console.print("  • ORB features: 2000")
    console.print("  • Min inliers: 30")
    console.print("  • RANSAC threshold: 5.0 pixels")
    console.print("  • Max images per listing: 12\n")
    console.print(f"  • Progress log: geometric_progress_filtered.log\n")

    # Initialize matcher
    matcher = GeometricMatcher(num_features=2000, min_inliers=30, ransac_threshold=5.0)

    # Results
    matches = []
    comparison_count = 0
    match_count = 0
    pair_times = []

    start_time = time.time()

    # Progress bar
    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TextColumn("[progress.percentage]{task.percentage:>3.0f}%"),
        TimeElapsedColumn(),
        TimeRemainingColumn(),
        console=console
    ) as progress:

        task = progress.add_task(
            f"Comparing filtered pairs...",
            total=len(candidate_pairs)
        )

        # Compare each filtered pair
        for viva, coelho in candidate_pairs:
            viva_path = os.path.join(viva_dir, viva['code'])
            coelho_path = os.path.join(coelho_dir, coelho['code'])

            # Check if directories exist
            if not os.path.isdir(viva_path) or not os.path.isdir(coelho_path):
                comparison_count += 1
                progress.update(task, advance=1)
                continue

            # Time this comparison
            pair_start = time.time()

            # Match listings
            result = matcher.match_listings(coelho_path, viva_path, max_images=12)

            pair_time = time.time() - pair_start
            pair_times.append(pair_time)

            comparison_count += 1

            # Record if match found
            if result["is_match"]:
                match_count += 1
                matches.append({
                    "viva": {
                        "code": viva['code'],
                        "url": viva['url'],
                        "price": viva['raw']['price'],
                        "specs": viva['raw'].get('detailedData', {}).get('specs', {})
                    },
                    "coelho": {
                        "code": coelho['code'],
                        "url": coelho['url'],
                        "price": coelho['raw']['price'],
                        "features": coelho['raw'].get('features', '')
                    },
                    "geometric_match": {
                        "best_inliers": result["best_inliers"],
                        "avg_inliers": result["avg_inliers"],
                        "image_comparisons": result["comparisons"]
                    },
                    "price_diff_pct": abs(viva['price'] - coelho['price']) / max(viva['price'], coelho['price']) * 100,
                    "area_diff_pct": abs(viva['built'] - coelho['built']) / max(viva['built'], coelho['built']) * 100
                })

                # Log matches immediately
                logger.log_pair(coelho['code'], viva['code'], result, pair_time)

            # Log progress every 10 pairs
            if comparison_count % 10 == 0:
                avg_time = np.mean(pair_times)
                logger.log_progress(comparison_count, len(candidate_pairs), match_count, avg_time)

            # Log every 50 pairs with more detail
            if comparison_count % 50 == 0:
                elapsed = time.time() - start_time
                avg_time = np.mean(pair_times)
                logger.log("")
                logger.log(f"CHECKPOINT: {comparison_count}/{len(candidate_pairs)} pairs")
                logger.log(f"  Elapsed: {elapsed/60:.1f} minutes")
                logger.log(f"  Matches found: {match_count}")
                logger.log(f"  Avg time/pair: {avg_time*1000:.0f}ms")
                if len(pair_times) >= 50:
                    logger.log(f"  Recent 50: min={min(pair_times[-50:])*1000:.0f}ms, max={max(pair_times[-50:])*1000:.0f}ms")
                logger.log("")

            progress.update(task, advance=1)

    elapsed_time = time.time() - start_time

    # Final log
    logger.log("")
    logger.log("="*60)
    logger.log("COMPLETED!")
    logger.log(f"Total pairs checked: {len(candidate_pairs):,}")
    logger.log(f"Matches found: {match_count}")
    logger.log(f"Match rate: {match_count/len(candidate_pairs)*100:.2f}%")
    logger.log(f"Total time: {elapsed_time/60:.1f} minutes")
    logger.log(f"Avg time/pair: {(elapsed_time * 1000) / len(candidate_pairs):.0f}ms")
    logger.log("="*60)

    # Save results
    output_data = {
        "metadata": {
            "approach": "Price-filtered geometric matching",
            "total_possible_pairs": len(viva_listings) * len(coelho_listings),
            "filtered_pairs": len(candidate_pairs),
            "reduction_pct": (1 - len(candidate_pairs) / (len(viva_listings) * len(coelho_listings))) * 100,
            "matches_found": match_count,
            "viva_count": len(viva_listings),
            "coelho_count": len(coelho_listings),
            "elapsed_seconds": elapsed_time,
            "avg_ms_per_pair": (elapsed_time * 1000) / len(candidate_pairs) if len(candidate_pairs) > 0 else 0,
            "filters": {
                "price_tolerance": 0.15,
                "area_tolerance": 0.15,
                "bedroom_diff": 1,
                "suite_diff": 1
            },
            "geometric_params": {
                "num_features": 2000,
                "min_inliers": 30,
                "ransac_threshold": 5.0,
                "max_images": 12
            }
        },
        "matches": matches
    }

    with open(output_file, 'w') as f:
        json.dump(output_data, f, indent=2)

    # Summary
    console.print(f"\n[bold green]✓ Price-filtered geometric matching complete![/bold green]\n")
    console.print(f"Results:")
    console.print(f"  • Total possible pairs: {len(viva_listings) * len(coelho_listings):,}")
    console.print(f"  • Filtered to: {len(candidate_pairs)} pairs ({100 * len(candidate_pairs) / (len(viva_listings) * len(coelho_listings)):.1f}%)")
    console.print(f"  • Matches found: {match_count}")
    console.print(f"  • Match rate: {match_count/len(candidate_pairs)*100:.2f}%")
    console.print(f"  • Elapsed time: {elapsed_time/60:.1f} minutes ({elapsed_time:.1f}s)")
    console.print(f"  • Avg time per pair: {(elapsed_time * 1000) / len(candidate_pairs):.1f}ms\n")
    console.print(f"Results saved to: [cyan]{output_file}[/cyan]\n")
    console.print(f"Progress log: [cyan]geometric_progress_filtered.log[/cyan]\n")

    if match_count > 0:
        console.print(f"[bold yellow]Found {match_count} potential matches![/bold yellow]")
        console.print(f"Review the matches in {output_file}\n")

        # Show sample matches
        console.print("Sample matches:")
        for i, match in enumerate(matches[:5]):
            console.print(f"  {i+1}. Viva {match['viva']['code']} ↔ Coelho {match['coelho']['code']}")
            console.print(f"     Price diff: {match['price_diff_pct']:.1f}% | Area diff: {match['area_diff_pct']:.1f}%")
            console.print(f"     Inliers: {match['geometric_match']['best_inliers']}")


if __name__ == "__main__":
    main()
