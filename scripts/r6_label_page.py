"""Round 6 second label page: the no_match vivas with candidates from metadata + the LightGlue verifier.

Usage: python scripts/r6_label_page.py [OUTDIR]   (default data/review/label-page-r6)
Reads data/r6/targets-v1.json (scripts/r6_report.py). Up to 5 candidates per viva by verifier score, never the
broker-rejected ones; the verified photo pairs (top inliers) are shown side by side. Labels go to the Firestore
collection "labels_r6" (same schema as "labels"). Not deployed by this script.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_label_page import PRIO, ImageStore  # noqa: E402
from fuse_scores import ROOT  # noqa: E402
from lib.listings import load_pool  # noqa: E402
from photo_dups import COELHO, VIVA, list_listings  # noqa: E402
from lib.photo_types import photo_types  # noqa: E402
from topk_agg import COMPOUNDS  # noqa: E402

NOTE = ("Segunda rodada: casas que você marcou como \"não está na Coelho\" quando só mostrávamos 3 candidatas por semelhança de foto. "
        "Agora as candidatas vêm de metadados (terreno, construída, suítes) e de pontos em comum entre fotos, mesmo de ensaios fotográficos diferentes. "
        "O número sob cada par de fotos são pontos geométricos coerentes (mais alto = mais provável). \"Não está na Coelho\" continua valendo.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("outdir", type=Path, nargs="?", default=ROOT / "data/review/label-page-r6")
    ap.add_argument("--cands", type=int, default=5)
    ap.add_argument("--pairs", type=int, default=3)
    ap.add_argument("--context", type=int, default=4)
    a = ap.parse_args()
    a.outdir.mkdir(parents=True, exist_ok=True)
    t = json.loads((ROOT / "data/r6/targets-v1.json").read_text())
    root = ROOT / "data/photos-fresh"
    meta = {s: {x["code"]: x for comp in COMPOUNDS for x in load_pool(comp)[s]} for s in ("viva", "coelho")}
    vl = list_listings(root, VIVA)
    store = ImageStore(a.outdir)
    m = lambda x: x and {k: x.get(k) for k in ("lot_m2", "built_m2", "beds", "suites", "vagas", "price", "url")}  # noqa: E731
    items = []
    # flagged-by-reviewer vivas first, then vivas with a candidate above threshold, then the rest
    recheck = {"12229", "18360"}
    order = sorted(t["targets"], key=lambda v: (v not in recheck, -t["targets"][v][0]["score"]))
    for v in order:
        vf = vl[v]
        types = photo_types(vf, VIVA)
        ctx_p = sorted(vf, key=lambda p: PRIO.get(types[p], 2))[: a.context]
        cands = t["targets"][v]
        if v in recheck:  # the broker-flagged candidate stays visible, first
            flagged = {"12229": "647221", "18360": "685893"}[v]
            cands = sorted(cands, key=lambda c: c["coelho"] != flagged)
        cs = []
        for c in cands[: a.cands]:
            pairs = []
            for r in c["photo_pairs"][: a.pairs]:
                pv, pc = root / r["viva_photo"], root / r["coelho_photo"]
                tag = lambda ty: ty if ty in PRIO else None  # noqa: E731
                pairs.append({"viva": store.add(pv), "coelho": store.add(pc), "sscd": 0.0, "vt": tag(r["vt"]), "ct": tag(r["ct"]),
                              "label": f"{r['inliers']} pts" + (" · espelhada" if r["flip"] else "")})
            cs.append({"code": c["coelho"], "meta": m(meta["coelho"].get(c["coelho"])), "pairs": pairs, "score": c["score"]})
        items.append({"viva": v, "meta": m(meta["viva"].get(v)), "context": [store.add(p) for p in ctx_p],
                      "context_t": [PRIO and (types[p] if types[p] in PRIO else None) for p in ctx_p], "candidates": cs})
    (a.outdir / "data.json").write_text(json.dumps(items, ensure_ascii=False, indent=1))
    html = (ROOT / "scripts/label_page_template.html").read_text()
    html = html.replace("__ITEMS__", json.dumps(items, ensure_ascii=False).replace("</", "<\\/"))
    html = html.replace("Casas Viva na Coelho", "Casas Viva na Coelho: 2ª rodada", 1)
    html = html.replace('<main id="list">', f'<p class="hint">{NOTE}</p><main id="list">', 1)
    marker = '<script type="application/json" id="items">'
    html = html.replace(marker, '<script>window.LABEL_COLLECTION="labels_r6";</script>\n' + marker, 1)
    (a.outdir / "index.html").write_text(html)
    used = {x for it in items for x in it["context"]} | {q for it in items for c in it["candidates"] for p in c["pairs"] for q in (p["viva"], p["coelho"])}
    for f in (a.outdir / "img").glob("*.jpg"):
        if "img/" + f.name not in used:
            f.unlink()
    print(f"{len(items)} items, {len(used)} images -> {a.outdir}")


if __name__ == "__main__":
    main()
