"""Frozen benchmark built from the broker's labels. One command, one output line (also appended to data/eval/history.jsonl).

    python scripts/benchmark.py r5            # SSCD count (data/candidates/topk-agg-live-idf-v1.json)
    python scripts/benchmark.py r6            # r5 count + ALIKED/LightGlue verifier (compound pool)
    python scripts/benchmark.py r7            # same scorer on the enlarged Coelho pool (builds data/candidates/r7-inventory-v1.json)
    python scripts/benchmark.py custom --cands FILE --scorer sscd|lg [--pool compound|extended]

Frozen sets (data/benchmark/frozen-v1.json, created once, never edited by hand):
  P      59 live GT positive pairs.
  H      broker-rejected shown pairs (hard negatives).
  S      3 random same-compound Coelho listings per GT viva, minus true pairs, rejected pairs and r5-duplicates of the house.
  P_hard each P pair with every Viva photo removed whose best SSCD vs ANY photo of that Coelho listing >= 0.25 or whose
         PDQ distance (dihedral) <= 31; pairs with < 3 photos left are skipped; only the remaining photos are scored.
  U      the 42 unresolved vivas (no_match vivas minus 12229, 18360, 8748, 16113).
Metrics: R@1 on P (ranking file); T = score threshold with <= 2% FPR on H; recall on P_hard at T (T chosen by 2-fold CV
by viva; "rec_hard_cv"); FPR on H and S; number of U vivas with a candidate above T.
Gates: R@1(P) == 1.000 and FPR(H) <= 2%.  Push rec_hard_cv up.
"""
import argparse
import hashlib
import json
import random
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from evaluate_candidates import HISTORY, evaluate, git_short_sha  # noqa: E402
from fuse_scores import ROOT  # noqa: E402
from lib.ground_truth import load_ground_truth, load_nomatch_live, load_pair_negatives  # noqa: E402
from lib.listings import load_pool  # noqa: E402
from lib.photo_fingerprints import fingerprint_files, sha1_file  # noqa: E402
from lib.photo_types import photo_types  # noqa: E402
from metadata_ranker import DEFAULT_WEIGHTS, cost  # noqa: E402
from photo_dups import COELHO, VIVA, list_listings  # noqa: E402
from photo_idf import listing_counts, sim  # noqa: E402
from topk_agg import COMPOUNDS, load_live  # noqa: E402

BENCH = ROOT / "data/benchmark"
FROZEN = BENCH / "frozen-v1.json"
LG_CACHE = BENCH / "lg-cache.json"
R5 = ROOT / "data/candidates/topk-agg-live-idf-v1.json"
VERIFY_V1 = ROOT / "data/r6/verify-v1.json"
EXTRAS = ("r7-extra", "r7-extra-b")  # enlarged Coelho pool: lot<=2% + same suites candidates (tier A, 79 listings)
DROP_SSCD, DROP_PDQ, MIN_LEFT, FPR = 0.25, 31, 3, 0.02
RESOLVED = {"12229", "18360", "8748", "16113"}
METHODS = {
    "r5": dict(cands=R5, scorer="sscd", pool="compound"),
    "r6": dict(cands=ROOT / "data/candidates/r6-lightglue-v1.json", scorer="lg", pool="compound"),
    "r7": dict(cands=ROOT / "data/candidates/r7-inventory-v1.json", scorer="lg", pool="extended"),
}


def threshold(neg, fpr=FPR):
    """T such that fraction(neg > T) <= fpr."""
    h = sorted(neg, reverse=True)
    k = int(np.floor(fpr * len(h)))
    return h[k] if k < len(h) else 0.0


