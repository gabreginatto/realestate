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
from lib.ground_truth import DEFAULT_PATH, load_ground_truth, load_nomatch_live  # noqa: E402

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


def decision_universe(candidates, gt_path=None):
    """Live labeled vivas: {viva: (true live coelhos, condo)}; empty set = labeled "not at Coelho"."""
    data = json.loads(Path(gt_path or DEFAULT_PATH).read_text())
    live = {v: {str(c["coelho"]) for c in cs} for v, cs in candidates.items()}
    uni = {}
    for p in data["positives"]:
        v, c = str(p["viva"]), str(p["coelho"])
        if p.get("status", "confirmed") == "confirmed" and c in live.get(v, ()):
            uni.setdefault(v, (set(), p.get("condo", "?")))[0].add(c)
    for v, n in load_nomatch_live(gt_path).items():
        if v in live and v not in uni:
            uni[v] = (set(), n.get("condo", "?"))
    return uni


def decide(candidates, uni, vivas, t):
    """Confusion counts for "match to top-1 if top-1 score >= t, else no match"."""
    r = dict(tp=0, fp_pos=0, fp_neg=0, miss=0, tn=0)
    for v in vivas:
        truth = uni[v][0]
        lst = candidates.get(v, [])
        fired = bool(lst) and lst[0]["score"] >= t
        if truth:
            if fired and str(lst[0]["coelho"]) in truth:
                r["tp"] += 1
            elif fired:
                r["fp_pos"] += 1
            else:
                r["miss"] += 1
        elif fired:
            r["fp_neg"] += 1
        else:
            r["tn"] += 1
    return r


def dec_metrics(r):
    fired, pos, neg = r["tp"] + r["fp_pos"] + r["fp_neg"], r["tp"] + r["fp_pos"] + r["miss"], r["fp_neg"] + r["tn"]
    n = pos + neg
    nan = float("nan")
    return {"prec": r["tp"] / fired if fired else nan, "rec": r["tp"] / pos if pos else nan,
            "spec": r["tn"] / neg if neg else nan, "acc": (r["tp"] + r["tn"]) / n if n else nan, "n": n, "pos": pos, "neg": neg}


def decision_report(candidates, method, gt_path=None, seeds=5, out=print):
    import random
    uni = decision_universe(candidates, gt_path)
    vivas = sorted(uni)
    mx = max((c[0]["score"] for c in candidates.values() if c), default=1)
    grid = sorted({0.0, *[float(x) for x in range(1, int(mx) + 2)]}) if float(mx).is_integer() else \
        [round(mx * i / 20, 3) for i in range(21)]
    fmt = lambda m: f"prec={m['prec']:.3f} rec={m['rec']:.3f} spec={m['spec']:.3f} acc={m['acc']:.3f}"
    first = dec_metrics(decide(candidates, uni, vivas, grid[0]))
    out(f"decision universe: {first['n']} live labeled vivas ({first['pos']} positives, {first['neg']} not-at-coelho); "
        f"per condo: " + ", ".join(f"{c}={sum(uni[v][1] == c for v in vivas)}" for c in sorted({uni[v][1] for v in vivas})))
    lm = evaluate(candidates, {(v, c) for v in vivas for c in uni[v][0]})
    out("live-positives " + format_line(method, lm[0]))
    for t in grid:
        out(f"in-sample t={t:g} " + fmt(dec_metrics(decide(candidates, uni, vivas, t))))
    pick = lambda vs: max(grid, key=lambda t: (dec_metrics(decide(candidates, uni, vs, t))["acc"], t))
    held, chosen = [], []
    for seed in range(seeds):
        sh = vivas[:]
        random.Random(seed).shuffle(sh)
        folds = [sh[0::2], sh[1::2]]
        for i in (0, 1):
            t = pick(folds[1 - i])
            chosen.append(t)
            held.append((t, folds[i], decide(candidates, uni, folds[i], t)))
    for key in ("acc", "prec", "rec", "spec"):
        xs = [dec_metrics(r)[key] for _, _, r in held]
        xs = [x for x in xs if x == x]
        out(f"held-out {key}: {statistics.mean(xs):.3f} +- {statistics.pstdev(xs):.3f} (n_runs={len(xs)})")
    out(f"held-out chosen t: {sorted(set(chosen))} mean={statistics.mean(chosen):.2f}")
    tf = pick(vivas)
    out(f"full-data best t={tf:g} " + fmt(dec_metrics(decide(candidates, uni, vivas, tf))))
    for comp in sorted({uni[v][1] for v in vivas}):
        vs = [v for v in vivas if uni[v][1] == comp]
        out(f"condo {comp} (t={tf:g}) " + fmt(dec_metrics(decide(candidates, uni, vs, tf))) + f" n={len(vs)}")
    # error cases at tf
    fm, ms = [], []
    for v in vivas:
        truth, lst = uni[v][0], candidates.get(v, [])
        top = lst[0] if lst else None
        fired = top is not None and top["score"] >= tf
        if fired and str(top["coelho"]) not in truth:
            fm.append((v, top["coelho"], top["score"], "pos" if truth else "neg"))
        if truth and not (fired and str(top["coelho"]) in truth):
            ranks = [i + 1 for i, c in enumerate(lst) if str(c["coelho"]) in truth]
            sc = next((c["score"] for c in lst if str(c["coelho"]) in truth), None)
            ms.append((v, "|".join(sorted(truth)), min(ranks) if ranks else None, sc, top["score"] if top else None))
    out(f"false matches @t={tf:g} (viva, predicted, score, truth-type): {fm[:8]}")
    out(f"misses @t={tf:g} (viva, true, rank, true-score, top1-score): {ms[:8]}")
    return {"universe": first["n"], "best_t": tf, "heldout_acc": statistics.mean(dec_metrics(r)["acc"] for _, _, r in held)}


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
    ap.add_argument("--decision", action="store_true", help="live-only match/no-match decision evaluation (2-fold CV threshold)")
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

    dec = None
    if args.decision:
        dec = decision_report(data["candidates"], method)

    if not args.no_history:
        HISTORY.parent.mkdir(parents=True, exist_ok=True)
        record = {
            "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "method": method,
            "label": args.label,
            "metrics": metrics,
            "include_disputed": args.include_disputed,
            **({"decision": dec} if dec else {}),
            **({"nomatch": nm, "score_field": args.score_field} if nm else {}),
            "git_sha": git_short_sha(),
        }
        with HISTORY.open("a") as f:
            f.write(json.dumps(record) + "\n")


if __name__ == "__main__":
    main()
