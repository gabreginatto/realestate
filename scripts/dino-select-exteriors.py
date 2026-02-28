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

The dino-server must be running (--dino-url, default http://localhost:8000).

Output: selected_for_matching/{site}/{code}/   (read by dino-auto-matcher.py)

Usage:
    # Start server first:
    cd dino-server && uvicorn main:app --port 8000 --workers 1

    # From existing selected_exteriors (fast path):
    python scripts/dino-select-exteriors.py

    # From full image cache after re-scrape:
    python scripts/dino-select-exteriors.py --source-type cache --data-root data/

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
# Source directory resolution
# ---------------------------------------------------------------------------

def find_listing_dirs(source_type: str, source_root: Path, site: str) -> list:
    """Return per-listing image directories for a site."""
    if source_type == "selected":
        base = source_root / site
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
                 dry_run: bool, verbose: bool) -> dict:
    listing_dirs = find_listing_dirs(source_type, source_root, site)
    if not listing_dirs:
        print(f"[{site}] No listing directories found in source")
        return {}

    print(f"\n[{site}] Processing {len(listing_dirs)} listings ...")
    stats = {
        "total": len(listing_dirs),
        "with_pool": 0, "facade_only": 0, "garden_only": 0,
        "fallback": 0, "empty": 0, "total_selected": 0,
    }

    for listing_dir in listing_dirs:
        code = listing_dir.name
        img_paths = sorted(
            p for p in listing_dir.iterdir()
            if p.suffix.lower() in IMG_EXTS and not p.name.startswith("_")
        )

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
    p.add_argument("--source-type", choices=["selected", "cache"], default="selected",
                   help="selected: use selected_exteriors/ (default). cache: use data/{site}/cache/")
    p.add_argument("--source-root", default=".",
                   help="Root containing selected_exteriors/ or data/ (default: .)")
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
    args = p.parse_args()

    source_root = Path(args.source_root).resolve()
    output_root = Path(args.output_dir).resolve()

    if args.source_type == "selected":
        source_root = source_root / "selected_exteriors"
        if not source_root.is_dir():
            print(f"ERROR: selected_exteriors/ not found at {source_root}")
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
        print(f"    Avg selected/listing:{avg:.1f}")

    if not args.dry_run:
        print(f"\nDone. Run dino-auto-matcher.py — it will use {output_root}/ automatically.")


if __name__ == "__main__":
    main()
