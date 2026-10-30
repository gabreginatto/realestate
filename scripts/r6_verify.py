"""Round 6: photo-independent candidates + different-shoot visual verifier (ALIKED + LightGlue + MAGSAC, DINOv2 pairing).

Stages (all idempotent, caches keyed by file sha1 under data/photos/_cache/{aliked,dino}):
  1. metadata_scores(): per viva, live Coelho of the same compound ranked by lot m2 / built m2 / suites / beds.
  2. build_pairs(): positives, broker-rejected shown pairs (hard negatives), random same-compound pairs (sure
     negatives) and, for the vivas labeled "no_match" against the shown top-3, the union of metadata top-10 and
     r5 top-10 minus rejected.
  3. DINOv2-base (CLS + mean patch, ~448px, no crop) picks <= 8 photo pairs per listing pair (same CLIP photo type,
     generic and near-copy-free photos only when mode == "noncopy").
  4. ALIKED+LightGlue on MPS, original and h-flipped Viva photo, Coelho watermark band keypoints dropped,
     fundamental-matrix MAGSAC inliers and their convex-hull spread.
Output: data/r6/verify-v1.json  {pairs: [{v, c, kind, mode, photo_pairs: [...]}]}
"""
import argparse
import hashlib
import json
import random
import sys
import time
from pathlib import Path

import cv2
import numpy as np
import torch
from PIL import Image, ImageOps

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fuse_scores import ROOT  # noqa: E402
from lib.ground_truth import load_ground_truth, load_needs_recheck, load_nomatch_live, load_pair_negatives  # noqa: E402
from lib.listings import load_pool  # noqa: E402
from lib.photo_fingerprints import fingerprint_files, sha1_file  # noqa: E402
from lib.photo_types import photo_types  # noqa: E402
from photo_dups import COELHO, VIVA, list_listings  # noqa: E402
from photo_idf import listing_counts, load_embeddings  # noqa: E402
from topk_agg import COMPOUNDS, load_live  # noqa: E402

DEV = "mps" if torch.backends.mps.is_available() else "cpu"
CACHE = ROOT / "data/photos/_cache"
OUT = ROOT / "data/r6"
LONG = 1024  # matching resolution (long side)
N_KPT = 2048
MAGSAC_PX = 1.5
WM_X, WM_Y = (0.08, 0.90), (0.43, 0.56)  # "COELHO DA FONSECA" band, from the mean/std of 60 Coelho photos
PAIRS_PER = 8
R5 = ROOT / "data/candidates/topk-agg-live-idf-v1.json"


# ---------------------------------------------------------------- metadata candidate generator
def metadata_score(v, c):
    """Higher is better. Lot m2 dominates (<=3% rel diff strongest), then built m2 (<=15%), suites, beds."""
    s, diffs = 0.0, {}
    lv, lc = v.get("lot_m2"), c.get("lot_m2")
    if lv and lc:
        d = abs(lv - lc) / max(lv, lc)
        diffs["lot"] = d
        s += 4.0 if d <= 0.03 else 2.0 * max(0.0, 1 - d / 0.15)
    bv, bc = v.get("built_m2"), c.get("built_m2")
    if bv and bc:
        d = abs(bv - bc) / max(bv, bc)
        diffs["built"] = d
        s += 2.0 if d <= 0.15 else 0.0
        s += 1.0 * max(0.0, 1 - d / 0.15)
    if v.get("suites") is not None and c.get("suites") is not None:
        s += 1.0 if v["suites"] == c["suites"] else -0.5 * min(3, abs(v["suites"] - c["suites"]))
    if v.get("beds") is not None and c.get("beds") is not None:
        s += 0.5 if v["beds"] == c["beds"] else -0.25 * min(3, abs(v["beds"] - c["beds"]))
    if "lot" in diffs:
        s -= diffs["lot"] * 0.5  # tie-break among near equals
    return s, diffs


def metadata_rank(allp):
    """{viva: [(coelho, score, diffs)]} over live Coelho of the viva's compound (allp already restricted)."""
    pool = {}
    for comp in COMPOUNDS:
        p = load_pool(comp)
        for site in ("viva", "coelho"):
            for x in p[site]:
                pool.setdefault(site, {})[x["code"]] = x
    out = {}
    for v, cs in allp.items():
        rows = []
        for c in cs:
            sc, d = metadata_score(pool["viva"][v], pool["coelho"][c])
            rows.append((c, sc, d))
        out[v] = sorted(rows, key=lambda r: -r[1])
    return out, pool


