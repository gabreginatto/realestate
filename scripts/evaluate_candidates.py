#!/usr/bin/env python3
"""
Evaluate a candidate-ranking file against the ground truth.

Candidates JSON:
    {"method": str, "candidates": {"<viva_code>": [{"coelho": "<code>", "score": float}, ...]}}
    (each list ranked best-first)

Prints exactly one metrics line and appends a record to data/eval/history.jsonl.
Vivas with several confirmed coelho count the best-ranked one. A GT viva that is
absent, or whose true coelho is not in its list, counts as a miss (recall 0,
reciprocal rank 0, excluded from the median rank).

Usage:
    python3 scripts/evaluate_candidates.py data/candidates/metadata-v1.json \
      --label baseline-metadata-v1 [--show-misses] [--include-disputed]
"""

from __future__ import annotations

import argparse
import json
import statistics
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.ground_truth import load_ground_truth  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
HISTORY = ROOT / "data" / "eval" / "history.jsonl"
KS = (1, 3, 5, 10)


def git_short_sha():
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True
        )
        return out.stdout.strip() or None
    except OSError:
        return None


def evaluate(candidates, pairs):
    """Return (metrics, per_viva) where per_viva = {viva: (true_coelhos, rank|None, top1)}."""
    truth = {}
    for viva, coelho in pairs:
        truth.setdefault(viva, set()).add(coelho)

    per_viva = {}
    for viva, true_set in sorted(truth.items()):
        ranked = [str(c["coelho"]) for c in candidates.get(viva, [])]
        ranks = [ranked.index(t) + 1 for t in true_set if t in ranked]
        per_viva[viva] = (sorted(true_set), min(ranks) if ranks else None, ranked[0] if ranked else None)

    n = len(per_viva)
    found = [r for _, r, _ in per_viva.values() if r is not None]
    metrics = {f"R@{k}": sum(r <= k for r in found) / n for k in KS}
    metrics["MRR"] = sum(1 / r for r in found) / n
    metrics["med"] = statistics.median(found) if found else None
    metrics["n"] = n
    metrics["miss"] = n - len(found)
    return metrics, per_viva


def format_line(method, m):
    med = "NA" if m["med"] is None else f"{m['med']:g}"
    recalls = " ".join(f"R@{k}={m[f'R@{k}']:.3f}" for k in KS)
    return f"method={method} {recalls} MRR={m['MRR']:.3f} med={med} n={m['n']} miss={m['miss']}"


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("candidates", help="candidates JSON file")
    ap.add_argument("--label", default="", help="free-text label stored in history")
    ap.add_argument("--include-disputed", action="store_true")
    ap.add_argument("--show-misses", action="store_true", help="one line per GT viva not at rank 1")
    ap.add_argument("--no-history", action="store_true", help="do not append to history.jsonl")
    args = ap.parse_args()

    data = json.loads(Path(args.candidates).read_text())
    method = data.get("method", Path(args.candidates).stem)
    pairs = load_ground_truth(include_disputed=args.include_disputed)
    metrics, per_viva = evaluate(data["candidates"], pairs)

    print(format_line(method, metrics))
    if args.show_misses:
        for viva, (true_set, rank, top1) in per_viva.items():
            if rank != 1:
                print(
                    f"miss viva={viva} true={'|'.join(true_set)} "
                    f"rank={rank if rank else 'absent'} top1={top1}"
                )

    if not args.no_history:
        HISTORY.parent.mkdir(parents=True, exist_ok=True)
        record = {
            "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "method": method,
            "label": args.label,
            "metrics": metrics,
            "include_disputed": args.include_disputed,
            "git_sha": git_short_sha(),
        }
        with HISTORY.open("a") as f:
            f.write(json.dumps(record) + "\n")


if __name__ == "__main__":
    main()
