#!/usr/bin/env python3
"""
DINOv2 Auto-Matcher — 5-pass property matching pipeline.

Replaces the human reviewer in the matching workflow by comparing property images
via DINOv2 cosine similarity. Preserves the 5-pass progressively-relaxed loop
architecture from the manual matching server.

Usage:
    python scripts/dino-auto-matcher.py \\
        --dino-url http://{VM_IP}:8000 \\
        --threshold 0.85 \\
        --data-root data/ \\
        --compound alphaville \\
        --output data/auto-matches.json

    # Dry-run (skip actual embedding calls, log candidate pairs only):
    python scripts/dino-auto-matcher.py --dry-run
"""

import argparse
import json
import logging
import os
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
# Pass criteria (progressively relaxed)
# ---------------------------------------------------------------------------

PASS_CRITERIA = [
    {"pass": 1, "label": "strict",     "area_tol": 0.15, "beds_delta": 0},
    {"pass": 2, "label": "relaxed",    "area_tol": 0.20, "beds_delta": 0},
    {"pass": 3, "label": "broader",    "area_tol": 0.28, "beds_delta": 1},
    {"pass": 4, "label": "very_broad", "area_tol": 0.40, "beds_delta": 2},
    {"pass": 5, "label": "hail_mary",  "hail_mary": True},
]
# Price is no longer a hard gate — agencies list the same property at different
# prices too often (see Viva 17481 / Coelho 677791: sim=0.97 but 20% price gap).
# Price is still used in score_candidate() to rank candidates before image comparison.

# ---------------------------------------------------------------------------
# Helpers — parsing
# ---------------------------------------------------------------------------

def parse_area(area_str) -> float | None:
    """Extract numeric area from strings like '397m²' or '397'."""
    if not area_str:
        return None
    import re
    m = re.search(r"(\d+(?:[.,]\d+)?)", str(area_str))
    if not m:
        return None
    return float(m.group(1).replace(",", "."))


def parse_price(price_str) -> float | None:
    """Parse Brazilian price strings like 'R$ 4.500.000,00' → 4500000.0"""
    if not price_str:
        return None
    import re
    m = re.search(r"[\d.,]+", str(price_str))
    if not m:
        return None
    raw = m.group(0)
    # "4.500.000,00" → remove thousands dots, replace comma decimal
    raw = raw.replace(".", "").replace(",", ".")
    try:
        return float(raw)
    except ValueError:
        return None


def within_tolerance(a: float | None, b: float | None, tol: float) -> bool:
    if a is None or b is None:
        return False
    if a == 0 and b == 0:
        return True
    avg = (a + b) / 2
    return abs(a - b) / avg <= tol


# ---------------------------------------------------------------------------
# Helpers — candidate scoring
# ---------------------------------------------------------------------------

def score_candidate(viva_area, viva_price, viva_beds,
                    coelho_area, coelho_price, coelho_beds) -> float:
    """
    Score 0–1 reflecting how well a Coelho listing matches a Viva listing on
    numeric attributes (area, price, bedrooms). Higher is better.
    Used to rank candidates within a pass before image comparison.
    """
    score = 0.0

    if viva_area and coelho_area and viva_area > 0:
        area_diff = abs(viva_area - coelho_area) / ((viva_area + coelho_area) / 2)
        score += max(0.0, 1.0 - area_diff) * 0.4

    if viva_price and coelho_price and viva_price > 0:
        price_diff = abs(viva_price - coelho_price) / ((viva_price + coelho_price) / 2)
        score += max(0.0, 1.0 - price_diff) * 0.4

    if viva_beds is not None and coelho_beds is not None:
        beds_diff = abs(viva_beds - coelho_beds)
        score += max(0.0, 1.0 - beds_diff * 0.5) * 0.2

    return score


# ---------------------------------------------------------------------------
# Helpers — image resolution (priority chain)
# ---------------------------------------------------------------------------

def get_images_for_listing(site: str, listing_id: str, data_root: Path,
                           compound: str | None = None) -> list[Path]:
    """
    Return a list of image paths for a listing, using the priority chain:
      1. selected_exteriors/{site}/{listing_id}/   (pre-ranked exterior photos)
      2. data/{compound}/mosaics/{site}/{listing_id}.png   (2x4 mosaic)
      3. data/{site}/images/{listing_id}_1.jpg, _2.jpg    (raw scraped images)
    """
    # 1. selected_exteriors
    ext_dir = data_root.parent / "selected_exteriors" / site / listing_id
    if ext_dir.is_dir():
        imgs = sorted(
            p for p in ext_dir.iterdir()
            if p.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp")
            and p.name != "_manifest.json"
        )
        if imgs:
            log.debug(f"  [{site}/{listing_id}] using selected_exteriors ({len(imgs)} imgs)")
            return imgs

    # 2. Mosaic fallback
    if compound:
        mosaic = data_root / compound / "mosaics" / site / f"{listing_id}.png"
        if mosaic.exists():
            log.debug(f"  [{site}/{listing_id}] using mosaic")
            return [mosaic]

    # 3. Raw images fallback
    images_dir = data_root / site / "images"
    raw_imgs = []
    for n in (1, 2):
        for ext in ("jpg", "jpeg", "png"):
            p = images_dir / f"{listing_id}_{n}.{ext}"
            if p.exists():
                raw_imgs.append(p)
                break
    if raw_imgs:
        log.debug(f"  [{site}/{listing_id}] using raw images ({len(raw_imgs)})")
        return raw_imgs

    log.warning(f"  [{site}/{listing_id}] no images found")
    return []


