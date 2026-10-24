#!/usr/bin/env python3
"""
Metadata-only ranker: for every Viva listing rank ALL Coelho listings.

Cost (lower = better) is a weighted sum of relative lot/built area diffs,
capped absolute suites/beds/vagas diffs, and a weak relative price diff.
A field missing on either side adds a neutral penalty. Score = -cost.

Usage:
    python3 scripts/metadata_ranker.py --output data/candidates/metadata-v1.json \
      [--w-lot 10 --w-built 8 --w-suites 1.5 ...]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.listings import load_listings  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]

# (field, kind, weight, cap). rel = |a-b|/max(a,b) in [0,1]; abs = min(|a-b|, cap).
DEFAULT_WEIGHTS = {
    "lot_m2": 10.0,
    "built_m2": 8.0,
    "suites": 1.0,
    "beds": 0.7,
    "vagas": 0.3,
    "price": 1.5,
}
ABS_CAP = 3  # cap on absolute count diffs
MISSING_PENALTY = 0.35  # neutral cost per missing field, as a fraction of the weight
PRICE_SLACK = 0.20  # relative price diffs below this are free (agencies vary ~20%)
TOP_N = 20
REL_FIELDS = ("lot_m2", "built_m2", "price")


def field_cost(field, a, b, weight):
    if a is None or b is None:
        return weight * MISSING_PENALTY * (ABS_CAP if field not in REL_FIELDS else 1)
    if field in REL_FIELDS:
        diff = abs(a - b) / max(a, b, 1e-9)
        if field == "price":
            diff = max(0.0, diff - PRICE_SLACK)
        return weight * diff
    return weight * min(abs(a - b), ABS_CAP)


def cost(viva, coelho, weights):
    return sum(field_cost(f, viva[f], coelho[f], w) for f, w in weights.items() if w)


def rank_all(data, weights, top_n=TOP_N):
    out = {}
    for v in data["viva"]:
        scored = [(-cost(v, c, weights), c["code"]) for c in data["coelho"]]
        scored.sort(key=lambda t: (-t[0], t[1]))
        out[v["code"]] = [{"coelho": code, "score": round(s, 4)} for s, code in scored[:top_n]]
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--data-root", default=None)
    ap.add_argument("--output", default=str(ROOT / "data/candidates/metadata-v1.json"))
    ap.add_argument("--method", default="metadata-v1")
    ap.add_argument("--top", type=int, default=TOP_N)
    for field, w in DEFAULT_WEIGHTS.items():
        ap.add_argument("--w-" + field.replace("_m2", ""), type=float, default=w)
    args = ap.parse_args()

    weights = {f: getattr(args, "w_" + f.replace("_m2", "")) for f in DEFAULT_WEIGHTS}
    candidates = rank_all(load_listings(args.data_root), weights, args.top)
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"method": args.method, "weights": weights, "candidates": candidates}))
    print(f"wrote {out} ({len(candidates)} vivas)", file=sys.stderr)


if __name__ == "__main__":
    main()
