#!/usr/bin/env python3
"""
Recursive Matcher V2 — Pool-first, facade-second optimization.

Phase 1: Compute per-category embeddings for all listings (cached to disk).
Phase 2: Run 10 rounds of iterative scoring strategies evaluated against
         15 human-reviewed ground truth pairs.

Key insight: the current weighted-combo approach (pool×0.60 + facade×0.25 +
garden×0.15) mixes signals and produces 47 false positives out of 62 matches.
Instead, we use pool similarity as the PRIMARY signal and facade as a
separate VERIFICATION step.

Research-inspired strategies:
  - Two-stage matching (VPR literature: global retrieval → local re-ranking)
  - Mutual nearest neighbor filtering (bidirectional agreement)
  - Ratio test (best match must be significantly better than 2nd best)
  - k-reciprocal re-ranking (Person Re-ID literature)

Usage:
    python scripts/recursive-matcher-v2.py \\
        --dino-url http://localhost:8000 \\
        --data-root data/ \\
        --output data/auto-matches-v3.json
"""

import argparse
import json
import logging
import pickle
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import requests

# ─────────────────────────────────────────────────────────────
# Logging
# ─────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("recursive-v2")

# ─────────────────────────────────────────────────────────────
# Ground truth from human review (pass-1)
# ─────────────────────────────────────────────────────────────

CONFIRMED_PAIRS = {
    ("17388", "354149"), ("16886", "617978"), ("16626", "597308"),
    ("13254", "356006"), ("17116", "674139"), ("5380", "467562"),
    ("16026", "674557"), ("12854", "616435"), ("13572", "653980"),
    ("16385", "663777"), ("16892", "663984"), ("14127", "663462"),
    ("2075", "502738"), ("17722", "677257"), ("17378", "659639"),
}

# ─────────────────────────────────────────────────────────────
# Helpers — parsing (from dino-auto-matcher.py)
# ─────────────────────────────────────────────────────────────

import re as _re

def parse_area(area_str) -> float | None:
    if not area_str:
        return None
    m = _re.search(r"(\d+(?:[.,]\d+)?)", str(area_str))
    return float(m.group(1).replace(",", ".")) if m else None


def parse_price(price_str) -> float | None:
    if not price_str:
        return None
    m = _re.search(r"[\d.,]+", str(price_str))
    if not m:
        return None
    raw = m.group(0).replace(".", "").replace(",", ".")
    try:
        return float(raw)
    except ValueError:
        return None


# ─────────────────────────────────────────────────────────────
# Data loading (from dino-auto-matcher.py)
# ─────────────────────────────────────────────────────────────

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
        }

    def parse_coelho(listing) -> dict:
        features = listing.get("features", "")
        area_m = _re.search(r"(\d+(?:[.,]\d+)?)\s*m²\s*construída", features, _re.I)
        area = float(area_m.group(1).replace(",", ".")) if area_m else None
        beds_m = _re.search(r"(\d+)\s*dorms?", features, _re.I)
        beds = int(beds_m.group(1)) if beds_m else None
        return {
            "code": str(listing["propertyCode"]),
            "price": parse_price(listing.get("price")),
            "price_raw": listing.get("price"),
            "area": area,
            "beds": beds,
            "url": listing.get("url", ""),
        }

    viva = [parse_viva(l) for l in viva_raw["listings"]]
    coelho = [parse_coelho(l) for l in coelho_raw["listings"]]
    log.info(f"Loaded {len(viva)} Viva, {len(coelho)} Coelho listings")
    return viva, coelho


# ─────────────────────────────────────────────────────────────
# Image resolution — CLIP manifest → per-category paths
# ─────────────────────────────────────────────────────────────

def get_images_by_category(site: str, listing_id: str,
                           data_root: Path) -> dict[str, list[Path]]:
    """
    Read CLIP manifest, return {pool: [paths], facade: [paths], garden: [paths]}.
    Falls back to empty if no manifest.
    """
    repo_root = data_root.parent
    manifest_path = (repo_root / "selected_for_matching" / site
                     / listing_id / "_manifest.json")
    cache_dir = data_root / site / "cache" / listing_id
    by_cat: dict[str, list[Path]] = {"pool": [], "facade": [], "garden": []}

    if manifest_path.exists():
        with open(manifest_path) as f:
            manifest = json.load(f)
        for entry in manifest.get("all_categories", []):
            cat = entry.get("category", "interior")
            if cat not in by_cat:
                continue
            p = cache_dir / entry["filename"]
            if p.exists():
                by_cat[cat].append(p)
        # Fallback: try selected entries
        if not any(by_cat.values()):
            base_dir = manifest_path.parent
            for entry in manifest.get("selected", []):
                cat = entry.get("category", "pool")
                if cat in by_cat:
                    p = base_dir / entry["filename"]
                    if p.exists():
                        by_cat[cat].append(p)
    return by_cat


# ─────────────────────────────────────────────────────────────
# DINOv2 embedding via HTTP
# ─────────────────────────────────────────────────────────────

def embed_image(image_path: Path, dino_url: str) -> np.ndarray | None:
    endpoint = dino_url.rstrip("/") + "/embed"
    try:
        with open(image_path, "rb") as f:
            resp = requests.post(endpoint, files={"image": f}, timeout=30)
        resp.raise_for_status()
        return np.array(resp.json()["embedding"], dtype=np.float32)
    except Exception as exc:
        log.debug(f"  embed failed for {image_path.name}: {exc}")
        return None


def cosine_sim(a: np.ndarray | None, b: np.ndarray | None) -> float:
    if a is None or b is None:
        return 0.0
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    return float(np.dot(a, b) / (na * nb)) if na > 0 and nb > 0 else 0.0


# ─────────────────────────────────────────────────────────────
# Embedding cache (persisted to disk)
# ─────────────────────────────────────────────────────────────

