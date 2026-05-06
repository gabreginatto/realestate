#!/usr/bin/env python3
"""
Patch-token VLAD matcher experiment.

This is closer to AnyLoc than the current image-vector VLAD mode. It extracts
DINOv3 patch tokens from each selected image, learns a small visual vocabulary,
encodes each image as a VLAD descriptor, compares listing image sets, and
benchmarks the result against the existing confirmed-pair set.

It deliberately writes separate cache/output files so it does not contaminate
the production VLAD or MegaLoc artifacts.

Usage:
    python3 scripts/patch-vlad-matcher.py \
        --data-root data \
        --cache data/embedding-cache-patch-vlad.pkl \
        --output data/auto-matches-patch-vlad.json
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import logging
import pickle
import random
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from scipy.cluster.vq import kmeans2
from scipy.optimize import linear_sum_assignment
from torchvision import transforms


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("patch-vlad-matcher")

SITES = ("vivaprimeimoveis", "coelhodafonseca")
IMG_EXTS = {".jpg", ".jpeg", ".png", ".webp"}


def load_recursive_matcher(repo_root: Path):
    path = repo_root / "scripts" / "recursive-matcher-v2.py"
    spec = importlib.util.spec_from_file_location("recursive_matcher_v2", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def selected_images(repo_root: Path, site: str, code: str) -> list[Path]:
    base = repo_root / "selected_for_matching" / site / code
    if not base.is_dir():
        return []
    return [
        p for p in sorted(base.iterdir())
        if p.suffix.lower() in IMG_EXTS and not p.name.startswith("_")
    ]


def select_device(requested: str) -> str:
    if requested != "auto":
        return requested
    if torch.cuda.is_available():
        return "cuda"
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def load_dino(repo_root: Path, device: str):
    dino_dir = repo_root / "dino-server"
    repo_dir = dino_dir / "dinov3-repo"
    ckpt = dino_dir / "dinov3_vitb16_pretrain_lvd1689m-73cec8be.pth"
    sys.path.insert(0, str(repo_dir))
    from dinov3.hub.backbones import dinov3_vitb16

    log.info("Loading local DINOv3 vitb16...")
    model = dinov3_vitb16(pretrained=False)
    state = torch.load(ckpt, map_location="cpu", weights_only=True)
    if "model" in state:
        state = state["model"]
    model.load_state_dict(state, strict=False)
    model.to(device)
    model.eval()
    return model


def image_transform():
    return transforms.Compose([
        transforms.Resize(256, interpolation=transforms.InterpolationMode.BICUBIC),
        transforms.CenterCrop(224),
        transforms.ToTensor(),
        transforms.Normalize(
            mean=(0.485, 0.456, 0.406),
            std=(0.229, 0.224, 0.225),
        ),
    ])


def l2_normalize_rows(x: np.ndarray) -> np.ndarray:
    return x / np.maximum(np.linalg.norm(x, axis=1, keepdims=True), 1e-9)


def extract_patch_tokens(model, path: Path, device: str, transform) -> np.ndarray | None:
    try:
        image = Image.open(path).convert("RGB")
    except Exception as exc:
        log.warning(f"Skipping unreadable image {path}: {exc}")
        return None

    tensor = transform(image).unsqueeze(0).to(device)
    with torch.no_grad():
        features = model.forward_features(tensor)
    tokens = features["x_norm_patchtokens"].squeeze(0).detach().cpu().numpy()
    return l2_normalize_rows(tokens.astype(np.float32))


def vlad_encode(tokens: np.ndarray, centers: np.ndarray) -> np.ndarray:
    sims = tokens @ centers.T
    assignments = sims.argmax(axis=1)
    desc = np.zeros((centers.shape[0], centers.shape[1]), dtype=np.float32)
    for token, cluster_id in zip(tokens, assignments):
        desc[cluster_id] += token - centers[cluster_id]
    desc = desc / np.maximum(np.linalg.norm(desc, axis=1, keepdims=True), 1e-9)
    flat = desc.reshape(-1)
    return flat / max(float(np.linalg.norm(flat)), 1e-9)


def sample_training_tokens(image_tokens: list[np.ndarray], max_tokens: int,
                           seed: int) -> np.ndarray:
    rng = random.Random(seed)
    sampled = []
    per_image = max(1, max_tokens // max(1, len(image_tokens)))
    for tokens in image_tokens:
        n = min(per_image, len(tokens))
        idx = rng.sample(range(len(tokens)), n)
        sampled.append(tokens[idx])
    train = np.vstack(sampled).astype(np.float32)
    if len(train) > max_tokens:
        idx = rng.sample(range(len(train)), max_tokens)
        train = train[idx]
    return l2_normalize_rows(train)


def compute_cache(viva, coelho, repo_root: Path, cache_path: Path,
                  clusters: int, max_train_tokens: int, seed: int,
                  device: str, refresh: bool):
    if cache_path.exists() and not refresh:
        log.info(f"Loading patch-VLAD cache from {cache_path}")
        with open(cache_path, "rb") as f:
            return pickle.load(f)

    model = load_dino(repo_root, device)
    transform = image_transform()
    all_items = [("vivaprimeimoveis", x["code"]) for x in viva] + [
        ("coelhodafonseca", x["code"]) for x in coelho
    ]

    raw_tokens = {}
    train_tokens = []
    for idx, (site, code) in enumerate(all_items, start=1):
        paths = selected_images(repo_root, site, code)
        listing_tokens = []
        for path in paths:
            tokens = extract_patch_tokens(model, path, device, transform)
            if tokens is not None:
                listing_tokens.append((path.name, tokens))
                train_tokens.append(tokens)
        raw_tokens[f"{site}/{code}"] = listing_tokens
        short = "viva" if "viva" in site else "coelho"
        log.info(f"[{idx}/{len(all_items)}] {short}/{code} {len(listing_tokens)} images")

    if not train_tokens:
        raise RuntimeError("No patch tokens extracted")

    log.info(f"Sampling up to {max_train_tokens} patch tokens for k-means...")
    train = sample_training_tokens(train_tokens, max_train_tokens, seed)
    log.info(f"Training VLAD vocabulary: tokens={len(train)} clusters={clusters}")
    centers, _ = kmeans2(train, clusters, minit="points", iter=25, seed=seed)
    centers = l2_normalize_rows(centers.astype(np.float32))

    cache = {
        "meta": {
            "clusters": clusters,
            "max_train_tokens": max_train_tokens,
            "seed": seed,
            "descriptor": "dino-v3-patch-vlad",
        },
        "centers": centers,
        "listings": {},
    }
    for key, listing_tokens in raw_tokens.items():
        cache["listings"][key] = {
            "files": [name for name, _ in listing_tokens],
            "vectors": [vlad_encode(tokens, centers) for _, tokens in listing_tokens],
        }

    cache_path.parent.mkdir(parents=True, exist_ok=True)
    with open(cache_path, "wb") as f:
        pickle.dump(cache, f)
    log.info(f"Saved cache -> {cache_path}")
    return cache


def get_vectors(cache: dict, site: str, code: str) -> list[np.ndarray]:
    item = cache.get("listings", {}).get(f"{site}/{code}") or {}
    return [np.asarray(v, dtype=np.float32) for v in item.get("vectors", [])]


def set_similarity(a_vecs: list[np.ndarray], b_vecs: list[np.ndarray],
                   top_k: int = 5) -> float:
    if not a_vecs or not b_vecs:
        return 0.0
    a = l2_normalize_rows(np.stack(a_vecs).astype(np.float32))
    b = l2_normalize_rows(np.stack(b_vecs).astype(np.float32))
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
    for threshold in np.arange(0.20, 0.91, 0.025):
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
    p = argparse.ArgumentParser(description="DINOv3 patch-token VLAD matcher")
    p.add_argument("--data-root", default="data")
    p.add_argument("--cache", default="data/embedding-cache-patch-vlad.pkl")
    p.add_argument("--output", default="data/auto-matches-patch-vlad.json")
    p.add_argument("--clusters", type=int, default=32)
    p.add_argument("--max-train-tokens", type=int, default=40000)
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--device", default="auto",
                   choices=["auto", "cpu", "mps", "cuda"])
    p.add_argument("--refresh-cache", action="store_true")
    return p.parse_args()


def main():
    args = parse_args()
    repo_root = Path.cwd()
    data_root = Path(args.data_root).resolve()
    matcher = load_recursive_matcher(repo_root)
    device = select_device(args.device)
    log.info(f"Device: {device}")

    viva, coelho = matcher.load_listings(data_root)
    cache = compute_cache(
        viva, coelho, repo_root, Path(args.cache), args.clusters,
        args.max_train_tokens, args.seed, device, args.refresh_cache,
    )

    log.info("Building patch-VLAD similarity matrix...")
    sim_matrix = build_matrix(viva, coelho, cache)
    log.info(f"matrix={sim_matrix.shape} nonzero={(sim_matrix > 0).sum()}")

    best, sweep = threshold_sweep(sim_matrix, viva, coelho, matcher)
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
        "session_name": "patch-vlad-experiment",
        "strategy": "dino-v3-patch-token-vlad",
        "model": {
            "backbone": "dinov3-vitb16",
            "clusters": args.clusters,
            "max_train_tokens": args.max_train_tokens,
            "device": device,
        },
        "threshold_sweep": sweep,
        "matches": [{
            **m,
            "matched_at": now,
            "reviewer": "dino-v3-patch-vlad",
            "confidence": "high" if m["similarity_score"] >= best["threshold"] + 0.05 else "medium",
            "confidence_score": m["similarity_score"],
            "strategy": "patch-token-vlad",
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
    output_path.write_text(json.dumps(output, indent=2, ensure_ascii=False))
    log.info(f"Saved -> {output_path}")


if __name__ == "__main__":
    main()
