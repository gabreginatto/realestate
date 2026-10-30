"""Round 8 final list: every live Viva listing (alphaville-1, tambore-xi) with its status at Coelho.

    python scripts/r8_final_list.py [--merge-cache FILE ...] [--no-score]

Method = benchmark r8 (verifier ALIKED+LightGlue, per-Coelho "mutual best" normalization, T from H).
  confirmed_at_coelho  broker-confirmed pair (ground truth) with a live Coelho listing
  likely_at_coelho     not confirmed, but a non-rejected candidate beats T after normalization (and was not judged a different house
                       by eye, REVIEWED_DIFFERENT) or shares >= 2 copied photos with a live Coelho listing (r5 count)
  not_found_at_coelho  none of the above; ranked by a heuristic confidence (see confidence())
Also scores the r7 candidates that had no photos (data/r7-extra-c) against the unresolved vivas they are metadata-compatible
with (lot within 2 % and same suites) and any viva-candidate not yet scored.
Output: data/output/viva-not-at-coelho.{csv,json}
"""
import argparse
import csv
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import benchmark as B  # noqa: E402
from lib.ground_truth import load_ground_truth, load_pair_negatives  # noqa: E402

OUT = B.ROOT / "data/output"
EXTRA_C = "r7-extra-c"
# pairs above T that I looked at (photo sheets) and judged to be different houses: docs/proposta-fotografos-diferentes.md and round 8
REVIEWED_DIFFERENT = {
    ("12414", "352803"): "piscina e fachada diferentes (revisado a olho)",
    ("9624", "352241"): "piscina diferente (revisado a olho)",
    ("18404", "351828"): "piscina redonda vs retangular (revisado a olho)",
    ("14138", "661093"): "quartos diferentes (revisado a olho)",
    ("12030", "565110"): "quartos diferentes (revisado a olho)",
    ("1786", "505106"): "casa de 1 andar com piscina oval e escada externa vs sobrado com piso de marmore e piscina retangular; o parquet e a janela sao da mesma construtora (revisado a olho)",
    ("6001", "674951"): "piscinas de formato diferente; os 55 inliers vem do piso/horizonte (revisado a olho)",
}
LOT_TOL, META_MAX = 0.02, 0.35  # META_MAX: a hit needs lot and built within 35 % (the confirmed pairs differ by <= 32 % built)


def rel(a, b):
    return None if not a or not b else (b - a) / a


def meta_ok(mv, mc):
    return all(abs(rel(mv.get(k), mc.get(k)) or 0) <= META_MAX for k in ("lot_m2", "built_m2"))


def pct(x):
    return "" if x is None else f"{x * 100:+.1f}%"


