#!/usr/bin/env python3
"""Find reused photos between Viva Prime and Coelho da Fonseca listings.

Layout: <root>/<site>/<listing_code>/*.jpg|png|webp  (site: vivaprimeimoveis | coelhodafonseca)

A photo pair is a near-duplicate if PDQ Hamming (min over 8 dihedral variants) <= --pdq-thresh
OR SSCD cosine (max over original/hflip) >= --sscd-thresh.

Thresholds: PDQ <= 31 is the PDQ authors' (Facebook ThreatExchange) recommended match
distance (of 256 bits); SSCD 0.75 is a conservative value for the sscd_disc_mixup
descriptor (SSCD README suggests ~0.5-0.75 for copy detection; higher = fewer false positives).

Usage:
    python scripts/photo_dups.py --root data/photos --candidates data/candidates/metadata-v1.json --top-k 20 \
        --out data/photo_dups/pairs.json --out-candidates data/candidates/metadata+dups-v1.json
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.photo_fingerprints import IMAGE_EXTS, Fingerprint, fingerprint_files, pairwise_pdq  # noqa: E402

log = logging.getLogger("photo_dups")
VIVA, COELHO = "vivaprimeimoveis", "coelhodafonseca"
METHOD = "metadata+dups-v1"


def list_listings(root: Path, site: str) -> dict[str, list[Path]]:
    out: dict[str, list[Path]] = {}
    for d in sorted((root / site).glob("*")):
        if d.is_dir():
            files = sorted(p for p in d.iterdir() if p.suffix.lower() in IMAGE_EXTS)
            if files:
                out[d.name] = files
    return out


def compare_listings(
    va: list[Path], ca: list[Path], fps: dict[Path, Fingerprint], sscd_t: float, pdq_t: int
) -> dict:
    ve = np.stack([fps[p].emb for p in va])  # n,2,D
    ce = np.stack([fps[p].emb for p in ca])  # m,2,D
    # original vs original and original vs flipped covers both orientations
    sim = np.maximum(ve[:, 0] @ ce[:, 0].T, ve[:, 0] @ ce[:, 1].T)
    vp = np.stack([fps[p].pdq[0] for p in va])  # original hash
    cp = np.stack([fps[p].pdq for p in ca])  # m,8,32
    dist = pairwise_pdq(vp, cp)
    dup = (sim >= sscd_t) | (dist <= pdq_t)
    idx = np.argwhere(dup)
    idx = sorted(idx.tolist(), key=lambda ij: -sim[ij[0], ij[1]])
    # n_dup_photos: viva photos with >=1 duplicate counterpart; also distinct coelho photos / matched pairs
    flat = np.argsort(-sim, axis=None)[:3]
    top = [[va[i].name, ca[j].name, round(float(sim[i, j]), 4)] for i, j in (np.unravel_index(f, sim.shape) for f in flat)]
    return {
        "n_dup_photos": int(dup.any(axis=1).sum()),
        "n_dup_coelho_photos": int(dup.any(axis=0).sum()),
        "n_dup_pairs": int(dup.sum()),
        "top_pairs": top,
        "best_sscd": round(float(sim.max()), 4),
        "best_pdq_dist": int(dist.min()),
        "pairs": [
            [va[i].name, ca[j].name, round(float(sim[i, j]), 4), int(dist[i, j])] for i, j in idx[:5]
        ],
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", required=True, type=Path)
    ap.add_argument("--candidates", type=Path, help="metadata-v1 style candidates JSON")
    ap.add_argument("--top-k", type=int, default=20)
    ap.add_argument("--all-pairs", action="store_true")
    ap.add_argument("--sscd-thresh", type=float, default=0.75)
    ap.add_argument("--pdq-thresh", type=int, default=31)
    ap.add_argument("--batch-size", type=int, default=16)
    ap.add_argument("--out", type=Path, default=Path("data/photo_dups/pairs.json"))
    ap.add_argument("--out-candidates", type=Path, default=Path("data/candidates/metadata+dups-v1.json"))
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    log.info("thresholds: SSCD cosine >= %.2f (conservative, SSCD README range 0.5-0.75); "
             "PDQ Hamming <= %d (PDQ recommended match distance)", args.sscd_thresh, args.pdq_thresh)

    viva = list_listings(args.root, VIVA)
    coelho = list_listings(args.root, COELHO)
    log.info("%d viva listings, %d coelho listings", len(viva), len(coelho))
    if not args.all_pairs and not args.candidates:
        ap.error("need --candidates or --all-pairs")

    incoming: dict[str, list[dict]] = {}
    if args.candidates:
        incoming = json.loads(args.candidates.read_text())["candidates"]
    if args.all_pairs:
        pairs = [(v, c) for v in viva for c in coelho]
    else:
        pairs = [(v, str(c["coelho"])) for v in viva for c in incoming.get(v, [])[: args.top_k] if str(c["coelho"]) in coelho]

    needed_v = {v for v, _ in pairs}
    needed_c = {c for _, c in pairs}
    files = [p for v in needed_v for p in viva[v]] + [p for c in needed_c for p in coelho[c]]
    fps = fingerprint_files(files, args.root / "_cache", batch_size=args.batch_size)
    # drop unreadable photos, not whole listings
    viva = {k: [p for p in ps if p in fps] for k, ps in viva.items()}
    coelho = {k: [p for p in ps if p in fps] for k, ps in coelho.items()}
    pairs = [(v, c) for v, c in pairs if viva.get(v) and coelho.get(c)]

    results: dict[str, dict[str, dict]] = {}
    for v, c in pairs:
        results.setdefault(v, {})[c] = compare_listings(viva[v], coelho[c], fps, args.sscd_thresh, args.pdq_thresh)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps({"sscd_thresh": args.sscd_thresh, "pdq_thresh": args.pdq_thresh,
                                    "pairs": results}, indent=1))

    reranked: dict[str, list[dict]] = {}
    for v, base in incoming.items():
        res = results.get(v, {})
        hit = [c for c in base if res.get(str(c["coelho"]), {}).get("n_dup_photos", 0) >= 1]
        hit.sort(key=lambda c: (-res[str(c["coelho"])]["n_dup_photos"], -res[str(c["coelho"])]["best_sscd"]))
        rest = [c for c in base if c not in hit]
        reranked[v] = hit + rest
    if incoming:
        args.out_candidates.parent.mkdir(parents=True, exist_ok=True)
        args.out_candidates.write_text(json.dumps({"method": METHOD, "candidates": reranked}))
        n = sum(1 for v in reranked if any(res["n_dup_photos"] for res in results.get(v, {}).values()))
        log.info("wrote %s (%d vivas have >=1 dup listing)", args.out_candidates, n)
    log.info("wrote %s (%d listing pairs)", args.out, len(pairs))


if __name__ == "__main__":
    main()
