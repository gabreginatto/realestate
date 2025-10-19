#!/usr/bin/env python3
"""
Reorganize UFOID flat output back into per-listing folder structure.

UFOID outputs to a flat directory, but we need per-listing folders for fastdup.
This script maps each cleaned image back to its original listing.
"""
import os
import shutil
from pathlib import Path
from rich.console import Console
from rich.progress import track
import typer

app = typer.Typer()
console = Console()


def reorganize_site(site_name, cache_root="data", ufoid_root="ufoid_output", out_root="data_clean"):
    """
    Reorganize UFOID output for a single site back into per-listing folders.

    Args:
        site_name: "coelhodafonseca" or "vivaprimeimoveis"
        cache_root: Original cache directory root
        ufoid_root: UFOID output directory root
        out_root: Output directory for reorganized structure
    """
    console.print(f"\n[bold cyan]Reorganizing {site_name}...[/bold cyan]")

    # Paths
    cache_dir = Path(cache_root) / site_name / "cache"
    # Map site name to UFOID output folder
    site_to_ufoid = {
        "coelhodafonseca": "coelho_clean",
        "vivaprimeimoveis": "viva_clean"
    }
    ufoid_clean = Path(ufoid_root) / site_to_ufoid[site_name]
    out_dir = Path(out_root) / site_name

    if not cache_dir.exists():
        console.print(f"[red]Error: {cache_dir} does not exist![/red]")
        return 0

    if not ufoid_clean.exists():
        console.print(f"[red]Error: {ufoid_clean} does not exist![/red]")
        return 0

    # Build a map: filename -> original listing_id
    console.print("Building filename -> listing map from original cache...")
    filename_to_listing = {}

    for listing_dir in cache_dir.iterdir():
        if not listing_dir.is_dir():
            continue

        listing_id = listing_dir.name

        for img_file in listing_dir.glob("*.jpg"):
            filename = img_file.name
            filename_to_listing[filename] = listing_id

        for img_file in listing_dir.glob("*.jpeg"):
            filename = img_file.name
            filename_to_listing[filename] = listing_id

        for img_file in listing_dir.glob("*.png"):
            filename = img_file.name
            filename_to_listing[filename] = listing_id

    console.print(f"Found {len(filename_to_listing)} original images")

    # Get all cleaned images from UFOID output
    cleaned_files = list(ufoid_clean.glob("*.jpg")) + list(ufoid_clean.glob("*.jpeg")) + list(ufoid_clean.glob("*.png"))
    console.print(f"Found {len(cleaned_files)} cleaned images from UFOID")

    # Copy cleaned images to their respective listing folders
    copied = 0
    skipped = 0

    for cleaned_file in track(cleaned_files, description="Reorganizing images"):
        filename = cleaned_file.name

        if filename not in filename_to_listing:
            console.print(f"[yellow]Warning: {filename} not found in original cache, skipping[/yellow]")
            skipped += 1
            continue

        listing_id = filename_to_listing[filename]

        # Create output directory for this listing
        listing_out_dir = out_dir / listing_id
        listing_out_dir.mkdir(parents=True, exist_ok=True)

        # Copy file
        dest = listing_out_dir / filename
        shutil.copy2(cleaned_file, dest)
        copied += 1

    console.print(f"\n[green]✓ Reorganized {copied} images into per-listing folders[/green]")
    if skipped > 0:
        console.print(f"[yellow]  Skipped {skipped} images (not found in original cache)[/yellow]")
    console.print(f"[cyan]  Output: {out_dir}/[/cyan]\n")

    return copied


@app.command()
def run(
    cache_root: str = typer.Option("data", help="Original cache root directory"),
    ufoid_root: str = typer.Option("ufoid_output", help="UFOID output directory"),
    out_root: str = typer.Option("data_clean", help="Output directory for reorganized structure"),
):
    """
    Reorganize UFOID flat output back into per-listing folder structure.

    Processes both sites: coelhodafonseca and vivaprimeimoveis
    """
    console.print("\n[bold]Reorganizing UFOID Output into Per-Listing Folders[/bold]")
    console.print("=" * 60)

    sites = ["coelhodafonseca", "vivaprimeimoveis"]
    total_copied = 0

    for site in sites:
        copied = reorganize_site(site, cache_root, ufoid_root, out_root)
        total_copied += copied

    console.print("=" * 60)
    console.print(f"[bold green]Complete! Reorganized {total_copied} total images[/bold green]")
    console.print(f"\nNext step: Run fastdup on {out_root}/{{site}}/{{listing_id}}/\n")


if __name__ == "__main__":
    app()
