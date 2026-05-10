#!/usr/bin/env python3
"""
Conservative ensemble over the current VLAD and MegaLoc match outputs.

The goal is precision: only keep pairs that both matchers agree on, and
surface the remaining one-sided candidates as review suggestions.

Usage:
    python3 scripts/ensemble-matcher.py \
        --vlad data/auto-matches-vlad.json \
        --megaloc data/auto-matches-megaloc.json \
        --output data/auto-matches-ensemble.json
"""

from __future__ import annotations

import argparse
import json
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


def parse_args():
    p = argparse.ArgumentParser(description="VLAD + MegaLoc consensus matcher")
    p.add_argument("--vlad", default="data/auto-matches-vlad.json")
    p.add_argument("--megaloc", default="data/auto-matches-megaloc.json")
    p.add_argument("--output", default="data/auto-matches-ensemble.json")
    return p.parse_args()


def evaluate(matches):
    predicted = {(m["viva_code"], m["coelho_code"]) for m in matches}
    tp = len(predicted & CONFIRMED_PAIRS)
    fp = len(predicted - CONFIRMED_PAIRS)
    fn = len(CONFIRMED_PAIRS - predicted)
    precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
    recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0.0
    return {
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "total": len(predicted),
    }


def load_matches(path: Path):
    payload = json.loads(path.read_text())
    return payload.get("matches", []), payload


def pair_key(match):
    return match["viva_code"], match["coelho_code"]


def merge_match(vlad_match, megaloc_match):
    merged = dict(vlad_match or megaloc_match)
    if vlad_match and megaloc_match:
        merged["source"] = "vlad+megaloc"
        merged["vlad_score"] = vlad_match.get("similarity_score")
        merged["megaloc_score"] = megaloc_match.get("similarity_score")
        merged["similarity_score"] = round(
            (
                float(vlad_match.get("similarity_score", 0.0))
                + float(megaloc_match.get("similarity_score", 0.0))
            )
            / 2.0,
            6,
        )
        merged["confidence"] = "high"
        merged["confidence_score"] = max(
            float(vlad_match.get("confidence_score", 0.0) or 0.0),
            float(megaloc_match.get("confidence_score", 0.0) or 0.0),
        )
    else:
        merged["source"] = "vlad" if vlad_match else "megaloc"
        merged["vlad_score"] = (vlad_match or {}).get("similarity_score")
        merged["megaloc_score"] = (megaloc_match or {}).get("similarity_score")
        merged["confidence"] = (vlad_match or megaloc_match).get("confidence", "medium")
        merged["confidence_score"] = (vlad_match or megaloc_match).get("confidence_score")
    merged["strategy"] = "ensemble-consensus"
    return merged


def main():
    args = parse_args()
    now = datetime.now(timezone.utc).isoformat()

    vlad_matches, vlad_payload = load_matches(Path(args.vlad))
    megaloc_matches, megaloc_payload = load_matches(Path(args.megaloc))

    vlad_map = {pair_key(m): m for m in vlad_matches}
    mega_map = {pair_key(m): m for m in megaloc_matches}
    shared_keys = sorted(set(vlad_map) & set(mega_map))
    vlad_only = sorted(set(vlad_map) - set(mega_map))
    mega_only = sorted(set(mega_map) - set(vlad_map))

    consensus = [merge_match(vlad_map[k], mega_map[k]) for k in shared_keys]
    consensus.sort(key=lambda m: (-float(m.get("similarity_score", 0.0)), m["viva_code"], m["coelho_code"]))

    review_candidates = []
    for k in vlad_only:
        review_candidates.append(merge_match(vlad_map[k], None))
    for k in mega_only:
        review_candidates.append(merge_match(None, mega_map[k]))
    review_candidates.sort(
        key=lambda m: (-float(m.get("similarity_score", 0.0)), m["viva_code"], m["coelho_code"])
    )

    consensus_eval = evaluate(consensus)
    union_eval = evaluate(consensus + review_candidates)

    output = {
        "session_started": now,
        "session_name": "ensemble-consensus",
        "strategy": "vlad-megaloc-consensus",
        "matches": consensus,
        "review_candidates": review_candidates,
        "sources": {
            "vlad": args.vlad,
            "megaloc": args.megaloc,
            "vlad_count": len(vlad_matches),
            "megaloc_count": len(megaloc_matches),
            "shared_count": len(shared_keys),
            "vlad_only_count": len(vlad_only),
            "megaloc_only_count": len(mega_only),
        },
        "stats": {
            "total_viva": vlad_payload.get("stats", {}).get("total_viva"),
            "total_coelho": vlad_payload.get("stats", {}).get("total_coelho"),
            "matched": len(consensus),
            "ground_truth_confirmed": len(CONFIRMED_PAIRS),
            **consensus_eval,
            "union": {
                "matched": len(consensus) + len(review_candidates),
                **union_eval,
            },
        },
    }

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(output, indent=2, ensure_ascii=False))
    print(f"Saved -> {out_path}")
    print(
        f"consensus: {consensus_eval['tp']} TP / {consensus_eval['fp']} FP "
        f"P={consensus_eval['precision']:.0%} R={consensus_eval['recall']:.0%} "
        f"F1={consensus_eval['f1']:.0%}"
    )


if __name__ == "__main__":
    main()