# ---------------------------------------------------------------- image loading / features
def load_img(path, long_side):
    im = Image.open(path)
    im.draft("RGB", (long_side * 2, long_side * 2))
    im = ImageOps.exif_transpose(im).convert("RGB")
    w, h = im.size
    k = long_side / max(w, h)
    return im.resize((max(8, round(w * k)), max(8, round(h * k))), Image.LANCZOS)


class Dino:
    def __init__(self):
        from transformers import AutoModel
        self.m = AutoModel.from_pretrained("facebook/dinov2-base").to(DEV).eval()
        self.dir = CACHE / "dino-b448"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.mean = torch.tensor([0.485, 0.456, 0.406]).view(3, 1, 1)
        self.std = torch.tensor([0.229, 0.224, 0.225]).view(3, 1, 1)

    def embed(self, path, sha):
        f = self.dir / f"{sha}.npy"
        if f.exists():
            return np.load(f)
        im = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
        w, h = im.size
        k = (448 * 602 / (w * h)) ** 0.5  # ~448x602 tokens area, aspect kept, no crop
        nw, nh = max(14, round(w * k / 14) * 14), max(14, round(h * k / 14) * 14)
        x = torch.from_numpy(np.asarray(im.resize((nw, nh), Image.BICUBIC))).permute(2, 0, 1).float() / 255
        x = ((x - self.mean) / self.std)[None].to(DEV)
        with torch.no_grad():
            hs = self.m(pixel_values=x).last_hidden_state[0].float().cpu()
        cls, patch = hs[0], hs[1:].mean(0)
        e = torch.cat([cls / cls.norm(), patch / patch.norm()]).numpy() / np.sqrt(2)
        np.save(f, e.astype(np.float32))
        return e


class Matcher:
    def __init__(self):
        from lightglue import ALIKED, LightGlue
        self.ex = ALIKED(max_num_keypoints=N_KPT, detection_threshold=0.01).eval().to(DEV)
        self.lg = LightGlue(features="aliked").eval().to(DEV)
        self.dir = CACHE / "aliked-1024"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.mem = {}

    def feats(self, path, sha, flip):
        key = (sha, flip)
        if key in self.mem:
            return self.mem[key]
        f = self.dir / f"{sha}{'_f' if flip else ''}.npz"
        if f.exists():
            z = np.load(f)
            r = {"kp": z["kp"], "desc": z["desc"].astype(np.float32), "size": z["size"]}
        else:
            im = load_img(path, LONG)
            if flip:
                im = ImageOps.mirror(im)
            x = torch.from_numpy(np.asarray(im)).permute(2, 0, 1).float().div(255).to(DEV)
            with torch.no_grad():
                o = self.ex.extract(x)
            r = {"kp": o["keypoints"][0].cpu().numpy(), "desc": o["descriptors"][0].cpu().numpy(),
                 "size": np.array([im.size[0], im.size[1]], np.float32)}
            np.savez(f, kp=r["kp"], desc=r["desc"].astype(np.float16), size=r["size"])
        if len(self.mem) > 4000:
            self.mem.clear()
        self.mem[key] = r
        return r

    def match(self, a, b, mask_b):
        """a: viva feats, b: coelho feats; mask_b drops the watermark band on b. -> (n_matches, inliers, spread)."""
        kb, db = b["kp"], b["desc"]
        if mask_b:
            nx, ny = kb[:, 0] / b["size"][0], kb[:, 1] / b["size"][1]
            keep = ~((nx > WM_X[0]) & (nx < WM_X[1]) & (ny > WM_Y[0]) & (ny < WM_Y[1]))
            kb, db = kb[keep], db[keep]
        if len(a["kp"]) < 8 or len(kb) < 8:
            return 0, 0, 0.0
        t = lambda arr: torch.from_numpy(arr)[None].to(DEV)  # noqa: E731
        d = {"image0": {"keypoints": t(a["kp"]), "descriptors": t(a["desc"]), "image_size": t(a["size"])},
             "image1": {"keypoints": t(kb), "descriptors": t(db), "image_size": t(b["size"])}}
        with torch.no_grad():
            mt = self.lg(d)["matches"][0].cpu().numpy()
        if len(mt) < 8:
            return len(mt), 0, 0.0
        p0, p1 = a["kp"][mt[:, 0]], kb[mt[:, 1]]
        try:
            _, m = cv2.findFundamentalMat(p0, p1, cv2.USAC_MAGSAC, MAGSAC_PX, 0.999, 10000)
        except cv2.error:
            return len(mt), 0, 0.0
        if m is None:
            return len(mt), 0, 0.0
        m = m.ravel().astype(bool)
        n = int(m.sum())
        if n < 4:
            return len(mt), n, 0.0
        sp = min(cv2.contourArea(cv2.convexHull(p.astype(np.float32))) / (s[0] * s[1])
                 for p, s in ((p0[m], a["size"]), (p1[m], b["size"])))
        return len(mt), n, float(sp)


