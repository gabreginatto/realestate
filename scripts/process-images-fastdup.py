#!/usr/bin/env python3
"""
Run fastdup on listing image folders.

By default this processes all listings for both sites. Optional flags allow
incremental runs limited to a subset of listing codes.
"""
import os
import sys
import fastdup
import json
import argparse
from pathlib import Path
from rich.console import Console
from rich.progress import track

console = Console()

def run_fastdup_on_listing(listing_dir, work_dir):
    """
    Run fastdup on a single listing directory.

    Args:
        listing_dir: Path to listing directory containing images
        work_dir: Path where fastdup outputs will be saved
    """
    listing_path = Path(listing_dir)
    work_path = Path(work_dir)

    # Get all images
    images = list(listing_path.glob("*.jpg")) + list(listing_path.glob("*.jpeg")) + \
             list(listing_path.glob("*.png")) + list(listing_path.glob("*.webp"))

    if not images:
        console.print(f"[yellow]  No images found in {listing_path.name}[/yellow]")
        return False

    if len(images) < 2:
        console.print(f"[yellow]  Only {len(images)} image(s) in {listing_path.name}, skipping fastdup[/yellow]")
        return False

    # Create work directory
    work_path.mkdir(parents=True, exist_ok=True)

    try:
        # Run fastdup
        fd = fastdup.create(work_dir=str(work_path))
        fd.run(input_dir=str(listing_path), overwrite=True)

        console.print(f"[green]  ✓ Fastdup completed for {listing_path.name} ({len(images)} images)[/green]")
        return True

    except Exception as e:
        console.print(f"[red]  Error running fastdup on {listing_path.name}: {e}[/red]")
        return False

def load_only_codes(only_codes_file=None, codes_key=None):
    """Load listing codes from a JSON file (list or object with list field)."""
    if not only_codes_file:
        return None

    with open(only_codes_file, "r", encoding="utf-8") as f:
        data = json.load(f)

    codes = []
    if isinstance(data, list):
        codes = data
    elif isinstance(data, dict):
        if codes_key:
            codes = data.get(codes_key, [])
        elif "codes" in data:
            codes = data.get("codes", [])
        elif "listing_codes" in data:
            codes = data.get("listing_codes", [])
        else:
            raise ValueError(
                f"Could not infer codes list key in {only_codes_file}; "
                "use --codes-key"
            )
    else:
        raise ValueError(f"Unsupported JSON structure in {only_codes_file}")

    if not isinstance(codes, list):
        raise ValueError(f"Codes payload is not a list in {only_codes_file}")

    return {str(code) for code in codes if str(code).strip()}


def process_site(site_name, images_dir, work_root, only_codes=None):
    """
    Process all listings for a site.

    Args:
        site_name: Name of the site (coelhodafonseca or vivaprimeimoveis)
        images_dir: Path to images_processed directory
        work_root: Root directory for fastdup work outputs
    """
    console.print(f"\n[bold cyan]Processing {site_name}...[/bold cyan]\n")

    images_path = Path(images_dir)

    if not images_path.exists():
        console.print(f"[red]Error: {images_dir} does not exist![/red]")
        return

    # Get all listing directories
    listings = sorted([d for d in images_path.iterdir() if d.is_dir()])

    if not listings:
        console.print(f"[yellow]No listings found in {images_dir}[/yellow]")
        return

    if only_codes is not None:
        listings = [d for d in listings if d.name in only_codes]
        console.print(f"Filtered to {len(listings)} listings using only-codes filter")
        if not listings:
            console.print("[yellow]No matching listings to process for this site[/yellow]")
            return

    console.print(f"Found {len(listings)} listings to process\n")

    success_count = 0

    for listing_path in track(listings, description=f"Running fastdup on {site_name}"):
        listing_id = listing_path.name
        work_dir = os.path.join(work_root, site_name, listing_id, "fastdup")

        if run_fastdup_on_listing(str(listing_path), work_dir):
            success_count += 1

    console.print(f"\n[bold green]✓ Fastdup complete for {site_name}![/bold green]")
    console.print(f"Successfully processed: {success_count}/{len(listings)} listings\n")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run fastdup listing pre-processing")
    parser.add_argument(
        "--site",
        choices=["coelhodafonseca", "vivaprimeimoveis", "both"],
        default="both",
        help="Which site to process",
    )
    parser.add_argument(
        "--only-codes-file",
        default="",
        help="Path to JSON file containing listing codes to process",
    )
    parser.add_argument(
        "--codes-key",
        default="",
        help="JSON key when --only-codes-file points to an object payload",
    )
    args = parser.parse_args()

    console.print("\n[bold]Running fastdup on all listings[/bold]")
    console.print("=" * 60)

    try:
        only_codes = load_only_codes(args.only_codes_file or None, args.codes_key or None)
    except Exception as exc:
        console.print(f"[red]Error loading only-codes filter: {exc}[/red]")
        sys.exit(1)

    if args.site in ("coelhodafonseca", "both"):
        process_site(
            "coelhodafonseca",
            "data/coelhodafonseca/images",
            "work_fastdup",
            only_codes=only_codes
        )

    if args.site in ("vivaprimeimoveis", "both"):
        process_site(
            "vivaprimeimoveis",
            "data/vivaprimeimoveis/images",
            "work_fastdup",
            only_codes=only_codes
        )

    console.print("=" * 60)
    console.print("[bold green]✅ All fastdup processing complete![/bold green]\n")
