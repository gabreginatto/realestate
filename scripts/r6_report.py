"""Round 6 report: calibrate the verifier score (no use of the 46 no_match vivas), apply it to them, evaluate.

Reads data/r6/verify-v1.json (scripts/r6_verify.py). Positives = 59 live GT pairs; "pos_nc" = the same pairs with the
SSCD near-copy photos removed (simulates a different shoot). Negatives: hard = broker-rejected shown pairs, sure =
random same-compound pairs of GT vivas. Threshold = score > T with hard-negative FPR <= 2%, chosen by 2-fold CV over vivas.
Outputs: data/r6/targets-v1.json, data/candidates/r6-lightglue-v1.json, one line in data/eval/history.jsonl.
"""
import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from evaluate_candidates import HISTORY, evaluate, git_short_sha  # noqa: E402
from fuse_scores import ROOT  # noqa: E402
from lib.ground_truth import load_ground_truth  # noqa: E402
from r6_verify import R5, metadata_rank, metadata_score  # noqa: E402
from topk_agg import load_live  # noqa: E402

GATE = 0.08  # min convex-hull spread (fraction of the image) for an inlier set to count


def variants(recs):
    inl = sorted((r["inliers"] for r in recs), reverse=True)
    gated = sorted((r["inliers"] if r["spread"] >= GATE else 0 for r in recs), reverse=True)
    m = lambda xs, k: float(np.mean(xs[:k])) if xs else 0.0  # noqa: E731
    return {"max": m(inl, 1), "top2": m(inl, 2), "maxgate": m(gated, 1), "top2gate": m(gated, 2)}