# ---------------------------------------------------------------------------
# DINOv2 embedding via HTTP server
# ---------------------------------------------------------------------------

def embed_image(image_path: Path, dino_url: str) -> np.ndarray | None:
    """POST an image to /embed and return the 768-dim embedding, or None on error."""
    endpoint = dino_url.rstrip("/") + "/embed"
    try:
        with open(image_path, "rb") as f:
            resp = requests.post(endpoint, files={"image": f}, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        return np.array(data["embedding"], dtype=np.float32)
    except Exception as exc:
        log.warning(f"  embed failed for {image_path.name}: {exc}")
        return None


def mean_embedding(image_paths: list[Path], dino_url: str) -> np.ndarray | None:
    """Compute the mean DINOv2 embedding across all images for a listing."""
    vectors = []
    for p in image_paths:
        v = embed_image(p, dino_url)
        if v is not None:
            vectors.append(v)
    if not vectors:
        return None
    stacked = np.stack(vectors, axis=0)
    return stacked.mean(axis=0)


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return float(np.dot(a, b) / (norm_a * norm_b))


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def load_listings(data_root: Path):
    """Load and parse both sites' listings into dicts keyed by propertyCode."""
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
        # Extract area: "... 950 m² construída ..."
        area_m = re.search(r"(\d+(?:[.,]\d+)?)\s*m²\s*construída", features, re.I)
        area = float(area_m.group(1).replace(",", ".")) if area_m else None
        # Extract beds
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

    viva_listings = [parse_viva(l) for l in viva_raw["listings"]]
    coelho_listings = [parse_coelho(l) for l in coelho_raw["listings"]]

    log.info(f"Loaded {len(viva_listings)} Viva listings, {len(coelho_listings)} Coelho listings")
    return viva_listings, coelho_listings


# ---------------------------------------------------------------------------
# Candidate building per pass
# ---------------------------------------------------------------------------

def build_candidates(viva: dict, coelho_all: list[dict], criteria: dict) -> list[dict]:
    """
    Return Coelho listings that pass the current pass criteria for a given Viva listing,
    sorted by score descending.
    """
    if criteria.get("hail_mary"):
        # Pass 5: include every Coelho listing not yet matched
        candidates = list(coelho_all)
    else:
        area_tol = criteria["area_tol"]
        beds_delta = criteria["beds_delta"]

        candidates = []
        for c in coelho_all:
            # Area check (hard gate — area is reliable and limits the candidate pool)
            if viva["area"] and c["area"]:
                if not within_tolerance(viva["area"], c["area"], area_tol):
                    continue
            elif viva["area"] or c["area"]:
                continue  # one has area, the other doesn't — skip

            # Beds check (hard gate)
            if viva["beds"] is not None and c["beds"] is not None:
                if abs(viva["beds"] - c["beds"]) > beds_delta:
                    continue

            # Price is NOT a hard gate — it feeds into score_candidate() for ranking only

            candidates.append(c)

    # Score and sort
    for c in candidates:
        c["_score"] = score_candidate(
            viva["area"], viva["price"], viva["beds"],
            c["area"], c["price"], c["beds"],
        )
    candidates.sort(key=lambda x: x["_score"], reverse=True)
    return candidates


# ---------------------------------------------------------------------------
# Main matching loop
# ---------------------------------------------------------------------------

def run_matching(
    viva_listings: list[dict],
    coelho_listings: list[dict],
    dino_url: str,
    threshold: float,
    data_root: Path,
    compound: str | None,
    dry_run: bool,
) -> dict:
    matched_viva = set()        # viva codes that have been matched
    matched_coelho = set()      # coelho codes that have been matched
    matches = []
    skipped = []
    embedding_cache: dict[str, np.ndarray | None] = {}
    total_api_calls = 0

    session_started = datetime.now(timezone.utc).isoformat()

    def get_embedding(site: str, code: str) -> np.ndarray | None:
        nonlocal total_api_calls
        key = f"{site}/{code}"
        if key in embedding_cache:
            return embedding_cache[key]
        image_paths = get_images_for_listing(site, code, data_root, compound)
        if not image_paths:
            embedding_cache[key] = None
            return None
        if dry_run:
            # Return a random unit vector for dry-run mode
            v = np.random.randn(768).astype(np.float32)
            v /= np.linalg.norm(v)
            embedding_cache[key] = v
            return v
        emb = mean_embedding(image_paths, dino_url)
        total_api_calls += len(image_paths)
        embedding_cache[key] = emb
        return emb

    for pass_cfg in PASS_CRITERIA:
        pass_num = pass_cfg["pass"]
        pass_label = pass_cfg["label"]

        unmatched_viva = [v for v in viva_listings if v["code"] not in matched_viva]
        available_coelho = [c for c in coelho_listings if c["code"] not in matched_coelho]

        log.info(
            f"\n{'='*60}\n"
            f"Pass {pass_num} ({pass_label}) — "
            f"{len(unmatched_viva)} Viva unmatched, "
            f"{len(available_coelho)} Coelho available"
        )

        pass_matched = 0
        pass_skipped = 0

        for viva in unmatched_viva:
            candidates = build_candidates(viva, available_coelho, pass_cfg)
            if not candidates:
                log.debug(f"  Viva {viva['code']}: 0 candidates in pass {pass_num}")
                continue

            log.info(
                f"  Viva {viva['code']} "
                f"(area={viva['area']}m², price={viva['price_raw']}, beds={viva['beds']})"
                f" → {len(candidates)} candidates"
            )

            viva_emb = get_embedding("vivaprimeimoveis", viva["code"])
            if viva_emb is None:
                log.warning(f"  Viva {viva['code']}: no embedding — skipping")
                pass_skipped += 1
                continue

            best_sim = -1.0
            best_coelho = None

            for coelho in candidates:
                if coelho["code"] in matched_coelho:
                    continue
                coelho_emb = get_embedding("coelhodafonseca", coelho["code"])
                if coelho_emb is None:
                    continue

                sim = cosine_similarity(viva_emb, coelho_emb)
                log.debug(
                    f"    Coelho {coelho['code']} "
                    f"(area={coelho['area']}m², price={coelho['price_raw']}, beds={coelho['beds']}) "
                    f"sim={sim:.4f}"
                )

                if sim > best_sim:
                    best_sim = sim
                    best_coelho = coelho

            if best_coelho and best_sim >= threshold:
                log.info(
                    f"  ✓ MATCH  Viva {viva['code']} ↔ Coelho {best_coelho['code']} "
                    f"(sim={best_sim:.4f})"
                )
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
                })
                pass_matched += 1
                # Remove from available pool immediately
                available_coelho = [c for c in available_coelho if c["code"] != best_coelho["code"]]
            else:
                best_info = f"best_sim={best_sim:.4f} ({best_coelho['code']})" if best_coelho else "no candidates with embeddings"
                log.info(f"  ✗ no match for Viva {viva['code']} — {best_info}")
                pass_skipped += 1

        log.info(
            f"Pass {pass_num} done — matched: {pass_matched}, skipped: {pass_skipped}"
        )

    # Collect final skipped (never matched)
    for viva in viva_listings:
        if viva["code"] not in matched_viva:
            skipped.append({
                "viva_code": viva["code"],
                "reason": "no_match_after_all_passes",
                "price": viva["price_raw"],
                "area": viva["area"],
                "beds": viva["beds"],
            })

    stats = {
        "total_viva": len(viva_listings),
        "total_coelho": len(coelho_listings),
        "matched": len(matches),
        "skipped": len(skipped),
        "embedding_cache_size": len(embedding_cache),
        "total_api_calls": total_api_calls,
        "threshold": threshold,
        "dry_run": dry_run,
    }

    log.info(
        f"\n{'='*60}\n"
        f"Final: {stats['matched']} matches, {stats['skipped']} unmatched\n"
        f"Total embed API calls: {total_api_calls}"
    )

    return {
        "session_started": session_started,
        "session_name": "dino-auto",
        "current_pass": len(PASS_CRITERIA),
        "matches": matches,
        "skipped": skipped,
        "stats": stats,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args():
    p = argparse.ArgumentParser(description="DINOv2 auto-matcher for property listings")
    p.add_argument(
        "--dino-url",
        default="http://localhost:8000",
        help="Base URL of the DINOv2 FastAPI server (default: http://localhost:8000)",
    )
    p.add_argument(
        "--threshold",
        type=float,
        default=0.85,
        help="Cosine similarity threshold to accept a match (default: 0.85)",
    )
    p.add_argument(
        "--data-root",
        default="data",
        help="Path to the data/ directory (default: data)",
    )
    p.add_argument(
        "--compound",
        default=None,
        help="Compound name used to locate mosaic images (e.g. alphaville)",
    )
    p.add_argument(
        "--output",
        default="data/auto-matches.json",
        help="Output file path (default: data/auto-matches.json)",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Skip actual embedding calls; use random vectors (for testing pipeline logic)",
    )
    p.add_argument(
        "--verbose",
        action="store_true",
        help="Enable DEBUG-level logging",
    )
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
        # Quick server health check
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

    result = run_matching(
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
