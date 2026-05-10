#!/usr/bin/env python3
"""
CLIP-based image selector for DINOv2 property matching.

Calls the CLIP /classify endpoint on the dino-server to classify each image
into: pool / facade / garden / interior — then selects a pool-first mix.

  Pool shots    (up to --max-pool,   default 4): "swimming pool"
  Facade shots  (up to --max-facade, default 2): "house exterior facade"
  Garden shots  (up to --max-garden, default 2): "garden with plants and trees"
  Interiors: discarded

This produces better DINOv2 embeddings than the HSV-only selector because:
  - Pool shots are the strongest fingerprint for luxury properties (agents
    always show the pool even when they hide the facade)
  - CLIP understands scene semantics rather than relying on color heuristics

Works with two image sources (--source-type):
  selected      Use existing selected_exteriors/{site}/{code}/ (fast, no re-scrape)
  cache         Use full image cache data/{site}/cache/{code}/ (after full re-scrape)
  compound-images
                Use compound-local images data/{compound}/{site}/images/{code}/

The dino-server must be running (--dino-url, default http://localhost:8000).

Output: selected_for_matching/{site}/{code}/   (read by dino-auto-matcher.py)

Usage:
    # Start server first:
    cd dino-server && uvicorn main:app --port 8000 --workers 1

    # From existing selected_exteriors (fast path):
    python scripts/dino-select-exteriors.py

    # From full image cache after re-scrape, constrained to official galleries:
    python scripts/dino-select-exteriors.py --source-type cache --data-root data/ \
      --official-listings data/alphaville-1/listings/vivaprimeimoveis_listings.json \
      --official-listings data/alphaville-1/listings/coelhodafonseca_listings.json

    # Dry-run (prints classification without writing files):
    python scripts/dino-select-exteriors.py --dry-run
"""

import argparse
import json
import shutil
import sys
from pathlib import Path

try:
    import requests
except ImportError:
    print("ERROR: pip install requests")
    sys.exit(1)

SITES = ["vivaprimeimoveis", "coelhodafonseca"]
IMG_EXTS = {".jpg", ".jpeg", ".png", ".webp"}

# CLIP label → internal category
LABEL_TO_CATEGORY = {
    "swimming pool":               "pool",
    "house exterior facade":       "facade",
    "garden with plants and trees": "garden",
    "interior room of a house":    "interior",
}

DEFAULT_DINO_URL = "http://localhost:8000"


# ---------------------------------------------------------------------------
# CLIP classification via server
# ---------------------------------------------------------------------------

def classify_image(img_path: Path, dino_url: str) -> str:
    """
    Calls POST /classify on the dino-server.
    Returns the category string: pool / facade / garden / interior.
    Falls back to "interior" on any error (safest — will be deprioritised).
    """
    endpoint = dino_url.rstrip("/") + "/classify"
    try:
        with open(img_path, "rb") as f:
            resp = requests.post(endpoint, files={"image": f}, timeout=30)
        resp.raise_for_status()
        label = resp.json()["label"]
        return LABEL_TO_CATEGORY.get(label, "interior")
    except Exception as exc:
        print(f"    [WARN] classify failed for {img_path.name}: {exc}")
        return "interior"


# ---------------------------------------------------------------------------
# Classification and selection
# ---------------------------------------------------------------------------

def classify_images(img_paths: list, dino_url: str, verbose: bool) -> list:
    records = []
    for p in img_paths:
        cat = classify_image(p, dino_url)
        if verbose:
            print(f"      {p.name} → {cat}")
        records.append({"path": p, "category": cat})
    return records


def select_pool_first(records: list, max_pool: int,
                      max_facade: int, max_garden: int) -> list:
    pools   = [r["path"] for r in records if r["category"] == "pool"]
    facades = [r["path"] for r in records if r["category"] == "facade"]
    gardens = [r["path"] for r in records if r["category"] == "garden"]

    chosen = pools[:max_pool] + facades[:max_facade] + gardens[:max_garden]

    # Fallback: if completely empty, take first 4 images regardless of category
    if not chosen:
        chosen = [r["path"] for r in records[:4]]

    return chosen


