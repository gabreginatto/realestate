#!/usr/bin/env python3
"""
Geometric Property Matcher using Local Feature Matching + RANSAC

This script matches properties based on geometric identity, not perceptual similarity.
It uses local feature detection (ORB) and geometric verification (RANSAC) to find
the same physical property photographed from different angles.

This is the CORRECT approach for property matching because:
- Global embeddings find "similar" not "identical"
- Local features find specific geometric structures (window corners, pool edges, etc.)
- RANSAC verifies geometric consistency across matched features
- Works across different viewpoints, lighting, and seasons

Approach:
1. Detect keypoints (ORB) in both image sets
2. Match descriptors (Brute-force or FLANN)
3. Verify with RANSAC homography
4. Count inliers (high inliers = same property)
"""

import cv2
import numpy as np
from pathlib import Path
from typing import List, Tuple, Dict, Optional
import json
from dataclasses import dataclass, asdict
from rich.console import Console
from rich.progress import track
import typer

console = Console()
app = typer.Typer()


@dataclass
class MatchResult:
    """Result of geometric matching between two images"""
    img1_path: str
    img2_path: str
    num_keypoints_1: int
    num_keypoints_2: int
    num_putative_matches: int
    num_inliers: int
    inlier_ratio: float
    is_match: bool
    confidence: float