class Ctx:
    """Photos, fingerprints, generic-photo sets and pair scorers over one pool (compound = r5/r6 pool, extended = + extra Coelho)."""

    def __init__(self, pool_kind, root=ROOT / "data/photos-fresh"):
        self.root = root.resolve()
        self.tau = json.loads(R5.read_text())["tau"]
        self.allp, self.meta = load_live(root)
        self.pool = {"viva": {}, "coelho": {}}
        for comp in COMPOUNDS + (EXTRAS if pool_kind == "extended" else ()):
            p = load_pool(comp)
            for site in ("viva", "coelho"):
                for x in p[site]:
                    self.pool[site][x["code"]] = x
        self.vl, self.cl = list_listings(self.root, VIVA), list_listings(self.root, COELHO)
        if pool_kind == "extended":
            ok = {c for c, x in self.pool["coelho"].items() if x.get("in_fresh") and c in self.cl}
            self.allp = {v: {c: {} for c in sorted(ok)} for v in self.allp}
        self.vivas = sorted(self.allp)
        self.coelhos = sorted({c for v in self.allp for c in self.allp[v]})
        files = [p for v in self.vivas for p in self.vl[v]] + [p for c in self.coelhos for p in self.cl[c]]
        self.fps = fingerprint_files(files, ROOT / "data/photos/_cache")
        emb = lambda ps: np.stack([self.fps[p].emb for p in ps if p in self.fps])  # noqa: E731
        self.V = {v: emb(self.vl[v]) for v in self.vivas}
        self.C = {c: emb(self.cl[c]) for c in self.coelhos}
        cv, cc = listing_counts(self.V, self.C, self.tau), listing_counts(self.C, self.V, self.tau)
        self.generic = set()
        for v, (no, ns) in cv.items():
            self.generic |= {p for p, n in zip(self.vl[v], no + ns) if n >= 3}
        for c, (no, ns) in cc.items():
            self.generic |= {p for p, n in zip(self.cl[c], no + ns) if n >= 3}
        self._lg = None
        self.lg_cache = json.loads(LG_CACHE.read_text()) if LG_CACHE.exists() else {}
        if not self.lg_cache and VERIFY_V1.exists():  # seed with the r6 run (same selection, all photos)
            for p in json.loads(VERIFY_V1.read_text())["pairs"]:
                if p["mode"] == "all":
                    best = max(p["photo_pairs"], key=lambda r: r["inliers"], default=None)
                    self.lg_cache[f"{p['v']}|{p['c']}|all"] = {"max": best["inliers"] if best else 0}

    # ---------------------------------------------------------------- photo sets
    def sscd_matrix(self, v, c, vph=None):
        idx = [i for i, p in enumerate(self.vl[v]) if vph is None or p in vph]
        return sim(self.V[v][idx], self.C[c]), [self.vl[v][i] for i in idx]

    def hard_photos(self, v, c):
        """Viva photos of v that survive the P_hard drop for listing c."""
        s, _ = self.sscd_matrix(v, c)
        vp = np.stack([self.fps[p].pdq[0] for p in self.vl[v]])
        cp = np.stack([self.fps[p].pdq for p in self.cl[c]])
        from lib.photo_fingerprints import pairwise_pdq
        d = pairwise_pdq(vp, cp)
        drop = (s.max(1) >= DROP_SSCD) | (d.min(1) <= DROP_PDQ)
        return [p for p, x in zip(self.vl[v], drop) if not x]

    # ---------------------------------------------------------------- scorers
    def score(self, scorer, v, c, vph=None):
        return self.score_sscd(v, c, vph) if scorer == "sscd" else self.score_lg(v, c, vph)["max"]

    def score_sscd(self, v, c, vph=None):
        """r5: number of Viva photos (non-generic) with max SSCD >= tau vs non-generic Coelho photos."""
        s, vps = self.sscd_matrix(v, c, vph)
        okv = np.array([p not in self.generic for p in vps])
        okc = np.array([p not in self.generic for p in self.cl[c]])
        if not okv.any() or not okc.any():
            return 0.0
        return float((s[okv][:, okc].max(1) >= self.tau).sum())

    def _models(self):
        if self._lg is None:
            import r6_verify as r6
            self._lg = (r6, r6.Dino(), r6.Matcher(), {}, {})
        return self._lg

    def score_lg(self, v, c, vph=None):
        """r6 verifier: max MAGSAC inliers over <= 8 DINO-selected photo pairs (cached on disk)."""
        key = f"{v}|{c}|" + ("all" if vph is None else hashlib.sha1("".join(sorted(p.name for p in vph)).encode()).hexdigest()[:12])
        if key in self.lg_cache:
            return self.lg_cache[key]
        r6, dino, mt, emb, types = self._models()
        vph = list(self.vl[v]) if vph is None else list(vph)
        cph = self.cl[c]
        sha = {}
        for p in vph + cph:
            sha[p] = sha1_file(p)
            if p not in emb:
                try:
                    emb[p] = dino.embed(p, sha[p])
                except Exception:  # noqa: BLE001
                    pass
        for ps, site in ((vph, VIVA), (cph, COELHO)):
            miss = [p for p in ps if p not in types]
            if miss:
                types.update(photo_types(miss, site))
        sel = r6.select_photo_pairs(v, c, vph, cph, emb, types, self.generic, (set(), set()), "all")
        best = {"max": 0}
        for pv, pc, _ in sel:
            for flip in (False, True):
                _, n, _ = mt.match(mt.feats(pv, sha[pv], flip), mt.feats(pc, sha[pc], False), True)
                if n > best["max"]:
                    best = {"max": n, "best": [str(pv.relative_to(self.root)), str(pc.relative_to(self.root)), n, flip]}
        self.lg_cache[key] = best
        return best

    def save_cache(self):
        BENCH.mkdir(parents=True, exist_ok=True)
        LG_CACHE.write_text(json.dumps(self.lg_cache))

    # ---------------------------------------------------------------- candidate generation for the unresolved vivas
    def meta_rank(self, v):
        from r6_verify import metadata_score
        mv = self.pool["viva"][v]
        rows = [(metadata_score(mv, self.pool["coelho"][c])[0], c) for c in self.allp[v]]
        return [c for _, c in sorted(rows, key=lambda r: -r[0])]

    def lg_candidates(self, v, cnt=None, rejected=()):
        """Pairs the verifier scores for viva v: top-3 by r5 count and top-5 by lot/built/suites metadata, minus rejected."""
        cnt = cnt or {c: self.score_sscd(v, c) for c in self.allp[v]}
        top_cnt = sorted(cnt, key=lambda c: (-cnt[c], c))[:3]
        return [c for c in dict.fromkeys(top_cnt + self.meta_rank(v)[:5]) if c not in rejected]

    def r5_rank(self, v):
        cs = sorted(self.allp[v], key=lambda c: (-self.score_sscd(v, c), c))
        return cs