# ---------------------------------------------------------------------------
# Official gallery limits
# ---------------------------------------------------------------------------

def image_index(path: Path) -> int:
    stem = path.stem
    return int(stem) if stem.isdigit() else 10**9


def listing_code(row: dict) -> str:
    return str(
        row.get("propertyCode")
        or row.get("code")
        or row.get("id")
        or ""
    ).strip()


def site_from_listing_file(file_path: Path) -> str | None:
    name = file_path.name.lower()
    if "vivaprime" in name:
        return "vivaprimeimoveis"
    if "coelho" in name:
        return "coelhodafonseca"
    parts = [p.lower() for p in file_path.parts]
    if "vivaprimeimoveis" in parts:
        return "vivaprimeimoveis"
    if "coelhodafonseca" in parts:
        return "coelhodafonseca"
    return None


def load_official_counts(files: list[str] | None) -> dict:
    counts: dict[str, dict[str, int]] = {}
    if not files:
        return counts

    for raw in files:
        file_path = Path(raw)
        if not file_path.exists():
            print(f"[WARN] official listings file not found: {file_path}")
            continue

        site = site_from_listing_file(file_path)
        if not site:
            print(f"[WARN] cannot infer site from official listings file: {file_path}")
            continue

        data = json.loads(file_path.read_text())
        listings = data if isinstance(data, list) else data.get("listings", [])
        for row in listings:
            code = listing_code(row)
            images = row.get("images")
            if code and isinstance(images, list) and images:
                counts.setdefault(site, {})[code] = len(images)

    return counts


def filter_to_official_gallery(site: str, code: str, img_paths: list,
                               official_counts: dict, verbose: bool) -> list:
    official_count = official_counts.get(site, {}).get(code)
    if not official_count:
        return img_paths

    filtered = [p for p in img_paths if image_index(p) <= official_count]
    dropped = len(img_paths) - len(filtered)
    if dropped and verbose:
        print(f"  [{code}] official gallery filter: dropped {dropped} cache image(s)")
    return filtered


def listed_codes_for(site: str, official_counts: dict | None) -> set:
    if not official_counts:
        return set()
    return set(official_counts.get(site, {}).keys())


# ---------------------------------------------------------------------------
# Source directory resolution
# ---------------------------------------------------------------------------

def find_listing_dirs(source_type: str, source_root: Path, site: str) -> list:
    """Return per-listing image directories for a site."""
    if source_type == "selected":
        base = source_root / site
    elif source_type == "compound-images":
        base = source_root / site / "images"
    elif source_type == "fresh-images":
        base = source_root / "fresh-images" / site
    else:  # cache
        base = source_root / site / "cache"

    if not base.is_dir():
        return []
    return sorted(d for d in base.iterdir() if d.is_dir() and not d.name.startswith("_"))


# ---------------------------------------------------------------------------
# Main processing
# ---------------------------------------------------------------------------