# ---------------------------------------------------------------- pair construction
def build_pairs(allp, r5, mrank, seed=0):
    gt = {(v, c) for v, c in load_ground_truth() if v in allp and c in allp[v]}
    hard = {(v, c) for v, c in load_pair_negatives() if v in allp and c in allp[v]}
    rejected = {}
    for v, c in load_pair_negatives():
        rejected.setdefault(v, set()).add(c)
    gt_by_v = {}
    for v, c in gt:
        gt_by_v.setdefault(v, set()).add(c)
    rng = random.Random(seed)
    pairs = {}

    def add(v, c, kind):
        pairs.setdefault((v, c), set()).add(kind)

    for v, c in sorted(gt):
        add(v, c, "pos")
    for v, c in sorted(hard):
        add(v, c, "hard")
    r5_score = {v: {x["coelho"]: x["score"] for x in r5[v]} for v in r5}
    for v in sorted(gt_by_v):
        dup = {c for c, s in r5_score[v].items() if s > 0}  # may be another listing of the same house
        pool = sorted(c for c in allp[v] if c not in gt_by_v[v] | dup | rejected.get(v, set()))
        for c in rng.sample(pool, min(3, len(pool))):
            add(v, c, "sure")
        # competitors for the R@1 evaluation of the combined ranking
        for c in [x["coelho"] for x in r5[v][:5]] + [x[0] for x in mrank[v][:5]]:
            if (v, c) not in hard:
                add(v, c, "rank")
    nm = load_nomatch_live()
    recheck = load_needs_recheck()
    targets = sorted(v for v in nm if v in allp)
    for v in targets:
        rej = rejected.get(v, set())
        cand = [x["coelho"] for x in r5[v][:10]] + [x[0] for x in mrank[v][:10]] + recheck.get(v, [])
        for c in cand:
            if c in recheck.get(v, []) or c not in rej:
                add(v, c, "target")
    return pairs, targets


