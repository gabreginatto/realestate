#!/usr/bin/env python3
"""
Geometric reranker experiment for matcher candidates.

This script takes candidate pairs from existing matcher outputs, compares the
actual selected images with ORB feature matching + RANSAC homography, sweeps
filter thresholds against the current confirmed-pair set, and writes a separate
experiment output.

Usage:
    python3 scripts/geometric-reranker.py \
      --inputs data/auto-matches-vlad.json \
               data/auto-matches-megaloc.json \
               data/auto-matches-patch-vlad.json \
      --output data/auto-matches-geometric-rerank.json
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np


CONFIRMED_PAIRS = {
    ("17388", "354149"), ("16886", "617978"), ("16626", "597308"),
    ("13254", "356006"), ("17116", "674139"), ("5380", "467562"),
    ("16026", "674557"), ("12854", "616435"), ("13572", "653980"),
    ("16385", "663777"), ("16892", "663984"), ("14127", "663462"),
    ("2075", "502738"), ("17722", "677257"), ("17378", "659639"),
    ("7597", "358601"), ("18035", "661014"), ("14138", "660058"),
    ("16117", "628299"), ("17378", "425516"), ("12814", "682781"),
}

IMG_EXTS = {".jpg", ".jpeg", ".png", ".webp"}


def parse_args():
    p = argparse.ArgumentParser(description="Geometric candidate reranker")
    p.add_argument("--inputs", nargs="+", required=True)
    p.add_argument("--output", default="data/auto-matches-geometric-rerank.json")
    p.add_argument("--selected-root", default="selected_for_matching")
    p.add_argument("--max-size", type=int, default=900)
    p.add_argument("--max-images", type=int, default=8)
    p.add_argument("--nfeatures", type=int, default=2500)
    return p.parse_args()


def evaluate(matches):
    predicted = {(m["viva_code"], m["coelho_code"]) for m in matches}
    tp = len(predicted & CONFIRMED_PAIRS)
    fp = len(predicted - CONFIRMED_PAIRS)
    fn = len(CONFIRMED_PAIRS - predicted)
    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
    return {
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "total": len(predicted),
    }


def load_candidates(paths: list[str]):
    candidates = {}
    source_stats = {}
    for path_str in paths:
        path = Path(path_str)
        payload = json.loads(path.read_text())
        source = path.stem.replace("auto-matches-", "")
        source_stats[source] = payload.get("stats", {})
        for match in payload.get("matches", []):
            key = (match["viva_code"], match["coelho_code"])
            item = candidates.setdefault(key, {
                "viva_code": key[0],
                "coelho_code": key[1],
                "sources": [],
                "source_scores": {},
            })
            item["sources"].append(source)
            item["source_scores"][source] = match.get("similarity_score")
    return candidates, source_stats


def selected_images(root: Path, site: str, code: str, max_images: int) -> list[Path]:
    base = root / site / code
    if not base.is_dir():
        return []
    paths = [
        p for p in sorted(base.iterdir())
        if p.suffix.lower() in IMG_EXTS and not p.name.startswith("_")
    ]
    return paths[:max_images]


def read_gray(path: Path, max_size: int):
    image = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
    if image is None:
        return None
    h, w = image.shape[:2]
    scale = min(1.0, max_size / max(h, w))
    if scale < 1.0:
        image = cv2.resize(
            image,
            (int(w * scale), int(h * scale)),
            interpolation=cv2.INTER_AREA,
        )
    return image


def image_features(paths: list[Path], orb, max_size: int):
    features = []
    for path in paths:
        image = read_gray(path, max_size)
        if image is None:
            continue
        keypoints, desc = orb.detectAndCompute(image, None)
        if desc is None or len(keypoints) < 8:
            continue
        features.append({
            "path": path,
            "keypoints": keypoints,
            "desc": desc,
        })
    return features


def compare_images(a, b, matcher):
    pairs = matcher.knnMatch(a["desc"], b["desc"], k=2)
    good = []
    for pair in pairs:
        if len(pair) < 2:
            continue
        m, n = pair
        if m.distance < 0.75 * n.distance:
            good.append(m)

    if len(good) < 4:
        return {
            "good_matches": len(good),
            "inliers": 0,
            "inlier_ratio": 0.0,
            "score": 0.0,
            "a_image": a["path"].name,
            "b_image": b["path"].name,
        }

    src = np.float32([a["keypoints"][m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
    dst = np.float32([b["keypoints"][m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
    _, mask = cv2.findHomography(src, dst, cv2.RANSAC, 5.0)
    if mask is None:
        inliers = 0
    else:
        inliers = int(mask.ravel().sum())
    ratio = inliers / len(good) if good else 0.0
    score = 0.70 * min(inliers / 35.0, 1.0) + 0.30 * min(ratio / 0.35, 1.0)
    return {
        "good_matches": len(good),
        "inliers": inliers,
        "inlier_ratio": round(ratio, 4),
        "score": round(float(score), 6),
        "a_image": a["path"].name,
        "b_image": b["path"].name,
    }


def compare_listings(viva_features, coelho_features, matcher):
    image_results = []
    for a in viva_features:
        for b in coelho_features:
            image_results.append(compare_images(a, b, matcher))
    image_results.sort(key=lambda x: (x["score"], x["inliers"], x["good_matches"]), reverse=True)
    if not image_results:
        return {
            "geometric_score": 0.0,
            "best_inliers": 0,
            "best_inlier_ratio": 0.0,
            "support_pairs_8": 0,
            "support_pairs_12": 0,
            "top_image_pairs": [],
        }
    top = image_results[:5]
    best = image_results[0]
    support_8 = len([r for r in image_results if r["inliers"] >= 8 and r["inlier_ratio"] >= 0.18])
    support_12 = len([r for r in image_results if r["inliers"] >= 12 and r["inlier_ratio"] >= 0.20])
    top_score = float(np.mean([r["score"] for r in top]))
    geom_score = 0.65 * best["score"] + 0.25 * top_score + 0.10 * min(support_8 / 3.0, 1.0)
    return {
        "geometric_score": round(float(geom_score), 6),
        "best_inliers": best["inliers"],
        "best_inlier_ratio": best["inlier_ratio"],
        "support_pairs_8": support_8,
        "support_pairs_12": support_12,
        "top_image_pairs": top,
    }


def filter_matches(scored, min_score: float, min_inliers: int,
                   min_ratio: float, min_support: int):
    matches = []
    for item in scored:
        if item["geometric_score"] < min_score:
            continue
        if item["best_inliers"] < min_inliers:
            continue
        if item["best_inlier_ratio"] < min_ratio:
            continue
        if item["support_pairs_8"] < min_support:
            continue
        matches.append(item)
    return matches


def threshold_sweep(scored):
    best = None
    rows = []
    for min_score in np.arange(0.0, 0.81, 0.05):
        for min_inliers in (0, 6, 8, 10, 12, 16, 20):
            for min_ratio in (0.0, 0.12, 0.16, 0.20, 0.25, 0.30):
                for min_support in (0, 1, 2):
                    matches = filter_matches(
                        scored,
                        float(round(min_score, 3)),
                        min_inliers,
                        min_ratio,
                        min_support,
                    )
                    result = evaluate(matches)
                    row = {
                        "min_score": float(round(min_score, 3)),
                        "min_inliers": min_inliers,
                        "min_ratio": min_ratio,
                        "min_support": min_support,
                        **result,
                    }
                    rows.append(row)
                    if best is None or (
                        result["f1"], result["precision"], result["recall"]
                    ) > (
                        best["f1"], best["precision"], best["recall"]
                    ):
                        best = row
    return best, rows


def main():
    args = parse_args()
    selected_root = Path(args.selected_root)
    candidates, source_stats = load_candidates(args.inputs)
    orb = cv2.ORB_create(nfeatures=args.nfeatures)
    matcher = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=False)

    feature_cache = {}

    def get_listing_features(site: str, code: str):
        key = (site, code)
        if key not in feature_cache:
            paths = selected_images(selected_root, site, code, args.max_images)
            feature_cache[key] = image_features(paths, orb, args.max_size)
        return feature_cache[key]

    scored = []
    for idx, item in enumerate(candidates.values(), start=1):
        viva_features = get_listing_features("vivaprimeimoveis", item["viva_code"])
        coelho_features = get_listing_features("coelhodafonseca", item["coelho_code"])
        geom = compare_listings(viva_features, coelho_features, matcher)
        scored_item = {**item, **geom}
        scored.append(scored_item)
        print(
            f"[{idx}/{len(candidates)}] {item['viva_code']}↔{item['coelho_code']} "
            f"score={scored_item['geometric_score']:.3f} "
            f"inliers={scored_item['best_inliers']} "
            f"sources={','.join(scored_item['sources'])}"
        )

    scored.sort(key=lambda x: (-x["geometric_score"], -x["best_inliers"]))
    best, sweep = threshold_sweep(scored)
    matches = filter_matches(
        scored,
        best["min_score"],
        best["min_inliers"],
        best["min_ratio"],
        best["min_support"],
    )
    final_eval = evaluate(matches)

    now = datetime.now(timezone.utc).isoformat()
    output = {
        "session_started": now,
        "session_name": "geometric-reranker-experiment",
        "strategy": "orb-ransac-geometric-rerank",
        "inputs": args.inputs,
        "source_stats": source_stats,
        "best_filter": {
            "min_score": best["min_score"],
            "min_inliers": best["min_inliers"],
            "min_ratio": best["min_ratio"],
            "min_support": best["min_support"],
        },
        "threshold_sweep": sweep,
        "matches": [{
            **m,
            "matched_at": now,
            "reviewer": "orb-ransac",
            "similarity_score": m["geometric_score"],
            "confidence_score": m["geometric_score"],
            "confidence": "high" if m["geometric_score"] >= best["min_score"] + 0.10 else "medium",
            "strategy": "geometric-rerank",
        } for m in matches],
        "all_candidates": scored,
        "stats": {
            "candidate_count": len(scored),
            "matched": len(matches),
            "ground_truth_confirmed": len(CONFIRMED_PAIRS),
            **final_eval,
        },
    }

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(output, indent=2, ensure_ascii=False))
    print(
        f"Saved -> {out_path}\n"
        f"best filter={output['best_filter']} "
        f"P={final_eval['precision']:.0%} R={final_eval['recall']:.0%} "
        f"F1={final_eval['f1']:.0%} TP={final_eval['tp']} FP={final_eval['fp']}"
    )


if __name__ == "__main__":
    main()
