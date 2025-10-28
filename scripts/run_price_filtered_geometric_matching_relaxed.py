#!/usr/bin/env python3
"""
RELAXED Price-Filtered Geometric Matching (Second Pass)

Relaxed parameters to find more matches:
- Min inliers: 25 → 20
- Min inlier ratio: 0.20 → 0.15
- Max images: 6 → 12
- Keep price/area tolerance: 15% (unchanged)

This should find additional medium-quality matches without compromising on price similarity.
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
from multiprocessing import Pool, cpu_count

console = Console()

class ProgressLogger:
    """Logger for tracking matching progress."""

    def __init__(self, log_file="geometric_progress_relaxed.log"):
        self.log_file = log_file
        self.start_time = time.time()

        # Initialize log file
        with open(self.log_file, 'w') as f:
            f.write(f"=== RELAXED PRICE-FILTERED GEOMETRIC MATCHING LOG ===\n")
            f.write(f"Started: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
            f.write(f"=" * 60 + "\n\n")

    def log(self, message):
        """Write message to log file with timestamp."""
        elapsed = time.time() - self.start_time
        timestamp = f"[{elapsed/60:6.1f}m]"
        with open(self.log_file, 'a') as f:
            f.write(f"{timestamp} {message}\n")
            f.flush()

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
            f"ratio: {result.get('inlier_ratio', 0):.3f} | "
            f"time: {time_taken*1000:6.0f}ms"
        )
        self.log(msg)


class FastGeometricMatcher:
    """Optimized ORB+RANSAC geometric matcher."""

    def __init__(self, num_features=1000, min_inliers=20, min_inlier_ratio=0.15, ransac_threshold=5.0):
        self.num_features = num_features
        self.min_inliers = min_inliers
        self.min_inlier_ratio = min_inlier_ratio
        self.ransac_threshold = ransac_threshold
        self.orb = cv2.ORB_create(nfeatures=num_features)
        self.bf_matcher = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=False)

    def match_images(self, img1_path: str, img2_path: str) -> Tuple[int, float]:
        """
        Match two images using ORB+RANSAC.

        Returns:
            (inliers, inlier_ratio): Number of RANSAC inliers and ratio
        """
        # Read and downscale images for faster processing
        img1 = cv2.imread(img1_path, cv2.IMREAD_GRAYSCALE)
        img2 = cv2.imread(img2_path, cv2.IMREAD_GRAYSCALE)

        if img1 is None or img2 is None:
            return 0, 0.0

        # Downscale if too large (speeds up ORB by 2-3x)
        max_dim = 800
        h1, w1 = img1.shape
        h2, w2 = img2.shape

        if max(h1, w1) > max_dim:
            scale = max_dim / max(h1, w1)
            img1 = cv2.resize(img1, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)

        if max(h2, w2) > max_dim:
            scale = max_dim / max(h2, w2)
            img2 = cv2.resize(img2, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)

        # Detect ORB keypoints and descriptors
        kp1, des1 = self.orb.detectAndCompute(img1, None)
        kp2, des2 = self.orb.detectAndCompute(img2, None)

        if des1 is None or des2 is None or len(kp1) < 4 or len(kp2) < 4:
            return 0, 0.0

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
            return 0, 0.0

        # RANSAC geometric verification
        src_pts = np.float32([kp1[m.queryIdx].pt for m in good_matches]).reshape(-1, 1, 2)
        dst_pts = np.float32([kp2[m.trainIdx].pt for m in good_matches]).reshape(-1, 1, 2)

        try:
            _, mask = cv2.findHomography(src_pts, dst_pts, cv2.RANSAC, self.ransac_threshold)
            if mask is None:
                return 0, 0.0
            inliers = int(np.sum(mask))
            inlier_ratio = inliers / len(good_matches)
            return inliers, inlier_ratio
        except:
            return 0, 0.0

    def match_listings(self, listing1_dir: str, listing2_dir: str, max_images: int = 12) -> Dict:
        """
        Match two listings by comparing image pairs.

        Returns:
            Dict with best_inliers, inlier_ratio, avg_inliers, is_match
        """
        # Get images
        images1 = sorted([f for f in os.listdir(listing1_dir) if f.endswith(('.jpg', '.jpeg', '.png'))])[:max_images]
        images2 = sorted([f for f in os.listdir(listing2_dir) if f.endswith(('.jpg', '.jpeg', '.png'))])[:max_images]

        if not images1 or not images2:
            return {"best_inliers": 0, "inlier_ratio": 0.0, "avg_inliers": 0.0, "is_match": False, "comparisons": 0}

        inlier_counts = []
        best_inliers = 0
        best_ratio = 0.0

        # Compare image pairs (with early termination)
        for img1 in images1:
            for img2 in images2:
                img1_path = os.path.join(listing1_dir, img1)
                img2_path = os.path.join(listing2_dir, img2)

                inliers, ratio = self.match_images(img1_path, img2_path)
                inlier_counts.append(inliers)

                if inliers > best_inliers:
                    best_inliers = inliers
                    best_ratio = ratio

                # Early termination - stop as soon as we find a good match
                if best_inliers >= self.min_inliers and best_ratio >= self.min_inlier_ratio:
                    break

            if best_inliers >= self.min_inliers and best_ratio >= self.min_inlier_ratio:
                break

        avg_inliers = np.mean(inlier_counts) if inlier_counts else 0.0
        is_match = (best_inliers >= self.min_inliers) and (best_ratio >= self.min_inlier_ratio)

        return {
            "best_inliers": best_inliers,
            "inlier_ratio": best_ratio,
            "avg_inliers": float(avg_inliers),
            "is_match": is_match,
            "comparisons": len(inlier_counts)
        }


# Global matcher instance for multiprocessing
_global_matcher = None

def _init_worker(num_features, min_inliers, min_inlier_ratio, ransac_threshold):
    """Initialize worker process with matcher."""
    global _global_matcher
    _global_matcher = FastGeometricMatcher(num_features, min_inliers, min_inlier_ratio, ransac_threshold)


def _match_pair(args):
    """Worker function for parallel matching."""
    viva, coelho, viva_dir_base, coelho_dir_base, max_images = args

    viva_path = os.path.join(viva_dir_base, viva['code'])
    coelho_path = os.path.join(coelho_dir_base, coelho['code'])

    # Check if directories exist
    if not os.path.isdir(viva_path) or not os.path.isdir(coelho_path):
        return None

    start_time = time.time()
    result = _global_matcher.match_listings(coelho_path, viva_path, max_images=max_images)
    elapsed = time.time() - start_time

    return (viva, coelho, result, elapsed)


# ============================================================================
# DATA LOADING & NORMALIZATION (same as before)
# ============================================================================

def parse_price_brl(price_str: str) -> Optional[float]:
    if not price_str:
        return None
    cleaned = re.sub(r'[R$\s]', '', price_str)
    cleaned = cleaned.replace('.', '').replace(',', '.')
    try:
        return float(cleaned)
    except:
        return None


def parse_area_m2(area_str: str) -> Optional[float]:
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
    specs = listing.get('detailedData', {}).get('specs', {})
    price = parse_price_brl(listing.get('price', ''))
    built = parse_area_m2(specs.get('area_construida', ''))
    lot = parse_area_m2(specs.get('area_total', ''))
    beds = specs.get('dormitorios')
    suites = specs.get('suites')
    baths = specs.get('banheiros')
    park = specs.get('vagas')

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
    price = parse_price_brl(listing.get('price', ''))
    features = listing.get('features', '')
    built = parse_area_m2(features)
    beds = extract_from_features(features, r'(\d+)\s*dorms?')
    suites = extract_from_features(features, r'(\d+)\s*su[ií]tes?')
    park = extract_from_features(features, r'(\d+)\s*vagas?')

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
        'baths': None,
        'park': park,
        'raw': listing
    }


def filter_candidate_pairs(viva_listings: List[Dict], coelho_listings: List[Dict],
                          price_tolerance: float = 0.15,
                          area_tolerance: float = 0.15) -> List[Tuple[Dict, Dict]]:
    candidates = []

    for viva in viva_listings:
        if not viva['price'] or not viva['built']:
            continue

        for coelho in coelho_listings:
            if not coelho['price'] or not coelho['built']:
                continue

            price_diff = abs(viva['price'] - coelho['price']) / max(viva['price'], coelho['price'])
            if price_diff > price_tolerance:
                continue

            area_diff = abs(viva['built'] - coelho['built']) / max(viva['built'], coelho['built'])
            if area_diff > area_tolerance:
                continue

            if viva['beds'] and coelho['beds']:
                if abs(viva['beds'] - coelho['beds']) > 1:
                    continue

            if viva['suites'] and coelho['suites']:
                if abs(viva['suites'] - coelho['suites']) > 1:
                    continue

            candidates.append((viva, coelho))

    return candidates


def main():
    console.print("\n[bold cyan]🔍 RELAXED Price-Filtered Geometric Matching (Second Pass)[/bold cyan]\n")

    # Paths
    viva_json = "data/vivaprimeimoveis/listings/all-listings.json"
    coelho_json = "data/coelhodafonseca/listings/all-listings.json"
    coelho_dir = "selected_exteriors/coelhodafonseca"
    viva_dir = "selected_exteriors/vivaprimeimoveis"
    output_file = "geometric_matches_relaxed.json"

    # Initialize logger
    logger = ProgressLogger("geometric_progress_relaxed.log")

    # Load listing data
    console.print("📊 Loading listing data...\n")

    with open(viva_json) as f:
        viva_data = json.load(f)
    with open(coelho_json) as f:
        coelho_data = json.load(f)

    viva_listings = [normalize_viva_listing(x) for x in viva_data['listings']]
    coelho_listings = [normalize_coelho_listing(x) for x in coelho_data['listings']]

    console.print(f"Viva listings: {len(viva_listings)}")
    console.print(f"Coelho listings: {len(coelho_listings)}")
    console.print(f"Total possible pairs: {len(viva_listings) * len(coelho_listings):,}\n")

    logger.log(f"Viva listings: {len(viva_listings)}")
    logger.log(f"Coelho listings: {len(coelho_listings)}")
    logger.log(f"Total possible pairs: {len(viva_listings) * len(coelho_listings):,}")

    # Filter by price/area/beds
    console.print("🔍 Filtering candidates by price, area, and bedrooms...\n")

    candidate_pairs = filter_candidate_pairs(viva_listings, coelho_listings,
                                            price_tolerance=0.15,
                                            area_tolerance=0.15)

    console.print(f"[bold green]✓ Filtered to {len(candidate_pairs)} candidate pairs[/bold green]\n")

    logger.log(f"After price/area/bed filtering: {len(candidate_pairs)} pairs")

    if len(candidate_pairs) == 0:
        console.print("[yellow]⚠️  No candidate pairs found.[/yellow]\n")
        return

    # Relaxed parameters summary
    console.print("[bold yellow]⚡ RELAXED PARAMETERS:[/bold yellow]")
    console.print("  • Price tolerance: 15% (UNCHANGED)")
    console.print("  • Area tolerance: 15% (UNCHANGED)")
    console.print("  • Min inliers: 20 (was 25)")
    console.print("  • Min inlier ratio: 0.15 (was 0.20)")
    console.print("  • Max images: 12 per listing (was 6)")
    console.print("  • ORB features: 1000")
    console.print("  • Image downscaling: 800px max dimension")
    console.print("  • Parallel processing: Enabled\n")

    # Matching params
    num_features = 1000
    min_inliers = 20
    min_inlier_ratio = 0.15
    ransac_threshold = 5.0
    max_images = 12

    # Parallel processing
    num_workers = max(1, cpu_count() - 1)  # Leave one core free
    console.print(f"Using {num_workers} parallel workers\n")

    logger.log(f"Parallel workers: {num_workers}")
    logger.log(f"Parameters: features={num_features}, min_inliers={min_inliers}, min_ratio={min_inlier_ratio}, max_images={max_images}")
    logger.log("")

    # Prepare work items
    work_items = [(viva, coelho, viva_dir, coelho_dir, max_images)
                  for viva, coelho in candidate_pairs]

    # Results
    matches = []
    match_count = 0
    pair_times = []

    start_time = time.time()

    # Process with multiprocessing
    console.print(f"[bold cyan]Processing {len(candidate_pairs)} pairs in parallel...[/bold cyan]\n")

    with Pool(processes=num_workers,
              initializer=_init_worker,
              initargs=(num_features, min_inliers, min_inlier_ratio, ransac_threshold)) as pool:

        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            TextColumn("[progress.percentage]{task.percentage:>3.0f}%"),
            TimeElapsedColumn(),
            TimeRemainingColumn(),
            console=console
        ) as progress:

            task = progress.add_task("Comparing filtered pairs...", total=len(work_items))

            # Process results as they come in
            for i, result in enumerate(pool.imap_unordered(_match_pair, work_items)):
                if result is None:
                    progress.update(task, advance=1)
                    continue

                viva, coelho, match_result, elapsed = result
                pair_times.append(elapsed)

                if match_result["is_match"]:
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
                            "best_inliers": match_result["best_inliers"],
                            "inlier_ratio": match_result["inlier_ratio"],
                            "avg_inliers": match_result["avg_inliers"],
                            "image_comparisons": match_result["comparisons"]
                        },
                        "price_diff_pct": abs(viva['price'] - coelho['price']) / max(viva['price'], coelho['price']) * 100,
                        "area_diff_pct": abs(viva['built'] - coelho['built']) / max(viva['built'], coelho['built']) * 100
                    })

                    logger.log_pair(coelho['code'], viva['code'], match_result, elapsed)

                # Log progress
                if (i + 1) % 10 == 0 and pair_times:
                    avg_time = np.mean(pair_times)
                    logger.log_progress(i + 1, len(work_items), match_count, avg_time)

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
    logger.log(f"Speedup vs sequential: ~{num_workers}x")
    logger.log("="*60)

    # Save results
    output_data = {
        "metadata": {
            "approach": "Relaxed price-filtered geometric matching (second pass)",
            "total_possible_pairs": len(viva_listings) * len(coelho_listings),
            "filtered_pairs": len(candidate_pairs),
            "reduction_pct": (1 - len(candidate_pairs) / (len(viva_listings) * len(coelho_listings))) * 100,
            "matches_found": match_count,
            "viva_count": len(viva_listings),
            "coelho_count": len(coelho_listings),
            "elapsed_seconds": elapsed_time,
            "avg_ms_per_pair": (elapsed_time * 1000) / len(candidate_pairs) if len(candidate_pairs) > 0 else 0,
            "parallel_workers": num_workers,
            "filters": {
                "price_tolerance": 0.15,
                "area_tolerance": 0.15,
                "bedroom_diff": 1,
                "suite_diff": 1
            },
            "geometric_params": {
                "num_features": num_features,
                "min_inliers": min_inliers,
                "min_inlier_ratio": min_inlier_ratio,
                "ransac_threshold": ransac_threshold,
                "max_images": max_images,
                "image_max_dim": 800
            }
        },
        "matches": matches
    }

    with open(output_file, 'w') as f:
        json.dump(output_data, f, indent=2)

    # Summary
    console.print(f"\n[bold green]✓ Relaxed geometric matching complete![/bold green]\n")
    console.print(f"Results:")
    console.print(f"  • Filtered to: {len(candidate_pairs)} pairs")
    console.print(f"  • Matches found: {match_count}")
    console.print(f"  • Match rate: {match_count/len(candidate_pairs)*100:.2f}%")
    console.print(f"  • Elapsed time: {elapsed_time/60:.1f} minutes ({elapsed_time:.1f}s)")
    console.print(f"  • Avg time per pair: {(elapsed_time * 1000) / len(candidate_pairs):.1f}ms\n")
    console.print(f"Results saved to: [cyan]{output_file}[/cyan]\n")

    if match_count > 0:
        console.print(f"[bold yellow]Found {match_count} potential matches![/bold yellow]\n")
        console.print("[dim]To generate comparison mosaics, run:[/dim]")
        console.print("[dim]  node scripts/generate-match-mosaics.js geometric_matches_relaxed.json matched_mosaics_relaxed[/dim]\n")


if __name__ == "__main__":
    main()
