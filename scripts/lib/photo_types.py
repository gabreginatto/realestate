"""Zero-shot photo type classifier (open_clip ViT-B-32 on MPS) -> pool/outdoor/interior/other.

Cache: data/photo_types/<site>.json keyed by relative path, valid while mtime matches.
"""
import json
from pathlib import Path

import torch
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent.parent
CACHE_DIR = ROOT / "data/photo_types"

# (prompt, type)
PROMPTS = [
    ("a photo of a swimming pool", "pool"),
    ("a photo of a pool with a deck next to a house", "pool"),
    ("a photo of a backyard garden", "outdoor"),
    ("a photo of an outdoor area with lawn and trees", "outdoor"),
    ("a photo of an outdoor gourmet barbecue area", "outdoor"),
    ("a photo of a house facade exterior", "outdoor"),
    ("a photo of a living room", "interior"),
    ("a photo of a bedroom", "interior"),
    ("a photo of a kitchen", "interior"),
    ("a photo of a bathroom", "interior"),
    ("a floor plan, map or logo", "other"),
]

_model = None


def _load():
    global _model
    if _model is None:
        import open_clip
        dev = "mps" if torch.backends.mps.is_available() else "cpu"
        m, _, pre = open_clip.create_model_and_transforms("ViT-B-32", pretrained="laion2b_s34b_b79k")
        tok = open_clip.get_tokenizer("ViT-B-32")
        m = m.to(dev).eval()
        with torch.no_grad():
            t = m.encode_text(tok([p for p, _ in PROMPTS]).to(dev))
            t = t / t.norm(dim=-1, keepdim=True)
        _model = (m, pre, t, dev)
    return _model


def _classify(paths: list[Path]) -> list[str]:
    m, pre, t, dev = _load()
    out = []
    for i in range(0, len(paths), 32):
        ims = []
        for p in paths[i:i + 32]:
            try:
                ims.append(pre(Image.open(p).convert("RGB")))
            except Exception:
                ims.append(torch.zeros(3, 224, 224))
        with torch.no_grad():
            f = m.encode_image(torch.stack(ims).to(dev))
            f = f / f.norm(dim=-1, keepdim=True)
            probs = (100 * f @ t.T).softmax(-1).cpu()
        for row in probs:
            agg: dict[str, float] = {}
            for (_, ty), pr in zip(PROMPTS, row.tolist()):
                agg[ty] = agg.get(ty, 0) + pr
            out.append(max(agg, key=agg.get))
    return out


def photo_types(paths: list[Path], site: str) -> dict[Path, str]:
    """Return {path: type}, using/updating the per-site cache."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cf = CACHE_DIR / f"{site}.json"
    cache = json.loads(cf.read_text()) if cf.exists() else {}
    key = lambda p: str(p.relative_to(ROOT))  # noqa: E731
    todo = [p for p in paths if cache.get(key(p), {}).get("mtime") != p.stat().st_mtime]
    if todo:
        for p, ty in zip(todo, _classify(todo)):
            cache[key(p)] = {"mtime": p.stat().st_mtime, "type": ty}
        cf.write_text(json.dumps(cache))
    return {p: cache[key(p)]["type"] for p in paths}
