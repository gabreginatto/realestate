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
            for c, d in cs.items()]
    return float(np.percentile(vals, 99)), len(vals)


def lexi(pool, pairs, t0):
    out = {}
    for v, cs in pool.items():
        hi = sorted([c for c in cs if sscd(pairs, v, c["coelho"]) >= t0],
                    key=lambda c: -sscd(pairs, v, c["coelho"]))
        lo = [c for c in cs if sscd(pairs, v, c["coelho"]) < t0]
        out[v] = [{"coelho": c["coelho"], "score": sscd(pairs, v, c["coelho"]), "best_sscd": sscd(pairs, v, c["coelho"]),
                   "meta": c["score"]} for c in hi + lo]
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
            best = max(GRID, key=lambda w: (evaluate(blend(pool, pairs, t0, w), gt_tr)[0]["MRR"], -w))  # tie -> smaller w
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


# ---------------------------------------------------------------- round 3 (sscd-first over all pairs)
F_GRID = (0.30, 0.35, 0.40, 0.45)
T_GRID = (0.35, 0.40, 0.45, 0.50, 0.55)
HISTORY = ROOT / "data/eval/history.jsonl"


def load_r3():
    from metadata_ranker import DEFAULT_WEIGHTS, rank_all
    from lib.listings import load_pool
    data = load_pool()
    meta = {v: {c["coelho"]: c["score"] for c in cs}
            for v, cs in rank_all(data, DEFAULT_WEIGHTS, top_n=10**6).items()}
    allp = json.loads((ROOT / "data/photo_dups/pairs-all-v1.json").read_text())["pairs"]
    live = {c["code"] for c in data["coelho"] if c.get("in_fresh")}
    return {v: {c: d for c, d in cs.items() if c in meta[v]} for v, cs in allp.items() if v in meta}, meta, live


def rank_sscd_first(allp, meta, f, coelho_ok=None):
    """Per viva: all coelho with best_sscd >= f first (sscd desc), then the rest by metadata score."""
    out = {}
    for v, cs in allp.items():
        rows = [{"coelho": c, "score": d["best_sscd"], "best_sscd": d["best_sscd"], "meta": meta[v].get(c, -99.0)}
                for c, d in cs.items() if coelho_ok is None or c in coelho_ok]
        hi = sorted([r for r in rows if r["best_sscd"] >= f], key=lambda r: -r["best_sscd"])
        lo = sorted([r for r in rows if r["best_sscd"] < f], key=lambda r: (-r["meta"], -r["best_sscd"]))
        out[v] = hi + lo
    return out


def assign(allp, t, banned=(), coelho_ok=None):
    """1:1 Hungarian over best_sscd with a 'no match' dummy gain t per viva -> {viva: coelho|None}."""
    from scipy.optimize import linear_sum_assignment
    vs = sorted(allp)
    cs = sorted({c for v in vs for c in allp[v] if c not in banned and (coelho_ok is None or c in coelho_ok)})
    S = np.array([[allp[v].get(c, {}).get("best_sscd", 0.0) for c in cs] for v in vs])
    cost = np.concatenate([-S, np.full((len(vs), len(vs)), -t)], axis=1)
    r, c = linear_sum_assignment(cost)
    return {vs[i]: (cs[j] if j < len(cs) else None) for i, j in zip(r, c)}


def hung_rank(base, A, t):
    """r3b candidates: the assigned coelho first (score=sscd), other rows keep the r3a order with score 0."""
    out = {}
    for v, rows in base.items():
        a = A.get(v)
        first = [dict(r) for r in rows if r["coelho"] == a]
        rest = [dict(r, score=0.0) for r in rows if r["coelho"] != a]
        out[v] = first + rest
    return out


def stats_for(variant, allp, meta, gt, f, t, coelho_ok=None):
    """Per-viva (rank, tp, fp) for GT vivas. variant a: threshold on top-1 sscd; b: Hungarian assignment."""
    from evaluate_candidates import nomatch
    base = rank_sscd_first(allp, meta, f, coelho_ok)
    if variant == "a":
        cands = base
        r = nomatch(cands, gt, t, "score")
        tp, fp = r["tp"], r["fp"]
    else:
        A = assign(allp, t, coelho_ok=coelho_ok)
        cands = hung_rank(base, A, t)
        truth = {}
        for v, c in gt:
            truth.setdefault(v, set()).add(c)
        tp = {v: A.get(v) in ts for v, ts in truth.items()}
        fp = {v: assign(allp, t, banned=ts, coelho_ok=coelho_ok).get(v) is not None for v, ts in truth.items()}
    per = evaluate(cands, gt)[1]
    return cands, {v: (per[v][1], tp[v], fp[v]) for v in per}


def agg(st, vivas):
    xs = [st[v] for v in vivas]
    n = len(xs)
    return {"R@1": sum(r == 1 for r, _, _ in xs) / n, "MRR": sum(1 / r for r, _, _ in xs if r) / n,
            "TPR": sum(tp for _, tp, _ in xs) / n, "FPR": sum(fp for _, _, fp in xs) / n}


