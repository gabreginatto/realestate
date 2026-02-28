#!/usr/bin/env python3
"""
DINOv2 Auto-Matcher — property matching pipeline.

Two strategies are available (--strategy):

  optimal (default)
    Embeds all listings upfront, builds a full NxM similarity matrix, then
    runs scipy.optimize.linear_sum_assignment for the globally optimal
    one-to-one assignment. Also outputs a near_misses section showing the
    best unmatched score for every Viva listing — useful for threshold tuning.

  greedy
    5-pass progressively-relaxed loop (original implementation). Processes
    Viva listings in order; each one claims its best available Coelho match
    above threshold. Kept for comparison.

Usage:
    python scripts/dino-auto-matcher.py \\
        --dino-url http://{VM_IP}:8000 \\
        --threshold 0.85 \\
        --data-root data/ \\
        --output data/auto-matches.json

    # Dry-run (random embeddings, tests pipeline logic):
    python scripts/dino-auto-matcher.py --dry-run
"""

import argparse
import json
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import requests

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("dino-matcher")

# ---------------------------------------------------------------------------
# Pass criteria (greedy strategy only)
# ---------------------------------------------------------------------------

PASS_CRITERIA = [
    {"pass": 1, "label": "strict",     "area_tol": 0.15, "beds_delta": 0},
    {"pass": 2, "label": "relaxed",    "area_tol": 0.20, "beds_delta": 0},
    {"pass": 3, "label": "broader",    "area_tol": 0.28, "beds_delta": 1},
    {"pass": 4, "label": "very_broad", "area_tol": 0.40, "beds_delta": 2},
    {"pass": 5, "label": "hail_mary",  "hail_mary": True},
]
# Price is not a hard gate — agencies list the same property at different prices
# too often. Price feeds into score_candidate() for candidate ranking only.

# ---------------------------------------------------------------------------
# Helpers — parsing
# ---------------------------------------------------------------------------

def parse_area(area_str) -> float | None:
    if not area_str:
        return None
    import re
    m = re.search(r"(\d+(?:[.,]\d+)?)", str(area_str))
    return float(m.group(1).replace(",", ".")) if m else None


def parse_price(price_str) -> float | None:
    if not price_str:
        return None
    import re
    m = re.search(r"[\d.,]+", str(price_str))
    if not m:
        return None
    raw = m.group(0).replace(".", "").replace(",", ".")
    try:
        return float(raw)
    except ValueError:
        return None


def within_tolerance(a: float | None, b: float | None, tol: float) -> bool:
    if a is None or b is None:
        return False
    if a == 0 and b == 0:
        return True
    return abs(a - b) / ((a + b) / 2) <= tol


# ---------------------------------------------------------------------------
# Helpers — candidate scoring (for greedy ranking)
# ---------------------------------------------------------------------------

def score_candidate(viva_area, viva_price, viva_beds,
                    coelho_area, coelho_price, coelho_beds) -> float:
    score = 0.0
    if viva_area and coelho_area and viva_area > 0:
        score += max(0.0, 1.0 - abs(viva_area - coelho_area) / ((viva_area + coelho_area) / 2)) * 0.4
    if viva_price and coelho_price and viva_price > 0:
        score += max(0.0, 1.0 - abs(viva_price - coelho_price) / ((viva_price + coelho_price) / 2)) * 0.4
    if viva_beds is not None and coelho_beds is not None:
        score += max(0.0, 1.0 - abs(viva_beds - coelho_beds) * 0.5) * 0.2
    return score


# ---------------------------------------------------------------------------
# Helpers — image resolution (priority chain)
# ---------------------------------------------------------------------------

def get_images_for_listing(site: str, listing_id: str, data_root: Path,
                           compound: str | None = None) -> list[Path]:
    """
    Priority:
      1. selected_for_matching/{site}/{listing_id}/   (CLIP-selected, pool-first)
      2. selected_exteriors/{site}/{listing_id}/      (HSV-selected, legacy)
      3. data/{compound}/mosaics/{site}/{listing_id}.png
      4. data/{site}/images/{listing_id}_1.jpg, _2.jpg
    """
    repo_root = data_root.parent

    for subdir in ("selected_for_matching", "selected_exteriors"):
        candidate = repo_root / subdir / site / listing_id
        if candidate.is_dir():
            imgs = sorted(
                p for p in candidate.iterdir()
                if p.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp")
                and not p.name.startswith("_")
            )
            if imgs:
                return imgs

    if compound:
        mosaic = data_root / compound / "mosaics" / site / f"{listing_id}.png"
        if mosaic.exists():
            return [mosaic]

    images_dir = data_root / site / "images"
    raw_imgs = []
    for n in (1, 2):
        for ext in ("jpg", "jpeg", "png"):
            p = images_dir / f"{listing_id}_{n}.{ext}"
            if p.exists():
                raw_imgs.append(p)
                break
    return raw_imgs