class GeometricMatcher:
    """
    Geometric property matcher using ORB + RANSAC

    This matches properties based on geometric consistency of local features,
    not global perceptual similarity.
    """

    def __init__(
        self,
        num_features: int = 2000,
        match_threshold: int = 50,
        ransac_reproj_threshold: float = 5.0,
        min_inliers: int = 30
    ):
        """
        Initialize the geometric matcher.

        Args:
            num_features: Number of ORB features to detect per image
            match_threshold: Hamming distance threshold for descriptor matching
            ransac_reproj_threshold: RANSAC reprojection error threshold (pixels)
            min_inliers: Minimum inliers to consider a match
        """
        # ORB detector (fast, free, rotation-invariant)
        self.orb = cv2.ORB_create(
            nfeatures=num_features,
            scaleFactor=1.2,
            nlevels=8,
            edgeThreshold=31,
            firstLevel=0,
            WTA_K=2,
            scoreType=cv2.ORB_HARRIS_SCORE,
            patchSize=31,
            fastThreshold=20
        )

        # Brute-force matcher with Hamming distance (for binary descriptors like ORB)
        self.matcher = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=False)

        self.match_threshold = match_threshold
        self.ransac_threshold = ransac_reproj_threshold
        self.min_inliers = min_inliers

    def detect_and_describe(self, image_path: str) -> Tuple[Optional[List], Optional[np.ndarray]]:
        """
        Detect keypoints and compute descriptors for an image.

        Args:
            image_path: Path to the image

        Returns:
            (keypoints, descriptors) or (None, None) if detection fails
        """
        try:
            # Read image in grayscale (features work better on grayscale)
            img = cv2.imread(image_path, cv2.IMREAD_GRAYSCALE)
            if img is None:
                console.print(f"[yellow]Warning: Could not read {image_path}[/yellow]")
                return None, None

            # Detect keypoints and compute descriptors
            keypoints, descriptors = self.orb.detectAndCompute(img, None)

            return keypoints, descriptors

        except Exception as e:
            console.print(f"[red]Error processing {image_path}: {e}[/red]")
            return None, None

    def match_features(
        self,
        desc1: np.ndarray,
        desc2: np.ndarray
    ) -> List[cv2.DMatch]:
        """
        Match features between two descriptor sets.

        Args:
            desc1: Descriptors from image 1
            desc2: Descriptors from image 2

        Returns:
            List of good matches after ratio test
        """
        if desc1 is None or desc2 is None or len(desc1) < 2 or len(desc2) < 2:
            return []

        # Find 2 best matches for each descriptor (for ratio test)
        matches = self.matcher.knnMatch(desc1, desc2, k=2)

        # Apply Lowe's ratio test to filter out ambiguous matches
        good_matches = []
        for match_pair in matches:
            if len(match_pair) == 2:
                m, n = match_pair
                # Keep match only if it's significantly better than the second-best
                if m.distance < 0.75 * n.distance and m.distance < self.match_threshold:
                    good_matches.append(m)

        return good_matches

    def verify_with_ransac(
        self,
        kp1: List,
        kp2: List,
        matches: List[cv2.DMatch]
    ) -> Tuple[int, float]:
        """
        Verify matches using RANSAC homography estimation.

        This is the KEY step that distinguishes "same property" from "similar property".
        RANSAC finds a geometric transformation that is consistent across matched points.

        Args:
            kp1: Keypoints from image 1
            kp2: Keypoints from image 2
            matches: List of putative matches

        Returns:
            (num_inliers, inlier_ratio)
        """
        if len(matches) < 4:
            # Need at least 4 points to compute homography
            return 0, 0.0

        # Extract matched point coordinates
        pts1 = np.float32([kp1[m.queryIdx].pt for m in matches]).reshape(-1, 1, 2)
        pts2 = np.float32([kp2[m.trainIdx].pt for m in matches]).reshape(-1, 1, 2)

        # Find homography using RANSAC
        # This finds a geometric transformation that maps points from img1 to img2
        # Only geometrically consistent matches will be inliers
        H, mask = cv2.findHomography(
            pts1,
            pts2,
            cv2.RANSAC,
            self.ransac_threshold
        )

        if mask is None:
            return 0, 0.0

        # Count inliers
        num_inliers = int(mask.sum())
        inlier_ratio = num_inliers / len(matches) if len(matches) > 0 else 0.0

        return num_inliers, inlier_ratio

    def match_image_pair(
        self,
        img1_path: str,
        img2_path: str
    ) -> MatchResult:
        """
        Match a pair of images using geometric verification.

        Args:
            img1_path: Path to first image
            img2_path: Path to second image

        Returns:
            MatchResult containing matching statistics and decision
        """
        # Step 1: Detect and describe
        kp1, desc1 = self.detect_and_describe(img1_path)
        kp2, desc2 = self.detect_and_describe(img2_path)

        num_kp1 = len(kp1) if kp1 is not None else 0
        num_kp2 = len(kp2) if kp2 is not None else 0

        if desc1 is None or desc2 is None:
            return MatchResult(
                img1_path=img1_path,
                img2_path=img2_path,
                num_keypoints_1=num_kp1,
                num_keypoints_2=num_kp2,
                num_putative_matches=0,
                num_inliers=0,
                inlier_ratio=0.0,
                is_match=False,
                confidence=0.0
            )

        # Step 2: Match features
        matches = self.match_features(desc1, desc2)
        num_matches = len(matches)

        if num_matches < 4:
            return MatchResult(
                img1_path=img1_path,
                img2_path=img2_path,
                num_keypoints_1=num_kp1,
                num_keypoints_2=num_kp2,
                num_putative_matches=num_matches,
                num_inliers=0,
                inlier_ratio=0.0,
                is_match=False,
                confidence=0.0
            )

        # Step 3: Verify with RANSAC (THE KEY STEP!)
        num_inliers, inlier_ratio = self.verify_with_ransac(kp1, kp2, matches)

        # Decision: High inliers = same property
        is_match = num_inliers >= self.min_inliers

        # Confidence based on number of inliers and ratio
        confidence = min(1.0, (num_inliers / self.min_inliers) * inlier_ratio)

        return MatchResult(
            img1_path=img1_path,
            img2_path=img2_path,
            num_keypoints_1=num_kp1,
            num_keypoints_2=num_kp2,
            num_putative_matches=num_matches,
            num_inliers=num_inliers,
            inlier_ratio=inlier_ratio,
            is_match=is_match,
            confidence=confidence
        )

    def match_listing_pair(
        self,
        images1: List[str],
        images2: List[str],
        max_images_per_listing: int = 10
    ) -> Dict:
        """
        Match two listings by comparing all image pairs.

        This is the CORE of the property matching system.
        We compare every image from listing 1 against every image from listing 2.

        Args:
            images1: List of image paths for listing 1
            images2: List of image paths for listing 2
            max_images_per_listing: Max images to use per listing (for speed)

        Returns:
            Dictionary with match results and statistics
        """
        # Limit images for performance
        imgs1 = images1[:max_images_per_listing]
        imgs2 = images2[:max_images_per_listing]

        console.print(f"  Comparing {len(imgs1)} × {len(imgs2)} = {len(imgs1) * len(imgs2)} image pairs...")

        all_results = []
        best_inliers = 0
        best_result = None
        total_inliers = 0

        # Compare every image from listing1 vs every image from listing2
        for img1 in imgs1:
            for img2 in imgs2:
                result = self.match_image_pair(img1, img2)
                all_results.append(result)

                total_inliers += result.num_inliers

                if result.num_inliers > best_inliers:
                    best_inliers = result.num_inliers
                    best_result = result

        # Decision logic:
        # - If ANY pair has strong inliers → MATCH
        # - If best pair has weak inliers → NO MATCH
        is_match = best_inliers >= self.min_inliers

        # Calculate aggregate statistics
        avg_inliers = total_inliers / len(all_results) if all_results else 0

        return {
            "is_match": is_match,
            "best_inliers": best_inliers,
            "avg_inliers": avg_inliers,
            "total_comparisons": len(all_results),
            "best_match": asdict(best_result) if best_result else None,
            "all_results": [asdict(r) for r in all_results]
        }


