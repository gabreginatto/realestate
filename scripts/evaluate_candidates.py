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


NOMATCH_TS = (0.35, 0.40, 0.45, 0.50, 0.55)


def nomatch(candidates, pairs, t, field="score", all_gt_vivas=None):
    """No-match decision metrics at threshold t on candidate[field] (top-1 fires if value >= t).

    TPR: GT vivas whose top-1 is a true coelho and fires. FPR (leave-true-out): remove the viva's
    true coelho from its list; the new top-1 firing is a false match. unlabeled_firing: vivas with no
    GT positive (all_gt_vivas = vivas with any GT, incl. disputed) whose top-1 fires.
    """
    truth = {}
    for viva, coelho in pairs:
        truth.setdefault(viva, set()).add(coelho)
    val = lambda c: c.get(field, 0.0)
    tp, fp = {}, {}
    for v, true_set in truth.items():
        lst = candidates.get(v, [])
        tp[v] = bool(lst) and str(lst[0]["coelho"]) in true_set and val(lst[0]) >= t
        rest = [c for c in lst if str(c["coelho"]) not in true_set]
        fp[v] = bool(rest) and val(rest[0]) >= t
    excl = set(truth) | set(all_gt_vivas or ())
    unl = [v for v, lst in candidates.items() if v not in excl and lst and val(lst[0]) >= t]
    n = len(truth)
    return {"t": t, "TPR": sum(tp.values()) / n, "FPR": sum(fp.values()) / n, "unlabeled_firing": len(unl),
            "n_unlabeled": sum(1 for v in candidates if v not in excl), "tp": tp, "fp": fp}


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
    ap.add_argument("--nomatch", action="store_true", help="no-match evaluation (TPR / leave-true-out FPR) per threshold")
    ap.add_argument("--score-field", default="score", help="candidate field thresholded by --nomatch")
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

    nm = []
    if args.nomatch:
        anygt = {v for v, _ in load_ground_truth(include_disputed=True)}
        for t in NOMATCH_TS:
            r = nomatch(data["candidates"], pairs, t, args.score_field, anygt)
            print(f"nomatch method={method} t={t:.2f} TPR={r['TPR']:.3f} FPR={r['FPR']:.3f} "
                  f"unlabeled_firing={r['unlabeled_firing']}/{r['n_unlabeled']}")
            nm.append({k: (round(x, 4) if isinstance(x, float) else x) for k, x in r.items() if k not in ("tp", "fp")})

    if not args.no_history:
        HISTORY.parent.mkdir(parents=True, exist_ok=True)
        record = {
            "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "method": method,
            "label": args.label,
            "metrics": metrics,
            "include_disputed": args.include_disputed,
            **({"nomatch": nm, "score_field": args.score_field} if nm else {}),
            "git_sha": git_short_sha(),
        }
        with HISTORY.open("a") as f:
            f.write(json.dumps(record) + "\n")


if __name__ == "__main__":
    main()