# ---------------------------------------------------------------------------
# DINOv2 embedding via HTTP server
# ---------------------------------------------------------------------------

def embed_image(image_path: Path, dino_url: str) -> np.ndarray | None:
    endpoint = dino_url.rstrip("/") + "/embed"
    try:
        with open(image_path, "rb") as f:
            resp = requests.post(endpoint, files={"image": f}, timeout=30)
        resp.raise_for_status()
        return np.array(resp.json()["embedding"], dtype=np.float32)
    except Exception as exc:
        log.warning(f"  embed failed for {image_path.name}: {exc}")
        return None


def mean_embedding(image_paths: list[Path], dino_url: str) -> np.ndarray | None:
    vectors = [embed_image(p, dino_url) for p in image_paths]
    vectors = [v for v in vectors if v is not None]
    if not vectors:
        return None
    return np.stack(vectors).mean(axis=0)


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    return float(np.dot(a, b) / (na * nb)) if na > 0 and nb > 0 else 0.0


# ---------------------------------------------------------------------------
# Embedding cache (shared between strategies)
# ---------------------------------------------------------------------------

class EmbeddingCache:
    def __init__(self, dino_url: str, data_root: Path,
                 compound: str | None, dry_run: bool):
        self._cache: dict[str, np.ndarray | None] = {}
        self.api_calls = 0
        self.dino_url = dino_url
        self.data_root = data_root
        self.compound = compound
        self.dry_run = dry_run

    def get(self, site: str, code: str) -> np.ndarray | None:
        key = f"{site}/{code}"
        if key in self._cache:
            return self._cache[key]
        image_paths = get_images_for_listing(site, code, self.data_root, self.compound)
        if not image_paths:
            log.warning(f"  [{site}/{code}] no images found")
            self._cache[key] = None
            return None
        if self.dry_run:
            v = np.random.randn(768).astype(np.float32)
            v /= np.linalg.norm(v)
            self._cache[key] = v
            return v
        emb = mean_embedding(image_paths, self.dino_url)
        self.api_calls += len(image_paths)
        self._cache[key] = emb
        return emb

    def __len__(self):
        return len(self._cache)


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def load_listings(data_root: Path):
    viva_path = data_root / "vivaprimeimoveis" / "listings" / "all-listings.json"
    coelho_path = data_root / "coelhodafonseca" / "listings" / "all-listings.json"

    with open(viva_path) as f:
        viva_raw = json.load(f)
    with open(coelho_path) as f:
        coelho_raw = json.load(f)

    def parse_viva(listing) -> dict:
        specs = listing.get("detailedData", {}).get("specs", {})
        return {
            "code": str(listing["propertyCode"]),
            "price": parse_price(listing.get("price")),
            "price_raw": listing.get("price"),
            "area": parse_area(specs.get("area_construida")),
            "beds": specs.get("dormitorios"),
            "url": listing.get("url", ""),
            "specs": specs,
        }

    def parse_coelho(listing) -> dict:
        import re
        features = listing.get("features", "")
        area_m = re.search(r"(\d+(?:[.,]\d+)?)\s*m²\s*construída", features, re.I)
        area = float(area_m.group(1).replace(",", ".")) if area_m else None
        beds_m = re.search(r"(\d+)\s*dorms?", features, re.I)
        beds = int(beds_m.group(1)) if beds_m else None
        return {
            "code": str(listing["propertyCode"]),
            "price": parse_price(listing.get("price")),
            "price_raw": listing.get("price"),
            "area": area,
            "beds": beds,
            "url": listing.get("url", ""),
            "features": features,
        }

    viva = [parse_viva(l) for l in viva_raw["listings"]]
    coelho = [parse_coelho(l) for l in coelho_raw["listings"]]
    log.info(f"Loaded {len(viva)} Viva listings, {len(coelho)} Coelho listings")
    return viva, coelho