def process_site(site: str, source_type: str, source_root: Path,
                 output_root: Path, dino_url: str,
                 max_pool: int, max_facade: int, max_garden: int,
                 dry_run: bool, verbose: bool,
                 official_counts: dict | None = None,
                 only_listed: bool = False,
                 clean_extra_output: bool = False) -> dict:
    listing_dirs = find_listing_dirs(source_type, source_root, site)
    if not listing_dirs:
        print(f"[{site}] No listing directories found in source")
        return {}

    source_codes = {d.name for d in listing_dirs}
    listed_codes = listed_codes_for(site, official_counts)
    if only_listed:
        if not listed_codes:
            print(f"[{site}] ERROR: --only-listed requires --official-listings for this site")
            return {}
        before = len(listing_dirs)
        listing_dirs = [d for d in listing_dirs if d.name in listed_codes]
        skipped_unlisted = before - len(listing_dirs)
    else:
        skipped_unlisted = 0

    if clean_extra_output and listed_codes and not dry_run:
        out_site = output_root / site
        if out_site.is_dir():
            for out_dir in out_site.iterdir():
                if out_dir.is_dir() and out_dir.name in source_codes and out_dir.name not in listed_codes:
                    shutil.rmtree(out_dir)

    print(f"\n[{site}] Processing {len(listing_dirs)} listings ...")
    stats = {
        "total": len(listing_dirs),
        "with_pool": 0, "facade_only": 0, "garden_only": 0,
        "fallback": 0, "empty": 0, "total_selected": 0,
        "skipped_unlisted": skipped_unlisted,
    }

    for listing_dir in listing_dirs:
        code = listing_dir.name
        img_paths = sorted(
            p for p in listing_dir.iterdir()
            if p.suffix.lower() in IMG_EXTS and not p.name.startswith("_")
        )
        if source_type == "cache" and official_counts:
            img_paths = filter_to_official_gallery(site, code, img_paths,
                                                   official_counts, verbose)

        if not img_paths:
            if verbose:
                print(f"  [{code}] no images — skipping")
            stats["empty"] += 1
            continue

        print(f"  [{code}] classifying {len(img_paths)} images ...")
        records = classify_images(img_paths, dino_url, verbose)
        chosen = select_pool_first(records, max_pool, max_facade, max_garden)

        cat_counts = {"pool": 0, "facade": 0, "garden": 0, "interior": 0}
        for r in records:
            cat_counts[r["category"]] += 1

        chosen_set = set(chosen)
        pools_chosen  = sum(1 for r in records if r["path"] in chosen_set and r["category"] == "pool")
        facade_chosen = sum(1 for r in records if r["path"] in chosen_set and r["category"] == "facade")
        garden_chosen = sum(1 for r in records if r["path"] in chosen_set and r["category"] == "garden")

        print(
            f"    pool={cat_counts['pool']} facade={cat_counts['facade']} "
            f"garden={cat_counts['garden']} int={cat_counts['interior']} "
            f"→ {len(chosen)} selected "
            f"(pool:{pools_chosen} facade:{facade_chosen} garden:{garden_chosen})"
            + (" ⚠ no pool found" if pools_chosen == 0 else "")
        )

        if pools_chosen > 0:
            stats["with_pool"] += 1
        elif facade_chosen > 0:
            stats["facade_only"] += 1
        elif garden_chosen > 0:
            stats["garden_only"] += 1
        else:
            stats["fallback"] += 1
        stats["total_selected"] += len(chosen)

        if dry_run:
            continue

        # Write output
        out_dir = output_root / site / code
        out_dir.mkdir(parents=True, exist_ok=True)

        # Clear previous selection
        for f in out_dir.iterdir():
            if not f.name.startswith("_"):
                f.unlink()

        for src in chosen:
            shutil.copy2(src, out_dir / src.name)

        manifest = {
            "site": site,
            "listing_id": code,
            "source_type": source_type,
            "classifier": "clip",
            "total_images": len(records),
            "selected_count": len(chosen),
            "strategy": "pool_first",
            "selected": [
                {
                    "filename": r["path"].name,
                    "category": r["category"],
                }
                for r in records if r["path"] in chosen_set
            ],
            "all_categories": [
                {"filename": r["path"].name, "category": r["category"]}
                for r in records
            ],
        }
        (out_dir / "_manifest.json").write_text(json.dumps(manifest, indent=2))

    return stats


