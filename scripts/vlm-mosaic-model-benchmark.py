#!/usr/bin/env python3
"""
Compare vision-language models for mosaic image selection.

This benchmark classifies images from the human-confirmed listing set with each
candidate VLM, builds the same pool/facade/garden-first selection, and evaluates
whether the resulting images make the known matching property stand out by
perceptual image evidence.

It is intentionally scoped to the confirmed-pair listings so new model tests are
fast enough to run on a Mac CPU.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import cv2
import numpy as np
import torch
from PIL import Image
from transformers import AutoModel, AutoProcessor, SiglipProcessor


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

LABELS = {
    "pool": "a real estate photo of a swimming pool or pool deck",
    "facade": "a real estate photo of the outside facade of a house",
    "garden": "a real estate photo of a garden, yard, trees, or landscaping",
    "interior": "a real estate photo of an interior room inside a house",
}
ORDER = ["pool", "facade", "garden", "interior"]
OUTDOOR = {"pool", "facade", "garden"}
CATEGORY_PRIORITY = {"pool": 0, "facade": 1, "garden": 2}


def numeric_name_key(path: Path) -> tuple[int, str]:
    return (int(path.stem) if path.stem.isdigit() else math.inf, path.name)


def positive_sets() -> dict[str, set[str]]:
    positives: dict[str, set[str]] = {}
    for viva, coelho in CONFIRMED_PAIRS:
        positives.setdefault(viva, set()).add(coelho)
    return positives


def confirmed_codes() -> dict[str, list[str]]:
    return {
        SITE_VIVA: sorted(positive_sets()),
        SITE_COELHO: sorted({coelho for _, coelho in CONFIRMED_PAIRS}),
    }


def image_paths(repo: Path, site: str, code: str, max_images: int | None) -> list[Path]:
    base = repo / "data" / site / "cache" / code
    paths = sorted(
        [p for p in base.glob("*") if p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}],
        key=numeric_name_key,
    )
    return paths[:max_images] if max_images else paths


def model_key(model_id: str) -> str:
    return model_id.replace("/", "__")


def load_cache(path: Path) -> dict:
    if not path.exists():
        return {}
    return json.loads(path.read_text())


def save_cache(path: Path, cache: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(cache, indent=2))


def classify_image(model, processor, model_id: str, image_path: Path) -> dict:
    image = Image.open(image_path).convert("RGB")
    prompts = [LABELS[k] for k in ORDER]
    inputs = processor(text=prompts, images=image, padding=True, return_tensors="pt")
    with torch.no_grad():
        outputs = model(**inputs)
    logits = outputs.logits_per_image.squeeze(0).detach().cpu()
    if "siglip" in model_id.lower():
        probs = torch.sigmoid(logits)
    else:
        probs = torch.softmax(logits, dim=0)
    scores = {ORDER[i]: float(probs[i]) for i in range(len(ORDER))}
    best = max(scores, key=scores.get)
    return {"label": best, "scores": scores}


def classify_dataset(
    repo: Path,
    model_id: str,
    cache_path: Path,
    max_images_per_listing: int | None,
) -> dict:
    cache = load_cache(cache_path)
    model_cache = cache.setdefault(model_key(model_id), {})

    model = AutoModel.from_pretrained(model_id).eval()
    processor = (
        SiglipProcessor.from_pretrained(model_id)
        if "siglip" in model_id.lower()
        else AutoProcessor.from_pretrained(model_id)
    )

    for site, codes in confirmed_codes().items():
        for code in codes:
            for path in image_paths(repo, site, code, max_images_per_listing):
                rel = str(path.relative_to(repo))
                if rel not in model_cache:
                    model_cache[rel] = classify_image(model, processor, model_id, path)

    save_cache(cache_path, cache)
    return model_cache


def select_images(
    repo: Path,
    site: str,
    code: str,
    classifications: dict,
    max_images_per_listing: int | None,
) -> list[tuple[Path, str]]:
    scored = []
    for path in image_paths(repo, site, code, max_images_per_listing):
        rel = str(path.relative_to(repo))
        pred = classifications.get(rel, {})
        label = pred.get("label")
        if label not in OUTDOOR:
            continue
        scores = pred.get("scores", {})
        scored.append((path, label, float(scores.get(label, 0.0))))

    scored.sort(key=lambda x: (CATEGORY_PRIORITY[x[1]], -x[2], numeric_name_key(x[0])))
    pools = [x for x in scored if x[1] == "pool"][:4]
    facades = [x for x in scored if x[1] == "facade"][:2]
    gardens = [x for x in scored if x[1] == "garden"][:2]
    selected = pools + facades + gardens
    return [(path, label) for path, label, _ in selected]


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
    sims = sorted((hash_similarity(a, b) for a in a_hashes for b in b_hashes), reverse=True)
    return float(np.mean(sims[: min(3, len(sims))]))


def evaluate_model(
    repo: Path,
    model_id: str,
    classifications: dict,
    max_images_per_listing: int | None,
) -> dict:
    positives = positive_sets()
    coelho_codes = confirmed_codes()[SITE_COELHO]
    selected_cache: dict[tuple[str, str], list[tuple[Path, str]]] = {}
    hash_cache: dict[tuple[str, str], list[np.ndarray]] = {}
    category_counts = {"pool": 0, "facade": 0, "garden": 0, "interior": 0}

    def selected(site: str, code: str) -> list[tuple[Path, str]]:
        key = (site, code)
        if key not in selected_cache:
            selected_cache[key] = select_images(repo, site, code, classifications, max_images_per_listing)
            for _, label in selected_cache[key]:
                category_counts[label] = category_counts.get(label, 0) + 1
        return selected_cache[key]

    def hashes(site: str, code: str) -> list[np.ndarray]:
        key = (site, code)
        if key not in hash_cache:
            hash_cache[key] = [h for h in (phash(path) for path, _ in selected(site, code)) if h is not None]
        return hash_cache[key]

    ranks = []
    reciprocals = []
    r1 = r3 = r5 = 0
    direct_scores = []
    selected_counts = []

    for viva_code, true_coelhos in positives.items():
        selected_counts.append(len(selected(SITE_VIVA, viva_code)))
        viva_hashes = hashes(SITE_VIVA, viva_code)
        scored = []
        for coelho_code in coelho_codes:
            selected_counts.append(len(selected(SITE_COELHO, coelho_code)))
            score = image_set_score(viva_hashes, hashes(SITE_COELHO, coelho_code))
            scored.append((coelho_code, score))
            if coelho_code in true_coelhos:
                direct_scores.append(score)
        scored.sort(key=lambda x: x[1], reverse=True)
        rank = min(idx + 1 for idx, (code, _) in enumerate(scored) if code in true_coelhos)
        ranks.append(rank)
        reciprocals.append(1.0 / rank)
        r1 += int(rank <= 1)
        r3 += int(rank <= 3)
        r5 += int(rank <= 5)

    n = len(ranks)
    return {
        "model": model_id,
        "candidate_coelho_count": len(coelho_codes),
        "evaluated_viva": n,
        "recall_at_1": r1 / n,
        "recall_at_3": r3 / n,
        "recall_at_5": r5 / n,
        "mrr": float(np.mean(reciprocals)),
        "median_rank": float(np.median(ranks)),
        "mean_rank": float(np.mean(ranks)),
        "mean_direct_pair_score": float(np.mean(direct_scores)),
        "mean_selected_images": float(np.mean(selected_counts)),
        "category_counts": category_counts,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--models", nargs="+", required=True)
    parser.add_argument("--max-images-per-listing", type=int, default=24)
    parser.add_argument("--cache", default="data/vlm-mosaic-model-cache.json")
    parser.add_argument("--output", default="data/vlm-mosaic-model-benchmark.json")
    args = parser.parse_args()

    repo = Path(args.repo_root).resolve()
    cache_path = repo / args.cache
    results = []

    for model_id in args.models:
        classifications = classify_dataset(repo, model_id, cache_path, args.max_images_per_listing)
        results.append(evaluate_model(repo, model_id, classifications, args.max_images_per_listing))

    output = {
        "confirmed_pair_count": len(CONFIRMED_PAIRS),
        "unique_viva_count": len(positive_sets()),
        "max_images_per_listing": args.max_images_per_listing,
        "labels": LABELS,
        "metric_notes": {
            "rank_metrics": "Ranks the known true Coelho listing among confirmed Coelho candidates using selected images and top-3 perceptual-hash similarity.",
            "scope": "Confirmed-pair listing set only, intended for fast model comparison before full reclassification.",
        },
        "results": results,
    }
    out = repo / args.output
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(output, indent=2))

    print("model,R@1,R@3,R@5,MRR,median_rank,mean_rank,mean_pair_score,mean_images")
    for r in results:
        print(
            f"{r['model']},{r['recall_at_1']:.3f},{r['recall_at_3']:.3f},"
            f"{r['recall_at_5']:.3f},{r['mrr']:.3f},{r['median_rank']:.1f},"
            f"{r['mean_rank']:.1f},{r['mean_direct_pair_score']:.3f},"
            f"{r['mean_selected_images']:.1f}"
        )
    print(f"Wrote {out}")


if __name__ == "__main__":
    main()
