"""Build the broker labeling page bundle (index.html + img/*.jpg + data.json).

Usage: python scripts/build_label_page.py OUTDIR [--pairs 3] [--cands 3] [--context 4]
Items: vivas in data/review/to-label-r3.json; candidates from data/candidates/topk-agg-v1.json.
"""
import argparse
import hashlib
import io
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.listings import load_pool  # noqa: E402
from lib.photo_fingerprints import fingerprint_files  # noqa: E402
from lib.photo_types import photo_types  # noqa: E402
from photo_dups import COELHO, VIVA, list_listings  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
PHOTOS = ROOT / "data/photos"


class ImageStore:
    def __init__(self, outdir: Path):
        self.dir = outdir / "img"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.by_src: dict[Path, str] = {}

    def add(self, src: Path) -> str:
        if src in self.by_src:
            return self.by_src[src]
        img = ImageOps.exif_transpose(Image.open(src)).convert("RGB")
        img.thumbnail((640, 640), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=72, optimize=True)  # no exif saved
        name = hashlib.sha1(buf.getvalue()).hexdigest()[:12] + ".jpg"
        f = self.dir / name
        if not f.exists():
            f.write_bytes(buf.getvalue())
        self.by_src[src] = "img/" + name
        return self.by_src[src]


PRIO = {"pool": 0, "outdoor": 1}  # lower = shown first; anything else is 2


def best_pairs(vfiles, cfiles, fps, n, types):
    """Greedy one-to-one pairs; pairs touching a pool/outdoor photo come first (pool > outdoor, then SSCD),
    remaining slots filled with the best SSCD pairs of any type."""
    ve = np.stack([fps[p].emb for p in vfiles])
    ce = np.stack([fps[p].emb for p in cfiles])
    sim = np.maximum(ve[:, 0] @ ce[:, 0].T, ve[:, 0] @ ce[:, 1].T)

    def prio(i, j):
        return min(PRIO.get(types[vfiles[i]], 2), PRIO.get(types[cfiles[j]], 2))

    cells = [(i, j) for i in range(sim.shape[0]) for j in range(sim.shape[1])]
    cells.sort(key=lambda ij: (prio(*ij), -sim[ij]))
    picked, used_v, used_c = [], set(), set()
    for i, j in cells:
        if i in used_v or j in used_c:
            continue
        picked.append((vfiles[i], cfiles[j], float(sim[i, j])))
        used_v.add(i)
        used_c.add(j)
        if len(picked) == n:
            break
    return picked


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("outdir", type=Path)
    ap.add_argument("--pairs", default="3,3,3", help="pairs per candidate rank, comma list")
    ap.add_argument("--cands", type=int, default=3)
    ap.add_argument("--context", type=int, default=4)
    ap.add_argument("--html", type=Path, default=ROOT / "scripts/label_page_template.html")
    a = ap.parse_args()
    npairs = [int(x) for x in a.pairs.split(",")]
    a.outdir.mkdir(parents=True, exist_ok=True)

    rev = json.loads((ROOT / "data/review/to-label-r3.json").read_text())
    vivas = [x["viva"] for x in rev["firing"]] + [x["viva"] for x in rev["not_firing"]]
    for extra in ("18093", "17948"):
        if extra not in vivas:
            vivas.append(extra)
    cands = json.loads((ROOT / "data/candidates/topk-agg-v1.json").read_text())["candidates"]
    pool = load_pool()
    meta = {s: {x["code"]: x for x in pool[s]} for s in ("viva", "coelho")}
    vl, cl = list_listings(PHOTOS, VIVA), list_listings(PHOTOS, COELHO)
    need = [p for v in vivas for p in vl.get(v, [])]
    need += [p for v in vivas for c in cands[v][: a.cands] for p in cl.get(c["coelho"], [])]
    fps = fingerprint_files(need, PHOTOS / "_cache")
    types = photo_types(sorted({p for p in need if p.parent.parent.name == VIVA}), VIVA)
    types.update(photo_types(sorted({p for p in need if p.parent.parent.name == COELHO}), COELHO))
    tag = lambda p: types[p] if types[p] in PRIO else None  # noqa: E731
    store = ImageStore(a.outdir)

    def m(x):
        if not x:
            return None
        return {k: x.get(k) for k in ("lot_m2", "built_m2", "beds", "suites", "vagas", "price", "url")}

    items = []
    for v in vivas:
        vf = [p for p in vl.get(v, []) if p in fps]
        vf_ctx = sorted(vf, key=lambda p: PRIO.get(types[p], 2))[: a.context]  # stable: keeps file order in a tier
        ctx = [store.add(p) for p in vf_ctx]
        ctx_t = [tag(p) for p in vf_ctx]
        cs = []
        for rk, c in enumerate(cands[v][: a.cands]):
            cf = [p for p in cl.get(c["coelho"], []) if p in fps]
            pairs = []
            if vf and cf:
                for pv, pc, s in best_pairs(vf, cf, fps, npairs[min(rk, len(npairs) - 1)], types):
                    pairs.append({"viva": store.add(pv), "coelho": store.add(pc), "sscd": round(s, 3),
                                  "vt": tag(pv), "ct": tag(pc)})
            cs.append({"code": c["coelho"], "meta": m(meta["coelho"].get(c["coelho"])), "pairs": pairs,
                       "score": c.get("score")})
        items.append({"viva": v, "meta": m(meta["viva"].get(v)), "context": ctx, "context_t": ctx_t, "candidates": cs})

    (a.outdir / "data.json").write_text(json.dumps(items, ensure_ascii=False, indent=1))
    html = a.html.read_text().replace("__ITEMS__", json.dumps(items, ensure_ascii=False).replace("</", "<\\/"))
    (a.outdir / "index.html").write_text(html)
    used = {x for it in items for x in it["context"]} | {q for it in items for c in it["candidates"] for p in c["pairs"] for q in (p["viva"], p["coelho"])}
    for f in (a.outdir / "img").glob("*.jpg"):
        if "img/" + f.name not in used:
            f.unlink()
    files = list((a.outdir / "img").glob("*.jpg"))
    mb = sum(f.stat().st_size for f in files) / 1e6
    print(f"{len(items)} items, {len(files)} images, {mb:.1f} MB")


if __name__ == "__main__":
    main()
