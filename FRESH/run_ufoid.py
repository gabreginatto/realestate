#!/usr/bin/env python3
"""
Wrapper script to run UFOID for image deduplication.
This script:
1. Sets up the folder structure (raw/ folders from cache images)
2. Runs UFOID CLI with the configured settings
3. Copies cleaned images back to ufoid_clean/ folders
"""

import subprocess
import shutil
from pathlib import Path
from rich.console import Console
from rich.progress import track
import typer

console = Console()
app = typer.Typer()

def setup_raw_folders(cache_dir: str):
    """
    Move all images in cache/{listing_id}/ to cache/{listing_id}/raw/
    """
    cache_path = Path(cache_dir)

    if not cache_path.exists():
        console.print(f"[red]Directory {cache_dir} does not exist![/red]")
        return 0

    listing_dirs = [d for d in cache_path.iterdir() if d.is_dir() and not d.name.startswith('.')]

    moved_count = 0
    for listing_dir in listing_dirs:
        raw_dir = listing_dir / "raw"
        raw_dir.mkdir(exist_ok=True)

        # Move all .jpg files to raw/
        for img_file in listing_dir.glob("*.jpg"):
            dest = raw_dir / img_file.name
            if not dest.exists():
                shutil.move(str(img_file), str(dest))
                moved_count += 1

    return moved_count

def copy_cleaned_images_back():
    """
    Copy deduplicated images from ufoid_output/clean back to ufoid_clean/ folders
    """
    clean_output = Path("ufoid_output/clean")

    if not clean_output.exists():
        console.print(f"[yellow]No cleaned output found at {clean_output}[/yellow]")
        return 0

    copied_count = 0

    # Traverse the mirror tree created by UFOID
    for site_dir in clean_output.iterdir():
        if not site_dir.is_dir():
            continue

        cache_clean = site_dir / "cache"
        if not cache_clean.exists():
            continue

        # For each listing in the cleaned output
        for listing_dir in cache_clean.iterdir():
            if not listing_dir.is_dir():
                continue

            raw_clean = listing_dir / "raw"
            if not raw_clean.exists():
                continue

            # Destination: data/{site}/cache/{listing}/ufoid_clean/
            original_listing = Path("data") / site_dir.name / "cache" / listing_dir.name
            ufoid_clean_dir = original_listing / "ufoid_clean"
            ufoid_clean_dir.mkdir(exist_ok=True)

            # Copy cleaned images
            for img in raw_clean.glob("*.jpg"):
                dest = ufoid_clean_dir / img.name
                if not dest.exists():
                    shutil.copy2(img, dest)
                    copied_count += 1

    return copied_count

@app.command()
def run(config: str = typer.Option("ufoid_cfg/config.yaml", help="Path to UFOID config file")):
    """
    Run the complete UFOID deduplication pipeline.
    """
    console.print("\n[bold cyan]Step 1: Setting up raw/ folders[/bold cyan]")

    moved1 = setup_raw_folders("data/coelhodafonseca/cache")
    moved2 = setup_raw_folders("data/vivaprimeimoveis/cache")

    console.print(f"[green]✓ Moved {moved1 + moved2} images to raw/ folders[/green]")

    console.print("\n[bold cyan]Step 2: Running UFOID deduplication[/bold cyan]")
    console.print(f"Config: {config}")

    try:
        # Run UFOID CLI
        result = subprocess.run(
            ["python", "-m", "ufoid", "--config", config],
            check=True,
            capture_output=True,
            text=True
        )
        console.print("[green]✓ UFOID completed successfully[/green]")

        if result.stdout:
            console.print("\n[dim]" + result.stdout + "[/dim]")

    except subprocess.CalledProcessError as e:
        console.print(f"[red]Error running UFOID: {e}[/red]")
        if e.stderr:
            console.print(f"[red]{e.stderr}[/red]")
        raise typer.Exit(1)

    console.print("\n[bold cyan]Step 3: Copying cleaned images to ufoid_clean/ folders[/bold cyan]")

    copied = copy_cleaned_images_back()

    console.print(f"[green]✓ Copied {copied} deduplicated images to ufoid_clean/ folders[/green]")

    console.print("\n[bold green]Pipeline complete![/bold green]")
    console.print(f"Check ufoid_output/duplicates.csv for duplicate details")

if __name__ == "__main__":
    app()
