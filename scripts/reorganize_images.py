#!/usr/bin/env python3
"""
Reorganize images from flat structure to per-listing folder structure.
Creates raw/, ufoid_clean/, and fastdup_keep/ subdirectories for each listing.
"""

import os
import shutil
from pathlib import Path
from collections import defaultdict

def reorganize_images(base_dir: str):
    """
    Reorganize images from flat structure to per-listing structure.

    Args:
        base_dir: Path to the images directory (e.g., data/coelhodafonseca/images)
    """
    images_dir = Path(base_dir)

    if not images_dir.exists():
        print(f"Directory {images_dir} does not exist!")
        return

    # Group images by listing ID
    listings = defaultdict(list)

    # Find all image files
    for img_file in images_dir.glob("*.jpg"):
        # Parse filename: {listing_id}_{number}.jpg
        filename = img_file.name
        if '_' in filename:
            listing_id = filename.split('_')[0]
            listings[listing_id].append(img_file)

    print(f"Found {len(listings)} unique listings with {sum(len(v) for v in listings.values())} total images")

    # Create folder structure for each listing
    for listing_id, image_files in listings.items():
        listing_dir = images_dir / listing_id
        raw_dir = listing_dir / "raw"
        ufoid_clean_dir = listing_dir / "ufoid_clean"
        fastdup_keep_dir = listing_dir / "fastdup_keep"

        # Create directories
        raw_dir.mkdir(parents=True, exist_ok=True)
        ufoid_clean_dir.mkdir(parents=True, exist_ok=True)
        fastdup_keep_dir.mkdir(parents=True, exist_ok=True)

        # Move images to raw/ folder
        for img_file in image_files:
            dest = raw_dir / img_file.name
            if not dest.exists():
                shutil.move(str(img_file), str(dest))
                print(f"  Moved {img_file.name} -> {listing_id}/raw/")

    print("\nReorganization complete!")
    print(f"Created {len(listings)} listing directories with raw/, ufoid_clean/, and fastdup_keep/ subfolders")

if __name__ == "__main__":
    # Process both Coelho da Fonseca and Viva Prime Imóveis
    reorganize_images("data/coelhodafonseca/images")
    reorganize_images("data/vivaprimeimoveis/images")
