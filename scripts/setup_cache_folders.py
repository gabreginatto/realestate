#!/usr/bin/env python3
"""
Set up raw/, ufoid_clean/, and fastdup_keep/ folders in cache directories.
Moves existing images to raw/ subfolder.
"""

import os
import shutil
from pathlib import Path
from rich.console import Console
from rich.progress import track

console = Console()

def setup_listing_folders(cache_dir: str):
    """
    Set up folder structure for each listing in cache directory.

    Args:
        cache_dir: Path to cache directory (e.g., data/coelhodafonseca/cache)
    """
    cache_path = Path(cache_dir)

    if not cache_path.exists():
        console.print(f"[red]Directory {cache_dir} does not exist![/red]")
        return

    # Get all listing directories
    listing_dirs = [d for d in cache_path.iterdir() if d.is_dir() and not d.name.startswith('.')]

    console.print(f"\n[bold cyan]Processing {len(listing_dirs)} listings in {cache_dir}[/bold cyan]")

    for listing_dir in track(listing_dirs, description="Setting up folders"):
        raw_dir = listing_dir / "raw"
        ufoid_clean_dir = listing_dir / "ufoid_clean"
        fastdup_keep_dir = listing_dir / "fastdup_keep"

        # Create directories
        raw_dir.mkdir(exist_ok=True)
        ufoid_clean_dir.mkdir(exist_ok=True)
        fastdup_keep_dir.mkdir(exist_ok=True)

        # Move all .jpg files to raw/ folder (skip if already in subfolder)
        image_files = list(listing_dir.glob("*.jpg"))

        if image_files:
            for img_file in image_files:
                dest = raw_dir / img_file.name
                if not dest.exists():
                    shutil.move(str(img_file), str(dest))

    console.print(f"[green]✓ Setup complete for {len(listing_dirs)} listings[/green]")

if __name__ == "__main__":
    setup_listing_folders("data/coelhodafonseca/cache")
    setup_listing_folders("data/vivaprimeimoveis/cache")
