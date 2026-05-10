#!/usr/bin/env python3
"""
Tiered matcher experiment.

Builds a practical review queue from retrieval + geometry signals:

- auto-review-high: MegaLoc candidate with strong geometric verification
- review-normal: MegaLoc candidate without strong geometry
- review-recall: patch-VLAD-only candidate
- reject-low: weak geometry + weak model agreement

Rejected/dead-code pairs are excluded from output. Metrics include both direct
pair scoring and duplicate-aware/entity scoring.

Usage:
    python3 scripts/tiered-matcher.py \
      --geometric data/auto-matches-geometric-rerank.json \
      --output data/auto-matches-tiered.json
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

REJECTED_PAIRS = {
    ("6930", "395513"),  # Coelho page blank / code not found.
}


class UnionFind:
    def __init__(self):
        self.parent = {}

    def find(self, x):
        if x not in self.parent:
            self.parent[x] = x
        if self.parent[x] != x:
            self.parent[x] = self.find(self.parent[x])
        return self.parent[x]

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[rb] = ra


def parse_args():
    p = argparse.ArgumentParser(description="Tiered property matcher")
    p.add_argument("--geometric", default="data/auto-matches-geometric-rerank.json")
    p.add_argument("--output", default="data/auto-matches-tiered.json")
    p.add_argument("--exclude-summary", default=None,
                   help="Trial summary JSON whose confirmed/reviewed pairs should be excluded.")
    p.add_argument("--exclusions", default=None,
                   help="Exclusions JSON produced by prepare-next-review-round.js.")
    p.add_argument("--round", type=int, default=1)
    p.add_argument("--high-score", type=float, default=0.76)
    p.add_argument("--high-inliers", type=int, default=20)
    return p.parse_args()


def build_components():
    uf = UnionFind()
    for viva_code, coelho_code in CONFIRMED_PAIRS:
        uf.union(f"v:{viva_code}", f"c:{coelho_code}")
    components = {}
    for node in list(uf.parent):
        components.setdefault(uf.find(node), set()).add(node)
    node_to_component = {
        node: root for root, nodes in components.items() for node in nodes
    }
    return components, node_to_component


def evaluate(matches):
    predicted = {(m["viva_code"], m["coelho_code"]) for m in matches}
    predicted = predicted - REJECTED_PAIRS

    pair_tp = predicted & CONFIRMED_PAIRS
    pair_fp = predicted - CONFIRMED_PAIRS
    pair_fn = CONFIRMED_PAIRS - predicted

    components, node_to_component = build_components()
    entity_tp = set()
    entity_fp = set()
    found_components = set()
    for viva_code, coelho_code in predicted:
        v_node = f"v:{viva_code}"
        c_node = f"c:{coelho_code}"
        if (
            v_node in node_to_component
            and c_node in node_to_component
            and node_to_component[v_node] == node_to_component[c_node]
        ):
            entity_tp.add((viva_code, coelho_code))
            found_components.add(node_to_component[v_node])
        else:
            entity_fp.add((viva_code, coelho_code))

    def metrics(tp, fp, fn):
        precision = tp / (tp + fp) if tp + fp else 0.0
        recall = tp / (tp + fn) if tp + fn else 0.0
        f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        return {
            "tp": tp,
            "fp": fp,
            "fn": fn,
            "precision": precision,
            "recall": recall,
            "f1": f1,
        }

    return {
        "matched": len(predicted),
        "pair": metrics(len(pair_tp), len(pair_fp), len(pair_fn)),
        "entity_edge": metrics(
            len(entity_tp),
            len(entity_fp),
            len(CONFIRMED_PAIRS) - len(entity_tp),
        ),
        "entity": {
            "found": len(found_components),
            "total": len(components),
            "recall": len(found_components) / len(components) if components else 0.0,
        },
    }


def tier_for(candidate, high_score: float, high_inliers: int):
    sources = set(candidate.get("sources", []))
    strong_geometry = (
        candidate.get("geometric_score", 0.0) >= high_score
        and candidate.get("best_inliers", 0) >= high_inliers
    )
    if "megaloc" in sources and strong_geometry:
        return "auto-review-high"
    if "megaloc" in sources:
        return "review-normal"
    if "patch-vlad" in sources:
        return "review-recall"
    return "reject-low"


def is_review_tier(tier: str) -> bool:
    return tier in {"auto-review-high", "review-normal", "review-recall"}


def legacy_tier(tier: str) -> str:
    return {
        "auto-review-high": "high",
        "review-normal": "normal",
        "review-recall": "recall",
        "reject-low": "low",
    }[tier]


def confidence_for_tier(tier: str) -> str:
    return {
        "auto-review-high": "high",
        "review-normal": "medium",
        "review-recall": "low",
        "reject-low": "low",
    }[tier]


def tier_priority(tier: str) -> int:
    return {
        "auto-review-high": 0,
        "review-normal": 1,
        "review-recall": 2,
        "reject-low": 3,
    }.get(tier, 4)


def pair_key(viva_code: str, coelho_code: str) -> str:
    return f"{viva_code}::{coelho_code}"


def load_exclusions(args):
    confirmed_viva = set()
    confirmed_coelho = set()
    reviewed_pairs = set()

    if args.exclude_summary:
        summary = json.loads(Path(args.exclude_summary).read_text())
        for p in summary.get("confirmed_matches", []):
            if p.get("viva_code"):
                confirmed_viva.add(str(p["viva_code"]))
            if p.get("coelho_code"):
                confirmed_coelho.add(str(p["coelho_code"]))
            if p.get("viva_code") and p.get("coelho_code"):
                reviewed_pairs.add(pair_key(str(p["viva_code"]), str(p["coelho_code"])))
        for p in summary.get("viva_without_confirmed_coelho", []):
            if p.get("viva_code") and p.get("attempted_coelho_code"):
                reviewed_pairs.add(pair_key(str(p["viva_code"]), str(p["attempted_coelho_code"])))

    if args.exclusions:
        exclusions = json.loads(Path(args.exclusions).read_text())
        confirmed_viva.update(map(str, exclusions.get("confirmed_viva_codes", [])))
        confirmed_coelho.update(map(str, exclusions.get("confirmed_coelho_codes", [])))
        reviewed_pairs.update(map(str, exclusions.get("reviewed_pair_keys", [])))

    return confirmed_viva, confirmed_coelho, reviewed_pairs


def print_tier_stats(tier_stats: dict, key: str):
    s = tier_stats[key]
    pair = s["pair"]
    print(
        f"{key:24s} count={s['count']:2d} "
        f"TP={pair['tp']:2d} FP={pair['fp']:2d} "
        f"P={pair['precision']:.1%} R={pair['recall']:.1%} F1={pair['f1']:.1%}"
    )


def main():
    args = parse_args()
    payload = json.loads(Path(args.geometric).read_text())
    now = datetime.now(timezone.utc).isoformat()
    confirmed_viva, confirmed_coelho, reviewed_pairs = load_exclusions(args)

    matches = []
    for candidate in payload.get("all_candidates", []):
        pair = (candidate["viva_code"], candidate["coelho_code"])
        key = pair_key(str(candidate["viva_code"]), str(candidate["coelho_code"]))
        if pair in REJECTED_PAIRS:
            continue
        if str(candidate["viva_code"]) in confirmed_viva:
            continue
        if str(candidate["coelho_code"]) in confirmed_coelho:
            continue
        if key in reviewed_pairs:
            continue
        tier = tier_for(candidate, args.high_score, args.high_inliers)
        include_in_review = is_review_tier(tier)
        matches.append({
            **candidate,
            "tier": tier,
            "legacy_tier": legacy_tier(tier),
            "include_in_review": include_in_review,
            "round": args.round,
            "matched_at": now,
            "reviewer": "tiered-megaloc-patch-geometry",
            "similarity_score": candidate.get("geometric_score", 0.0),
            "confidence_score": candidate.get("geometric_score", 0.0),
            "confidence": confidence_for_tier(tier),
            "strategy": "tiered-megaloc-patch-geometry",
        })

    matches.sort(
        key=lambda m: (
            tier_priority(m["tier"]),
            -m.get("geometric_score", 0.0),
            -m.get("best_inliers", 0),
            m["viva_code"],
            m["coelho_code"],
        )
    )

    tier_stats = {}
    cumulative = []
    review_matches = [m for m in matches if m["include_in_review"]]
    low_matches = [m for m in matches if not m["include_in_review"]]
    for tier in ("auto-review-high", "review-normal", "review-recall"):
        tier_matches = [m for m in matches if m["tier"] == tier]
        tier_stats[tier] = {
            "count": len(tier_matches),
            **evaluate(tier_matches),
        }
        cumulative.extend(tier_matches)
        tier_stats[f"through_{tier}"] = {
            "count": len(cumulative),
            **evaluate(cumulative),
        }
    tier_stats["reject-low"] = {
        "count": len(low_matches),
        **evaluate(low_matches),
    }
    tier_stats["review-output"] = {
        "count": len(review_matches),
        **evaluate(review_matches),
    }

    output = {
        "session_started": now,
        "session_name": f"tiered-matcher-pass-{args.round}",
        "strategy": "tiered-megaloc-patch-geometry",
        "source": args.geometric,
        "round": args.round,
        "policy": {
            "auto-review-high": (
                "MegaLoc candidate with geometric_score >= "
                f"{args.high_score} and best_inliers >= {args.high_inliers}"
            ),
            "review-normal": "MegaLoc candidate without strong geometry",
            "review-recall": "patch-VLAD candidate without MegaLoc",
            "reject-low": "weak geometry + weak model agreement; kept for audit but not review",
            "excluded": sorted([list(p) for p in REJECTED_PAIRS]),
            "confirmed_viva_removed": len(confirmed_viva),
            "confirmed_coelho_removed": len(confirmed_coelho),
            "reviewed_pairs_removed": len(reviewed_pairs),
        },
        "matches": matches,
        "review_matches": review_matches,
        "low_rejected": low_matches,
        "stats": {
            "ground_truth_confirmed": len(CONFIRMED_PAIRS),
            "entity_count": len(build_components()[0]),
            "matched": len(review_matches),
            **evaluate(review_matches),
            "tiers": tier_stats,
        },
    }

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(output, indent=2, ensure_ascii=False))

    print(f"Saved -> {out_path}")
    for key in (
        "auto-review-high",
        "through_auto-review-high",
        "review-normal",
        "through_review-normal",
        "review-recall",
        "through_review-recall",
        "reject-low",
        "review-output",
    ):
        print_tier_stats(tier_stats, key)


if __name__ == "__main__":
    main()