# ---------------------------------------------------------------------------
# Strategy A — Optimal assignment (default)
# ---------------------------------------------------------------------------

def run_optimal_matching(
    viva_listings: list[dict],
    coelho_listings: list[dict],
    dino_url: str,
    threshold: float,
    data_root: Path,
    compound: str | None,
    dry_run: bool,
) -> dict:
    """
    Build the full NxM cosine similarity matrix, then solve for the globally
    optimal one-to-one assignment using the Hungarian algorithm.
    """
    try:
        from scipy.optimize import linear_sum_assignment
    except ImportError:
        log.error("scipy is required for optimal strategy: pip install scipy")
        sys.exit(1)

    session_started = datetime.now(timezone.utc).isoformat()
    cache = EmbeddingCache(dino_url, data_root, compound, dry_run)

    n_viva = len(viva_listings)
    n_coelho = len(coelho_listings)

    # ── Phase 1: embed all listings ──────────────────────────────────────────
    log.info(f"\nPhase 1 — embedding all {n_viva} Viva listings ...")
    viva_embs = []
    for i, v in enumerate(viva_listings):
        emb = cache.get("vivaprimeimoveis", v["code"])
        viva_embs.append(emb)
        if (i + 1) % 10 == 0:
            log.info(f"  {i+1}/{n_viva} embedded")

    log.info(f"\nPhase 2 — embedding all {n_coelho} Coelho listings ...")
    coelho_embs = []
    for j, c in enumerate(coelho_listings):
        emb = cache.get("coelhodafonseca", c["code"])
        coelho_embs.append(emb)
        if (j + 1) % 10 == 0:
            log.info(f"  {j+1}/{n_coelho} embedded")

    # ── Phase 2: build similarity matrix ────────────────────────────────────
    log.info(f"\nPhase 3 — building {n_viva}×{n_coelho} similarity matrix ...")
    sim_matrix = np.zeros((n_viva, n_coelho), dtype=np.float32)
    for i, v_emb in enumerate(viva_embs):
        if v_emb is None:
            continue
        for j, c_emb in enumerate(coelho_embs):
            if c_emb is None:
                continue
            sim_matrix[i, j] = cosine_similarity(v_emb, c_emb)

    # ── Phase 3: optimal assignment ──────────────────────────────────────────
    log.info("Phase 4 — running optimal assignment (Hungarian algorithm) ...")
    row_ind, col_ind = linear_sum_assignment(-sim_matrix)  # negate to maximise

    matches = []
    matched_viva = set()
    matched_coelho = set()

    for r, c in zip(row_ind, col_ind):
        sim = float(sim_matrix[r, c])
        if sim >= threshold:
            viva = viva_listings[r]
            coelho = coelho_listings[c]
            log.info(
                f"  ✓ MATCH  Viva {viva['code']} ↔ Coelho {coelho['code']}  sim={sim:.4f}"
            )
            matched_viva.add(viva["code"])
            matched_coelho.add(coelho["code"])
            matches.append({
                "viva_code": viva["code"],
                "coelho_code": coelho["code"],
                "matched_at": datetime.now(timezone.utc).isoformat(),
                "reviewer": "dino-v1",
                "similarity_score": round(sim, 6),
                "confidence": "ai_approved",
                "strategy": "optimal",
            })

    # ── Near-misses: best score for each unmatched Viva ─────────────────────
    near_misses = []
    skipped = []
    for i, viva in enumerate(viva_listings):
        if viva["code"] in matched_viva:
            continue
        row = sim_matrix[i]
        best_j = int(np.argmax(row))
        best_sim = float(row[best_j])
        best_coelho = coelho_listings[best_j]
        near_misses.append({
            "viva_code": viva["code"],
            "best_coelho_code": best_coelho["code"],
            "best_sim": round(best_sim, 6),
            "viva_price": viva["price_raw"],
            "viva_area": viva["area"],
            "viva_beds": viva["beds"],
            "coelho_price": best_coelho["price_raw"],
            "coelho_area": best_coelho["area"],
        })
        skipped.append({
            "viva_code": viva["code"],
            "reason": "below_threshold",
            "best_sim": round(best_sim, 6),
            "price": viva["price_raw"],
            "area": viva["area"],
            "beds": viva["beds"],
        })

    # Sort near-misses by best_sim descending — closest to threshold first
    near_misses.sort(key=lambda x: x["best_sim"], reverse=True)

    # Score distribution buckets
    buckets = {}
    for nm in near_misses:
        b = f"{nm['best_sim']:.1f}"[:3]  # e.g. "0.8"
        buckets[b] = buckets.get(b, 0) + 1

    log.info(f"\n{'='*60}")
    log.info(f"Final: {len(matches)} matches, {len(skipped)} unmatched")
    log.info(f"Near-miss score distribution (best sim per unmatched Viva):")
    for bucket, count in sorted(buckets.items(), reverse=True):
        log.info(f"  {bucket}x: {count} listings")
    log.info(f"Total embed API calls: {cache.api_calls}")

    stats = {
        "total_viva": n_viva,
        "total_coelho": n_coelho,
        "matched": len(matches),
        "skipped": len(skipped),
        "embedding_cache_size": len(cache),
        "total_api_calls": cache.api_calls,
        "threshold": threshold,
        "dry_run": dry_run,
        "strategy": "optimal",
    }

    return {
        "session_started": session_started,
        "session_name": "dino-auto",
        "strategy": "optimal",
        "matches": matches,
        "skipped": skipped,
        "near_misses": near_misses,
        "stats": stats,
    }


