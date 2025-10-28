#!/usr/bin/env python3
"""
Run full geometric matching: Compare all Viva listings against all Coelho listings.

This script:
1. Loads all listings from selected_exteriors/
2. Compares each Coelho listing against all Viva listings
3. Uses ORB+RANSAC geometric verification (100-200ms per pair)
4. Saves matches to JSON file

Estimated time: ~14 minutes for 5,589 pairs
"""

import os
import json
import sys
from pathlib import Path
from typing import List, Dict
import cv2
import numpy as np
from rich.console import Console
from rich.progress import Progress, SpinnerColumn, BarColumn, TextColumn, TimeElapsedColumn, TimeRemainingColumn
import time

console = Console()

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


def get_listings(site_dir: str) -> List[str]:
    """Get all listing IDs from a site directory."""
    listings = []
    for item in os.listdir(site_dir):
        full_path = os.path.join(site_dir, item)
        if os.path.isdir(full_path) and not item.startswith('.'):
            listings.append(item)
    return sorted(listings)


def main():
    console.print("\n[bold cyan]🔍 Full Geometric Matching: Viva ↔ Coelho[/bold cyan]\n")

    # Paths
    coelho_dir = "selected_exteriors/coelhodafonseca"
    viva_dir = "selected_exteriors/vivaprimeimoveis"
    output_file = "geometric_matches.json"

    # Get all listings
    coelho_listings = get_listings(coelho_dir)
    viva_listings = get_listings(viva_dir)

    total_pairs = len(coelho_listings) * len(viva_listings)

    console.print(f"Coelho listings: {len(coelho_listings)}")
    console.print(f"Viva listings: {len(viva_listings)}")
    console.print(f"Total pairs to compare: {total_pairs:,}\n")

    console.print(f"Parameters:")
    console.print(f"  • ORB features: 2000")
    console.print(f"  • Min inliers: 30")
    console.print(f"  • RANSAC threshold: 5.0 pixels")
    console.print(f"  • Max images per listing: 12\n")

    # Initialize matcher
    matcher = GeometricMatcher(num_features=2000, min_inliers=30, ransac_threshold=5.0)

    # Results
    matches = []
    comparison_count = 0
    match_count = 0

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
            f"Comparing listings...",
            total=total_pairs
        )

        # Compare each Coelho listing against all Viva listings
        for coelho_id in coelho_listings:
            coelho_path = os.path.join(coelho_dir, coelho_id)

            for viva_id in viva_listings:
                viva_path = os.path.join(viva_dir, viva_id)

                # Match listings
                result = matcher.match_listings(coelho_path, viva_path, max_images=12)

                comparison_count += 1

                # Record if match found
                if result["is_match"]:
                    match_count += 1
                    matches.append({
                        "coelho_id": coelho_id,
                        "viva_id": viva_id,
                        "best_inliers": result["best_inliers"],
                        "avg_inliers": result["avg_inliers"],
                        "image_comparisons": result["comparisons"]
                    })

                progress.update(task, advance=1)

    elapsed_time = time.time() - start_time

    # Save results
    output_data = {
        "metadata": {
            "total_pairs": total_pairs,
            "matches_found": match_count,
            "coelho_count": len(coelho_listings),
            "viva_count": len(viva_listings),
            "elapsed_seconds": elapsed_time,
            "avg_ms_per_pair": (elapsed_time * 1000) / total_pairs,
            "parameters": {
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
    console.print(f"\n[bold green]✓ Geometric matching complete![/bold green]\n")
    console.print(f"Results:")
    console.print(f"  • Total pairs compared: {total_pairs:,}")
    console.print(f"  • Matches found: {match_count}")
    console.print(f"  • Match rate: {match_count/total_pairs*100:.2f}%")
    console.print(f"  • Elapsed time: {elapsed_time/60:.1f} minutes ({elapsed_time:.1f}s)")
    console.print(f"  • Avg time per pair: {(elapsed_time * 1000) / total_pairs:.1f}ms\n")
    console.print(f"Results saved to: [cyan]{output_file}[/cyan]\n")

    if match_count > 0:
        console.print(f"[bold yellow]Found {match_count} potential matches![/bold yellow]")
        console.print(f"Review the matches in {output_file}\n")


if __name__ == "__main__":
    main()