# ------------------------------------------------------------------------------ frozen sets
def build_frozen():
    ctx = Ctx("compound")
    allp = ctx.allp
    gt = sorted((v, c) for v, c in load_ground_truth() if v in allp and c in allp[v])
    hard = sorted((v, c) for v, c in load_pair_negatives() if v in allp and c in allp[v])
    rejected, gt_by_v = {}, {}
    for v, c in load_pair_negatives():
        rejected.setdefault(v, set()).add(c)
    for v, c in gt:
        gt_by_v.setdefault(v, set()).add(c)
    r5 = {v: {x["coelho"]: x["score"] for x in xs} for v, xs in json.loads(R5.read_text())["candidates"].items()}
    rng, sure = random.Random(0), []
    for v in sorted(gt_by_v):
        dup = {c for c, s in r5[v].items() if s > 0}  # may be another listing of the same house
        pool = sorted(c for c in allp[v] if c not in gt_by_v[v] | dup | rejected.get(v, set()))
        sure += [(v, c) for c in rng.sample(pool, min(3, len(pool)))]
    phard = {}
    for v, c in gt:
        left = ctx.hard_photos(v, c)
        phard[f"{v}|{c}"] = {"n_total": len(ctx.vl[v]), "n_left": len(left), "photos": [p.name for p in left]}
    unresolved = sorted(v for v in load_nomatch_live() if v in allp and v not in RESOLVED)
    assert len(unresolved) == 42, len(unresolved)
    BENCH.mkdir(parents=True, exist_ok=True)
    FROZEN.write_text(json.dumps({"created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                                  "P": gt, "H": hard, "S": sure, "P_hard": phard, "U": unresolved,
                                  "rejected": {v: sorted(c) for v, c in rejected.items()}}))
    print(f"frozen: P={len(gt)} H={len(hard)} S={len(sure)} P_hard={sum(x['n_left'] >= MIN_LEFT for x in phard.values())} U={len(unresolved)}")


