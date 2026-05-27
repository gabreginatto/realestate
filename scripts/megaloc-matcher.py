#!/usr/bin/env python3
"""
MegaLoc matcher experiment for property listing matching.

MegaLoc is a visual place recognition model. This script embeds each
CLIP-selected listing image, compares listing image sets, runs one-to-one
Hungarian assignment, and benchmarks thresholds against the current
human-confirmed ground truth from recursive-matcher-v2.py.

Usage:
    python scripts/megaloc-matcher.py \
        --data-root data \
        --cache data/embedding-cache-megaloc.pkl \
        --output data/auto-matches-megaloc.json
"""

import argparse
import importlib.util
import json
import logging
import os
import pickle
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from scipy.optimize import linear_sum_assignment
from torchvision import transforms


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("megaloc-matcher")

SITES = ("vivaprimeimoveis", "coelhodafonseca")
IMG_EXTS = {".jpg", ".jpeg", ".png", ".webp"}


def load_recursive_matcher(repo_root: Path):
    path = repo_root / "scripts" / "recursive-matcher-v2.py"
    spec = importlib.util.spec_from_file_location("recursive_matcher_v2", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def selected_images(selected_root: Path, site: str, code: str) -> list[Path]:
    base = selected_root / site / code
    if not base.is_dir():
        return []
    return [
        p for p in sorted(base.iterdir())
        if p.suffix.lower() in IMG_EXTS and not p.name.startswith("_")
    ]


def select_device() -> str:
    requested = os.environ.get("MEGALOC_DEVICE")
    if requested:
        return requested
    if torch.cuda.is_available():
        return "cuda"
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def load_model(device: str):
    log.info("Loading MegaLoc via torch.hub...")
    model = torch.hub.load("gmberton/MegaLoc", "get_trained_model",
                           trust_repo=True)
    model.eval()
    model.to(device)
    return model


def image_transform(image_size: int):
    return transforms.Compose([
        transforms.Resize((image_size, image_size), antialias=True),
        transforms.ToTensor(),
        transforms.Normalize(
            mean=(0.485, 0.456, 0.406),
            std=(0.229, 0.224, 0.225),
        ),
    ])


def embed_paths(model, paths: list[Path], device: str,
                image_size: int, batch_size: int) -> list[np.ndarray]:
    transform = image_transform(image_size)
    vectors = []
    for start in range(0, len(paths), batch_size):
        batch_paths = paths[start:start + batch_size]
        tensors = []
        for path in batch_paths:
            try:
                image = Image.open(path).convert("RGB")
            except Exception as exc:
                log.warning(f"Skipping unreadable image {path}: {exc}")
                continue
            tensors.append(transform(image))
        if not tensors:
            continue
        batch = torch.stack(tensors).to(device)
        with torch.no_grad():
            desc = model(batch).detach().cpu().numpy().astype(np.float32)
        vectors.extend([row for row in desc])
    return vectors


def compute_cache(viva, coelho, repo_root: Path, selected_root: Path,
                  cache_path: Path,
                  image_size: int, batch_size: int, refresh: bool):
    if cache_path.exists() and not refresh:
        log.info(f"Loading MegaLoc cache from {cache_path}")
        with open(cache_path, "rb") as f:
            return pickle.load(f)

    device = select_device()
    log.info(f"Device: {device}")
    model = load_model(device)

    cache = {}
    all_items = [("vivaprimeimoveis", x["code"]) for x in viva] + [
        ("coelhodafonseca", x["code"]) for x in coelho
    ]
    for idx, (site, code) in enumerate(all_items, start=1):
        paths = selected_images(selected_root, site, code)
        vectors = embed_paths(model, paths, device, image_size, batch_size)
        cache[f"{site}/{code}"] = {
            "files": [p.name for p in paths],
            "vectors": vectors,
        }
        short = "viva" if "viva" in site else "coelho"
        log.info(f"[{idx}/{len(all_items)}] {short}/{code} "
                 f"{len(vectors)} images")

    cache_path.parent.mkdir(parents=True, exist_ok=True)
    with open(cache_path, "wb") as f:
        pickle.dump(cache, f)
    log.info(f"Saved cache -> {cache_path}")
    return cache


def get_vectors(cache: dict, site: str, code: str) -> list[np.ndarray]:
    item = cache.get(f"{site}/{code}") or {}
    return [np.asarray(v, dtype=np.float32) for v in item.get("vectors", [])]


def set_similarity(a_vecs: list[np.ndarray], b_vecs: list[np.ndarray],
                   top_k: int = 5) -> float:
    if not a_vecs or not b_vecs:
        return 0.0
    a = np.stack(a_vecs).astype(np.float32)
    b = np.stack(b_vecs).astype(np.float32)
    a = a / np.maximum(np.linalg.norm(a, axis=1, keepdims=True), 1e-9)
    b = b / np.maximum(np.linalg.norm(b, axis=1, keepdims=True), 1e-9)
    sims = a @ b.T
    flat = np.sort(sims.reshape(-1))[::-1]
    k = max(1, min(top_k, flat.size))
    best_score = float(flat[0])
    top_score = float(flat[:k].mean())
    coverage = (float(sims.max(axis=1).mean()) +
                float(sims.max(axis=0).mean())) / 2.0
    return 0.50 * best_score + 0.30 * top_score + 0.20 * coverage


def build_matrix(viva, coelho, cache: dict) -> np.ndarray:
    sim = np.zeros((len(viva), len(coelho)), dtype=np.float32)
    viva_vecs = [
        get_vectors(cache, "vivaprimeimoveis", listing["code"])
        for listing in viva
    ]
    coelho_vecs = [
        get_vectors(cache, "coelhodafonseca", listing["code"])
        for listing in coelho
    ]
    for i, a in enumerate(viva_vecs):
        if not a:
            continue
        for j, b in enumerate(coelho_vecs):
            if b:
                sim[i, j] = set_similarity(a, b)
    return sim


def assign(sim_matrix: np.ndarray, viva, coelho, threshold: float):
    rows, cols = linear_sum_assignment(-sim_matrix)
    matches = []
    for r, c in zip(rows, cols):
        score = float(sim_matrix[r, c])
        if score >= threshold:
            matches.append({
                "viva_code": viva[r]["code"],
                "coelho_code": coelho[c]["code"],
                "similarity_score": round(score, 6),
            })
    return matches


def threshold_sweep(sim_matrix: np.ndarray, viva, coelho, matcher):
    best = None
    results = []
    for threshold in np.arange(0.45, 0.96, 0.025):
        threshold = round(float(threshold), 3)
        matches = assign(sim_matrix, viva, coelho, threshold)
        result = matcher.evaluate(matches)
        row = {"threshold": threshold, **result}
        results.append(row)
        if best is None or (
            result["f1"], result["precision"], result["recall"]
        ) > (
            best["f1"], best["precision"], best["recall"]
        ):
            best = row
    return best, results


def parse_args():
    p = argparse.ArgumentParser(description="MegaLoc property matcher")
    p.add_argument("--data-root", default="data")
    p.add_argument("--selected-root", default="selected_for_matching")
    p.add_argument("--cache", default="data/embedding-cache-megaloc.pkl")
    p.add_argument("--output", default="data/auto-matches-megaloc.json")
    p.add_argument("--threshold", type=float, default=None,
                   help="Use a fixed assignment threshold instead of sweeping ground truth.")
    p.add_argument("--image-size", type=int, default=518)
    p.add_argument("--batch-size", type=int, default=2)
    p.add_argument("--refresh-cache", action="store_true")
    return p.parse_args()


def main():
    args = parse_args()
    repo_root = Path.cwd()
    data_root = Path(args.data_root).resolve()
    selected_root = Path(args.selected_root).resolve()
    matcher = load_recursive_matcher(repo_root)

    viva, coelho = matcher.load_listings(data_root)
    cache = compute_cache(
        viva, coelho, repo_root, selected_root, Path(args.cache), args.image_size,
        args.batch_size, args.refresh_cache,
    )

    log.info("Building MegaLoc similarity matrix...")
    sim_matrix = build_matrix(viva, coelho, cache)
    log.info(f"matrix={sim_matrix.shape} nonzero={(sim_matrix > 0).sum()}")

    if args.threshold is None:
        best, sweep = threshold_sweep(sim_matrix, viva, coelho, matcher)
    else:
        threshold = round(float(args.threshold), 3)
        matches_at_threshold = assign(sim_matrix, viva, coelho, threshold)
        best = {"threshold": threshold, **matcher.evaluate(matches_at_threshold)}
        sweep = [best]
    log.info(
        f"Best threshold={best['threshold']:.3f} "
        f"P={best['precision']:.0%} R={best['recall']:.0%} "
        f"F1={best['f1']:.0%} TP={best['tp']} FP={best['fp']}"
    )

    matches = assign(sim_matrix, viva, coelho, best["threshold"])
    matches.sort(key=lambda x: -x["similarity_score"])
    final_eval = matcher.evaluate(matches)

    now = datetime.now(timezone.utc).isoformat()
    output = {
        "session_started": now,
        "session_name": "megaloc",
        "strategy": "megaloc-set-similarity",
        "best_threshold": best["threshold"],
        "threshold_sweep": sweep,
        "matches": [{
            **m,
            "matched_at": now,
            "reviewer": "megaloc",
            "confidence": "high" if m["similarity_score"] >= best["threshold"] + 0.05 else "medium",
            "confidence_score": m["similarity_score"],
            "strategy": "megaloc-set-similarity",
        } for m in matches],
        "stats": {
            "total_viva": len(viva),
            "total_coelho": len(coelho),
            "matched": len(matches),
            "ground_truth_confirmed": len(matcher.CONFIRMED_PAIRS),
            **final_eval,
        },
    }

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)
    log.info(f"Saved -> {output_path}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
