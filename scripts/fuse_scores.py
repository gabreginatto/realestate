"""Fuse metadata ranking with continuous best-SSCD photo similarity (round 2).

Variants: lexi (SSCD >= t0 first) and blend (per-viva z(metadata) + w*max(0,sscd-t0)/(1-t0)).
t0 = p99 of best_sscd over pure-negative pairs (non-GT pairs of vivas without any GT positive).
Blend weight w chosen by 2-fold CV over GT vivas (split by viva). No GT info used for t0.
"""
import argparse
import json
import random
import statistics
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from evaluate_candidates import evaluate  # noqa: E402
from lib.ground_truth import load_ground_truth  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
GRID = (0.5, 1, 2, 4, 8)


def load():
    pool = json.loads((ROOT / "data/candidates/metadata-v1-pool.json").read_text())["candidates"]
    pairs = json.loads((ROOT / "data/photo_dups/pairs-v1.json").read_text())["pairs"]
    return pool, pairs


def sscd(pairs, v, c):
    return pairs.get(v, {}).get(str(c), {}).get("best_sscd", 0.0)


def compute_t0(pool, pairs, gt):
    gt_vivas = {v for v, _ in gt}
    vals = [d["best_sscd"] for v, cs in pairs.items() if v not in gt_vivas
            for c, d in cs.items() if (v, c) not in gt]
    return float(np.percentile(vals, 99)), len(vals)


def lexi(pool, pairs, t0):
    out = {}
    for v, cs in pool.items():
        hi = sorted([c for c in cs if sscd(pairs, v, c["coelho"]) >= t0],
                    key=lambda c: -sscd(pairs, v, c["coelho"]))
        lo = [c for c in cs if sscd(pairs, v, c["coelho"]) < t0]
        out[v] = [{"coelho": c["coelho"], "score": 0.0} for c in hi + lo]
    return out


def blend(pool, pairs, t0, w, vivas=None):
    out = {}
    for v, cs in pool.items():
        if vivas is not None and v not in vivas:
            continue
        m = np.array([c["score"] for c in cs], float)
        z = (m - m.mean()) / (m.std() or 1.0)
        s = z + w * np.array([max(0.0, sscd(pairs, v, c["coelho"]) - t0) / (1 - t0) for c in cs])
        order = np.argsort(-s, kind="stable")
        out[v] = [{"coelho": cs[i]["coelho"], "score": round(float(s[i]), 4)} for i in order]
    return out


def cv(pool, pairs, t0, gt):
    vivas = sorted({v for v, _ in gt})
    res = {"sel": [], "fixed": {w: [] for w in GRID}, "chosen": []}
    for seed in range(5):
        rng = random.Random(seed)
        vs = vivas[:]
        rng.shuffle(vs)
        folds = [set(vs[::2]), set(vs[1::2])]
        sel, fixed = [], {w: [] for w in GRID}
        for k in (0, 1):
            test, train = folds[k], folds[1 - k]
            gt_tr = {p for p in gt if p[0] in train}
            gt_te = {p for p in gt if p[0] in test}
            best = max(GRID[::-1], key=lambda w: (evaluate(blend(pool, pairs, t0, w), gt_tr)[0]["MRR"],))
            # tie -> smaller w (GRID reversed + max returns first max)
            res["chosen"].append(best)
            for w in GRID:
                m = evaluate(blend(pool, pairs, t0, w), gt_te)[0]
                fixed[w].append(m)
                if w == best:
                    sel.append(m)
        res["sel"].append({k: statistics.mean(m[k] for m in sel) for k in ("R@1", "R@3", "R@5", "R@10", "MRR")})
        for w in GRID:
            res["fixed"][w].append(statistics.mean(m["R@1"] for m in fixed[w]))
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir", default=str(ROOT / "data/candidates"))
    a = ap.parse_args()
    pool, pairs = load()
    gt = load_ground_truth()
    t0, nneg = compute_t0(pool, pairs, gt)
    print(f"t0={t0:.4f} (p99 over {nneg} pure-negative pairs)")
    out = Path(a.out_dir)
    (out / "sscd-lexi-v1.json").write_text(json.dumps({"method": "sscd-lexi-v1", "t0": t0, "candidates": lexi(pool, pairs, t0)}))
    res = cv(pool, pairs, t0, gt)
    for k in ("R@1", "R@3", "R@5", "R@10", "MRR"):
        xs = [r[k] for r in res["sel"]]
        print(f"CV selected-w heldout {k}: {statistics.mean(xs):.3f} +- {statistics.stdev(xs):.3f}")
    for w in GRID:
        xs = res["fixed"][w]
        print(f"CV fixed w={w} heldout R@1: {statistics.mean(xs):.3f} +- {statistics.stdev(xs):.3f}")
    cnt = {w: res["chosen"].count(w) for w in GRID}
    wf = max(GRID[::-1], key=lambda w: cnt[w])
    print(f"chosen counts {cnt} -> final w={wf}")
    (out / "sscd-blend-v1.json").write_text(json.dumps({"method": f"sscd-blend-v1-w{wf}", "t0": t0, "w": wf, "candidates": blend(pool, pairs, t0, wf)}))


if __name__ == "__main__":
    main()