@app.command()
def test_pair(
    img1: str = typer.Argument(..., help="Path to first image"),
    img2: str = typer.Argument(..., help="Path to second image"),
    min_inliers: int = typer.Option(30, help="Minimum inliers for match")
):
    """Test matching on a single image pair."""
    console.print("\n[bold cyan]Geometric Image Matching Test[/bold cyan]\n")

    matcher = GeometricMatcher(min_inliers=min_inliers)
    result = matcher.match_image_pair(img1, img2)

    console.print(f"Image 1: {img1}")
    console.print(f"  Keypoints: {result.num_keypoints_1}")
    console.print(f"\nImage 2: {img2}")
    console.print(f"  Keypoints: {result.num_keypoints_2}")
    console.print(f"\nMatching Results:")
    console.print(f"  Putative matches: {result.num_putative_matches}")
    console.print(f"  RANSAC inliers: {result.num_inliers}")
    console.print(f"  Inlier ratio: {result.inlier_ratio:.2%}")
    console.print(f"  Confidence: {result.confidence:.2%}")
    console.print(f"\n{'✅ MATCH' if result.is_match else '❌ NO MATCH'}")
    console.print(f"  (Threshold: {min_inliers} inliers)\n")


@app.command()
def match_listings(
    listing1_dir: str = typer.Argument(..., help="Directory with images for listing 1"),
    listing2_dir: str = typer.Argument(..., help="Directory with images for listing 2"),
    min_inliers: int = typer.Option(30, help="Minimum inliers for match"),
    max_images: int = typer.Option(10, help="Max images per listing")
):
    """Match two listings using geometric verification."""
    console.print("\n[bold cyan]Geometric Listing Matching[/bold cyan]\n")

    # Get image files
    imgs1 = sorted([str(p) for p in Path(listing1_dir).glob("*.jpg")])
    imgs2 = sorted([str(p) for p in Path(listing2_dir).glob("*.jpg")])

    if not imgs1:
        console.print(f"[red]No images found in {listing1_dir}[/red]")
        return
    if not imgs2:
        console.print(f"[red]No images found in {listing2_dir}[/red]")
        return

    console.print(f"Listing 1: {len(imgs1)} images")
    console.print(f"Listing 2: {len(imgs2)} images\n")

    matcher = GeometricMatcher(min_inliers=min_inliers)
    result = matcher.match_listing_pair(imgs1, imgs2, max_images)

    console.print(f"\n[bold]Results:[/bold]")
    console.print(f"  Total comparisons: {result['total_comparisons']}")
    console.print(f"  Best inliers: {result['best_inliers']}")
    console.print(f"  Average inliers: {result['avg_inliers']:.1f}")
    console.print(f"\n{'✅ MATCH' if result['is_match'] else '❌ NO MATCH'}")
    console.print(f"  (Threshold: {min_inliers} inliers)\n")

    if result['best_match']:
        best = result['best_match']
        console.print(f"[bold]Best matching pair:[/bold]")
        console.print(f"  {Path(best['img1_path']).name}")
        console.print(f"  {Path(best['img2_path']).name}")
        console.print(f"  Inliers: {best['num_inliers']}")


if __name__ == "__main__":
    app()