def compute_category_embedding(paths: list[Path], dino_url: str,
                                cat_name: str = "") -> np.ndarray | None:
    """Embed all images, centroid-filter for pool, return mean vector."""
    vecs = [embed_image(p, dino_url) for p in paths]
    vecs = [v for v in vecs if v is not None]
    if not vecs:
        return None
    # Pool centroid filtering: remove outlier images
    if cat_name == "pool" and len(vecs) > 4:
        centroid = np.stack(vecs).mean(axis=0)
        sims = [float(np.dot(v, centroid) /
                       (np.linalg.norm(v) * np.linalg.norm(centroid) + 1e-9))
                for v in vecs]
        top_k = max(4, len(vecs) // 2)
        top_idx = sorted(range(len(sims)), key=lambda x: sims[x],
                         reverse=True)[:top_k]
        vecs = [vecs[i] for i in top_idx]
    return np.stack(vecs).mean(axis=0)


def compute_and_cache_embeddings(viva, coelho, dino_url, data_root,
                                  cache_path: Path):
    """Compute per-category embeddings for all listings, save to disk."""
    if cache_path.exists():
        log.info(f"Loading cached embeddings from {cache_path}")
        with open(cache_path, "rb") as f:
            return pickle.load(f)

    log.info("Computing embeddings (this takes ~30 min on CPU)...")
    cache = {}
    api_calls = 0

    all_listings = [("vivaprimeimoveis", v["code"]) for v in viva] + \
                   [("coelhodafonseca", c["code"]) for c in coelho]
    total = len(all_listings)

    for idx, (site, code) in enumerate(all_listings):
        by_cat = get_images_by_category(site, code, data_root)
        n_imgs = sum(len(v) for v in by_cat.values())
        api_calls += n_imgs

        result = {}
        for cat, paths in by_cat.items():
            if not paths:
                result[cat] = None
            else:
                result[cat] = compute_category_embedding(paths, dino_url, cat)
        cache[f"{site}/{code}"] = result

        short = "viva" if "viva" in site else "coelho"
        cats = [f"{c}={len(by_cat[c])}" for c in ("pool", "facade", "garden")
                if by_cat[c]]
        log.info(f"  [{idx+1}/{total}] {short}/{code}  "
                 f"{', '.join(cats) or 'no images'}  ({api_calls} API calls)")

    log.info(f"Caching embeddings → {cache_path}")
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    with open(cache_path, "wb") as f:
        pickle.dump(cache, f)

    return cache


def get_emb(cache, site, code, cat):
    """Retrieve a single category embedding from cache."""
    key = f"{site}/{code}"
    if key not in cache:
        return None
    return cache[key].get(cat)


# ─────────────────────────────────────────────────────────────
# Evaluation
# ─────────────────────────────────────────────────────────────

def evaluate(matches):
    predicted = {(m["viva_code"], m["coelho_code"]) for m in matches}
    tp = len(predicted & CONFIRMED_PAIRS)
    fp = len(predicted - CONFIRMED_PAIRS)
    fn = len(CONFIRMED_PAIRS - predicted)
    precision = tp / (tp + fp) if (tp + fp) > 0 else 0
    recall = tp / (tp + fn) if (tp + fn) > 0 else 0
    f1 = 2 * precision * recall / (precision + recall) \
        if (precision + recall) > 0 else 0
    return {
        "tp": tp, "fp": fp, "fn": fn,
        "precision": precision, "recall": recall, "f1": f1,
        "total": len(predicted),
    }


# ─────────────────────────────────────────────────────────────
# Matrix builders
# ─────────────────────────────────────────────────────────────

def build_sim_matrix(viva, coelho, emb_cache, cat: str) -> np.ndarray:
    """Build NxM cosine similarity matrix for a single category."""
    n, m = len(viva), len(coelho)
    sim = np.zeros((n, m), dtype=np.float32)
    for i, v in enumerate(viva):
        v_emb = get_emb(emb_cache, "vivaprimeimoveis", v["code"], cat)
        if v_emb is None:
            continue
        for j, c in enumerate(coelho):
            c_emb = get_emb(emb_cache, "coelhodafonseca", c["code"], cat)
            if c_emb is None:
                continue
            sim[i, j] = cosine_sim(v_emb, c_emb)
    return sim


CATEGORY_WEIGHTS = {"pool": 0.60, "facade": 0.25, "garden": 0.15}


def build_combined_embedding_matrix(viva, coelho, emb_cache) -> np.ndarray:
    """Build NxM matrix using the ORIGINAL approach: weighted-mean embedding
    per listing (pool×0.60 + facade×0.25 + garden×0.15) → single cosine.
    This is mathematically different from averaging per-category similarities."""
    n, m = len(viva), len(coelho)

    def weighted_emb(site, code):
        present = {}
        for cat in ("pool", "facade", "garden"):
            e = get_emb(emb_cache, site, code, cat)
            if e is not None:
                present[cat] = e
        if not present:
            return None
        total_w = sum(CATEGORY_WEIGHTS[c] for c in present)
        combined = sum(
            (CATEGORY_WEIGHTS[c] / total_w) * e for c, e in present.items()
        )
        return combined

    viva_embs = [weighted_emb("vivaprimeimoveis", v["code"]) for v in viva]
    coelho_embs = [weighted_emb("coelhodafonseca", c["code"]) for c in coelho]

    sim = np.zeros((n, m), dtype=np.float32)
    for i in range(n):
        if viva_embs[i] is None:
            continue
        for j in range(m):
            if coelho_embs[j] is None:
                continue
            sim[i, j] = cosine_sim(viva_embs[i], coelho_embs[j])
    return sim


def build_price_multiplier_matrix(viva: list, coelho: list) -> np.ndarray:
    """Price-ratio multiplier matrix for boosting/penalizing assignment.

    Same property listed on two sites should have similar prices.
    We use this as a MULTIPLICATIVE factor on the visual similarity matrix
    so that Hungarian assignment naturally prefers price-compatible pairs.

    Multiplier scale:
      price diff < 5%  → 1.30 (strong boost — near-certain same property)
      price diff < 15% → 1.10
      price diff < 30% → 1.00 (neutral)
      price diff < 50% → 0.90
      price diff ≥ 50% → 0.75 (strong penalty)
      missing price    → 1.00 (neutral — don't penalize unknown)
    """
    n, m = len(viva), len(coelho)
    mat = np.ones((n, m), dtype=np.float32)
    for i, v in enumerate(viva):
        vp = v.get("price")
        if not vp or vp <= 0:
            continue
        for j, c in enumerate(coelho):
            cp = c.get("price")
            if not cp or cp <= 0:
                continue
            rel_diff = abs(vp - cp) / ((vp + cp) / 2.0)
            if rel_diff < 0.05:
                mat[i, j] = 1.30
            elif rel_diff < 0.15:
                mat[i, j] = 1.10
            elif rel_diff < 0.30:
                mat[i, j] = 1.00
            elif rel_diff < 0.50:
                mat[i, j] = 0.90
            else:
                mat[i, j] = 0.75
    return mat


def hungarian_assign(sim_matrix, viva, coelho, threshold):
    """Optimal one-to-one assignment above threshold."""
    from scipy.optimize import linear_sum_assignment
    row_ind, col_ind = linear_sum_assignment(-sim_matrix)
    matches = []
    for r, c in zip(row_ind, col_ind):
        s = float(sim_matrix[r, c])
        if s >= threshold:
            matches.append({
                "viva_code": viva[r]["code"],
                "coelho_code": coelho[c]["code"],
                "similarity_score": round(s, 6),
            })
    return matches


# ─────────────────────────────────────────────────────────────
# Strategies
# ─────────────────────────────────────────────────────────────

def strat_baseline_weighted(pool_mat, facade_mat, garden_mat,
                            viva, coelho, **kw):
    """Round 0: Original weighted combo (pool×0.60 + facade×0.25 + garden×0.15)."""
    threshold = kw.get("threshold", 0.85)
    # Reproduce the original weighted approach
    n, m = pool_mat.shape
    combined = np.zeros((n, m), dtype=np.float32)
    for i in range(n):
        for j in range(m):
            present = []
            for cat, mat, w in [("pool", pool_mat, 0.60),
                                 ("facade", facade_mat, 0.25),
                                 ("garden", garden_mat, 0.15)]:
                if mat[i, j] > 0:
                    present.append((mat[i, j], w))
            if not present:
                continue
            total_w = sum(w for _, w in present)
            combined[i, j] = sum(s * w / total_w for s, w in present)
    return hungarian_assign(combined, viva, coelho, threshold)


def strat_pool_only(pool_mat, facade_mat, garden_mat,
                    viva, coelho, **kw):
    """Round 1: Pool-only similarity → Hungarian assignment."""
    threshold = kw.get("threshold", 0.85)
    return hungarian_assign(pool_mat, viva, coelho, threshold)


def strat_pool_then_facade_gate(pool_mat, facade_mat, garden_mat,
                                viva, coelho, **kw):
    """Round 2: Pool assignment → reject pairs where facade_sim < gate."""
    pool_threshold = kw.get("pool_threshold", 0.85)
    facade_gate = kw.get("facade_gate", 0.80)
    matches = hungarian_assign(pool_mat, viva, coelho, pool_threshold)

    # Build facade lookup
    viva_idx = {v["code"]: i for i, v in enumerate(viva)}
    coelho_idx = {c["code"]: j for j, c in enumerate(coelho)}

    filtered = []
    for m in matches:
        i = viva_idx[m["viva_code"]]
        j = coelho_idx[m["coelho_code"]]
        f_sim = float(facade_mat[i, j])
        if f_sim >= facade_gate or facade_mat[i, :].max() == 0:
            # Accept if facade agrees OR if no facade data exists
            m["facade_sim"] = round(f_sim, 6)
            filtered.append(m)
    return filtered


def strat_pool_mutual_nn(pool_mat, facade_mat, garden_mat,
                         viva, coelho, **kw):
    """Round 3: Pool matching with mutual nearest neighbor constraint.
    Only accept if A's best match is B AND B's best match is A."""
    threshold = kw.get("threshold", 0.85)
    matches = hungarian_assign(pool_mat, viva, coelho, threshold)

    n, m = pool_mat.shape
    viva_idx = {v["code"]: i for i, v in enumerate(viva)}
    coelho_idx = {c["code"]: j for j, c in enumerate(coelho)}

    # Compute best match in each direction
    viva_best = pool_mat.argmax(axis=1)    # for each Viva, best Coelho
    coelho_best = pool_mat.argmax(axis=0)  # for each Coelho, best Viva

    filtered = []
    for m_item in matches:
        i = viva_idx[m_item["viva_code"]]
        j = coelho_idx[m_item["coelho_code"]]
        if viva_best[i] == j and coelho_best[j] == i:
            filtered.append(m_item)
    return filtered


def strat_pool_ratio_test(pool_mat, facade_mat, garden_mat,
                          viva, coelho, **kw):
    """Round 4: Pool matching with ratio test.
    Reject pairs where pool_sim(best) / pool_sim(2nd_best) < ratio_threshold.
    Ensures the match is unambiguous."""
    threshold = kw.get("threshold", 0.85)
    ratio_min = kw.get("ratio_min", 1.02)
    matches = hungarian_assign(pool_mat, viva, coelho, threshold)

    viva_idx = {v["code"]: i for i, v in enumerate(viva)}
    coelho_idx = {c["code"]: j for j, c in enumerate(coelho)}

    filtered = []
    for m_item in matches:
        i = viva_idx[m_item["viva_code"]]
        j = coelho_idx[m_item["coelho_code"]]
        row = pool_mat[i].copy()
        best = row[j]
        row[j] = -1  # mask best
        second_best = row.max()
        if second_best <= 0:
            filtered.append(m_item)
            continue
        ratio = best / second_best
        if ratio >= ratio_min:
            m_item["ratio"] = round(ratio, 4)
            filtered.append(m_item)
    return filtered


def strat_pool_facade_gate_mutual(pool_mat, facade_mat, garden_mat,
                                  viva, coelho, **kw):
    """Round 5: Combine pool + facade gate + mutual NN."""
    pool_threshold = kw.get("pool_threshold", 0.85)
    facade_gate = kw.get("facade_gate", 0.80)
    matches = hungarian_assign(pool_mat, viva, coelho, pool_threshold)

    n, m = pool_mat.shape
    viva_idx = {v["code"]: i for i, v in enumerate(viva)}
    coelho_idx = {c["code"]: j for j, c in enumerate(coelho)}

    viva_best = pool_mat.argmax(axis=1)
    coelho_best = pool_mat.argmax(axis=0)

    filtered = []
    for m_item in matches:
        i = viva_idx[m_item["viva_code"]]
        j = coelho_idx[m_item["coelho_code"]]
        # Mutual NN check
        if not (viva_best[i] == j and coelho_best[j] == i):
            continue
        # Facade gate
        f_sim = float(facade_mat[i, j])
        if f_sim >= facade_gate or facade_mat[i, :].max() == 0:
            filtered.append(m_item)
    return filtered


def strat_pool_facade_gate_ratio(pool_mat, facade_mat, garden_mat,
                                 viva, coelho, **kw):
    """Round 6: Pool + facade gate + ratio test."""
    pool_threshold = kw.get("pool_threshold", 0.85)
    facade_gate = kw.get("facade_gate", 0.80)
    ratio_min = kw.get("ratio_min", 1.02)
    matches = hungarian_assign(pool_mat, viva, coelho, pool_threshold)

    viva_idx = {v["code"]: i for i, v in enumerate(viva)}
    coelho_idx = {c["code"]: j for j, c in enumerate(coelho)}

    filtered = []
    for m_item in matches:
        i = viva_idx[m_item["viva_code"]]
        j = coelho_idx[m_item["coelho_code"]]
        # Facade gate
        f_sim = float(facade_mat[i, j])
        if f_sim < facade_gate and facade_mat[i, :].max() > 0:
            continue
        # Ratio test on pool
        row = pool_mat[i].copy()
        best = row[j]
        row[j] = -1
        second_best = row.max()
        if second_best > 0 and (best / second_best) < ratio_min:
            continue
        filtered.append(m_item)
    return filtered


def strat_area_filter(pool_mat, facade_mat, garden_mat,
                      viva, coelho, **kw):
    """Round 7: Best so far + structural area filter (within 30%)."""
    pool_threshold = kw.get("pool_threshold", 0.85)
    facade_gate = kw.get("facade_gate", 0.80)
    area_tol = kw.get("area_tol", 0.30)
    matches = hungarian_assign(pool_mat, viva, coelho, pool_threshold)

    viva_idx = {v["code"]: i for i, v in enumerate(viva)}
    coelho_idx = {c["code"]: j for j, c in enumerate(coelho)}

    viva_best = pool_mat.argmax(axis=1)
    coelho_best = pool_mat.argmax(axis=0)

    viva_map = {v["code"]: v for v in viva}
    coelho_map = {c["code"]: c for c in coelho}

    filtered = []
    for m_item in matches:
        i = viva_idx[m_item["viva_code"]]
        j = coelho_idx[m_item["coelho_code"]]
        # Mutual NN
        if not (viva_best[i] == j and coelho_best[j] == i):
            continue
        # Facade gate
        f_sim = float(facade_mat[i, j])
        if f_sim < facade_gate and facade_mat[i, :].max() > 0:
            continue
        # Area filter
        v_area = viva_map[m_item["viva_code"]]["area"]
        c_area = coelho_map[m_item["coelho_code"]]["area"]
        if v_area and c_area and v_area > 0 and c_area > 0:
            rel_diff = abs(v_area - c_area) / ((v_area + c_area) / 2)
            if rel_diff > area_tol:
                continue
        filtered.append(m_item)
    return filtered


def strat_geometric_mean(pool_mat, facade_mat, garden_mat,
                         viva, coelho, **kw):
    """Round 8: Geometric mean of pool and facade → Hungarian."""
    threshold = kw.get("threshold", 0.80)
    n, m = pool_mat.shape
    combined = np.zeros((n, m), dtype=np.float32)
    for i in range(n):
        for j in range(m):
            p = pool_mat[i, j]
            f = facade_mat[i, j]
            if p > 0 and f > 0:
                combined[i, j] = np.sqrt(p * f)
            elif p > 0:
                combined[i, j] = p * 0.8  # penalty for missing facade
    return hungarian_assign(combined, viva, coelho, threshold)


def strat_geometric_mutual(pool_mat, facade_mat, garden_mat,
                           viva, coelho, **kw):
    """Round 9: Geometric mean + mutual NN."""
    threshold = kw.get("threshold", 0.80)
    n, m = pool_mat.shape
    combined = np.zeros((n, m), dtype=np.float32)
    for i in range(n):
        for j in range(m):
            p = pool_mat[i, j]
            f = facade_mat[i, j]
            if p > 0 and f > 0:
                combined[i, j] = np.sqrt(p * f)
            elif p > 0:
                combined[i, j] = p * 0.8
    matches = hungarian_assign(combined, viva, coelho, threshold)

    viva_idx = {v["code"]: i for i, v in enumerate(viva)}
    coelho_idx = {c["code"]: j for j, c in enumerate(coelho)}
    viva_best = combined.argmax(axis=1)
    coelho_best = combined.argmax(axis=0)

    return [m_item for m_item in matches
            if viva_best[viva_idx[m_item["viva_code"]]] ==
               coelho_idx[m_item["coelho_code"]]
            and coelho_best[coelho_idx[m_item["coelho_code"]]] ==
                viva_idx[m_item["viva_code"]]]


def strat_combined_emb(pool_mat, facade_mat, garden_mat,
                       viva, coelho, **kw):
    """Combined embedding approach (original method done correctly)."""
    combined_mat = kw.get("combined_mat")
    threshold = kw.get("threshold", 0.85)
    if combined_mat is None:
        return []
    return hungarian_assign(combined_mat, viva, coelho, threshold)


def strat_combined_mutual_nn(pool_mat, facade_mat, garden_mat,
                             viva, coelho, **kw):
    """Combined embedding + mutual nearest neighbor filter."""
    combined_mat = kw.get("combined_mat")
    threshold = kw.get("threshold", 0.85)
    if combined_mat is None:
        return []
    matches = hungarian_assign(combined_mat, viva, coelho, threshold)

    viva_idx = {v["code"]: i for i, v in enumerate(viva)}
    coelho_idx = {c["code"]: j for j, c in enumerate(coelho)}
    viva_best = combined_mat.argmax(axis=1)
    coelho_best = combined_mat.argmax(axis=0)

    return [m for m in matches
            if viva_best[viva_idx[m["viva_code"]]] ==
               coelho_idx[m["coelho_code"]]
            and coelho_best[coelho_idx[m["coelho_code"]]] ==
                viva_idx[m["viva_code"]]]


def strat_combined_ratio_test(pool_mat, facade_mat, garden_mat,
                              viva, coelho, **kw):
    """Combined embedding + ratio test (best/2nd-best gap)."""
    combined_mat = kw.get("combined_mat")
    threshold = kw.get("threshold", 0.85)
    ratio_min = kw.get("ratio_min", 1.02)
    if combined_mat is None:
        return []
    matches = hungarian_assign(combined_mat, viva, coelho, threshold)

    viva_idx = {v["code"]: i for i, v in enumerate(viva)}
    coelho_idx = {c["code"]: j for j, c in enumerate(coelho)}

    filtered = []
    for m_item in matches:
        i = viva_idx[m_item["viva_code"]]
        j = coelho_idx[m_item["coelho_code"]]
        row = combined_mat[i].copy()
        best = row[j]
        row[j] = -1
        second_best = row.max()
        if second_best <= 0:
            filtered.append(m_item)
            continue
        if (best / second_best) >= ratio_min:
            filtered.append(m_item)
    return filtered


def strat_combined_mutual_ratio(pool_mat, facade_mat, garden_mat,
                                viva, coelho, **kw):
    """Combined embedding + mutual NN + ratio test."""
    combined_mat = kw.get("combined_mat")
    threshold = kw.get("threshold", 0.85)
    ratio_min = kw.get("ratio_min", 1.02)
    if combined_mat is None:
        return []
    matches = hungarian_assign(combined_mat, viva, coelho, threshold)

    viva_idx = {v["code"]: i for i, v in enumerate(viva)}
    coelho_idx = {c["code"]: j for j, c in enumerate(coelho)}
    viva_best = combined_mat.argmax(axis=1)
    coelho_best = combined_mat.argmax(axis=0)

    filtered = []
    for m_item in matches:
        i = viva_idx[m_item["viva_code"]]
        j = coelho_idx[m_item["coelho_code"]]
        # Mutual NN
        if not (viva_best[i] == j and coelho_best[j] == i):
            continue
        # Ratio test
        row = combined_mat[i].copy()
        best = row[j]
        row[j] = -1
        second_best = row.max()
        if second_best > 0 and (best / second_best) < ratio_min:
            continue
        filtered.append(m_item)
    return filtered


def strat_combined_pool_verify(pool_mat, facade_mat, garden_mat,
                               viva, coelho, **kw):
    """Combined embedding for assignment, then verify with pool agreement.
    Accept only if pool_sim for the pair is within top-3 for that Viva row."""
    combined_mat = kw.get("combined_mat")
    threshold = kw.get("threshold", 0.85)
    pool_rank_max = kw.get("pool_rank_max", 3)
    if combined_mat is None:
        return []
    matches = hungarian_assign(combined_mat, viva, coelho, threshold)

    viva_idx = {v["code"]: i for i, v in enumerate(viva)}
    coelho_idx = {c["code"]: j for j, c in enumerate(coelho)}

    filtered = []
    for m_item in matches:
        i = viva_idx[m_item["viva_code"]]
        j = coelho_idx[m_item["coelho_code"]]
        # Check if this Coelho is in top-K pool matches for this Viva
        row = pool_mat[i]
        top_k = np.argsort(row)[-pool_rank_max:]
        if j in top_k:
            filtered.append(m_item)
    return filtered


def strat_pool_weighted_facade_boost(pool_mat, facade_mat, garden_mat,
                                      viva, coelho, **kw):
    """Score = pool_sim + α * facade_sim. Facade breaks ties."""
    threshold = kw.get("threshold", 0.85)
    alpha = kw.get("alpha", 0.15)
    n, m = pool_mat.shape
    combined = pool_mat + alpha * facade_mat
    return hungarian_assign(combined, viva, coelho, threshold)


def strat_combined_low_thresh_area(pool_mat, facade_mat, garden_mat,
                                    viva, coelho, **kw):
    """Low threshold on combined embedding + area filter.
    More candidates → area constraint kills FP."""
    combined_mat = kw.get("combined_mat")
    threshold = kw.get("threshold", 0.80)
    area_tol = kw.get("area_tol", 0.30)
    if combined_mat is None:
        return []
    matches = hungarian_assign(combined_mat, viva, coelho, threshold)

    viva_map = {v["code"]: v for v in viva}
    coelho_map = {c["code"]: c for c in coelho}

    filtered = []
    for m_item in matches:
        v_area = viva_map[m_item["viva_code"]]["area"]
        c_area = coelho_map[m_item["coelho_code"]]["area"]
        if v_area and c_area and v_area > 0 and c_area > 0:
            rel_diff = abs(v_area - c_area) / ((v_area + c_area) / 2)
            if rel_diff > area_tol:
                continue
        filtered.append(m_item)
    return filtered


def strat_combined_area_pool_verify(pool_mat, facade_mat, garden_mat,
                                     viva, coelho, **kw):
    """Combined embedding + area filter + pool top-K verify."""
    combined_mat = kw.get("combined_mat")
    threshold = kw.get("threshold", 0.80)
    area_tol = kw.get("area_tol", 0.30)
    pool_rank_max = kw.get("pool_rank_max", 5)
    if combined_mat is None:
        return []
    matches = hungarian_assign(combined_mat, viva, coelho, threshold)

    viva_idx = {v["code"]: i for i, v in enumerate(viva)}
    coelho_idx = {c["code"]: j for j, c in enumerate(coelho)}
    viva_map = {v["code"]: v for v in viva}
    coelho_map = {c["code"]: c for c in coelho}

    filtered = []
    for m_item in matches:
        i = viva_idx[m_item["viva_code"]]
        j = coelho_idx[m_item["coelho_code"]]
        # Area filter
        v_area = viva_map[m_item["viva_code"]]["area"]
        c_area = coelho_map[m_item["coelho_code"]]["area"]
        if v_area and c_area and v_area > 0 and c_area > 0:
            rel_diff = abs(v_area - c_area) / ((v_area + c_area) / 2)
            if rel_diff > area_tol:
                continue
        # Pool top-K verify
        row = pool_mat[i]
        top_k = np.argsort(row)[-pool_rank_max:]
        if j in top_k:
            filtered.append(m_item)
    return filtered


def strat_combined_area_mutual(pool_mat, facade_mat, garden_mat,
                                viva, coelho, **kw):
    """Combined embedding + area filter + mutual NN on combined."""
    combined_mat = kw.get("combined_mat")
    threshold = kw.get("threshold", 0.80)
    area_tol = kw.get("area_tol", 0.30)
    if combined_mat is None:
        return []
    matches = hungarian_assign(combined_mat, viva, coelho, threshold)

    viva_idx = {v["code"]: i for i, v in enumerate(viva)}
    coelho_idx = {c["code"]: j for j, c in enumerate(coelho)}
    viva_map = {v["code"]: v for v in viva}
    coelho_map = {c["code"]: c for c in coelho}
    viva_best = combined_mat.argmax(axis=1)
    coelho_best = combined_mat.argmax(axis=0)

    filtered = []
    for m_item in matches:
        i = viva_idx[m_item["viva_code"]]
        j = coelho_idx[m_item["coelho_code"]]
        # Mutual NN
        if not (viva_best[i] == j and coelho_best[j] == i):
            continue
        # Area filter
        v_area = viva_map[m_item["viva_code"]]["area"]
        c_area = coelho_map[m_item["coelho_code"]]["area"]
        if v_area and c_area and v_area > 0 and c_area > 0:
            rel_diff = abs(v_area - c_area) / ((v_area + c_area) / 2)
            if rel_diff > area_tol:
                continue
        filtered.append(m_item)
    return filtered


def strat_softmax_scoring(pool_mat, facade_mat, garden_mat,
                           viva, coelho, **kw):
    """Softmax scoring: convert cosine sims to probabilities,
    emphasizing relative differences. High-temp softmax makes
    confident matches stand out."""
    combined_mat = kw.get("combined_mat")
    threshold = kw.get("threshold", 0.50)
    temperature = kw.get("temperature", 0.05)
    if combined_mat is None:
        return []

    n, m = combined_mat.shape
    # Row-wise softmax (for each Viva, probability over Coelhos)
    row_probs = np.zeros_like(combined_mat)
    for i in range(n):
        row = combined_mat[i] / temperature
        row = row - row.max()  # numerical stability
        exp_row = np.exp(row)
        row_probs[i] = exp_row / exp_row.sum()

    # Column-wise softmax (for each Coelho, probability over Vivas)
    col_probs = np.zeros_like(combined_mat)
    for j in range(m):
        col = combined_mat[:, j] / temperature
        col = col - col.max()
        exp_col = np.exp(col)
        col_probs[:, j] = exp_col / exp_col.sum()

    # Geometric mean of both directions
    joint = np.sqrt(row_probs * col_probs)
    return hungarian_assign(joint, viva, coelho, threshold)


def strat_softmax_area(pool_mat, facade_mat, garden_mat,
                        viva, coelho, **kw):
    """Softmax scoring + area filter."""
    combined_mat = kw.get("combined_mat")
    threshold = kw.get("threshold", 0.50)
    temperature = kw.get("temperature", 0.05)
    area_tol = kw.get("area_tol", 0.30)
    if combined_mat is None:
        return []

    n, m = combined_mat.shape
    row_probs = np.zeros_like(combined_mat)
    for i in range(n):
        row = combined_mat[i] / temperature
        row = row - row.max()
        exp_row = np.exp(row)
        row_probs[i] = exp_row / exp_row.sum()

    col_probs = np.zeros_like(combined_mat)
    for j in range(m):
        col = combined_mat[:, j] / temperature
        col = col - col.max()
        exp_col = np.exp(col)
        col_probs[:, j] = exp_col / exp_col.sum()

    joint = np.sqrt(row_probs * col_probs)
    matches = hungarian_assign(joint, viva, coelho, threshold)

    viva_map = {v["code"]: v for v in viva}
    coelho_map = {c["code"]: c for c in coelho}
    filtered = []
    for m_item in matches:
        v_area = viva_map[m_item["viva_code"]]["area"]
        c_area = coelho_map[m_item["coelho_code"]]["area"]
        if v_area and c_area and v_area > 0 and c_area > 0:
            rel_diff = abs(v_area - c_area) / ((v_area + c_area) / 2)
            if rel_diff > area_tol:
                continue
        filtered.append(m_item)
    return filtered


def strat_multi_signal_ensemble(pool_mat, facade_mat, garden_mat,
                                 viva, coelho, **kw):
    """Ensemble: require combined + pool + facade all to agree.
    A pair must be in top-K for EACH signal to be accepted."""
    combined_mat = kw.get("combined_mat")
    threshold = kw.get("threshold", 0.80)
    top_k = kw.get("top_k", 5)
    if combined_mat is None:
        return []
    matches = hungarian_assign(combined_mat, viva, coelho, threshold)

    viva_idx = {v["code"]: i for i, v in enumerate(viva)}
    coelho_idx = {c["code"]: j for j, c in enumerate(coelho)}

    filtered = []
    for m_item in matches:
        i = viva_idx[m_item["viva_code"]]
        j = coelho_idx[m_item["coelho_code"]]
        # Check if j is in top-K for pool and facade
        pool_topk = set(np.argsort(pool_mat[i])[-top_k:])
        facade_topk = set(np.argsort(facade_mat[i])[-top_k:])
        combined_topk = set(np.argsort(combined_mat[i])[-top_k:])
        # Must be in at least 2 of 3 top-K lists
        in_count = sum([j in pool_topk, j in facade_topk, j in combined_topk])
        if in_count >= 2:
            filtered.append(m_item)
    return filtered


def strat_price_area_visual(pool_mat, facade_mat, garden_mat,
                             viva, coelho, **kw):
    """Structural pre-filter (price within 40%, area within 30%)
    then combined visual matching on filtered candidates."""
    combined_mat = kw.get("combined_mat")
    threshold = kw.get("threshold", 0.80)
    price_tol = kw.get("price_tol", 0.40)
    area_tol = kw.get("area_tol", 0.30)
    if combined_mat is None:
        return []

    n, m = combined_mat.shape
    # Mask out structurally incompatible pairs
    masked = combined_mat.copy()
    for i, v in enumerate(viva):
        for j, c in enumerate(coelho):
            # Price check
            if v["price"] and c["price"] and v["price"] > 0 and c["price"] > 0:
                avg_p = (v["price"] + c["price"]) / 2
                if abs(v["price"] - c["price"]) / avg_p > price_tol:
                    masked[i, j] = 0
                    continue
            # Area check
            if v["area"] and c["area"] and v["area"] > 0 and c["area"] > 0:
                avg_a = (v["area"] + c["area"]) / 2
                if abs(v["area"] - c["area"]) / avg_a > area_tol:
                    masked[i, j] = 0
    return hungarian_assign(masked, viva, coelho, threshold)


def strat_price_area_pool_verify(pool_mat, facade_mat, garden_mat,
                                  viva, coelho, **kw):
    """Structural pre-filter + combined assignment + pool top-K verify."""
    combined_mat = kw.get("combined_mat")
    threshold = kw.get("threshold", 0.80)
    price_tol = kw.get("price_tol", 0.40)
    area_tol = kw.get("area_tol", 0.30)
    pool_rank_max = kw.get("pool_rank_max", 5)
    if combined_mat is None:
        return []

    n, m = combined_mat.shape
    masked = combined_mat.copy()
    for i, v in enumerate(viva):
        for j, c in enumerate(coelho):
            if v["price"] and c["price"] and v["price"] > 0 and c["price"] > 0:
                avg_p = (v["price"] + c["price"]) / 2
                if abs(v["price"] - c["price"]) / avg_p > price_tol:
                    masked[i, j] = 0
                    continue
            if v["area"] and c["area"] and v["area"] > 0 and c["area"] > 0:
                avg_a = (v["area"] + c["area"]) / 2
                if abs(v["area"] - c["area"]) / avg_a > area_tol:
                    masked[i, j] = 0
    matches = hungarian_assign(masked, viva, coelho, threshold)

    viva_idx = {v["code"]: i for i, v in enumerate(viva)}
    coelho_idx = {c["code"]: j for j, c in enumerate(coelho)}

    filtered = []
    for m_item in matches:
        i = viva_idx[m_item["viva_code"]]
        j = coelho_idx[m_item["coelho_code"]]
        row = pool_mat[i]
        top_k = np.argsort(row)[-pool_rank_max:]
        if j in top_k:
            filtered.append(m_item)
    return filtered


def greedy_assign(sim_matrix, viva, coelho, threshold):
    """Greedy 1-to-1 assignment: match highest-similarity pairs first.
    Unlike Hungarian (global optimum), this prioritizes locally certain
    matches — which helps when rank-1 pairs get stolen by the optimizer."""
    n, m = sim_matrix.shape
    matches = []
    used_viva = set()
    used_coelho = set()

    # Build all (i,j,sim) pairs above threshold
    candidates = []
    for i in range(n):
        for j in range(m):
            s = float(sim_matrix[i, j])
            if s >= threshold:
                candidates.append((i, j, s))
    candidates.sort(key=lambda x: -x[2])

    for i, j, s in candidates:
        if i in used_viva or j in used_coelho:
            continue
        matches.append({
            "viva_code": viva[i]["code"],
            "coelho_code": coelho[j]["code"],
            "similarity_score": round(s, 6),
        })
        used_viva.add(i)
        used_coelho.add(j)

    return matches


def strat_greedy_combined(pool_mat, facade_mat, garden_mat,
                           viva, coelho, **kw):
    """Greedy matching on combined embeddings — prioritizes rank-1 pairs."""
    combined_mat = kw.get("combined_mat")
    threshold = kw.get("threshold", 0.85)
    if combined_mat is None:
        return []
    return greedy_assign(combined_mat, viva, coelho, threshold)


def strat_greedy_combined_area(pool_mat, facade_mat, garden_mat,
                                viva, coelho, **kw):
    """Greedy combined + area filter."""
    combined_mat = kw.get("combined_mat")
    threshold = kw.get("threshold", 0.80)
    area_tol = kw.get("area_tol", 0.30)
    if combined_mat is None:
        return []
    matches = greedy_assign(combined_mat, viva, coelho, threshold)

    viva_map = {v["code"]: v for v in viva}
    coelho_map = {c["code"]: c for c in coelho}

    filtered = []
    for m_item in matches:
        v_area = viva_map[m_item["viva_code"]]["area"]
        c_area = coelho_map[m_item["coelho_code"]]["area"]
        if v_area and c_area and v_area > 0 and c_area > 0:
            rel_diff = abs(v_area - c_area) / ((v_area + c_area) / 2)
            if rel_diff > area_tol:
                continue
        filtered.append(m_item)
    return filtered


def strat_greedy_combined_area_pool(pool_mat, facade_mat, garden_mat,
                                     viva, coelho, **kw):
    """Greedy combined + area filter + pool top-K verify."""
    combined_mat = kw.get("combined_mat")
    threshold = kw.get("threshold", 0.80)
    area_tol = kw.get("area_tol", 0.30)
    pool_rank_max = kw.get("pool_rank_max", 5)
    if combined_mat is None:
        return []
    matches = greedy_assign(combined_mat, viva, coelho, threshold)

    viva_idx = {v["code"]: i for i, v in enumerate(viva)}
    coelho_idx = {c["code"]: j for j, c in enumerate(coelho)}
    viva_map = {v["code"]: v for v in viva}
    coelho_map = {c["code"]: c for c in coelho}

    filtered = []
    for m_item in matches:
        i = viva_idx[m_item["viva_code"]]
        j = coelho_idx[m_item["coelho_code"]]
        # Area filter
        v_area = viva_map[m_item["viva_code"]]["area"]
        c_area = coelho_map[m_item["coelho_code"]]["area"]
        if v_area and c_area and v_area > 0 and c_area > 0:
            rel_diff = abs(v_area - c_area) / ((v_area + c_area) / 2)
            if rel_diff > area_tol:
                continue
        # Pool top-K
        row = pool_mat[i]
        top_k = np.argsort(row)[-pool_rank_max:]
        if j in top_k:
            filtered.append(m_item)
    return filtered


def strat_greedy_combined_multi_verify(pool_mat, facade_mat, garden_mat,
                                        viva, coelho, **kw):
    """Greedy combined + area + require pool OR facade in top-K."""
    combined_mat = kw.get("combined_mat")
    threshold = kw.get("threshold", 0.80)
    area_tol = kw.get("area_tol", 0.30)
    top_k = kw.get("top_k", 5)
    if combined_mat is None:
        return []
    matches = greedy_assign(combined_mat, viva, coelho, threshold)

    viva_idx = {v["code"]: i for i, v in enumerate(viva)}
    coelho_idx = {c["code"]: j for j, c in enumerate(coelho)}
    viva_map = {v["code"]: v for v in viva}
    coelho_map = {c["code"]: c for c in coelho}

    filtered = []
    for m_item in matches:
        i = viva_idx[m_item["viva_code"]]
        j = coelho_idx[m_item["coelho_code"]]
        # Area filter
        v_area = viva_map[m_item["viva_code"]]["area"]
        c_area = coelho_map[m_item["coelho_code"]]["area"]
        if v_area and c_area and v_area > 0 and c_area > 0:
            rel_diff = abs(v_area - c_area) / ((v_area + c_area) / 2)
            if rel_diff > area_tol:
                continue
        # Pool or facade top-K
        pool_topk = set(np.argsort(pool_mat[i])[-top_k:])
        facade_topk = set(np.argsort(facade_mat[i])[-top_k:])
        if j in pool_topk or j in facade_topk:
            filtered.append(m_item)
    return filtered


def strat_rank_weighted_combined(pool_mat, facade_mat, garden_mat,
                                  viva, coelho, **kw):
    """Score by reciprocal rank across multiple signals.
    For each pair, compute rank in combined, pool, and facade matrices.
    Score = 1/rank_combined + α/rank_pool + β/rank_facade."""
    combined_mat = kw.get("combined_mat")
    threshold = kw.get("threshold", 0.0)
    alpha = kw.get("alpha", 0.5)
    beta = kw.get("beta", 0.3)
    min_score = kw.get("min_score", 0.5)
    if combined_mat is None:
        return []

    n, m = combined_mat.shape
    # Pre-compute rank matrices
    combined_ranks = np.zeros_like(combined_mat, dtype=np.int32)
    pool_ranks = np.zeros_like(pool_mat, dtype=np.int32)
    facade_ranks = np.zeros_like(facade_mat, dtype=np.int32)

    for i in range(n):
        combined_ranks[i] = m - np.argsort(np.argsort(combined_mat[i]))
        pool_ranks[i] = m - np.argsort(np.argsort(pool_mat[i]))
        facade_ranks[i] = m - np.argsort(np.argsort(facade_mat[i]))

    # Build score matrix
    score_mat = np.zeros((n, m), dtype=np.float32)
    for i in range(n):
        for j in range(m):
            cr = combined_ranks[i, j]
            pr = pool_ranks[i, j]
            fr = facade_ranks[i, j]
            score_mat[i, j] = 1.0/cr + alpha/pr + beta/fr

    return hungarian_assign(score_mat, viva, coelho, min_score)


def strat_rank_weighted_area(pool_mat, facade_mat, garden_mat,
                              viva, coelho, **kw):
    """Rank-weighted scoring + area filter."""
    combined_mat = kw.get("combined_mat")
    alpha = kw.get("alpha", 0.5)
    beta = kw.get("beta", 0.3)
    min_score = kw.get("min_score", 0.5)
    area_tol = kw.get("area_tol", 0.30)
    if combined_mat is None:
        return []

    n, m = combined_mat.shape
    combined_ranks = np.zeros_like(combined_mat, dtype=np.int32)
    pool_ranks = np.zeros_like(pool_mat, dtype=np.int32)
    facade_ranks = np.zeros_like(facade_mat, dtype=np.int32)
    for i in range(n):
        combined_ranks[i] = m - np.argsort(np.argsort(combined_mat[i]))
        pool_ranks[i] = m - np.argsort(np.argsort(pool_mat[i]))
        facade_ranks[i] = m - np.argsort(np.argsort(facade_mat[i]))

    score_mat = np.zeros((n, m), dtype=np.float32)
    for i in range(n):
        for j in range(m):
            score_mat[i, j] = (1.0/combined_ranks[i,j] + alpha/pool_ranks[i,j]
                               + beta/facade_ranks[i,j])

    matches = hungarian_assign(score_mat, viva, coelho, min_score)

    viva_map = {v["code"]: v for v in viva}
    coelho_map = {c["code"]: c for c in coelho}
    filtered = []
    for m_item in matches:
        v_area = viva_map[m_item["viva_code"]]["area"]
        c_area = coelho_map[m_item["coelho_code"]]["area"]
        if v_area and c_area and v_area > 0 and c_area > 0:
            if abs(v_area - c_area) / ((v_area + c_area) / 2) > area_tol:
                continue
        filtered.append(m_item)
    return filtered


def strat_ensemble_voting(pool_mat, facade_mat, garden_mat,
                           viva, coelho, **kw):
    """Ensemble: run multiple strategies, count votes per pair.
    Only accept pairs that appear in >= min_votes strategies.
    High-vote pairs are likely correct matches."""
    combined_mat = kw.get("combined_mat")
    min_votes = kw.get("min_votes", 3)
    if combined_mat is None:
        return []

    # Run diverse strategies with different parameters
    strategies = [
        # Combined embedding at various thresholds
        (strat_combined_emb, {**kw, "threshold": 0.85}),
        (strat_combined_emb, {**kw, "threshold": 0.88}),
        (strat_combined_emb, {**kw, "threshold": 0.90}),
        # Pool-verify at various thresholds and ranks
        (strat_combined_pool_verify, {**kw, "threshold": 0.82, "pool_rank_max": 3}),
        (strat_combined_pool_verify, {**kw, "threshold": 0.82, "pool_rank_max": 5}),
        (strat_combined_pool_verify, {**kw, "threshold": 0.85, "pool_rank_max": 3}),
        # Area-filtered variants
        (strat_combined_low_thresh_area, {**kw, "threshold": 0.80, "area_tol": 0.20}),
        (strat_combined_low_thresh_area, {**kw, "threshold": 0.85, "area_tol": 0.30}),
        (strat_combined_area_pool_verify,
         {**kw, "threshold": 0.80, "area_tol": 0.30, "pool_rank_max": 5}),
        (strat_combined_area_pool_verify,
         {**kw, "threshold": 0.80, "area_tol": 0.20, "pool_rank_max": 5}),
        # Multi-signal
        (strat_multi_signal_ensemble, {**kw, "threshold": 0.80, "top_k": 5}),
        (strat_multi_signal_ensemble, {**kw, "threshold": 0.80, "top_k": 3}),
        # Price+area filtered
        (strat_price_area_pool_verify,
         {**kw, "threshold": 0.80, "price_tol": 0.40, "area_tol": 0.30,
          "pool_rank_max": 5}),
        # Structural boost (finds structurally matching pairs)
        (strat_structural_boost,
         {**kw, "threshold": 0.85, "area_bonus": 0.05,
          "beds_bonus": 0.03, "price_bonus": 0.03}),
        (strat_structural_boost_area_filter,
         {**kw, "threshold": 0.85, "area_bonus": 0.05,
          "beds_bonus": 0.03, "price_bonus": 0.03, "area_tol": 0.30}),
        (strat_structural_boost_pool_verify,
         {**kw, "threshold": 0.85, "area_bonus": 0.05,
          "beds_bonus": 0.03, "price_bonus": 0.03,
          "area_tol": 0.30, "pool_rank_max": 5}),
        # Pool-only and geometric strategies
        (strat_pool_only, {"threshold": 0.85}),
        (strat_geometric_mean, {"threshold": 0.80}),
        (strat_pool_then_facade_gate,
         {"pool_threshold": 0.85, "facade_gate": 0.60}),
    ]

    from collections import Counter
    vote_counter = Counter()
    pair_sim = {}  # store best similarity seen

    for fn, params in strategies:
        try:
            matches = fn(pool_mat, facade_mat, garden_mat, viva, coelho, **params)
        except Exception:
            continue
        for m in matches:
            key = (m["viva_code"], m["coelho_code"])
            vote_counter[key] += 1
            if key not in pair_sim or m["similarity_score"] > pair_sim[key]:
                pair_sim[key] = m["similarity_score"]

    # Build score matrix: votes * combined_similarity
    # Then use Hungarian for globally optimal 1-to-1 assignment
    viva_idx = {v["code"]: i for i, v in enumerate(viva)}
    coelho_idx = {c["code"]: j for j, c in enumerate(coelho)}
    n, m = len(viva), len(coelho)

    score_mat = np.zeros((n, m), dtype=np.float32)
    for (vc, cc), votes in vote_counter.items():
        if votes < min_votes:
            continue
        if vc in viva_idx and cc in coelho_idx:
            i, j = viva_idx[vc], coelho_idx[cc]
            score_mat[i, j] = votes * pair_sim.get((vc, cc), 0)

    from scipy.optimize import linear_sum_assignment
    row_ind, col_ind = linear_sum_assignment(-score_mat)

    result = []
    for r, c in zip(row_ind, col_ind):
        if score_mat[r, c] <= 0:
            continue
        vc = viva[r]["code"]
        cc = coelho[c]["code"]
        votes = vote_counter.get((vc, cc), 0)
        if votes < min_votes:
            continue
        result.append({
            "viva_code": vc,
            "coelho_code": cc,
            "similarity_score": pair_sim.get((vc, cc), 0),
            "votes": votes,
        })
    return result


def strat_ensemble_composite(pool_mat, facade_mat, garden_mat,
                              viva, coelho, **kw):
    """High-recall ensemble (min_votes=3) → composite confidence filter.
    Confidence = w_vote * norm_votes + w_sim * combined_sim +
                 w_area * area_match + w_pool * (1/pool_rank)
    Then threshold on confidence for precision."""
    combined_mat = kw.get("combined_mat")
    min_votes_base = kw.get("min_votes_base", 3)
    conf_threshold = kw.get("conf_threshold", 0.55)
    w_vote = kw.get("w_vote", 0.35)
    w_sim = kw.get("w_sim", 0.25)
    w_area = kw.get("w_area", 0.20)
    w_pool = kw.get("w_pool", 0.20)
    if combined_mat is None:
        return []

    # Get high-recall candidates from ensemble
    ensemble_result = strat_ensemble_voting(
        pool_mat, facade_mat, garden_mat, viva, coelho,
        combined_mat=combined_mat, min_votes=min_votes_base)

    if not ensemble_result:
        return []

    viva_idx = {v["code"]: i for i, v in enumerate(viva)}
    coelho_idx = {c["code"]: j for j, c in enumerate(coelho)}
    viva_map = {v["code"]: v for v in viva}
    coelho_map = {c["code"]: c for c in coelho}

    # Compute max votes for normalization
    max_votes = max(m.get("votes", 1) for m in ensemble_result)

    scored = []
    for m_item in ensemble_result:
        i = viva_idx[m_item["viva_code"]]
        j = coelho_idx[m_item["coelho_code"]]

        # Vote score (0-1)
        vote_score = m_item.get("votes", 1) / max_votes

        # Combined similarity (already 0-1)
        sim_score = float(combined_mat[i, j])

        # Area match (0-1)
        v_area = viva_map[m_item["viva_code"]]["area"]
        c_area = coelho_map[m_item["coelho_code"]]["area"]
        if v_area and c_area and v_area > 0 and c_area > 0:
            rel_diff = abs(v_area - c_area) / ((v_area + c_area) / 2)
            area_score = max(0, 1 - rel_diff * 3)  # 0% diff → 1.0, 33% → 0
        else:
            area_score = 0.5  # neutral if no area data

        # Pool rank score (1/rank, normalized)
        row = pool_mat[i]
        rank = int((row >= row[j]).sum())  # rank 1 = best
        pool_score = 1.0 / max(rank, 1)

        confidence = (w_vote * vote_score + w_sim * sim_score +
                      w_area * area_score + w_pool * pool_score)
        m_item["confidence"] = round(confidence, 4)
        scored.append(m_item)

    # Filter by confidence
    return [m for m in scored if m["confidence"] >= conf_threshold]


def strat_structural_boost(pool_mat, facade_mat, garden_mat,
                            viva, coelho, **kw):
    """Boost combined similarity with structural data.
    If area and beds match, the visual similarity threshold is lowered.
    This helps rescue pairs that are visually ambiguous but structurally clear."""
    combined_mat = kw.get("combined_mat")
    base_threshold = kw.get("threshold", 0.85)
    area_bonus = kw.get("area_bonus", 0.05)
    beds_bonus = kw.get("beds_bonus", 0.03)
    price_bonus = kw.get("price_bonus", 0.03)
    if combined_mat is None:
        return []

    n, m = combined_mat.shape
    boosted = combined_mat.copy()

    for i, v in enumerate(viva):
        for j, c in enumerate(coelho):
            bonus = 0.0
            # Area match bonus
            if v["area"] and c["area"] and v["area"] > 0 and c["area"] > 0:
                rel_diff = abs(v["area"] - c["area"]) / ((v["area"] + c["area"]) / 2)
                if rel_diff < 0.10:
                    bonus += area_bonus
                elif rel_diff < 0.20:
                    bonus += area_bonus * 0.5
            # Beds match bonus
            if v.get("beds") and c.get("beds"):
                if v["beds"] == c["beds"]:
                    bonus += beds_bonus
            # Price match bonus
            if v["price"] and c["price"] and v["price"] > 0 and c["price"] > 0:
                rel_diff = abs(v["price"] - c["price"]) / ((v["price"] + c["price"]) / 2)
                if rel_diff < 0.20:
                    bonus += price_bonus
                elif rel_diff < 0.40:
                    bonus += price_bonus * 0.5
            boosted[i, j] += bonus

    return hungarian_assign(boosted, viva, coelho, base_threshold)


def strat_structural_boost_area_filter(pool_mat, facade_mat, garden_mat,
                                        viva, coelho, **kw):
    """Structural boost + area filter post-processing."""
    combined_mat = kw.get("combined_mat")
    base_threshold = kw.get("threshold", 0.85)
    area_bonus = kw.get("area_bonus", 0.05)
    beds_bonus = kw.get("beds_bonus", 0.03)
    price_bonus = kw.get("price_bonus", 0.03)
    area_tol = kw.get("area_tol", 0.30)
    if combined_mat is None:
        return []

    n, m = combined_mat.shape
    boosted = combined_mat.copy()
    for i, v in enumerate(viva):
        for j, c in enumerate(coelho):
            bonus = 0.0
            if v["area"] and c["area"] and v["area"] > 0 and c["area"] > 0:
                rel_diff = abs(v["area"] - c["area"]) / ((v["area"] + c["area"]) / 2)
                if rel_diff < 0.10:
                    bonus += area_bonus
                elif rel_diff < 0.20:
                    bonus += area_bonus * 0.5
            if v.get("beds") and c.get("beds") and v["beds"] == c["beds"]:
                bonus += beds_bonus
            if v["price"] and c["price"] and v["price"] > 0 and c["price"] > 0:
                rel_diff = abs(v["price"] - c["price"]) / ((v["price"] + c["price"]) / 2)
                if rel_diff < 0.20:
                    bonus += price_bonus
                elif rel_diff < 0.40:
                    bonus += price_bonus * 0.5
            boosted[i, j] += bonus

    matches = hungarian_assign(boosted, viva, coelho, base_threshold)

    viva_map = {v["code"]: v for v in viva}
    coelho_map = {c["code"]: c for c in coelho}
    filtered = []
    for m_item in matches:
        v_area = viva_map[m_item["viva_code"]]["area"]
        c_area = coelho_map[m_item["coelho_code"]]["area"]
        if v_area and c_area and v_area > 0 and c_area > 0:
            if abs(v_area - c_area) / ((v_area + c_area) / 2) > area_tol:
                continue
        filtered.append(m_item)
    return filtered


def strat_structural_boost_pool_verify(pool_mat, facade_mat, garden_mat,
                                        viva, coelho, **kw):
    """Structural boost + pool top-K verify."""
    combined_mat = kw.get("combined_mat")
    base_threshold = kw.get("threshold", 0.85)
    area_bonus = kw.get("area_bonus", 0.05)
    beds_bonus = kw.get("beds_bonus", 0.03)
    price_bonus = kw.get("price_bonus", 0.03)
    area_tol = kw.get("area_tol", 0.30)
    pool_rank_max = kw.get("pool_rank_max", 5)
    if combined_mat is None:
        return []

    n, m = combined_mat.shape
    boosted = combined_mat.copy()
    for i, v in enumerate(viva):
        for j, c in enumerate(coelho):
            bonus = 0.0
            if v["area"] and c["area"] and v["area"] > 0 and c["area"] > 0:
                rel_diff = abs(v["area"] - c["area"]) / ((v["area"] + c["area"]) / 2)
                if rel_diff < 0.10:
                    bonus += area_bonus
                elif rel_diff < 0.20:
                    bonus += area_bonus * 0.5
            if v.get("beds") and c.get("beds") and v["beds"] == c["beds"]:
                bonus += beds_bonus
            if v["price"] and c["price"] and v["price"] > 0 and c["price"] > 0:
                rel_diff = abs(v["price"] - c["price"]) / ((v["price"] + c["price"]) / 2)
                if rel_diff < 0.20:
                    bonus += price_bonus
                elif rel_diff < 0.40:
                    bonus += price_bonus * 0.5
            boosted[i, j] += bonus

    matches = hungarian_assign(boosted, viva, coelho, base_threshold)

    viva_idx = {v["code"]: i for i, v in enumerate(viva)}
    coelho_idx = {c["code"]: j for j, c in enumerate(coelho)}
    viva_map = {v["code"]: v for v in viva}
    coelho_map = {c["code"]: c for c in coelho}

    filtered = []
    for m_item in matches:
        i = viva_idx[m_item["viva_code"]]
        j = coelho_idx[m_item["coelho_code"]]
        # Area filter
        v_area = viva_map[m_item["viva_code"]]["area"]
        c_area = coelho_map[m_item["coelho_code"]]["area"]
        if v_area and c_area and v_area > 0 and c_area > 0:
            if abs(v_area - c_area) / ((v_area + c_area) / 2) > area_tol:
                continue
        # Pool verify
        row = pool_mat[i]
        top_k = np.argsort(row)[-pool_rank_max:]
        if j in top_k:
            filtered.append(m_item)
    return filtered


def strat_price_weighted_combined(pool_mat, facade_mat, garden_mat,
                                   viva, coelho, combined_mat=None, **kw):
    """Price-multiplied combined embedding matrix → Hungarian.

    Multiplies visual similarity by a price-ratio factor before assignment so
    Hungarian prefers pairs where prices agree, breaking visual ties.
    Threshold is applied to the ORIGINAL visual sim (not boosted) to avoid
    inflating the candidate set with low-visual-sim pairs that happen to have
    matching prices.
    """
    if combined_mat is None:
        return []
    from scipy.optimize import linear_sum_assignment
    threshold = kw.get("threshold", 0.80)
    price_mat = build_price_multiplier_matrix(viva, coelho)
    boosted = combined_mat * price_mat
    row_ind, col_ind = linear_sum_assignment(-boosted)
    matches = []
    for r, c in zip(row_ind, col_ind):
        orig_sim = float(combined_mat[r, c])   # filter on original visual sim
        if orig_sim >= threshold:
            matches.append({
                "viva_code": viva[r]["code"],
                "coelho_code": coelho[c]["code"],
                "similarity_score": round(orig_sim, 6),
            })
    return matches


def strat_threshold_sweep(pool_mat, facade_mat, garden_mat,
                          viva, coelho, **kw):
    """Sweep thresholds on the best strategy so far."""
    best_strat_fn = kw.get("best_fn")
    best_params = kw.get("best_params", {})
    if not best_strat_fn:
        return []

    best_f1 = 0
    best_matches = []
    sweep_params = []

    # Sweep key params
    thresholds = [0.70, 0.75, 0.78, 0.80, 0.82, 0.85, 0.87, 0.90]
    area_tols = [0.20, 0.25, 0.30, 0.35, 0.40, 0.50]
    price_tols = [0.30, 0.40, 0.50, 0.60]
    pool_ranks = [3, 5, 7, 10]
    temps = [0.02, 0.05, 0.10]

    for t in thresholds:
        for at in area_tols:
            for pt in price_tols:
                for pr in pool_ranks:
                    for temp in temps:
                        params = {**best_params,
                                  "threshold": t, "pool_threshold": t,
                                  "area_tol": at, "price_tol": pt,
                                  "pool_rank_max": pr, "temperature": temp,
                                  "top_k": pr}
                        try:
                            matches = best_strat_fn(
                                pool_mat, facade_mat, garden_mat,
                                viva, coelho, **params)
                        except Exception:
                            continue
                        result = evaluate(matches)
                        if result["f1"] > best_f1:
                            best_f1 = result["f1"]
                            best_matches = matches
                            sweep_params.append({
                                "t": t, "area": at, "price": pt,
                                "pool_rank": pr, "temp": temp,
                                **result,
                            })

    sweep_params.sort(key=lambda x: (-x.get("f1", 0), -x.get("precision", 0)))
    for sp in sweep_params[:8]:
        log.info(f"    t={sp.get('t')} area={sp.get('area')} "
                 f"price={sp.get('price')} pool_rank={sp.get('pool_rank')}"
                 f"  P={sp['precision']:.0%} R={sp['recall']:.0%}"
                 f" F1={sp['f1']:.0%}"
                 f" (TP={sp['tp']} FP={sp['fp']})")

    return best_matches


# ─────────────────────────────────────────────────────────────
# Optimization loop
# ─────────────────────────────────────────────────────────────

def run_optimization(viva, coelho, pool_mat, facade_mat, garden_mat,
                     combined_mat):
    # Inject combined_mat into all strategies via kwargs
    cm = {"combined_mat": combined_mat}

    rounds = [
        # ── Baseline ──
        ("R0  combined embedding (baseline)",
         strat_combined_emb, {**cm, "threshold": 0.85}),
        # ── Previous best strategies ──
        ("R1  combined + area + pool-verify (top-5)",
         strat_combined_area_pool_verify,
         {**cm, "threshold": 0.80, "area_tol": 0.30, "pool_rank_max": 5}),
        # ── Structural boost strategies ──
        ("R2  structural boost (area+beds+price)",
         strat_structural_boost,
         {**cm, "threshold": 0.85, "area_bonus": 0.05,
          "beds_bonus": 0.03, "price_bonus": 0.03}),
        ("R3  structural boost + area filter",
         strat_structural_boost_area_filter,
         {**cm, "threshold": 0.85, "area_bonus": 0.05,
          "beds_bonus": 0.03, "price_bonus": 0.03, "area_tol": 0.30}),
        ("R4  structural boost + pool verify",
         strat_structural_boost_pool_verify,
         {**cm, "threshold": 0.85, "area_bonus": 0.05,
          "beds_bonus": 0.03, "price_bonus": 0.03,
          "area_tol": 0.30, "pool_rank_max": 5}),
        ("R5  structural boost (larger bonuses)",
         strat_structural_boost,
         {**cm, "threshold": 0.85, "area_bonus": 0.08,
          "beds_bonus": 0.05, "price_bonus": 0.05}),
        ("R6  structural boost (larger) + area + pool",
         strat_structural_boost_pool_verify,
         {**cm, "threshold": 0.85, "area_bonus": 0.08,
          "beds_bonus": 0.05, "price_bonus": 0.05,
          "area_tol": 0.30, "pool_rank_max": 5}),
        # ── Ensemble with composite confidence ──
        ("R7  ensemble composite (conf=0.50)",
         strat_ensemble_composite,
         {**cm, "min_votes_base": 3, "conf_threshold": 0.50}),
        ("R8  ensemble composite (conf=0.55)",
         strat_ensemble_composite,
         {**cm, "min_votes_base": 3, "conf_threshold": 0.55}),
        ("R9  ensemble composite (conf=0.60)",
         strat_ensemble_composite,
         {**cm, "min_votes_base": 3, "conf_threshold": 0.60}),
        ("R10  ensemble composite (conf=0.65)",
         strat_ensemble_composite,
         {**cm, "min_votes_base": 3, "conf_threshold": 0.65}),
        ("R11  ensemble composite (w_area=0.30)",
         strat_ensemble_composite,
         {**cm, "min_votes_base": 3, "conf_threshold": 0.55,
          "w_vote": 0.25, "w_sim": 0.20, "w_area": 0.30, "w_pool": 0.25}),
        ("R12  ensemble voting (min=8)",
         strat_ensemble_voting,
         {**cm, "min_votes": 8}),
        ("R13  price-weighted combined (thresh=0.80)",
         strat_price_weighted_combined,
         {**cm, "threshold": 0.80}),
        ("R14  price-weighted combined (thresh=0.82)",
         strat_price_weighted_combined,
         {**cm, "threshold": 0.82}),
    ]

    best_f1 = 0.0
    best_name = ""
    best_matches = []
    best_fn = None
    best_params = {}
    results_log = []

    log.info(f"\n{'='*70}")
    log.info(f"Running {len(rounds)} rounds + threshold sweep")
    log.info(f"Ground truth: {len(CONFIRMED_PAIRS)} confirmed pairs")
    log.info(f"{'='*70}\n")

    for name, fn, params in rounds:
        matches = fn(pool_mat, facade_mat, garden_mat, viva, coelho, **params)
        result = evaluate(matches)
        improved = result["f1"] > best_f1

        status = "✓ KEEP" if improved else "✗ discard"
        if improved:
            best_f1 = result["f1"]
            best_name = name
            best_matches = matches
            best_fn = fn
            best_params = params

        log.info(
            f"{name}\n"
            f"    P={result['precision']:.0%}  R={result['recall']:.0%}"
            f"  F1={result['f1']:.0%}"
            f"  (TP={result['tp']}  FP={result['fp']}  FN={result['fn']}"
            f"  total={result['total']})  → {status}"
            f"  [best so far: {best_name}  F1={best_f1:.0%}]\n"
        )
        results_log.append({
            "round": name, **result, "kept": improved,
        })

    # ── Final round: threshold sweep on best strategy ──
    log.info("R-SWEEP  threshold sweep on best strategy...")
    sweep_matches = strat_threshold_sweep(
        pool_mat, facade_mat, garden_mat, viva, coelho,
        best_fn=best_fn, best_params=best_params,
    )
    if sweep_matches:
        sweep_result = evaluate(sweep_matches)
        if sweep_result["f1"] > best_f1:
            log.info(f"    Sweep improved! F1 {best_f1:.0%} → {sweep_result['f1']:.0%}")
            best_f1 = sweep_result["f1"]
            best_name = "R-SWEEP threshold sweep"
            best_matches = sweep_matches
            results_log.append({
                "round": "R10 threshold sweep", **sweep_result, "kept": True,
            })
        else:
            log.info(f"    Sweep did not improve (best: {best_f1:.0%})")

    # ── Summary ──
    log.info(f"\n{'='*70}")
    log.info(f"BEST STRATEGY:  {best_name}")
    final = evaluate(best_matches)
    log.info(f"  Precision:  {final['precision']:.0%}  ({final['tp']}/{final['total']})")
    log.info(f"  Recall:     {final['recall']:.0%}  ({final['tp']}/{len(CONFIRMED_PAIRS)})")
    log.info(f"  F1:         {final['f1']:.0%}")
    log.info(f"{'='*70}\n")

    # Log which ground truth pairs were found/missed
    predicted_set = {(m["viva_code"], m["coelho_code"]) for m in best_matches}
    found = CONFIRMED_PAIRS & predicted_set
    missed = CONFIRMED_PAIRS - predicted_set
    if missed:
        log.info(f"Missed ground truth pairs ({len(missed)}):")
        for v, c in sorted(missed):
            log.info(f"  viva {v} ↔ coelho {c}")
    false_pos = predicted_set - CONFIRMED_PAIRS
    if false_pos:
        log.info(f"\nFalse positives ({len(false_pos)}):")
        for v, c in sorted(false_pos):
            log.info(f"  viva {v} ↔ coelho {c}")

    return best_matches, results_log


def build_ranked_output(viva, coelho, pool_mat, facade_mat, garden_mat,
                        combined_mat):
    """Build a confidence-ranked list of ALL candidate pairs for human review.
    The review UI shows these sorted by confidence — user's time is optimized
    by reviewing the highest-confidence pairs first.

    Confidence = weighted combination of:
      - Combined embedding similarity
      - Pool similarity rank (reciprocal)
      - Facade similarity rank (reciprocal)
      - Area match score
      - Price match score
    """
    from scipy.optimize import linear_sum_assignment

    n, m = combined_mat.shape
    viva_map = {v["code"]: v for v in viva}
    coelho_map = {c["code"]: c for c in coelho}

    # Hungarian on visual similarity only for assignment.
    # Price is used as a confidence signal (below), not as an assignment bias,
    # because price-weighted Hungarian degrades high-tier precision.
    row_ind, col_ind = linear_sum_assignment(-combined_mat)

    # Compute per-pair confidence scores
    pairs_scored = []
    for r, c_idx in zip(row_ind, col_ind):
        sim = float(combined_mat[r, c_idx])
        if sim < 0.75:  # very low threshold to include most candidates
            continue

        v = viva[r]
        c = coelho[c_idx]

        # Pool rank
        pool_row = pool_mat[r]
        pool_rank = int((pool_row >= pool_row[c_idx]).sum())

        # Facade rank
        facade_row = facade_mat[r]
        facade_rank = int((facade_row >= facade_row[c_idx]).sum())

        # Area match
        area_score = 0.5  # neutral
        if v["area"] and c["area"] and v["area"] > 0 and c["area"] > 0:
            rel_diff = abs(v["area"] - c["area"]) / ((v["area"] + c["area"]) / 2)
            area_score = max(0, 1 - rel_diff * 3)

        # Price match — sharper curve: identical prices get 1.0, >30% diff → 0
        price_score = 0.5  # neutral when missing
        if v["price"] and c["price"] and v["price"] > 0 and c["price"] > 0:
            rel_diff = abs(v["price"] - c["price"]) / ((v["price"] + c["price"]) / 2)
            price_score = max(0.0, 1.0 - rel_diff * 3.5)

        # Composite confidence (weights sum to 1.00)
        # Price raised 15%→25%, visual lowered 30%→20%: same property = same price
        confidence = (0.20 * sim +
                      0.20 * (1.0 / max(pool_rank, 1)) +
                      0.15 * (1.0 / max(facade_rank, 1)) +
                      0.20 * area_score +
                      0.25 * price_score)

        # Tier assignment
        if confidence >= 0.65:
            tier = "high"
        elif confidence >= 0.50:
            tier = "medium"
        else:
            tier = "low"

        pairs_scored.append({
            "viva_code": v["code"],
            "coelho_code": c["code"],
            "similarity_score": round(sim, 6),
            "pool_rank": pool_rank,
            "facade_rank": facade_rank,
            "area_score": round(area_score, 3),
            "price_score": round(price_score, 3),
            "confidence": round(confidence, 4),
            "tier": tier,
        })

    pairs_scored.sort(key=lambda x: -x["confidence"])

    # Evaluate each tier
    for tier_name in ("high", "medium", "low"):
        tier_pairs = [p for p in pairs_scored if p["tier"] == tier_name]
        if tier_pairs:
            result = evaluate(tier_pairs)
            log.info(f"  Tier '{tier_name}': {len(tier_pairs)} pairs  "
                     f"P={result['precision']:.0%}  R={result['recall']:.0%}  "
                     f"F1={result['f1']:.0%}  (TP={result['tp']})")

    return pairs_scored


# ─────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────

def parse_args():
    p = argparse.ArgumentParser(
        description="Recursive matcher V2: pool-first, facade-second")
    p.add_argument("--dino-url", default="http://localhost:8000")
    p.add_argument("--data-root", default="data")
    p.add_argument("--output", default="data/auto-matches-v3.json")
    p.add_argument("--cache", default="data/embedding-cache-v3.pkl")
    p.add_argument("--verbose", action="store_true")
    return p.parse_args()


def main():
    args = parse_args()
    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    data_root = Path(args.data_root).resolve()
    cache_path = Path(args.cache).resolve()
    output_path = Path(args.output)

    # Health check
    health_url = args.dino_url.rstrip("/") + "/health"
    try:
        resp = requests.get(health_url, timeout=5)
        resp.raise_for_status()
        info = resp.json()
        log.info(f"DINOv2 server: device={info.get('device')}, "
                 f"model={info.get('dino', info.get('model'))}")
    except Exception as exc:
        if cache_path.exists():
            log.warning(f"DINOv2 server unreachable ({exc}), using cached embeddings")
        else:
            log.error(f"Cannot reach DINOv2 server: {exc}")
            sys.exit(1)

    # Load data
    viva, coelho = load_listings(data_root)

    # Compute / load embeddings
    emb_cache = compute_and_cache_embeddings(
        viva, coelho, args.dino_url, data_root, cache_path)

    # Build per-category similarity matrices
    log.info("Building similarity matrices...")
    pool_mat   = build_sim_matrix(viva, coelho, emb_cache, "pool")
    facade_mat = build_sim_matrix(viva, coelho, emb_cache, "facade")
    garden_mat = build_sim_matrix(viva, coelho, emb_cache, "garden")
    log.info(f"  pool:   {pool_mat.shape}, "
             f"non-zero: {(pool_mat > 0).sum()}")
    log.info(f"  facade: {facade_mat.shape}, "
             f"non-zero: {(facade_mat > 0).sum()}")
    log.info(f"  garden: {garden_mat.shape}, "
             f"non-zero: {(garden_mat > 0).sum()}")

    # Build combined embedding matrix (weighted-mean per listing → cosine)
    log.info("Building combined embedding matrix...")
    combined_mat = build_combined_embedding_matrix(viva, coelho, emb_cache)
    log.info(f"  combined: {combined_mat.shape}, "
             f"non-zero: {(combined_mat > 0).sum()}")

    # Run optimization (find best strategy)
    best_matches, results_log = run_optimization(
        viva, coelho, pool_mat, facade_mat, garden_mat, combined_mat)

    # Build confidence-ranked output for review UI
    log.info("\n" + "=" * 70)
    log.info("Building confidence-ranked pairs for review...")
    ranked_pairs = build_ranked_output(
        viva, coelho, pool_mat, facade_mat, garden_mat, combined_mat)
    all_eval = evaluate(ranked_pairs)
    log.info(f"Total ranked pairs: {len(ranked_pairs)}  "
             f"P={all_eval['precision']:.0%}  R={all_eval['recall']:.0%}  "
             f"F1={all_eval['f1']:.0%}")
    log.info("=" * 70 + "\n")

    # Save output — use ranked pairs (sorted by confidence for review)
    now = datetime.now(timezone.utc).isoformat()
    result = {
        "session_started": now,
        "session_name": "recursive-v2",
        "strategy": "confidence-ranked-ensemble",
        "optimization_log": results_log,
        "matches": [{
            "viva_code": m["viva_code"],
            "coelho_code": m["coelho_code"],
            "matched_at": now,
            "reviewer": "dino-v2",
            "similarity_score": m["similarity_score"],
            "confidence": m.get("tier", "medium"),
            "confidence_score": m.get("confidence", m["similarity_score"]),
            "pool_rank": m.get("pool_rank"),
            "facade_rank": m.get("facade_rank"),
            "strategy": "recursive-v2",
        } for m in ranked_pairs],
        "stats": {
            "total_viva": len(viva),
            "total_coelho": len(coelho),
            "matched": len(ranked_pairs),
            "ground_truth_confirmed": len(CONFIRMED_PAIRS),
            **all_eval,
            "tiers": {
                tier: len([p for p in ranked_pairs if p.get("tier") == tier])
                for tier in ("high", "medium", "low")
            },
        },
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    log.info(f"Saved → {output_path}")


if __name__ == "__main__":
    main()
