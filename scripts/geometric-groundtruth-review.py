#!/usr/bin/env python3
"""
Build a focused review file for high-geometric-evidence pairs that are not in
the active confirmed-pair benchmark.

The output is meant for ground-truth expansion, not automatic matching.

Usage:
    python3 scripts/geometric-groundtruth-review.py \
      --geometric data/auto-matches-geometric-rerank.json \
      --data-root data \
      --output data/geometric-groundtruth-review.json
"""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path


CONFIRMED_PAIRS = {
    ("17388", "354149"), ("16886", "617978"), ("16626", "597308"),
    ("13254", "356006"), ("17116", "674139"), ("5380", "467562"),
    ("16026", "674557"), ("12854", "616435"), ("13572", "653980"),
    ("16385", "663777"), ("16892", "663984"), ("14127", "663462"),
    ("2075", "502738"), ("17722", "677257"), ("17378", "659639"),
    ("7597", "358601"), ("18035", "661014"), ("14138", "660058"),
    ("16117", "628299"), ("17378", "425516"), ("12814", "682781"),
}

REJECTED_PAIRS = {
    ("6930", "395513"),  # Coelho page blank / code not found.
}


def parse_args():
    p = argparse.ArgumentParser(description="Build geometric ground-truth review file")
    p.add_argument("--geometric", default="data/auto-matches-geometric-rerank.json")
    p.add_argument("--data-root", default="data")
    p.add_argument("--output", default="data/geometric-groundtruth-review.json")
    p.add_argument("--markdown-output", default=None,
                   help="Optional markdown companion output. Defaults to JSON stem + .md")
    p.add_argument("--min-score", type=float, default=0.75)
    p.add_argument("--min-inliers", type=int, default=25)
    p.add_argument("--min-ratio", type=float, default=0.50)
    p.add_argument("--include-reviewed", action="store_true",
                   help="Include pairs already in the active confirmed set")
    return p.parse_args()


def parse_price(value):
    if not value:
        return None
    m = re.search(r"[\d.,]+", str(value))
    if not m:
        return None
    try:
        return float(m.group(0).replace(".", "").replace(",", "."))
    except ValueError:
        return None


def parse_area(value):
    if not value:
        return None
    m = re.search(r"(\d+(?:[.,]\d+)?)", str(value))
    return float(m.group(1).replace(",", ".")) if m else None


def load_metadata(data_root: Path):
    viva_raw = json.loads(
        (data_root / "vivaprimeimoveis" / "listings" / "all-listings.json").read_text()
    )["listings"]
    coelho_raw = json.loads(
        (data_root / "coelhodafonseca" / "listings" / "all-listings.json").read_text()
    )["listings"]

    viva = {}
    for listing in viva_raw:
        specs = listing.get("detailedData", {}).get("specs", {})
        code = str(listing["propertyCode"])
        viva[code] = {
            "code": code,
            "url": listing.get("url", ""),
            "price": parse_price(listing.get("price")),
            "price_raw": listing.get("price"),
            "area": parse_area(specs.get("area_construida")),
            "beds": specs.get("dormitorios"),
        }

    coelho = {}
    for listing in coelho_raw:
        code = str(listing["propertyCode"])
        features = listing.get("features", "")
        area_m = re.search(r"(\d+(?:[.,]\d+)?)\s*m²\s*construída", features, re.I)
        beds_m = re.search(r"(\d+)\s*dorms?", features, re.I)
        coelho[code] = {
            "code": code,
            "url": listing.get("url", ""),
            "price": parse_price(listing.get("price")),
            "price_raw": listing.get("price"),
            "area": float(area_m.group(1).replace(",", ".")) if area_m else None,
            "beds": int(beds_m.group(1)) if beds_m else None,
        }

    return viva, coelho


def rel_diff(a, b):
    if not a or not b:
        return None
    return abs(a - b) / ((a + b) / 2.0)


def selected_path(site: str, code: str, filename: str):
    return str(Path("selected_for_matching") / site / code / filename)


def build_review_item(candidate, viva_meta, coelho_meta):
    pair = (candidate["viva_code"], candidate["coelho_code"])
    viva = viva_meta.get(pair[0], {})
    coelho = coelho_meta.get(pair[1], {})
    top_pairs = []
    for item in candidate.get("top_image_pairs", []):
        top_pairs.append({
            **item,
            "viva_path": selected_path("vivaprimeimoveis", pair[0], item["a_image"]),
            "coelho_path": selected_path("coelhodafonseca", pair[1], item["b_image"]),
        })

    return {
        "viva_code": pair[0],
        "coelho_code": pair[1],
        "review_status": "needs_review",
        "current_benchmark_label": "false_positive",
        "sources": candidate.get("sources", []),
        "source_scores": candidate.get("source_scores", {}),
        "geometric": {
            "score": candidate.get("geometric_score"),
            "best_inliers": candidate.get("best_inliers"),
            "best_inlier_ratio": candidate.get("best_inlier_ratio"),
            "support_pairs_8": candidate.get("support_pairs_8"),
            "support_pairs_12": candidate.get("support_pairs_12"),
            "top_image_pairs": top_pairs,
        },
        "viva": viva,
        "coelho": coelho,
        "metadata_diffs": {
            "price_rel_diff": rel_diff(viva.get("price"), coelho.get("price")),
            "area_rel_diff": rel_diff(viva.get("area"), coelho.get("area")),
            "beds_match": (
                None if viva.get("beds") is None or coelho.get("beds") is None
                else int(viva["beds"]) == int(coelho["beds"])
            ),
        },
    }