# ------------------------------------------------------------------------------ r7 ranking
def build_ranking(ctx, fz, scorer, T):
    """Verified pairs (verifier > T, T from H) first by inliers, then r5 count x1000 + verifier; metadata tie-break.

    The verifier runs on top-3 by count + top-5 by metadata, P/U vivas only. Needed because with cross-condo candidates a single
    generic-looking photo (count 1) can outrank a true pair that has count 0 but a strong geometric match.
    """
    need = {v for v, _ in fz["P"]} | set(fz["U"])
    cands = {}
    for v in ctx.vivas:
        mv = ctx.pool["viva"][v]
        mrow = {c: -cost(mv, ctx.pool["coelho"][c], DEFAULT_WEIGHTS) for c in ctx.allp[v]}
        cnt = {c: ctx.score_sscd(v, c) for c in ctx.allp[v]}
        ver = {}
        if scorer == "lg" and v in need:
            for c in ctx.lg_candidates(v, cnt, set(fz["rejected"].get(v, [])) - ({c for vv, c in fz["P"] if vv == v})):
                ver[c] = ctx.score_lg(v, c)["max"]
            ctx.save_cache()
        rows = [{"coelho": c, "score": (1e6 if ver.get(c, 0) > T else 0.0) + cnt[c] * 1000 + min(999.0, float(ver.get(c, 0))), "meta": mrow[c]} for c in ctx.allp[v]]
        cands[v] = sorted(rows, key=lambda r: (-r["score"], -r["meta"]))
    return cands


