#!/usr/bin/env python3
"""
Select the best 12 exterior-leaning photos per listing using fastdup outputs.

IMPORTANT: Processes each site (Coelho, Viva) separately to preserve
cross-site duplicates for property matching.
"""
import os, sys, json, pathlib, shutil
import pandas as pd
import numpy as np
import cv2
from rich import print as rprint
from rich.progress import track
from rich.console import Console
import typer

app = typer.Typer()
console = Console()

def list_images(root):
    """Find all image files in a directory."""
    exts = (".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff")
    root_path = pathlib.Path(root)
    if not root_path.exists():
        return []
    return [str(p) for p in root_path.glob("*") if p.suffix.lower() in exts]

def laplacian_var(img):
    """Calculate image sharpness using Laplacian variance."""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if len(img.shape) == 3 else img
    return cv2.Laplacian(gray, cv2.CV_64F).var()

def hsv_exterior_score(img):
    """
    Heuristic: more sky/vegetation in upper half -> likely exterior.
    Returns a score between 0.0 and ~2.0+
    """
    h, w = img.shape[:2]
    top_half = img[:h//2, :, :]
    hsv = cv2.cvtColor(top_half, cv2.COLOR_BGR2HSV)
    H, S, V = cv2.split(hsv)

    # Sky-ish blue range (H≈90-140 degrees)
    sky_mask = ((H >= 90) & (H <= 140) & (S > 40) & (V > 80))
    sky_ratio = float(np.count_nonzero(sky_mask)) / (top_half.shape[0] * top_half.shape[1])

    # Vegetation green range (H≈35-85 degrees)
    veg_mask = ((H >= 35) & (H <= 85) & (S > 40) & (V > 40))
    veg_ratio = float(np.count_nonzero(veg_mask)) / (top_half.shape[0] * top_half.shape[1])

    # Indoor warm tones (reds/oranges) reduce score
    warm_mask = (((H <= 15) | (H >= 165)) & (S > 40) & (V > 40))
    warm_ratio = float(np.count_nonzero(warm_mask)) / (top_half.shape[0] * top_half.shape[1])

    # Weighted score: favor sky and vegetation, penalize warm indoor colors
    score = 1.5 * sky_ratio + 1.0 * veg_ratio - 0.5 * warm_ratio
    return max(0.0, score)

def normalize(series):
    """Normalize a pandas Series to 0-1 range."""
    if len(series) == 0:
        return series
    a = series.values.astype(float)
    mn, mx = np.nanmin(a), np.nanmax(a)
    if mx <= mn:
        return pd.Series(np.zeros_like(a), index=series.index)
    return pd.Series((a - mn) / (mx - mn), index=series.index)

def load_fastdup_tables(work_dir):
    """Load fastdup CSV outputs."""
    # Fastdup generates these file names
    stats_path = os.path.join(work_dir, "atrain_stats.csv")
    features_path = os.path.join(work_dir, "atrain_features.dat.csv")
    sim_path = os.path.join(work_dir, "similarity.csv")
    cc_path = os.path.join(work_dir, "connected_components.csv")

    df_stats = pd.read_csv(stats_path) if os.path.exists(stats_path) else pd.DataFrame()
    df_features = pd.read_csv(features_path) if os.path.exists(features_path) else pd.DataFrame()
    df_sim = pd.read_csv(sim_path) if os.path.exists(sim_path) else pd.DataFrame()
    df_cc = pd.read_csv(cc_path) if os.path.exists(cc_path) else pd.DataFrame()

    # Merge stats with filenames using index
    if not df_stats.empty and not df_features.empty:
        df_stats = df_stats.merge(df_features, left_on="index", right_on="index", how="left")

    # Add cluster info from connected_components (use component_id as cluster)
    if not df_cc.empty and not df_features.empty:
        # cc uses __id which corresponds to image index
        df_features_with_cluster = df_features.merge(
            df_cc[["__id", "component_id"]],
            left_on="index",
            right_on="__id",
            how="left"
        )
        df_features_with_cluster = df_features_with_cluster.rename(columns={"component_id": "cluster"})
    else:
        df_features_with_cluster = df_features.copy() if not df_features.empty else pd.DataFrame()
        if "cluster" not in df_features_with_cluster.columns:
            df_features_with_cluster["cluster"] = -1

    return df_stats, df_features_with_cluster, df_sim

def select_best_12(listing_dir, work_dir, site, listing_id, out_root, copy_mode="copy"):
    """
    Select the best 12 (or fewer if < 12) exterior-leaning photos for a listing.

    Returns: number of images selected
    """
    # Load fastdup outputs
    df_stats, df_features_with_cluster, df_sim = load_fastdup_tables(work_dir)

    # Get all images in listing
    files = list_images(listing_dir)
    if not files:
        console.print(f"[yellow]  No images found in {listing_dir}[/yellow]")
        return 0

    # Create base dataframe
    df = pd.DataFrame({"filename": files})
    df["site"] = site
    df["listing_id"] = listing_id

    # Merge fastdup stats if available
    if not df_stats.empty and "filename" in df_stats.columns:
        # Normalize paths for matching
        df_stats_clean = df_stats.copy()
        df_stats_clean["filename"] = df_stats_clean["filename"].apply(lambda x: os.path.abspath(x) if not os.path.isabs(x) else x)
        df["filename_abs"] = df["filename"].apply(os.path.abspath)
        df = df.merge(df_stats_clean, left_on="filename_abs", right_on="filename", how="left", suffixes=("", "_fd"))
        df["filename"] = df["filename"].fillna(df["filename_fd"])
        df = df.drop(columns=["filename_abs", "filename_fd"], errors="ignore")

    # Attach cluster ID from features_with_cluster if available
    if not df_features_with_cluster.empty and {"filename", "cluster"}.issubset(df_features_with_cluster.columns):
        features_clean = df_features_with_cluster.copy()
        features_clean["filename"] = features_clean["filename"].apply(lambda x: os.path.abspath(x) if not os.path.isabs(x) else x)
        df["filename_abs"] = df["filename"].apply(os.path.abspath)
        df = df.merge(features_clean[["filename", "cluster"]], left_on="filename_abs", right_on="filename", how="left", suffixes=("", "_cluster"))
        df["cluster"] = df["cluster"].fillna(-1).astype(int)
        df = df.drop(columns=["filename_abs", "filename_cluster"], errors="ignore")

    if "cluster" not in df.columns:
        df["cluster"] = -1  # Single cluster if missing

    # Compute quality metrics locally
    sharpness = []
    brightness = []
    exterior_scores = []
    valid = []

    for f in files:
        img = cv2.imread(f)
        if img is None:
            sharpness.append(np.nan)
            brightness.append(np.nan)
            exterior_scores.append(0.0)
            valid.append(False)
            continue

        valid.append(True)

        # Sharpness
        sharpness.append(laplacian_var(img))

        # Brightness
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        brightness.append(float(np.mean(gray)))

        # Exterior score
        exterior_scores.append(hsv_exterior_score(img))

    df["sharpness"] = sharpness
    df["brightness"] = brightness
    df["exterior_score"] = exterior_scores
    df["valid"] = valid

    # Filter out invalid images
    df = df[df["valid"] == True].copy()

    if len(df) == 0:
        console.print(f"[yellow]  No valid images in {listing_dir}[/yellow]")
        return 0

    # Normalize scores
    df["sharp_n"] = normalize(df["sharpness"])

    # Favor mid-brightness (avoid over/under exposure)
    # Gaussian bump centered at ~130 (out of 255)
    b = df["brightness"].astype(float)
    if b.notna().any():
        df["bright_n"] = np.exp(-((b - 130.0) ** 2) / (2 * (40.0 ** 2)))
    else:
        df["bright_n"] = 0.0

    df["ext_n"] = normalize(df["exterior_score"])

    # Final ranking score
    # Weights: exterior 50%, sharpness 35%, brightness 15%
    df["rank_score"] = 0.50 * df["ext_n"] + 0.35 * df["sharp_n"] + 0.15 * df["bright_n"]

    # Within each cluster, pick the top 1 image by rank_score (de-redundancy)
    representatives = (df.sort_values("rank_score", ascending=False)
                      .groupby("cluster", dropna=False, as_index=False)
                      .first())

    representatives = representatives.sort_values("rank_score", ascending=False)

    # Select best 12 (or all if fewer than 12)
    num_to_keep = min(12, len(representatives))
    chosen = representatives.head(num_to_keep).copy()

    # Create output directory
    out_dir = os.path.join(out_root, site, listing_id)
    os.makedirs(out_dir, exist_ok=True)

    # Copy/symlink selected images
    for _, row in chosen.iterrows():
        src = row["filename"]
        dst = os.path.join(out_dir, os.path.basename(src))

        if copy_mode == "copy":
            shutil.copy2(src, dst)
        else:  # symlink
            if os.path.islink(dst) or os.path.exists(dst):
                os.remove(dst)
            os.symlink(os.path.abspath(src), dst)

    # Save manifest for transparency
    manifest = {
        "site": site,
        "listing_id": listing_id,
        "listing_dir": listing_dir,
        "total_images": len(files),
        "valid_images": int(len(df)),
        "selected_count": int(len(chosen)),
        "target_count": 12,
        "selected": chosen[["filename", "rank_score", "ext_n", "sharp_n", "bright_n", "cluster"]].to_dict(orient="records")
    }

    with open(os.path.join(out_dir, "_manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)

    return len(chosen)

@app.command()
def run(
    site: str = typer.Argument(..., help="Site name: 'coelhodafonseca' or 'vivaprimeimoveis'"),
    cache_root: str = typer.Option("data_clean", help="Root data directory (UFOID cleaned)"),
    work_root: str = typer.Option("work_fastdup", help="Fastdup work directory"),
    out_root: str = typer.Option("selected_exteriors", help="Output directory for selected images"),
    copy_mode: str = typer.Option("copy", help="'copy' or 'symlink'"),
):
    """
    Select best 12 exterior photos per listing for a single site.

    Example:
        python select_exteriors.py coelhodafonseca
        python select_exteriors.py vivaprimeimoveis
    """
    console.print(f"\n[bold cyan]Selecting best 12 exterior images for: {site}[/bold cyan]\n")

    cache_dir = os.path.join(cache_root, site)

    if not os.path.exists(cache_dir):
        console.print(f"[red]Error: {cache_dir} does not exist![/red]")
        raise typer.Exit(1)

    # Get all listing directories
    listings = sorted([d for d in pathlib.Path(cache_dir).iterdir() if d.is_dir()])

    if not listings:
        console.print(f"[yellow]No listings found in {cache_dir}[/yellow]")
        raise typer.Exit(0)

    console.print(f"Found {len(listings)} listings to process\n")

    total_selected = 0
    stats = {"12": 0, "less_than_12": 0, "failed": 0}

    for listing_path in track(listings, description=f"Processing {site}"):
        listing_id = listing_path.name
        listing_dir = str(listing_path)
        work_dir = os.path.join(work_root, site, listing_id, "fastdup")

        try:
            count = select_best_12(listing_dir, work_dir, site, listing_id, out_root, copy_mode)
            total_selected += count

            if count == 12:
                stats["12"] += 1
            elif count > 0:
                stats["less_than_12"] += 1
            else:
                stats["failed"] += 1

        except Exception as e:
            console.print(f"[red]  Error processing {listing_id}: {e}[/red]")
            stats["failed"] += 1

    console.print(f"\n[bold green]✓ Complete![/bold green]")
    console.print(f"\nStatistics:")
    console.print(f"  Listings with exactly 12 photos: {stats['12']}")
    console.print(f"  Listings with < 12 photos: {stats['less_than_12']}")
    console.print(f"  Failed/No images: {stats['failed']}")
    console.print(f"  Total images selected: {total_selected}")
    console.print(f"\nOutput: {out_root}/{site}/\n")

if __name__ == "__main__":
    app()