def select_photo_pairs(v, c, vph, cph, emb, types, generic, copied, mode):
    """<= PAIRS_PER photo pairs by DINO cosine, same CLIP type first, <= 2 uses per photo."""
    vi = [p for p in vph if p in emb and types[p] != "other" and p not in generic]
    ci = [p for p in cph if p in emb and types[p] != "other" and p not in generic]
    if mode == "noncopy":
        vi = [p for p in vi if p not in copied[0]]
        ci = [p for p in ci if p not in copied[1]]
    if not vi or not ci:
        return []
    S = np.stack([emb[p] for p in vi]) @ np.stack([emb[p] for p in ci]).T
    cells = sorted(((i, j) for i in range(len(vi)) for j in range(len(ci))),
                   key=lambda ij: (types[vi[ij[0]]] != types[ci[ij[1]]], -S[ij]))
    out, uv, uc = [], {}, {}
    for i, j in cells:
        if uv.get(i, 0) >= 2 or uc.get(j, 0) >= 2:
            continue
        out.append((vi[i], ci[j], float(S[i, j])))
        uv[i] = uv.get(i, 0) + 1
        uc[j] = uc.get(j, 0) + 1
        if len(out) == PAIRS_PER:
            break
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--photos-root", type=Path, default=ROOT / "data/photos-fresh")
    ap.add_argument("--out", type=Path, default=OUT / "verify-v1.json")
    ap.add_argument("--limit", type=int, default=0, help="debug: only first N listing pairs")
    a = ap.parse_args()
    OUT.mkdir(exist_ok=True)
    root = a.photos_root.resolve()
    allp, _ = load_live(root)
    r5d = json.loads(R5.read_text())
    r5, tau = r5d["candidates"], r5d["tau"]
    mrank, _ = metadata_rank(allp)
    pairs, targets = build_pairs(allp, r5, mrank)
    plist = [(v, c, "all", ks) for (v, c), ks in sorted(pairs.items())]
    plist += [(v, c, "noncopy", {"pos_nc"}) for (v, c), ks in sorted(pairs.items()) if "pos" in ks]
    if a.limit:
        plist = plist[: a.limit]
    print(f"{len(pairs)} listing pairs, {len(plist)} with modes; targets {len(targets)}", flush=True)

    vl, cl = list_listings(root, VIVA), list_listings(root, COELHO)
    vs = sorted({v for v, *_ in plist})
    cs = sorted({c for _, c, *_ in plist})
    files = [p for v in vs for p in vl[v]] + [p for c in cs for p in cl[c]]
    sha = {p: sha1_file(p) for p in files}
    types = {}
    types.update(photo_types([p for p in files if p.parent.parent.name == VIVA], VIVA))
    types.update(photo_types([p for p in files if p.parent.parent.name == COELHO], COELHO))

    # generic photos (r5 rule) and near-copy photos (for the different-shoot simulation)
    allv, allc = sorted(allp), sorted({c for v in allp for c in allp[v]})
    V, C = load_embeddings(root, allv, allc)
    cv, cc = listing_counts(V, C, tau), listing_counts(C, V, tau)
    generic = set()
    for v, (no, ns) in cv.items():
        generic |= {p for p, n in zip(vl[v], no + ns) if n >= 3}
    for c, (no, ns) in cc.items():
        generic |= {p for p, n in zip(cl[c], no + ns) if n >= 3}
    fps = fingerprint_files(files, CACHE)
    print(f"generic photos among involved: {len(generic)}", flush=True)

    t0 = time.time()
    dino = Dino()
    emb = {}
    for i, p in enumerate(files):
        try:
            emb[p] = dino.embed(p, sha[p])
        except Exception as e:  # noqa: BLE001
            print("dino fail", p, e)
        if i % 500 == 0:
            print(f"dino {i}/{len(files)} {time.time() - t0:.0f}s", flush=True)
    mt = Matcher()
    res = []
    for k, (v, c, mode, kinds) in enumerate(plist):
        copied = (set(), set())
        if mode == "noncopy":
            vp, cp = [p for p in vl[v] if p in fps], [p for p in cl[c] if p in fps]
            s = np.maximum(np.stack([fps[p].emb[0] for p in vp]) @ np.stack([fps[p].emb[0] for p in cp]).T,
                           np.stack([fps[p].emb[0] for p in vp]) @ np.stack([fps[p].emb[1] for p in cp]).T)
            copied = ({vp[i] for i, j in zip(*np.where(s >= tau))}, {cp[j] for i, j in zip(*np.where(s >= tau))})
        sel = select_photo_pairs(v, c, vl[v], cl[c], emb, types, generic, copied, mode)
        recs = []
        for pv, pc, ds in sel:
            best = None
            for flip in (False, True):
                n_m, n_i, sp = mt.match(mt.feats(pv, sha[pv], flip), mt.feats(pc, sha[pc], False), True)
                if best is None or n_i > best["inliers"]:
                    best = {"inliers": n_i, "matches": n_m, "spread": round(sp, 4), "flip": flip}
            recs.append({"viva_photo": str(pv.relative_to(root)), "coelho_photo": str(pc.relative_to(root)),
                         "dino": round(ds, 4), "vt": types[pv], "ct": types[pc], **best})
        res.append({"v": v, "c": c, "mode": mode, "kinds": sorted(kinds), "photo_pairs": recs})
        if k % 50 == 0:
            print(f"match {k}/{len(plist)} {time.time() - t0:.0f}s", flush=True)
    a.out.write_text(json.dumps({"method": "r6-lightglue-verify", "tau": tau, "pairs": res}))
    print("done", len(res), f"{time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