# ---------------------------------------------------------------------------
# Strategy B — Greedy 5-pass (kept for comparison)
# ---------------------------------------------------------------------------

def build_candidates(viva: dict, coelho_all: list[dict], criteria: dict) -> list[dict]:
    if criteria.get("hail_mary"):
        candidates = list(coelho_all)
    else:
        area_tol = criteria["area_tol"]
        beds_delta = criteria["beds_delta"]
        candidates = []
        for c in coelho_all:
            if viva["area"] and c["area"]:
                if not within_tolerance(viva["area"], c["area"], area_tol):
                    continue
            elif viva["area"] or c["area"]:
                continue
            if viva["beds"] is not None and c["beds"] is not None:
                if abs(viva["beds"] - c["beds"]) > beds_delta:
                    continue
            candidates.append(c)

    for c in candidates:
        c["_score"] = score_candidate(
            viva["area"], viva["price"], viva["beds"],
            c["area"], c["price"], c["beds"],
        )
    candidates.sort(key=lambda x: x["_score"], reverse=True)
    return candidates


def run_greedy_matching(
    viva_listings: list[dict],
    coelho_listings: list[dict],
    dino_url: str,
    threshold: float,
    data_root: Path,
    compound: str | None,
    dry_run: bool,
) -> dict:
    session_started = datetime.now(timezone.utc).isoformat()
    cache = EmbeddingCache(dino_url, data_root, compound, dry_run)
    matched_viva = set()
    matched_coelho = set()
    matches = []
    skipped = []

    for pass_cfg in PASS_CRITERIA:
        pass_num = pass_cfg["pass"]
        pass_label = pass_cfg["label"]
        unmatched_viva = [v for v in viva_listings if v["code"] not in matched_viva]
        available_coelho = [c for c in coelho_listings if c["code"] not in matched_coelho]

        log.info(
            f"\n{'='*60}\n"
            f"Pass {pass_num} ({pass_label}) — "
            f"{len(unmatched_viva)} Viva unmatched, {len(available_coelho)} Coelho available"
        )
        pass_matched = 0

        for viva in unmatched_viva:
            candidates = build_candidates(viva, available_coelho, pass_cfg)
            if not candidates:
                continue

            log.info(
                f"  Viva {viva['code']} "
                f"(area={viva['area']}m², price={viva['price_raw']}, beds={viva['beds']})"
                f" → {len(candidates)} candidates"
            )

            viva_emb = cache.get("vivaprimeimoveis", viva["code"])
            if viva_emb is None:
                log.warning(f"  Viva {viva['code']}: no embedding — skipping")
                continue

            best_sim, best_coelho = -1.0, None
            for coelho in candidates:
                if coelho["code"] in matched_coelho:
                    continue
                coelho_emb = cache.get("coelhodafonseca", coelho["code"])
                if coelho_emb is None:
                    continue
                sim = cosine_similarity(viva_emb, coelho_emb)
                log.debug(f"    Coelho {coelho['code']} sim={sim:.4f}")
                if sim > best_sim:
                    best_sim, best_coelho = sim, coelho

            if best_coelho and best_sim >= threshold:
                log.info(f"  ✓ MATCH  Viva {viva['code']} ↔ Coelho {best_coelho['code']}  sim={best_sim:.4f}")
                matched_viva.add(viva["code"])
                matched_coelho.add(best_coelho["code"])
                matches.append({
                    "viva_code": viva["code"],
                    "coelho_code": best_coelho["code"],
                    "matched_at": datetime.now(timezone.utc).isoformat(),
                    "reviewer": "dino-v1",
                    "similarity_score": round(best_sim, 6),
                    "confidence": "ai_approved",
                    "pass": pass_num,
                    "pass_label": pass_label,
                    "strategy": "greedy",
                })
                pass_matched += 1
                available_coelho = [c for c in available_coelho if c["code"] != best_coelho["code"]]
            else:
                best_info = f"best_sim={best_sim:.4f} ({best_coelho['code']})" if best_coelho else "no embeddings"
                log.info(f"  ✗ no match for Viva {viva['code']} — {best_info}")

        log.info(f"Pass {pass_num} done — matched: {pass_matched}")

    for viva in viva_listings:
        if viva["code"] not in matched_viva:
            skipped.append({
                "viva_code": viva["code"],
                "reason": "no_match_after_all_passes",
                "price": viva["price_raw"],
                "area": viva["area"],
                "beds": viva["beds"],
            })

    log.info(f"\n{'='*60}\nFinal: {len(matches)} matches, {len(skipped)} unmatched")

    stats = {
        "total_viva": len(viva_listings),
        "total_coelho": len(coelho_listings),
        "matched": len(matches),
        "skipped": len(skipped),
        "embedding_cache_size": len(cache),
        "total_api_calls": cache.api_calls,
        "threshold": threshold,
        "dry_run": dry_run,
        "strategy": "greedy",
    }

    return {
        "session_started": session_started,
        "session_name": "dino-auto",
        "strategy": "greedy",
        "matches": matches,
        "skipped": skipped,
        "stats": stats,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args():
    p = argparse.ArgumentParser(description="DINOv2 auto-matcher for property listings")
    p.add_argument("--dino-url",   default="http://localhost:8000")
    p.add_argument("--threshold",  type=float, default=0.85)
    p.add_argument("--data-root",  default="data")
    p.add_argument("--compound",   default=None)
    p.add_argument("--output",     default="data/auto-matches.json")
    p.add_argument("--strategy",   choices=["optimal", "greedy"], default="optimal",
                   help="optimal: Hungarian algorithm on full NxM matrix (default). "
                        "greedy: 5-pass progressive loop.")
    p.add_argument("--dry-run",    action="store_true")
    p.add_argument("--verbose",    action="store_true")
    return p.parse_args()


def main():
    args = parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    data_root = Path(args.data_root).resolve()
    if not data_root.exists():
        log.error(f"data-root not found: {data_root}")
        sys.exit(1)

    if args.dry_run:
        log.info("DRY RUN mode — embeddings are random unit vectors")
    else:
        health_url = args.dino_url.rstrip("/") + "/health"
        try:
            resp = requests.get(health_url, timeout=5)
            resp.raise_for_status()
            info = resp.json()
            log.info(f"DINOv2 server OK — device={info.get('device')}, model={info.get('model')}")
        except Exception as exc:
            log.error(f"Cannot reach DINOv2 server at {health_url}: {exc}")
            log.error("Start the server first or use --dry-run for testing.")
            sys.exit(1)

    viva_listings, coelho_listings = load_listings(data_root)

    run_fn = run_optimal_matching if args.strategy == "optimal" else run_greedy_matching
    result = run_fn(
        viva_listings=viva_listings,
        coelho_listings=coelho_listings,
        dino_url=args.dino_url,
        threshold=args.threshold,
        data_root=data_root,
        compound=args.compound,
        dry_run=args.dry_run,
    )

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    log.info(f"Saved → {output_path}")


if __name__ == "__main__":
    main()
