#!/usr/bin/env python3
"""
Benchmark mosaic image-selection policies on the local Alphaville data.

This is not a replacement for human visual QA. It is a cheap regression test for
the question that matters to review UX: does the selected image set expose enough
shared exterior evidence that the confirmed matching listing ranks near the top?

The benchmark compares selectors with a simple perceptual-hash scorer over the
current human-confirmed pairs. It also reports "semantic leakage" using the
existing CLIP manifest categories as a weak oracle.
"""

from __future__ import annotations

import argparse
import json
import math
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np


CONFIRMED_PAIRS = [
    ("17388", "354149"),
    ("16886", "617978"),
    ("16626", "597308"),
    ("13254", "356006"),
    ("17116", "674139"),
    ("5380", "467562"),
    ("16026", "674557"),
    ("12854", "616435"),
    ("13572", "653980"),
    ("16385", "663777"),
    ("16892", "663984"),
    ("14127", "663462"),
    ("2075", "502738"),
    ("17722", "677257"),
    ("17378", "659639"),
    ("7597", "358601"),
    ("18035", "661014"),
    ("14138", "660058"),
    ("16117", "628299"),
    ("17378", "425516"),
    ("12814", "682781"),
]

SITE_VIVA = "vivaprimeimoveis"
SITE_COELHO = "coelhodafonseca"
OUTDOOR = {"pool", "facade", "garden"}
CATEGORY_PRIORITY = {"pool": 0, "facade": 1, "garden": 2, "interior": 3}


@dataclass(frozen=True)
class ImagePick:
    path: Path
    category: str | None = None


def numeric_name_key(path: Path) -> tuple[int, str]:
    stem = path.stem
    return (int(stem) if stem.isdigit() else math.inf, path.name)


def read_manifest(path: Path) -> dict:
    if not path.exists():
        return {}
    return json.loads(path.read_text())


def sorted_manifest_entries(entries: list[dict]) -> list[dict]:
    return sorted(
        entries,
        key=lambda e: (
            CATEGORY_PRIORITY.get(e.get("category"), 99),
            numeric_name_key(Path(str(e.get("filename", "")))),
        ),
    )


def cache_dir(repo: Path, site: str, code: str) -> Path:
    return repo / "data" / site / "cache" / code


def clip_manifest(repo: Path, site: str, code: str) -> dict:
    return read_manifest(repo / "selected_for_matching" / site / code / "_manifest.json")


def clip_category_map(repo: Path, site: str, code: str) -> dict[str, str]:
    manifest = clip_manifest(repo, site, code)
    return {
        str(e.get("filename")): str(e.get("category"))
        for e in manifest.get("all_categories", [])
        if e.get("filename")
    }


def existing_pick(path: Path, category: str | None) -> ImagePick | None:
    return ImagePick(path, category) if path.exists() else None


def select_clip_selected(repo: Path, site: str, code: str, limit: int) -> list[ImagePick]:
    manifest = clip_manifest(repo, site, code)
    entries = sorted_manifest_entries([
        e for e in manifest.get("selected", [])
        if e.get("category") in OUTDOOR
    ])
    picks = [
        existing_pick(cache_dir(repo, site, code) / str(e["filename"]), str(e.get("category")))
        for e in entries[:limit]
    ]
    return [p for p in picks if p is not None]


def select_clip_expanded(repo: Path, site: str, code: str, limit: int) -> list[ImagePick]:
    manifest = clip_manifest(repo, site, code)
    entries = sorted_manifest_entries([
        e for e in manifest.get("all_categories", manifest.get("selected", []))
        if e.get("category") in OUTDOOR
    ])
    picks = [
        existing_pick(cache_dir(repo, site, code) / str(e["filename"]), str(e.get("category")))
        for e in entries[:limit]
    ]
    return [p for p in picks if p is not None]


def select_source_first(repo: Path, site: str, code: str, limit: int) -> list[ImagePick]:
    cats = clip_category_map(repo, site, code)
    images = sorted(
        [p for p in cache_dir(repo, site, code).glob("*") if p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}],
        key=numeric_name_key,
    )
    return [ImagePick(p, cats.get(p.name)) for p in images[:limit]]


def select_legacy_heuristic(repo: Path, site: str, code: str, limit: int) -> list[ImagePick]:
    manifest = read_manifest(repo / "selected_exteriors" / site / code / "_manifest.json")
    cats = clip_category_map(repo, site, code)
    picks = []
    for entry in manifest.get("selected", [])[:limit]:
        filename = Path(str(entry.get("filename", ""))).name
        path = repo / "selected_exteriors" / site / code / filename
        pick = existing_pick(path, cats.get(filename))
        if pick is not None:
            picks.append(pick)
    return picks


SELECTORS = {
    "clip_selected_8": lambda repo, site, code: select_clip_selected(repo, site, code, 8),
    "clip_expanded_outdoor_16": lambda repo, site, code: select_clip_expanded(repo, site, code, 16),
    "source_first_8": lambda repo, site, code: select_source_first(repo, site, code, 8),
    "source_first_16": lambda repo, site, code: select_source_first(repo, site, code, 16),
    "legacy_heuristic_12": lambda repo, site, code: select_legacy_heuristic(repo, site, code, 12),
}