def run_r3(out_dir):
    allp, meta, live = load_r3()
    gt = set(load_ground_truth())  # GT vivas without photos stay in n and count as misses
    anygt = {v for v, _ in load_ground_truth(include_disputed=True)}
    vivas = sorted({v for v, _ in gt})
    print(f"r3: {len(allp)} vivas, GT vivas {len(vivas)}, live coelho {len(live)}")
    sa = {(f, t): stats_for("a", allp, meta, gt, f, t)[1] for f in F_GRID for t in T_GRID}
    sb = {(f, t): stats_for("b", allp, meta, gt, f, t)[1] for f in F_GRID for t in T_GRID}
    fixed = {"a": sa, "b": sb}
    res = {"a": [], "b": []}
    chosen = {"a": [], "b": []}
    for seed in range(5):
        vs = vivas[:]
        random.Random(seed).shuffle(vs)
        folds = [vs[::2], vs[1::2]]
        for k in (0, 1):
            test, train = folds[k], folds[1 - k]
            # f by train MRR (tie: smaller f), using the variant-a ranking; t by train TPR-FPR (tie: larger t)
            f = max(F_GRID, key=lambda x: (np.mean([agg(sa[(x, t)], train)["MRR"] for t in T_GRID]), -x))
            for var in "ab":
                t = max(T_GRID, key=lambda x: (lambda m: (m["TPR"] - m["FPR"], x))(agg(fixed[var][(f, x)], train)))
                chosen[var].append((f, t))
                res[var].append(agg(fixed[var][(f, t)], test))
    final = {}
    for var, name in (("a", "r3a-sscd-allpairs"), ("b", "r3b-hungarian")):
        m = {k: np.mean([r[k] for r in res[var]]) for k in ("R@1", "MRR", "TPR", "FPR")}
        cnt = {x: chosen[var].count(x) for x in set(chosen[var])}
        final[var] = max(cnt, key=lambda x: (cnt[x], -x[0], x[1]))
        print(f"{name} CV-heldout (2-fold x5 seeds) R@1={m['R@1']:.3f} MRR={m['MRR']:.3f} TPR={m['TPR']:.3f} "
              f"FPR={m['FPR']:.3f} chosen(f,t) counts={sorted(cnt.items())} -> final {final[var]}")
    meta_h = {"cv": {v: {k: float(np.mean([r[k] for r in res[v]])) for k in res[v][0]} for v in res}}
    from evaluate_candidates import git_short_sha
    for var, name in (("a", "r3a-sscd-allpairs"), ("b", "r3b-hungarian")):
        f, t = final[var]
        for tag, ok in (("", None), ("-live", live)):
            g = gt if ok is None else {p for p in gt if p[1] in ok}
            cands, st = stats_for(var, allp, meta, g, f, t, ok)
            m = agg(st, sorted(st))
            full = evaluate(cands, g)[0]
            m["unlabeled_firing"] = sum(1 for v, rows in cands.items() if v not in anygt and rows and rows[0]["score"] >= t
                                        and (var == "a" or rows[0]["score"] > 0))
            print(f"{name}{tag} in-sample f={f} t={t} n={len(st)} R@1={m['R@1']:.3f} MRR={m['MRR']:.3f} "
                  f"TPR={m['TPR']:.3f} FPR={m['FPR']:.3f} unlabeled_firing={m['unlabeled_firing']}")
            if not tag:
                fn = "sscd-first-v1.json" if var == "a" else "sscd-hungarian-v1.json"
                (out_dir / fn).write_text(json.dumps({"method": name, "f": f, "t": t, "candidates": cands}))
            rec = {"timestamp": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(timespec="seconds"),
                   "method": name, "label": name + tag,
                   "metrics": {k: round(float(x), 4) for k, x in m.items()} | {k: round(float(x), 4) for k, x in full.items() if k != "MRR"},
                   "f": f, "t": t, "cv_heldout": meta_h["cv"][var] if not tag else None,
                   "include_disputed": False, "git_sha": git_short_sha()}
            with HISTORY.open("a") as fh:
                fh.write(json.dumps(rec) + "\n")
    write_review(allp, meta, anygt, *final["a"])


def write_review(allp, meta, anygt, f, t):
    root = "data/photos/"
    base = rank_sscd_first(allp, meta, f)

    def info(v, r):
        d = allp[v][r["coelho"]]
        return {"coelho": r["coelho"], "best_sscd": r["best_sscd"], "meta": r["meta"],
                "photo_pairs": [{"viva": f"{root}vivaprimeimoveis/{v}/{a}", "coelho": f"{root}coelhodafonseca/{r['coelho']}/{b}",
                                 "sscd": sc} for a, b, sc in d.get("top_pairs", [])[:2]]}

    fire, nofire = [], []
    for v, rows in sorted(base.items()):
        if v in anygt or not rows:
            continue
        if rows[0]["best_sscd"] >= t:
            fire.append({"viva": v, **info(v, rows[0])})
        else:
            nofire.append({"viva": v, "top3": [info(v, r) for r in rows[:3]]})
    out = ROOT / "data/review/to-label-r3.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"method": "r3a-sscd-allpairs", "f": f, "t": t, "firing": fire, "not_firing": nofire}, indent=1))
    print(f"wrote {out}: firing={len(fire)} not_firing={len(nofire)}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=("r2", "sscd-first"), default="r2")
    ap.add_argument("--out-dir", default=str(ROOT / "data/candidates"))
    a = ap.parse_args()
    if a.mode == "sscd-first":
        return run_r3(Path(a.out_dir))
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
    wf = max(GRID, key=lambda w: (cnt[w], -w))  # tie -> smaller w
    print(f"chosen counts {cnt} -> final w={wf}")
    (out / "sscd-blend-v1.json").write_text(json.dumps({"method": f"sscd-blend-v1-w{wf}", "t0": t0, "w": wf, "candidates": blend(pool, pairs, t0, wf)}))


if __name__ == "__main__":
    main()
