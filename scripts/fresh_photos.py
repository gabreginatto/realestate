#!/usr/bin/env python3
"""Build data/photos-fresh/<site>/<code>/ (symlinks) from the current scrape only; the old archive is ignored.

Why: archive folders have no reliable provenance (re-saved copies, other listings' photos mixed in) and include
listings that are no longer online. Only live listings matter for "is this Viva house at Coelho?".

Rules (same as clean_photos.py for fresh data):
  Viva   : fresh-images/<site>/<code>/NN.jpg kept only if fresh-listings images[NN-1] is under /fotos/<code>/.
  Coelho : gallery already limited to the listing's own carousel; all kept.
Exact md5 duplicates inside a listing are dropped.

Usage: python scripts/fresh_photos.py
"""
from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from clean_photos import clean_viva_fresh, md5  # noqa: E402
from lib.photo_fingerprints import IMAGE_EXTS  # noqa: E402
from photo_dups import COELHO, VIVA  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data/photos-fresh"


def main() -> None:
    # clear per-site trees only: Finder may drop a .DS_Store in OUT mid-delete (Desktop is synced)
    for site in (VIVA, COELHO):
        if (OUT / site).exists():
            shutil.rmtree(OUT / site)
    stats = {VIVA: [0, 0, 0], COELHO: [0, 0, 0]}  # listings with photos, photos kept, listings without photos
    for f in sorted((ROOT / "data").glob("*/fresh-listings/*.json")):
        site = f.stem
        if site not in stats:
            continue
        for l in json.loads(f.read_text())["listings"]:
            code = str(l["propertyCode"])
            d = f.parents[1] / "fresh-images" / site / code
            files = sorted(p for p in d.iterdir() if p.suffix.lower() in IMAGE_EXTS) if d.is_dir() else []
            keep = clean_viva_fresh(code, files, l.get("images", []))[0] if site == VIVA else files
            seen, uniq = set(), []
            for p in keep:
                h = md5(p)
                if h not in seen:
                    seen.add(h)
                    uniq.append(p)
            if not uniq:
                stats[site][2] += 1
                continue
            o = OUT / site / code
            o.mkdir(parents=True, exist_ok=True)
            for p in uniq:
                (o / p.name).symlink_to(Path(os.path.realpath(p)))
            stats[site][0] += 1
            stats[site][1] += len(uniq)
    for site, (n, k, miss) in stats.items():
        print(f"{site:17s} listings={n:3d} photos={k:5d} no_photos={miss}")


if __name__ == "__main__":
    main()