def main():
    p = argparse.ArgumentParser(
        description="CLIP-based pool-first image selector for DINOv2 matching"
    )
    p.add_argument("--dino-url", default=DEFAULT_DINO_URL,
                   help=f"DINOv2/CLIP server URL (default: {DEFAULT_DINO_URL})")
    p.add_argument("--source-type", choices=["selected", "cache", "compound-images", "fresh-images"], default="selected",
                   help=(
                       "selected: use selected_exteriors/ (default). "
                       "cache: use data/{site}/cache/. "
                       "compound-images: use data/{compound}/{site}/images/. "
                       "fresh-images: use data/{compound}/fresh-images/{site}/."
                   ))
    p.add_argument("--source-root", default=".",
                   help="Root containing selected_exteriors/ or data/ (default: .)")
    p.add_argument("--compound", default=None,
                   help="Compound slug for --source-type compound-images, e.g. tambore-xi")
    p.add_argument("--output-dir", default="selected_for_matching",
                   help="Output directory (default: selected_for_matching/)")
    p.add_argument("--sites", nargs="+", default=SITES,
                   help="Sites to process")
    p.add_argument("--max-pool",   type=int, default=4,
                   help="Max pool images per listing (default: 4)")
    p.add_argument("--max-facade", type=int, default=2,
                   help="Max facade images per listing (default: 2)")
    p.add_argument("--max-garden", type=int, default=2,
                   help="Max garden images per listing (default: 2)")
    p.add_argument("--dry-run", action="store_true",
                   help="Print classification without writing files")
    p.add_argument("--verbose", action="store_true",
                   help="Print per-image classification")
    p.add_argument("--official-listings", action="append", default=[],
                   help=(
                       "Listing JSON with an images[] gallery. Repeat for each "
                       "site. When using --source-type cache, images beyond the "
                       "official gallery count are ignored."
                   ))
    p.add_argument("--only-listed", action="store_true",
                   help="Process only codes present in --official-listings")
    p.add_argument("--clean-extra-output", action="store_true",
                   help="Remove output dirs for codes not present in --official-listings")
    args = p.parse_args()

    source_root = Path(args.source_root).resolve()
    output_root = Path(args.output_dir).resolve()

    if args.source_type == "selected":
        source_root = source_root / "selected_exteriors"
        if not source_root.is_dir():
            print(f"ERROR: selected_exteriors/ not found at {source_root}")
            sys.exit(1)
    elif args.source_type in {"compound-images", "fresh-images"}:
        if not args.compound:
            print(f"ERROR: --compound is required with --source-type {args.source_type}")
            sys.exit(1)
        source_root = source_root / args.compound
        if not source_root.is_dir():
            print(f"ERROR: compound data directory not found at {source_root}")
            sys.exit(1)

    # Verify server is reachable
    try:
        health = requests.get(args.dino_url.rstrip("/") + "/health", timeout=10)
        health.raise_for_status()
        info = health.json()
        print(f"Server: {info}")
        if "clip" not in info:
            print("WARNING: server may not have CLIP loaded — /health did not report clip model")
    except Exception as exc:
        print(f"ERROR: cannot reach dino-server at {args.dino_url}: {exc}")
        print("  Start with: cd dino-server && uvicorn main:app --port 8000 --workers 1")
        sys.exit(1)

    if args.dry_run:
        print("DRY RUN — no files will be written\n")
    else:
        print(f"Output → {output_root}\n")

    official_counts = load_official_counts(args.official_listings)
    if official_counts:
        total_counts = sum(len(v) for v in official_counts.values())
        print(f"Official gallery guard loaded for {total_counts} listing(s)\n")

    all_stats = {}
    for site in args.sites:
        stats = process_site(
            site=site,
            source_type=args.source_type,
            source_root=source_root,
            output_root=output_root,
            dino_url=args.dino_url,
            max_pool=args.max_pool,
            max_facade=args.max_facade,
            max_garden=args.max_garden,
            dry_run=args.dry_run,
            verbose=args.verbose,
            official_counts=official_counts,
            only_listed=args.only_listed,
            clean_extra_output=args.clean_extra_output,
        )
        all_stats[site] = stats

    print("\n" + "=" * 60)
    print("Summary:")
    for site, s in all_stats.items():
        if not s:
            continue
        avg = s["total_selected"] / max(1, s["total"] - s["empty"])
        print(f"  {site}:")
        print(f"    Total listings:      {s['total']}")
        print(f"    With pool shots:     {s['with_pool']}")
        print(f"    Facade-only:         {s['facade_only']}")
        print(f"    Garden-only:         {s['garden_only']}")
        print(f"    Fallback (no ext):   {s['fallback']}")
        print(f"    No images:           {s['empty']}")
        print(f"    Skipped unlisted:    {s['skipped_unlisted']}")
        print(f"    Avg selected/listing:{avg:.1f}")

    if not args.dry_run:
        print(f"\nDone. Run dino-auto-matcher.py — it will use {output_root}/ automatically.")


if __name__ == "__main__":
    main()