def phash(path: Path) -> np.ndarray | None:
    img = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
    if img is None:
        return None
    resized = cv2.resize(img, (32, 32), interpolation=cv2.INTER_AREA)
    dct = cv2.dct(np.float32(resized))
    low = dct[:8, :8]
    med = np.median(low[1:, 1:])
    return (low > med).astype(np.uint8).reshape(-1)


def hash_similarity(a: np.ndarray, b: np.ndarray) -> float:
    return 1.0 - float(np.count_nonzero(a != b)) / float(a.size)


def image_set_score(a_hashes: list[np.ndarray], b_hashes: list[np.ndarray]) -> float:
    if not a_hashes or not b_hashes:
        return 0.0
    sims = sorted(
        (hash_similarity(a, b) for a in a_hashes for b in b_hashes),
        reverse=True,
    )
    return float(np.mean(sims[: min(3, len(sims))]))


def codes_with_cache(repo: Path, site: str) -> list[str]:
    base = repo / "data" / site / "cache"
    return sorted(d.name for d in base.iterdir() if d.is_dir())


def positive_sets() -> dict[str, set[str]]:
    positives: dict[str, set[str]] = {}
    for viva, coelho in CONFIRMED_PAIRS:
        positives.setdefault(viva, set()).add(coelho)
    return positives


def evaluate_selector(repo: Path, name: str) -> dict:
    selector = SELECTORS[name]
    positives = positive_sets()
    coelho_codes = codes_with_cache(repo, SITE_COELHO)
    hash_cache: dict[tuple[str, str, str], list[np.ndarray]] = {}
    category_counts = {"pool": 0, "facade": 0, "garden": 0, "interior": 0, "unknown": 0}
    selected_counts = []

    def selected_hashes(site: str, code: str) -> list[np.ndarray]:
        key = (name, site, code)
        if key in hash_cache:
            return hash_cache[key]
        picks = selector(repo, site, code)
        selected_counts.append(len(picks))
        for pick in picks:
            category_counts[pick.category or "unknown"] = category_counts.get(pick.category or "unknown", 0) + 1
        hashes = [h for h in (phash(p.path) for p in picks) if h is not None]
        hash_cache[key] = hashes
        return hashes

    ranks = []
    reciprocal = []
    recall_at_1 = 0
    recall_at_3 = 0
    recall_at_5 = 0
    evaluated = 0

    for viva_code, true_coelhos in positives.items():
        viva_hashes = selected_hashes(SITE_VIVA, viva_code)
        if not viva_hashes:
            continue
        scored = []
        for coelho_code in coelho_codes:
            coelho_hashes = selected_hashes(SITE_COELHO, coelho_code)
            scored.append((coelho_code, image_set_score(viva_hashes, coelho_hashes)))
        scored.sort(key=lambda x: x[1], reverse=True)
        rank = min(
            (idx + 1 for idx, (code, _) in enumerate(scored) if code in true_coelhos),
            default=len(scored) + 1,
        )
        evaluated += 1
        ranks.append(rank)
        reciprocal.append(1.0 / rank)
        recall_at_1 += int(rank <= 1)
        recall_at_3 += int(rank <= 3)
        recall_at_5 += int(rank <= 5)

    total_categorized = sum(category_counts.values())
    return {
        "selector": name,
        "evaluated_viva": evaluated,
        "recall_at_1": recall_at_1 / evaluated if evaluated else 0.0,
        "recall_at_3": recall_at_3 / evaluated if evaluated else 0.0,
        "recall_at_5": recall_at_5 / evaluated if evaluated else 0.0,
        "mrr": float(np.mean(reciprocal)) if reciprocal else 0.0,
        "median_rank": float(np.median(ranks)) if ranks else None,
        "mean_rank": float(np.mean(ranks)) if ranks else None,
        "mean_selected_images": float(np.mean(selected_counts)) if selected_counts else 0.0,
        "category_counts": category_counts,
        "interior_rate": category_counts.get("interior", 0) / total_categorized if total_categorized else 0.0,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--output", default="data/mosaic-selector-benchmark.json")
    args = parser.parse_args()

    repo = Path(args.repo_root).resolve()
    results = [evaluate_selector(repo, name) for name in SELECTORS]
    output = {
        "confirmed_pair_count": len(CONFIRMED_PAIRS),
        "unique_viva_count": len(positive_sets()),
        "metric_notes": {
            "rank_metrics": "Rank true Coelho listing among all Coelho candidates using top-3 perceptual-hash image-set similarity.",
            "interior_rate": "Weak semantic leakage estimate from the current CLIP all_categories labels.",
        },
        "results": results,
    }

    out = repo / args.output
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(output, indent=2))

    print("selector,evaluated,R@1,R@3,R@5,MRR,median_rank,mean_rank,mean_images,interior_rate")
    for r in results:
        print(
            f"{r['selector']},{r['evaluated_viva']},"
            f"{r['recall_at_1']:.3f},{r['recall_at_3']:.3f},{r['recall_at_5']:.3f},"
            f"{r['mrr']:.3f},{r['median_rank']:.1f},{r['mean_rank']:.1f},"
            f"{r['mean_selected_images']:.1f},{r['interior_rate']:.3f}"
        )
    print(f"Wrote {out}")


if __name__ == "__main__":
    main()
