#!/usr/bin/env python3
"""
Run fastdup to filter high-quality, distinct exterior images from ufoid_clean/ to fastdup_keep/.
Target: Keep 6-12 best exterior shots per listing.
"""

import os
import shutil
from pathlib import Path
import fastdup
from rich.console import Console
from rich.progress import track
import typer
import tempfile

console = Console()
app = typer.Typer()

def run_fastdup_on_listing(listing_dir: Path, target_count: int = 12):
    """
    Run fastdup on a listing to select best images.

    Args:
        listing_dir: Path to listing directory
        target_count: Target number of images to keep (6-12)

    Returns:
        Number of images kept
    """
    ufoid_clean_dir = listing_dir / "ufoid_clean"
    fastdup_keep_dir = listing_dir / "fastdup_keep"

    if not ufoid_clean_dir.exists():
        return 0

    images = list(ufoid_clean_dir.glob("*.jpg"))

    if not images:
        return 0

    # If we have fewer than target, keep all
    if len(images) <= target_count:
        for img in images:
            dest = fastdup_keep_dir / img.name
            if not dest.exists():
                shutil.copy2(img, dest)
        return len(images)

    # Create temporary work directory for fastdup
    with tempfile.TemporaryDirectory() as work_dir:
        try:
            # Run fastdup
            fd = fastdup.create(work_dir=work_dir)
            fd.run(input_dir=str(ufoid_clean_dir), overwrite=True)

            # Get similarity clusters and outliers
            outliers_df = fd.outliers()

            if outliers_df is not None and not outliers_df.empty:
                # Sort by outlier score (higher = more unique/better quality)
                outliers_df = outliers_df.sort_values('distance', ascending=False)

                # Take top N images
                top_images = outliers_df.head(target_count)

                for _, row in top_images.iterrows():
                    img_path = Path(row['filename'])
                    if img_path.exists():
                        dest = fastdup_keep_dir / img_path.name
                        if not dest.exists():
                            shutil.copy2(img_path, dest)

                return len(top_images)
            else:
                # Fallback: just copy first N images if fastdup fails
                for img in images[:target_count]:
                    dest = fastdup_keep_dir / img.name
                    if not dest.exists():
                        shutil.copy2(img, dest)
                return min(len(images), target_count)

        except Exception as e:
            console.print(f"[yellow]Warning: fastdup failed for {listing_dir.name}: {e}[/yellow]")
            console.print(f"[yellow]Falling back to keeping first {target_count} images[/yellow]")

            # Fallback: copy first N images
            for img in images[:target_count]:
                dest = fastdup_keep_dir / img.name
                if not dest.exists():
                    shutil.copy2(img, dest)
            return min(len(images), target_count)

@app.command()
def process_listing(
    listing_path: str = typer.Argument(..., help="Path to listing directory"),
    target: int = typer.Option(12, help="Target number of images to keep (6-12)")
):
    """Process a single listing directory."""
    listing_dir = Path(listing_path)

    if not listing_dir.exists():
        console.print(f"[red]Error: {listing_path} does not exist[/red]")
        raise typer.Exit(1)

    if target < 6 or target > 12:
        console.print(f"[yellow]Warning: target should be between 6 and 12, got {target}[/yellow]")

    console.print(f"\n[bold cyan]Processing {listing_dir.name}[/bold cyan]")

    kept = run_fastdup_on_listing(listing_dir, target)

    console.print(f"[green]✓ Kept {kept} best images[/green]")

@app.command()
def process_all(
    cache_dir: str = typer.Argument(..., help="Path to cache directory"),
    target: int = typer.Option(12, help="Target number of images to keep (6-12)")
):
    """Process all listings in a cache directory."""
    cache_path = Path(cache_dir)

    if not cache_path.exists():
        console.print(f"[red]Error: {cache_dir} does not exist[/red]")
        raise typer.Exit(1)

    if target < 6 or target > 12:
        console.print(f"[yellow]Warning: target should be between 6 and 12, got {target}[/yellow]")

    listing_dirs = [d for d in cache_path.iterdir() if d.is_dir() and not d.name.startswith('.')]

    console.print(f"\n[bold cyan]Processing {len(listing_dirs)} listings with fastdup[/bold cyan]")
    console.print(f"Target images per listing: {target}\n")

    total_kept = 0

    for listing_dir in track(listing_dirs, description="Filtering with fastdup"):
        kept = run_fastdup_on_listing(listing_dir, target)
        total_kept += kept

    console.print(f"\n[bold green]✓ fastdup complete![/bold green]")
    console.print(f"Total images kept: {total_kept}")
    console.print(f"Average per listing: {total_kept / len(listing_dirs):.1f}")

if __name__ == "__main__":
    app()
