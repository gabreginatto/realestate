"""Per-image fingerprints for reused-photo detection: PDQ (8 dihedral variants) + SSCD embeddings.

Cached by file content sha1 as one .npz per image (never committed).
"""
from __future__ import annotations

import hashlib
import logging
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

log = logging.getLogger("photo_fingerprints")

SSCD_URL = "https://dl.fbaipublicfiles.com/sscd-copy-detection/sscd_disc_mixup.torchscript.pt"
SSCD_PATH = Path.home() / ".cache" / "sscd" / "sscd_disc_mixup.torchscript.pt"
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}
_POPCOUNT = np.array([bin(i).count("1") for i in range(256)], dtype=np.uint8)


@dataclass
class Fingerprint:
    pdq: np.ndarray  # (8, 32) uint8 packed bits, dihedral variants
    emb: np.ndarray  # (2, D) float32, L2-normalised: [original, hflip]


def sha1_file(path: Path) -> str:
    h = hashlib.sha1()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_image(path: Path) -> Image.Image:
    img = Image.open(path)
    img = ImageOps.exif_transpose(img)
    return img.convert("RGB")


def pdq_variants(img: Image.Image) -> np.ndarray:
    """(8, 32) packed PDQ hashes for the 8 dihedral variants (pdqhash, else imagehash pHash + hflip)."""
    arr = np.asarray(img)
    try:
        import pdqhash

        hashes, _ = pdqhash.compute_dihedral(arr)
        return np.packbits(np.asarray(hashes, dtype=np.uint8), axis=1)
    except ImportError:
        import imagehash

        out = []
        for im in (img, ImageOps.mirror(img)):
            bits = imagehash.phash(im, hash_size=16).hash.flatten().astype(np.uint8)
            out.append(np.packbits(bits))
        return np.stack(out + [out[0]] * 6)  # padded so shapes match


def hamming_min(a: np.ndarray, variants: np.ndarray) -> int:
    """Min Hamming distance between hash a (32,) and any variant row of (k, 32)."""
    return int(_POPCOUNT[np.bitwise_xor(variants, a)].sum(axis=1).min())


def pairwise_pdq(orig: np.ndarray, variants_list: np.ndarray) -> np.ndarray:
    """orig (n,32), variants (m,8,32) -> (n,m) min Hamming over variants."""
    x = np.bitwise_xor(orig[:, None, None, :], variants_list[None])  # n,m,8,32
    return _POPCOUNT[x].sum(axis=-1, dtype=np.int32).min(axis=-1)


def pick_device() -> str:
    import torch

    return "mps" if torch.backends.mps.is_available() else "cpu"


def load_sscd(device: str):
    import torch

    if not SSCD_PATH.exists():
        SSCD_PATH.parent.mkdir(parents=True, exist_ok=True)
        log.info("downloading SSCD model to %s", SSCD_PATH)
        urllib.request.urlretrieve(SSCD_URL, SSCD_PATH)
    return torch.jit.load(str(SSCD_PATH), map_location="cpu").eval().to(device)


def _to_tensor(img: Image.Image, size: int = 288) -> np.ndarray:
    # SSCD README (disc_mixup): Resize([288, 288]) + ImageNet normalisation.
    a = np.asarray(img.resize((size, size), Image.BILINEAR), dtype=np.float32) / 255.0
    a = (a - np.array([0.485, 0.456, 0.406], np.float32)) / np.array([0.229, 0.224, 0.225], np.float32)
    return a.transpose(2, 0, 1)


def embed_batch(model, device: str, imgs: list[Image.Image]) -> np.ndarray:
    """(n, 2, D) L2-normalised embeddings of each image and its horizontal flip."""
    import torch

    x = torch.from_numpy(np.stack([_to_tensor(i) for i in imgs])).to(device)
    with torch.no_grad():
        e = model(torch.cat([x, torch.flip(x, dims=[3])])).float().cpu().numpy()
    e /= np.linalg.norm(e, axis=1, keepdims=True) + 1e-12
    n = len(imgs)
    return np.stack([e[:n], e[n:]], axis=1)


def fingerprint_files(
    paths: list[Path], cache_dir: Path, batch_size: int = 16, device: str | None = None
) -> dict[Path, Fingerprint]:
    """Fingerprint every path, using/filling the sha1-keyed cache."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    result: dict[Path, Fingerprint] = {}
    todo: list[tuple[Path, str]] = []
    for p in paths:
        key = sha1_file(p)
        cf = cache_dir / f"{key}.npz"
        if cf.exists():
            with np.load(cf) as z:
                result[p] = Fingerprint(z["pdq"], z["emb"].astype(np.float32))
        else:
            todo.append((p, key))
    log.info("%d images, %d cached, %d to compute", len(paths), len(result), len(todo))
    if not todo:
        return result
    device = device or pick_device()
    model = load_sscd(device)
    t0 = time.time()
    for i in range(0, len(todo), batch_size):
        chunk = todo[i : i + batch_size]
        imgs, kept = [], []
        for p, key in chunk:
            try:
                imgs.append(load_image(p))
                kept.append((p, key))
            except Exception as e:  # corrupt/unsupported image
                log.warning("skip %s: %s", p, e)
        if not imgs:
            continue
        embs = embed_batch(model, device, imgs)
        for (p, key), img, emb in zip(kept, imgs, embs):
            fp = Fingerprint(pdq_variants(img), emb)
            np.savez(cache_dir / f"{key}.npz", pdq=fp.pdq, emb=fp.emb.astype(np.float16))
            result[p] = fp
    dt = time.time() - t0
    log.info("computed %d images in %.1fs (%.1f img/s on %s)", len(todo), dt, len(todo) / max(dt, 1e-9), device)
    return result