def threshold(neg, fpr=0.02):
    """T such that fraction(neg > T) <= fpr."""
    h = sorted(neg, reverse=True)
    k = int(np.floor(fpr * len(h)))
    return h[k] if k < len(h) else 0.0


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--verify", type=Path, default=ROOT / "data/r6/verify-v1.json")
    ap.add_argument("--fpr", type=float, default=0.02)
    a = ap.parse_args()
    d = json.loads(a.verify.read_text())
    rows = []
    for p in d["pairs"]:
        ks = set(p["kinds"])
        kind = "pos_nc" if p["mode"] == "noncopy" else next((k for k in ("pos", "hard", "sure", "target", "rank") if k in ks), "?")
        rows.append({"v": p["v"], "c": p["c"], "kind": kind, "kinds": ks, "recs": p["photo_pairs"], **variants(p["photo_pairs"])})
    by = lambda k: [r for r in rows if r["kind"] == k]  # noqa: E731
    print("counts:", {k: len(by(k)) for k in ("pos", "pos_nc", "hard", "sure", "target", "rank")})
    q = lambda xs: [round(float(np.percentile(xs, x)), 1) for x in (5, 25, 50, 75, 95, 100)]  # noqa: E731
    best_var, best_tpr = None, -1
    for var in ("max", "top2", "maxgate", "top2gate"):
        print(f"[{var}] quantiles p5/25/50/75/95/max  pos {q([r[var] for r in by('pos')])}  pos_nc {q([r[var] for r in by('pos_nc')])}  "
              f"hard {q([r[var] for r in by('hard')])}  sure {q([r[var] for r in by('sure')])}")
        vivas = sorted({r["v"] for r in by("hard") + by("pos_nc")})
        folds = [set(vivas[0::2]), set(vivas[1::2])]
        tp = n = fp_h = n_h = fp_s = n_s = 0
        for i in (0, 1):
            tr = lambda r: r["v"] not in folds[i]  # noqa: E731
            te = lambda r: r["v"] in folds[i]  # noqa: E731
            T = threshold([r[var] for r in by("hard") if tr(r)], a.fpr)
            tp += sum(r[var] > T for r in by("pos_nc") if te(r))
            n += sum(te(r) for r in by("pos_nc"))
            fp_h += sum(r[var] > T for r in by("hard") if te(r))
            n_h += sum(te(r) for r in by("hard"))
            fp_s += sum(r[var] > T for r in by("sure") if te(r))
            n_s += sum(te(r) for r in by("sure"))
        tpr = tp / max(1, n)
        print(f"   2-fold CV @FPR<={a.fpr:.0%}: TPR(pos_nc)={tpr:.3f} ({tp}/{n}) FPR_hard={fp_h / max(1, n_h):.3f} FPR_sure={fp_s / max(1, n_s):.3f}")
        if tpr > best_tpr:
            best_var, best_tpr = var, tpr
    var = best_var
    T = threshold([r[var] for r in by("hard")], a.fpr)
    print(f"chosen score={var}, T (score > T) = {T:.1f}; in-sample TPR pos={np.mean([r[var] > T for r in by('pos')]):.3f} "
          f"pos_nc={np.mean([r[var] > T for r in by('pos_nc')]):.3f} FPR hard={np.mean([r[var] > T for r in by('hard')]):.3f} "
          f"sure={np.mean([r[var] > T for r in by('sure')]):.3f}")

    # ---- apply to the 46 (+ recheck) vivas
    allp, _ = load_live(ROOT / "data/photos-fresh")
    _, pool = metadata_rank({v: [] for v in allp})
    tg = {}
    for r in by("target"):
        mv, mc = pool["viva"][r["v"]], pool["coelho"][r["c"]]
        _, diffs = metadata_score(mv, mc)
        best = max(r["recs"], key=lambda x: x["inliers"], default=None)
        tg.setdefault(r["v"], []).append({
            "coelho": r["c"], "score": r[var], "all": {k: r[k] for k in ("max", "top2", "maxgate", "top2gate")},
            "best_dino": max((x["dino"] for x in r["recs"]), default=None), "best_inliers": best["inliers"] if best else 0,
            "lot_diff": diffs.get("lot"), "built_diff": diffs.get("built"),
            "suites": [mv.get("suites"), mc.get("suites")], "beds": [mv.get("beds"), mc.get("beds")],
            "photo_pairs": sorted(r["recs"], key=lambda x: -x["inliers"])})
    for v in tg:
        tg[v].sort(key=lambda x: (-x["score"], -(x["best_dino"] or 0)))
    fire = [v for v in tg if tg[v][0]["score"] > T]
    print(f"targets: {len(tg)} vivas; with a candidate above T: {len(fire)}; with >=2 above T: {sum(sum(c['score'] > T for c in tg[v]) >= 2 for v in tg)}")
    for v in sorted(tg):
        print(v, " | ".join(f"{c['coelho']} inl={c['score']:.0f} dino={c['best_dino']:.2f} lot={c['lot_diff'] if c['lot_diff'] is None else round(c['lot_diff'], 3)} "
                            f"blt={c['built_diff'] if c['built_diff'] is None else round(c['built_diff'], 3)}" for c in tg[v][:3]), "*" if v in fire else "")
    (ROOT / "data/r6/targets-v1.json").write_text(json.dumps({"score": var, "T": T, "targets": tg}))

    # ---- combined ranking evaluation: r5 count first, then verifier score, then metadata
    r5 = json.loads(R5.read_text())["candidates"]
    ver = {(r["v"], r["c"]): r[var] for r in rows if r["kind"] != "pos_nc"}
    gt = {(v, c) for v, c in load_ground_truth() if v in allp and c in allp[v]}
    cands = {}
    for v in allp:
        cs = [{"coelho": x["coelho"], "score": x["score"] * 1000 + min(999.0, ver.get((v, x["coelho"]), 0.0)), "meta": x["meta"]} for x in r5[v]]
        cands[v] = sorted(cs, key=lambda x: (-x["score"], -x["meta"]))
    (ROOT / "data/candidates/r6-lightglue-v1.json").write_text(json.dumps({"method": "r6-lightglue-verify", "tau": d["tau"], "candidates": cands}))
    m_live = evaluate(cands, gt)[0]
    m_r5 = evaluate(r5, gt)[0]
    ties = sum(1 for v in {v for v, _ in gt} if sum(x["score"] // 1000 == next(y["score"] // 1000 for y in cands[v] if (v, y["coelho"]) in gt) for x in cands[v]) > 1)
    print(f"live GT ({len(gt)} pairs): r5 R@1={m_r5['R@1']:.3f} MRR={m_r5['MRR']:.3f} | r5 count then verifier: R@1={m_live['R@1']:.3f} MRR={m_live['MRR']:.3f} "
          f"(vivas whose true pair ties on r5 count with another candidate: {ties})")
    hard = by("hard")
    rec = {"timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"), "method": "r6-lightglue-verify",
           "label": "r6-lightglue-verify", "metrics": m_live, "include_disputed": False, "git_sha": git_short_sha(),
           "r6": {"score": var, "T": T, "FPR_hard": float(np.mean([r[var] > T for r in hard])),
                  "FPR_sure": float(np.mean([r[var] > T for r in by("sure")])),
                  "TPR_pos_nc": float(np.mean([r[var] > T for r in by("pos_nc")])), "cv_TPR_pos_nc": best_tpr,
                  "targets_fired": len(fire), "targets": len(tg)}}
    with HISTORY.open("a") as f:
        f.write(json.dumps(rec) + "\n")


if __name__ == "__main__":
    main()
