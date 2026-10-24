#!/usr/bin/env python3
"""Build data/photos-clean/<site>/<code>/ (symlinks to kept original files) from data/photos.

Why: the scrapers collected every a.foto / static-image on the page, so listing photo folders also hold
photos of OTHER listings (condo carousels, "similar listings"). Originals are never touched.

Provenance rules (no re-downloading):
  Viva fresh   : fresh-images/<site>/<code>/NN.jpg -> fresh-listings JSON images[NN-1]; keep URL under /fotos/<code>/.
  Viva archive : keep files named like the listing's own uploads (<prefix>_<code><13 hex>.jpg, igvivaimo<code>_N.jpg)
                 + NN.jpg that are byte-identical (md5) copies of them. NN-only dirs: old production JSON (git bf95315)
                 own-image count (NN order == gallery order), else tail heuristic (see below).
  Coelho fresh : gallery already limited to the page's own carousel (checked == declared "Ver fotos (N)"); all kept.
  Coelho arch. : image-id named files (<id>.jpg) are the real gallery (== old JSON ids); NN.jpg are re-encoded copies
                 of them plus the 5 "similar listing" hero photos at the tail -> drop all NN. NN-only dirs: drop last 5.
  Tail heuristic (NN-only dirs, no provenance): own photos come first; cut at the first photo that is a near-duplicate
                 (SSCD >= 0.9) of a photo known to be foreign, then require >=60% of the tail to be foreign-like.
Exact md5 duplicates inside a kept set are dropped (counted separately).

Usage: python scripts/clean_photos.py [--no-dedupe]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.photo_fingerprints import IMAGE_EXTS, fingerprint_files, pairwise_pdq  # noqa: E402
from photo_dups import COELHO, VIVA, list_listings  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
PHOTOS, CLEAN = ROOT / "data/photos", ROOT / "data/photos-clean"
OLD_JSON_COMMIT = "bf95315"  # last production scrape that stored per-listing image URL lists
TAIL_SSCD, TAIL_FRAC = 0.9, 0.6
COELHO_SIMILAR_TAIL = 5


def md5(p: Path) -> str:
    return hashlib.md5(p.read_bytes()).hexdigest()


def git_json(path: str):
    r = subprocess.run(["git", "show", f"{OLD_JSON_COMMIT}:{path}"], capture_output=True, text=True, cwd=ROOT)
    return json.loads(r.stdout)["listings"] if r.returncode == 0 else []


def fresh_urls(site: str) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for f in sorted((ROOT / "data").glob(f"*/fresh-listings/{site}.json")):
        for l in json.loads(f.read_text())["listings"]:
            out[str(l["propertyCode"])] = l.get("images", [])
    return out


def own_viva_name(name: str, code: str) -> bool:
    return bool(re.search(rf"_{code}[0-9a-f]{{13}}\.\w+$", name) or re.match(rf"igvivaimo{code}_\d+\.\w+$", name))


def is_nn(p: Path) -> bool:
    return bool(re.fullmatch(r"\d{1,3}", p.stem))


def nn_index(p: Path) -> int:
    return int(p.stem)


def clean_viva_fresh(code: str, files: list[Path], urls: list[str]):
    keep = []
    for p in files:
        i = nn_index(p) - 1 if is_nn(p) else -1
        if 0 <= i < len(urls) and f"/vista.imobi/fotos/{code}/" in urls[i]:
            keep.append(p)
    return keep, "fresh-url-prefix"


def clean_viva_archive(code: str, files: list[Path], old_own: int | None):
    named = [p for p in files if own_viva_name(p.name, code)]
    if named:
        sums = {md5(p) for p in named}
        return named + [p for p in files if is_nn(p) and md5(p) in sums], "archive-name+md5", False
    if old_own is not None:
        nn = sorted((p for p in files if is_nn(p)), key=nn_index)
        return nn[:old_own], "old-json-own-count", False
    return None, "tail-heuristic", True


def clean_coelho_archive(code: str, files: list[Path]):
    ids = [p for p in files if re.fullmatch(r"\d{6,}", p.stem)]
    if ids:
        return ids, "archive-image-ids", False
    nn = sorted((p for p in files if is_nn(p)), key=nn_index)
    return nn[:-COELHO_SIMILAR_TAIL], "archive-nn-drop-tail5", True


def tail_cut(files: list[Path], foreign_emb: np.ndarray, fps) -> tuple[list[Path], bool]:
    """files in gallery order; cut at first near-duplicate of a known-foreign photo."""
    e = np.stack([fps[p].emb for p in files])
    sim = np.maximum(e[:, 0] @ foreign_emb[:, 0].T, e[:, 0] @ foreign_emb[:, 1].T).max(axis=1)
    flag = sim >= TAIL_SSCD
    if not flag.any():
        return files, True
    k = int(np.argmax(flag))
    ok = flag[k:].mean() >= TAIL_FRAC
    return (files[:k], not ok) if ok else (files, True)


def real_dir(site: str, code: str) -> Path:
    return Path(os.path.realpath(PHOTOS / site / code))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-dedupe", action="store_true")
    args = ap.parse_args()
    old_viva = {str(l["propertyCode"]): l for l in git_json("data/vivaprimeimoveis/listings/all-listings.json")}
    fresh_viva = fresh_urls(VIVA)
    listings = {s: list_listings(PHOTOS, s) for s in (VIVA, COELHO)}
    report: dict = {}
    kept: dict[str, dict[str, list[Path]]] = {VIVA: {}, COELHO: {}}
    pending: list[tuple[str, str]] = []

    for site, by_code in listings.items():
        for code, files in by_code.items():
            archive = "archive-images" in str(real_dir(site, code))
            uncertain = False
            if site == VIVA:
                if archive:
                    old = old_viva.get(code)
                    own_n = sum(f"/fotos/{code}/" in u for u in old["images"]) if old and old.get("images") else None
                    keep, method, uncertain = clean_viva_archive(code, files, own_n)
                else:
                    keep, method = clean_viva_fresh(code, files, fresh_viva.get(code, []))
            elif archive:
                keep, method, uncertain = clean_coelho_archive(code, files)
            else:
                keep, method = list(files), "fresh-gallery-verified"
            report[f"{site}/{code}"] = {"site": site, "code": code, "source": "archive" if archive else "fresh",
                                        "before": len(files), "method": method, "uncertain": uncertain}
            if keep is None:
                pending.append((site, code))
            else:
                kept[site][code] = keep

    # tail heuristic for viva NN-only archive dirs: foreign pool = every dropped viva photo of other listings
    if pending:
        foreign_files = [p for c, fs in listings[VIVA].items() if c in kept[VIVA] for p in fs if p not in set(kept[VIVA][c])]
        fps = fingerprint_files(foreign_files + [p for s, c in pending for p in listings[s][c]], PHOTOS / "_cache")
        femb = np.stack([fps[p].emb for p in foreign_files if p in fps])
        for site, code in pending:
            nn = sorted(listings[site][code], key=nn_index)
            keep, unc = tail_cut(nn, femb, fps)
            kept[site][code] = keep
            report[f"{site}/{code}"]["uncertain"] = unc
            report[f"{site}/{code}"]["method"] = "tail-heuristic" + ("-no-cut" if len(keep) == len(nn) else "")

    n_dedup = 0
    for site, by_code in kept.items():
        for code, keep in by_code.items():
            before_dedupe = len(keep)
            if not args.no_dedupe:
                seen, uniq = set(), []
                # hash-named / id-named files first so NN copies are the ones dropped
                for p in sorted(keep, key=lambda p: (is_nn(p) and not re.fullmatch(r"\d{6,}", p.stem), p.name)):
                    h = md5(p)
                    if h not in seen:
                        seen.add(h)
                        uniq.append(p)
                keep = sorted(uniq)
            n_dedup += before_dedupe - len(keep)
            by_code[code] = keep
            r = report[f"{site}/{code}"]
            r["after"] = len(keep)
            r["dropped"] = r["before"] - len(keep)
            r["dedup_dropped"] = before_dedupe - len(keep)
            r["foreign_dropped"] = r["before"] - before_dedupe
            r["dropped_files_sample"] = sorted(p.name for p in listings[site][code] if p not in set(keep))[:6]

    # Coelho sanity check on the kept sets: photos that are near-duplicates (SSCD >= .75 or PDQ <= 31) of a photo of
    # ANOTHER Coelho listing. Not dropped (the same house is sometimes listed twice) but flagged as uncertain.
    items = [(c, p) for c, ps in kept[COELHO].items() for p in ps]
    fps = fingerprint_files([p for _, p in items], PHOTOS / "_cache")
    emb = np.stack([fps[p].emb for _, p in items])
    pdq = np.stack([fps[p].pdq for _, p in items])
    codes = np.array([c for c, _ in items])
    sim = np.maximum(emb[:, 0] @ emb[:, 0].T, emb[:, 0] @ emb[:, 1].T)
    sus = ((sim >= 0.75) | (pairwise_pdq(pdq[:, 0], pdq) <= 31)) & (codes[:, None] != codes[None, :])
    for c in kept[COELHO]:
        rows = np.where((codes == c) & sus.any(axis=1))[0]
        if len(rows):
            r = report[f"{COELHO}/{c}"]
            r["cross_listing_dup_photos"] = int(len(rows))
            r["cross_listing_partners"] = sorted({str(x) for i in rows for x in codes[sus[i]]})
            r["uncertain"] = True

    # materialise symlinks
    import shutil

    if CLEAN.exists():
        shutil.rmtree(CLEAN)
    for site, by_code in kept.items():
        for code, keep in by_code.items():
            d = CLEAN / site / code
            d.mkdir(parents=True, exist_ok=True)
            for p in keep:
                (d / p.name).symlink_to(Path(os.path.realpath(p)))
    summary = {}
    for site in (VIVA, COELHO):
        for src in ("fresh", "archive"):
            x = [r for r in report.values() if r["site"] == site and r["source"] == src]
            summary[f"{site}/{src}"] = {
                "listings": len(x), "contaminated": sum(r["foreign_dropped"] > 0 for r in x),
                "foreign_photos_dropped": sum(r["foreign_dropped"] for r in x),
                "duplicate_photos_dropped": sum(r["dedup_dropped"] for r in x),
                "photos_before": sum(r["before"] for r in x), "photos_after": sum(r["after"] for r in x),
                "uncertain": sorted(r["code"] for r in x if r["uncertain"])}
    (ROOT / "data/photo_cleaning_report.json").write_text(
        json.dumps({"params": {"tail_sscd": TAIL_SSCD, "tail_frac": TAIL_FRAC, "dedupe": not args.no_dedupe},
                    "summary": summary, "listings": list(report.values())}, indent=1) + "\n")
    for site in (VIVA, COELHO):
        rs = [r for r in report.values() if r["site"] == site]
        for src in ("fresh", "archive"):
            x = [r for r in rs if r["source"] == src]
            print(f"{site:17s} {src:7s} n={len(x):3d} changed={sum(r['dropped']>0 for r in x):3d} "
                  f"foreign_dropped={sum(r['foreign_dropped'] for r in x):5d} dedup={sum(r['dedup_dropped'] for r in x):4d} "
                  f"photos {sum(r['before'] for r in x)}->{sum(r['after'] for r in x)} uncertain={sum(r['uncertain'] for r in x)}")


if __name__ == "__main__":
    main()