def confidence(raw_best, T, plausible_unscored, labeled):
    """Heuristic P(not at Coelho): 0.97 minus up to 0.45 as the best raw verifier score climbs from 25 inliers to T,
    -0.10 if metadata-compatible live Coelho listings could not be scored, -0.05 if the broker never looked at this viva."""
    r = min(1.3, max(0.0, (raw_best - 25) / max(1.0, T - 25)))
    c = 0.97 - 0.45 * r - (0.10 if plausible_unscored else 0.0) - (0.0 if labeled else 0.05)
    return round(min(0.97, max(0.05, c)), 2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--merge-cache", type=Path, nargs="*", default=[])
    ap.add_argument("--no-score", action="store_true", help="do not compute new pairs, use the cache as is")
    a = ap.parse_args()
    fz = json.loads(B.FROZEN.read_text())
    ctx = B.Ctx("extended", norm="mutual", extras=B.EXTRAS + (EXTRA_C,))
    for f in a.merge_cache:
        for k, v in json.loads(f.read_text()).items():
            ctx.lg_cache.setdefault(k, v)
    ctx.save_cache()
    H = [tuple(x) for x in fz["H"]]
    ctx.scope = ctx.bench_pairs(fz)  # T exactly as in the benchmark (r8): normalized H scores over the benchmark's own pairs
    T = B.threshold([ctx.score("lg", *p) for p in H])
    ctx.scope = None  # the list normalizes against every cached pair (the 42 unresolved vivas x all same-compound Coelho + extras)
    gt = {}
    for v, c in load_ground_truth():
        gt.setdefault(v, set()).add(c)
    rejected = {}
    for v, c in load_pair_negatives():
        rejected.setdefault(v, set()).add(c)
    live_c = set(ctx.coelhos)
    vivas = sorted(v for v, x in ctx.pool["viva"].items() if x.get("in_fresh") and v in ctx.vl)
    U = set(fz["U"])

    # ---- scoring: extras x compatible unresolved vivas, then lg_candidates of every viva that is not confirmed
    todo = []
    for v in vivas:
        mv = ctx.pool["viva"][v]
        if v in U:
            for c in ctx.coelhos:
                mc = ctx.pool["coelho"][c]
                if mc["condo"] in B.EXTRAS + (EXTRA_C,) and mc.get("suites") == mv.get("suites") and \
                        abs(rel(mv["lot_m2"], mc["lot_m2"]) or 9) <= LOT_TOL:
                    todo.append((v, c))
        if v not in gt:
            todo += [(v, c) for c in ctx.lg_candidates(v)]
    todo = [p for p in dict.fromkeys(todo) if f"{p[0]}|{p[1]}|all" not in ctx.lg_cache]
    print(f"T={T:g}; {len(todo)} pairs to score")
    if not a.no_score:
        for i, p in enumerate(todo):
            ctx.score_lg(*p)
            if i % 25 == 24:
                ctx.save_cache()
                print(f"  scored {i + 1}/{len(todo)}", flush=True)
        ctx.save_cache()

    rows = []
    for v in vivas:
        mv = ctx.pool["viva"][v]
        scored = {k.split("|")[1]: r["max"] for k, r in ctx.lg_cache.items() if k.startswith(f"{v}|") and k.endswith("|all")}
        scored = {c: s for c, s in scored.items() if c in live_c}
        norm = {c: ctx.normalize(v, c, s, s) for c, s in scored.items()}
        rej = rejected.get(v, set()) - gt.get(v, set())
        cnt = {c: ctx.score_sscd(v, c) for c in ctx.allp[v]}
        pick = [c for c in scored if c not in rej] or list(scored)
        confirmed = sorted(c for c in gt.get(v, ()) if c in live_c)
        if confirmed:
            pick = confirmed
        best = max(pick, key=lambda c: (norm.get(c, 0), scored.get(c, 0), cnt.get(c, 0))) if pick else None
        note = []
        hit = [c for c in scored if c not in rej and norm[c] > T and (v, c) not in REVIEWED_DIFFERENT and meta_ok(mv, ctx.pool["coelho"][c])]
        for c in scored:
            if c not in rej and norm[c] > T and (v, c) not in REVIEWED_DIFFERENT and c not in hit:
                note.append(f"{c}: verificador {scored[c]:g} > T mas lote/construida incompativeis")
        photo_dup = [c for c, n in cnt.items() if n >= 2 and c not in rej]
        if confirmed:
            status, codes = "confirmed_at_coelho", confirmed
        elif hit or photo_dup:
            status = "likely_at_coelho"
            codes = sorted(hit or photo_dup, key=lambda c: -norm.get(c, 0) - cnt.get(c, 0))
            best = codes[0]
            note.append("verificador > T" if hit else "fotos copiadas (SSCD >= 2)")
        else:
            status, codes = "not_found_at_coelho", []
        old = sorted(c for c in gt.get(v, ()) if c not in live_c)
        if old and not confirmed:
            note.append(f"ja confirmada na Coelho {','.join(old)}, que saiu do ar")
        for c in scored:
            if (v, c) in REVIEWED_DIFFERENT and scored[c] > T:
                note.append(f"{c}: {REVIEWED_DIFFERENT[(v, c)]}")
        mc = ctx.pool["coelho"].get(best, {}) if best else {}
        plausible = [c for c in ctx.coelhos if c not in scored and v in U and ctx.pool["coelho"][c].get("suites") == mv.get("suites")
                     and abs(rel(mv["lot_m2"], ctx.pool["coelho"][c].get("lot_m2")) or 9) <= LOT_TOL]
        row = {
            "viva_code": v, "viva_url": mv.get("url"), "condo": mv["condo"], "price": mv.get("price"), "lot_m2": mv.get("lot_m2"),
            "built_m2": mv.get("built_m2"), "suites": mv.get("suites"), "status": status,
            "coelho_codes": ",".join(codes), "best_coelho_code": best or "", "best_coelho_url": mc.get("url") or "",
            "best_coelho_condo": (mc.get("condo") if mc.get("condo") != EXTRA_C else "") if mc else "",
            "verifier_score": scored.get(best) if best else None, "verifier_score_norm": norm.get(best) if best else None,
            "lot_diff": pct(rel(mv.get("lot_m2"), mc.get("lot_m2"))), "built_diff": pct(rel(mv.get("built_m2"), mc.get("built_m2"))),
            "price_diff": pct(rel(mv.get("price"), mc.get("price"))),
            "suites_coelho": mc.get("suites"), "n_candidates_scored": len(scored),
            "unscored_plausible": len(plausible), "confidence_not_at_coelho": None, "confidence_label": "", "notes": "; ".join(note),
        }
        if status == "not_found_at_coelho":
            raw_best = max([s for c, s in scored.items() if c not in rej] or [0])
            row["confidence_not_at_coelho"] = confidence(raw_best, T, bool(plausible), v in rejected or v in U)
            if old:  # confirmed earlier at a Coelho listing that is gone (sold/removed) and nothing else beats T
                row["confidence_not_at_coelho"] = min(0.97, round(row["confidence_not_at_coelho"] + 0.15, 2))
            row["confidence_label"] = "alta" if row["confidence_not_at_coelho"] >= 0.8 else "media" if row["confidence_not_at_coelho"] >= 0.6 else "baixa"
        elif status == "likely_at_coelho":
            row["confidence_not_at_coelho"], row["confidence_label"] = 0.15, "baixa"
        rows.append(row)
    order = {"not_found_at_coelho": 0, "likely_at_coelho": 1, "confirmed_at_coelho": 2}
    rows.sort(key=lambda r: (order[r["status"]], -(r["confidence_not_at_coelho"] or 0), r["viva_code"]))
    OUT.mkdir(parents=True, exist_ok=True)
    with (OUT / "viva-not-at-coelho.csv").open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    (OUT / "viva-not-at-coelho.json").write_text(json.dumps({"method": "r8 (ALIKED+LightGlue, mutual-best normalization)", "T": T, "rows": rows},
                                                            ensure_ascii=False, indent=1))
    from collections import Counter
    print(Counter(r["status"] for r in rows), "-> data/output/viva-not-at-coelho.csv")


if __name__ == "__main__":
    main()
