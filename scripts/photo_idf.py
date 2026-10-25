"""Round 5: drop/down-weight generic photos (common areas, agency boilerplate) before counting matches.

A photo is generic when it matches (SSCD >= tau, orig+flip) >= K distinct listings, counting the other site
and, on the same site, other listings. K=3: one house has <= ~2 Coelho listings, so a photo matching 3+ listings
cannot identify a single house. Count = viva photos (not generic) whose max SSCD vs non-generic photos of the
coelho >= tau; --weight idf uses 1/n_matches instead of a hard cut. Same tau as r4 (read from the r4 file).
Photos come from data/photos-fresh through the sha1 fingerprint cache.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fuse_scores import ROOT  # noqa: E402
from lib.photo_fingerprints import fingerprint_files  # noqa: E402
from photo_dups import COELHO, VIVA, list_listings  # noqa: E402
from topk_agg import load_live  # noqa: E402


def sim(a, b):
    return np.maximum(a[:, 0] @ b[:, 0].T, a[:, 0] @ b[:, 1].T)


def load_embeddings(root, vivas, coelhos):
    viva, coelho = list_listings(root, VIVA), list_listings(root, COELHO)
    files = [p for v in vivas for p in viva[v]] + [p for c in coelhos for p in coelho[c]]
    fps = fingerprint_files(files, ROOT / "data/photos/_cache")
    emb = lambda ps: np.stack([fps[p].emb for p in ps if p in fps])
    return {v: emb(viva[v]) for v in vivas}, {c: emb(coelho[c]) for c in coelhos}


def listing_counts(own, other, tau, same_site=True):
    """Per photo of each listing in `own`: number of distinct listings of `other` (and of `own`, excluding itself) matched."""
    keys = sorted(own)
    cat = np.concatenate([own[k] for k in keys])
    ids = np.concatenate([[k] * len(own[k]) for k in keys])
    n_other = np.zeros(len(cat), int)
    for k, e in other.items():
        n_other += (sim(cat, e).max(1) >= tau)
    n_same = np.zeros(len(cat), int)
    for k, e in own.items():
        hit = sim(cat, e).max(1) >= tau
        n_same += hit & (ids != k)
    out, i = {}, 0
    for k in keys:
        out[k] = (n_other[i:i + len(own[k])], n_same[i:i + len(own[k])])
        i += len(own[k])
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--photos-root", type=Path, default=ROOT / "data/photos-fresh")
    ap.add_argument("--base", type=Path, default=ROOT / "data/candidates/topk-agg-live-count-v1.json")
    ap.add_argument("--out", type=Path, default=ROOT / "data/candidates/topk-agg-live-idf-v1.json")
    ap.add_argument("--k", type=int, default=3)
    ap.add_argument("--weight", choices=["cut", "idf"], default="cut")
    args = ap.parse_args()
    tau = json.loads(args.base.read_text())["tau"]
    allp, meta = load_live(args.photos_root)
    cs = sorted({c for v in allp for c in allp[v]})
    V, C = load_embeddings(args.photos_root, sorted(allp), cs)
    cv, cc = listing_counts(V, C, tau), listing_counts(C, V, tau)
    w = lambda n_o, n_s: ((n_o + n_s) < args.k).astype(float) if args.weight == "cut" else 1.0 / np.maximum(1, n_o + n_s)
    # n_o counts other-site listings; a true cross-site pair contributes 1, so generic = n_o + n_s >= k
    wv = {v: w(*cv[v]) for v in V}
    wc = {c: w(*cc[c]) for c in C}
    cands = {}
    for v in allp:
        rows = []
        for c in allp[v]:
            s = sim(V[v], C[c])
            hit = s >= tau
            # a viva photo i counts through coelho photo j: weight = both photos' weights (min)
            sc = (hit * np.minimum(wv[v][:, None], wc[c][None, :])).max(1).sum()
            rows.append({"coelho": c, "score": float(sc), "meta": meta[v].get(c, -99.0)})
        cands[v] = sorted(rows, key=lambda r: (-r["score"], -r["meta"]))
    ng = sum(int((wv[v] < 1).sum()) for v in V), sum(int((wc[c] < 1).sum()) for c in C)
    print(f"tau={tau:.4f} k={args.k} weight={args.weight}; down-weighted photos: viva {ng[0]}, coelho {ng[1]}")
    args.out.write_text(json.dumps({"method": f"r5-idf-{args.weight}-k{args.k}", "tau": tau, "candidates": cands}))


if __name__ == "__main__":
    main()