# ------------------------------------------------------------------------------ evaluation
def run(method, a):
    cfg = dict(METHODS.get(method, {}))
    if method == "custom":
        cfg = dict(cands=a.cands, scorer=a.scorer, pool=a.pool)
    if not FROZEN.exists() or a.refreeze:
        build_frozen()
    fz = json.loads(FROZEN.read_text())
    t0 = time.time()
    ctx = Ctx(cfg["pool"])
    sc = cfg["scorer"]
    P = [tuple(x) for x in fz["P"]]
    H = [tuple(x) for x in fz["H"] if x[0] in ctx.allp and x[1] in ctx.allp[x[0]]]
    S = [tuple(x) for x in fz["S"] if x[0] in ctx.allp and x[1] in ctx.allp[x[0]]]
    ph = {tuple(k.split("|")): v for k, v in fz["P_hard"].items() if v["n_left"] >= MIN_LEFT}
    cands_file = Path(cfg["cands"])
    if method == "r7" or (method == "custom" and a.build):
        cands = build_ranking(ctx, fz, sc, threshold([ctx.score(sc, *p) for p in H]))
        cands_file.write_text(json.dumps({"method": f"{method}-ranking", "tau": ctx.tau, "candidates": cands}))
        ctx.save_cache()
    else:
        cands = json.loads(cands_file.read_text())["candidates"]
    r1 = evaluate(cands, set(P))[0]["R@1"]
    # pair scores
    sH = {p: ctx.score(sc, *p) for p in H}
    sS = {p: ctx.score(sc, *p) for p in S}
    sP = {p: ctx.score(sc, *p) for p in P}
    sPh = {p: ctx.score(sc, p[0], p[1], {q for q in ctx.vl[p[0]] if q.name in set(v["photos"])}) for p, v in ph.items()}
    ctx.save_cache()
    T = threshold(list(sH.values()))
    vs = sorted({p[0] for p in list(sH) + list(sPh)})
    folds = [set(vs[0::2]), set(vs[1::2])]
    tp = fp = nh = 0
    for i in (0, 1):
        Ti = threshold([s for p, s in sH.items() if p[0] not in folds[i]])
        tp += sum(s > Ti for p, s in sPh.items() if p[0] in folds[i])
        fp += sum(s > Ti for p, s in sH.items() if p[0] in folds[i])
        nh += sum(p[0] in folds[i] for p in sH)
    # unresolved vivas: any candidate above T
    fires = {}
    for v in fz["U"]:
        rej = set(fz["rejected"].get(v, []))
        if sc == "sscd":
            pick = list(ctx.allp[v])
        else:
            pick = ctx.lg_candidates(v)
        best = max(((ctx.score(sc, v, c), c) for c in pick if c not in rej), default=(0, None))
        if best[0] > T:
            fires[v] = best
    ctx.save_cache()
    left = [v["n_left"] for v in ph.values()]
    m = {"R@1_P": round(r1, 4), "T": T, "rec_P": round(float(np.mean([s > T for s in sP.values()])), 4),
         "rec_hard_cv": round(tp / max(1, len(sPh)), 4), "rec_hard": round(float(np.mean([s > T for s in sPh.values()])), 4),
         "n_hard": len(sPh), "hard_left_mean": round(float(np.mean(left)), 1), "hard_left_min": int(min(left)),
         "FPR_H": round(float(np.mean([s > T for s in sH.values()])), 4), "FPR_H_cv": round(fp / max(1, nh), 4),
         "FPR_S": round(float(np.mean([s > T for s in sS.values()])), 4), "n_H": len(H), "n_S": len(S),
         "fires_U": len(fires), "n_U": len(fz["U"])}
    gate = "PASS" if m["R@1_P"] == 1.0 and m["FPR_H"] <= FPR else "FAIL"
    line = (f"benchmark {a.label or method} [{gate}] R@1(P)={m['R@1_P']:.3f} rec_hard_cv={m['rec_hard_cv']:.3f} (n={m['n_hard']}, "
            f"photos left mean {m['hard_left_mean']}) T={T:g} FPR_H={m['FPR_H']:.3f} (cv {m['FPR_H_cv']:.3f}, n={len(H)}) "
            f"FPR_S={m['FPR_S']:.3f} (n={len(S)}) rec_P={m['rec_P']:.3f} fires_U={m['fires_U']}/{m['n_U']}")
    print(line)
    if a.verbose:
        for v, (s, c) in sorted(fires.items()):
            mv, mc = ctx.pool["viva"][v], ctx.pool["coelho"][c]
            print(f"  fire {v}->{c} score={s:g} lot {mv.get('lot_m2')}/{mc.get('lot_m2')} built {mv.get('built_m2')}/{mc.get('built_m2')} "
                  f"suites {mv.get('suites')}/{mc.get('suites')} condo={mc.get('condo')}")
    if not a.no_history:
        rec = {"timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"), "method": "benchmark",
               "label": a.label or f"bench-{method}", "bench_method": method, "metrics": m, "git_sha": git_short_sha(),
               "fires": {v: [float(s), c] for v, (s, c) in fires.items()}, "seconds": round(time.time() - t0)}
        with HISTORY.open("a") as f:
            f.write(json.dumps(rec) + "\n")
    return m, fires


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("method", choices=list(METHODS) + ["custom"])
    ap.add_argument("--label", default="")
    ap.add_argument("--cands", type=Path)
    ap.add_argument("--scorer", choices=["sscd", "lg"], default="lg")
    ap.add_argument("--pool", choices=["compound", "extended"], default="compound")
    ap.add_argument("--build", action="store_true", help="custom: (re)build the ranking file with the scorer")
    ap.add_argument("--refreeze", action="store_true", help="rebuild data/benchmark/frozen-v1.json (changes the benchmark!)")
    ap.add_argument("--no-history", action="store_true")
    ap.add_argument("--verbose", "-v", action="store_true", help="list the unresolved vivas that fire")
    a = ap.parse_args()
    run(a.method, a)


if __name__ == "__main__":
    main()