def main():
    args = parse_args()
    data_root = Path(args.data_root)
    geometric = json.loads(Path(args.geometric).read_text())
    viva_meta, coelho_meta = load_metadata(data_root)

    candidates = []
    for candidate in geometric.get("all_candidates", []):
        pair = (candidate["viva_code"], candidate["coelho_code"])
        if pair in CONFIRMED_PAIRS and not args.include_reviewed:
            continue
        if pair in REJECTED_PAIRS and not args.include_reviewed:
            continue
        if candidate.get("geometric_score", 0.0) < args.min_score:
            continue
        if candidate.get("best_inliers", 0) < args.min_inliers:
            continue
        if candidate.get("best_inlier_ratio", 0.0) < args.min_ratio:
            continue
        candidates.append(build_review_item(candidate, viva_meta, coelho_meta))

    candidates.sort(
        key=lambda x: (
            -x["geometric"]["score"],
            -x["geometric"]["best_inliers"],
            x["viva_code"],
            x["coelho_code"],
        )
    )

    output = {
        "session_started": datetime.now(timezone.utc).isoformat(),
        "session_name": "geometric-groundtruth-review",
        "source": args.geometric,
        "purpose": "Review high-geometric-evidence pairs currently absent from active ground truth.",
        "filters": {
            "min_score": args.min_score,
            "min_inliers": args.min_inliers,
            "min_ratio": args.min_ratio,
            "include_reviewed": args.include_reviewed,
        },
        "excluded_rejected_pairs": sorted([list(p) for p in REJECTED_PAIRS]),
        "count": len(candidates),
        "review_instructions": {
            "confirm": "Set review_status to confirmed if the pair is the same physical property.",
            "reject": "Set review_status to rejected if the pair is only visually similar or shares a reused marketing image.",
            "then": "Confirmed pairs should be added to CONFIRMED_PAIRS in matcher scripts and MATCHES.md before rerunning benchmarks.",
        },
        "candidates": candidates,
    }

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(output, indent=2, ensure_ascii=False))
    markdown_path = Path(args.markdown_output) if args.markdown_output else output_path.with_suffix(".md")
    markdown_path.write_text(to_markdown(output, markdown_path))
    print(f"Saved -> {output_path}")
    print(f"Saved -> {markdown_path}")
    print(f"review candidates: {len(candidates)}")
    for item in candidates:
        print(
            f"{item['viva_code']}↔{item['coelho_code']} "
            f"score={item['geometric']['score']} "
            f"inliers={item['geometric']['best_inliers']} "
            f"ratio={item['geometric']['best_inlier_ratio']} "
            f"sources={','.join(item['sources'])}"
        )


def rel_from_markdown(markdown_path: Path, path: str) -> str:
    try:
        return str(Path(path).resolve().relative_to(markdown_path.parent.resolve()))
    except ValueError:
        return str(Path("..") / path)


def to_markdown(output: dict, markdown_path: Path) -> str:
    lines = [
        "# Geometric Ground Truth Review",
        "",
        f"Source: `{output['source']}`",
        f"Candidates: {output['count']}",
        "",
        "These pairs are not in the active confirmed benchmark, but passed the geometric evidence filter.",
        "Confirm only if the pair is the same physical property, not merely a reused marketing/detail image.",
        "",
    ]
    for idx, item in enumerate(output["candidates"], start=1):
        viva_url = item["viva"].get("url") or ""
        coelho_url = item["coelho"].get("url") or ""
        geom = item["geometric"]
        diffs = item["metadata_diffs"]
        lines.extend([
            f"## {idx}. Viva {item['viva_code']} <-> Coelho {item['coelho_code']}",
            "",
            f"- Review status: `{item['review_status']}`",
            f"- Sources: {', '.join(item['sources'])}",
            f"- Geometry: score `{geom['score']}`, inliers `{geom['best_inliers']}`, ratio `{geom['best_inlier_ratio']}`",
            f"- Price diff: `{diffs['price_rel_diff']}`",
            f"- Area diff: `{diffs['area_rel_diff']}`",
            f"- Beds match: `{diffs['beds_match']}`",
            f"- Viva: [{item['viva_code']}]({viva_url})",
            f"- Coelho: [{item['coelho_code']}]({coelho_url})",
            "",
            "| Viva image | Coelho image | Inliers | Ratio |",
            "|---|---|---:|---:|",
        ])
        for pair in geom.get("top_image_pairs", [])[:3]:
            viva_rel = rel_from_markdown(markdown_path, pair["viva_path"])
            coelho_rel = rel_from_markdown(markdown_path, pair["coelho_path"])
            lines.append(
                f"| <img src=\"{viva_rel}\" width=\"220\"> | "
                f"<img src=\"{coelho_rel}\" width=\"220\"> | "
                f"{pair['inliers']} | {pair['inlier_ratio']} |"
            )
        lines.append("")
    return "\n".join(lines)


if __name__ == "__main__":
    main()
