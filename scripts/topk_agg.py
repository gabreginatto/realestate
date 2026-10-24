"""Round 4: aggregate SSCD over a viva's photos instead of a single max (leave-one-out selection).

Per listing pair: for each viva photo take its max SSCD over the coelho photos (orig+flip). Score is either
mean of the top-k per-photo maxima (k in K_GRID; k=1 == r3a) or the count of viva photos with max >= tau,
tau = p99 of best_sscd over non-GT pairs (compute_t0, no GT tuning). Tie-break: metadata score.
Config (aggregator, k) is chosen by leave-one-out over GT vivas.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from evaluate_candidates import evaluate  # noqa: E402
from fuse_scores import ROOT, compute_t0, load_r3  # noqa: E402
from lib.ground_truth import load_ground_truth  # noqa: E402
from lib.photo_fingerprints import IMAGE_EXTS, fingerprint_files  # noqa: E402
from photo_dups import COELHO, VIVA, list_listings  # noqa: E402

K_GRID = (1, 2, 3, 5)
CONFIGS = [("topk", k) for k in K_GRID] + [("count", 0)]


def photo_maxima(allp, root=None):
    """{viva: {coelho: per-viva-photo max SSCD array}} from the cached embeddings.

    root: photo tree (<root>/<site>/<code>/*); fingerprints are cached under data/photos/_cache (sha1-keyed).
    """
    cache = ROOT / "data/photos/_cache"
    root = root or ROOT / "data/photos"
    viva, coelho = list_listings(root, VIVA), list_listings(root, COELHO)
    need = {v for v in allp}
    files = [p for v in need for p in viva.get(v, [])] + [p for c in {c for v in allp for c in allp[v]} for p in coelho.get(c, [])]
    fps = fingerprint_files(files, cache)
    emb = lambda ps: np.stack([fps[p].emb for p in ps if p in fps])
    out = {}
    for v in allp:
        if v not in viva:
            continue
        ve = emb(viva[v])[:, 0]
        out[v] = {}
        for c in allp[v]:
            if c in coelho:
                ce = emb(coelho[c])
                out[v][c] = np.maximum(ve @ ce[:, 0].T, ve @ ce[:, 1].T).max(axis=1)
    return out


def score(m, cfg, tau):
    kind, k = cfg
    if kind == "count":
        return float((m >= tau).sum())
    return float(np.sort(m)[::-1][:k].mean())


def rank(pm, meta, cfg, tau):
    out = {}
    for v, cs in pm.items():
        rows = [{"coelho": c, "score": score(m, cfg, tau), "meta": meta[v].get(c, -99.0)} for c, m in cs.items()]
        out[v] = sorted(rows, key=lambda r: (-r["score"], -r["meta"]))
    return out


def mrr_r1(cands, gt):
    m = evaluate(cands, gt)[0]
    return m["R@1"], m["MRR"]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--photos-root", type=Path, default=ROOT / "data/photos", help="e.g. data/photos-clean")
    ap.add_argument("--out", type=Path, default=ROOT / "data/candidates/topk-agg-v1.json")
    ap.add_argument("--config", help="force aggregator instead of the LOO pick: count | topk1 | topk2 | topk3 | topk5")
    args = ap.parse_args()
    allp, meta, _ = load_r3()
    gt = set(load_ground_truth())
    gv = sorted({v for v, _ in gt})
    pm = photo_maxima(allp, args.photos_root)
    if args.photos_root.resolve() != (ROOT / "data/photos").resolve():
        # pairs-all-v1 was computed on the original photo folders: recompute best_sscd on this tree for tau
        allp = {v: {c: {"best_sscd": float(m.max())} for c, m in cs.items()} for v, cs in pm.items()}
    tau = compute_t0(None, allp, gt)[0]
    cands = {cfg: rank(pm, meta, cfg, tau) for cfg in CONFIGS}
    print(f"tau (non-GT p99) = {tau:.4f}; GT vivas {len(gv)}, with photos {sum(v in pm for v in gv)}")
    for cfg in CONFIGS:
        r1, mrr = mrr_r1(cands[cfg], gt)
        print(f"in-sample {cfg}: R@1={r1:.3f} MRR={mrr:.3f} ({round(r1*len(gv))} pairs)")
    # per-viva reciprocal ranks and hits per config
    per = {cfg: evaluate(cands[cfg], gt)[1] for cfg in CONFIGS}
    rr = {cfg: {v: (1 / per[cfg][v][1] if per[cfg][v][1] else 0.0) for v in gv} for cfg in CONFIGS}
    h1 = {cfg: {v: float(per[cfg][v][1] == 1) for v in gv} for cfg in CONFIGS}
    picks, loo_rr, loo_h1 = [], {}, {}
    for i in gv:
        tr = [v for v in gv if v != i]
        best = max(CONFIGS, key=lambda c: (sum(h1[c][v] for v in tr), sum(rr[c][v] for v in tr), c == CONFIGS[0]))
        picks.append(best)
        loo_rr[i], loo_h1[i] = rr[best][i], h1[best][i]
    n = len(gv)
    print(f"LOO: R@1={sum(loo_h1.values())/n:.3f} ({int(sum(loo_h1.values()))}/{n}) MRR={sum(loo_rr.values())/n:.3f}")
    cnt = {c: picks.count(c) for c in CONFIGS}
    print("LOO picks:", cnt)
    final = max(CONFIGS, key=lambda c: (cnt[c], c == CONFIGS[0]))
    if args.config:
        final = next(c for c in CONFIGS if (c[0] + (str(c[1]) if c[0] == "topk" else "")) == args.config)
    print("final config:", final)
    out = args.out
    out.write_text(json.dumps({"method": f"r4-topk-agg-{final[0]}{final[1]}", "tau": tau, "candidates": cands[final]}))
    base = json.loads((ROOT / "data/candidates/sscd-first-v1.json").read_text())["candidates"]
    pb = evaluate(base, gt)[1]
    for v in gv:
        a, b = pb[v][1], per[final][v][1]
        if v in ("12252", "17316", "16228") or (b or 99) > (a or 99):
            print(f"viva {v}: r3a rank={a} -> r4 rank={b}" + ("  WORSE" if (b or 99) > (a or 99) else ""))
    print("per-config rank of key vivas:", {str(c): [per[c][v][1] for v in ("12252", "17316", "16228") if v in per[c]] for c in CONFIGS})


if __name__ == "__main__":
    main()
