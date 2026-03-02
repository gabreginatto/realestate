"""
DINOv3 + CLIP FastAPI server.

Endpoints:
  POST /embed     — DINOv3 CLS token embedding (768-dim) for property matching
  POST /classify  — CLIP zero-shot image classification (pool/exterior/garden/interior)
  GET  /health    — liveness check for both models

DINOv3 is loaded from local repo + public checkpoint (vitb16, 768-dim).
CLIP is loaded via HuggingFace transformers.

Start:  uvicorn main:app --host 0.0.0.0 --port 8000 --workers 1
Test embed:    curl -F "image=@test.jpg" http://localhost:8000/embed | python -m json.tool
Test classify: curl -F "image=@test.jpg" http://localhost:8000/classify | python -m json.tool
"""

import io
import logging
import os
import sys
import traceback
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
import torch
import torchvision.transforms.v2 as T
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from PIL import Image, UnidentifiedImageError
from transformers import CLIPModel, CLIPProcessor

logger = logging.getLogger("dino-server")
logging.basicConfig(level=logging.INFO)

# DINOv3 repo and checkpoint — loaded locally to avoid gated HF access
_HERE = Path(__file__).parent
DINOV3_REPO  = str(_HERE / "dinov3-repo")
DINOV3_CKPT  = str(_HERE / "dinov3_vitb16_pretrain_lvd1689m-73cec8be.pth")
CLIP_MODEL_NAME = "openai/clip-vit-base-patch32"

# Standard ImageNet preprocessing (same as DINOv2)
_DINO_TRANSFORM = T.Compose([
    T.Resize(256, interpolation=T.InterpolationMode.BICUBIC),
    T.CenterCrop(224),
    T.ToImage(),
    T.ToDtype(torch.float32, scale=True),
    T.Normalize(mean=(0.485, 0.456, 0.406), std=(0.229, 0.224, 0.225)),
])

# Global model state
_dino_model     = None
_clip_processor = None
_clip_model     = None
_device         = None


def _select_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    # MPS has known issues with some ops — always use CPU for reliability
    return "cpu"


@asynccontextmanager
async def lifespan(app):
    global _dino_model, _clip_processor, _clip_model, _device

    _device = _select_device()
    logger.info(f"Device: {_device}")

    # Load DINOv3 from local repo + checkpoint
    logger.info(f"Loading DINOv3 vitb16 from local repo ...")
    sys.path.insert(0, DINOV3_REPO)
    from dinov3.hub.backbones import dinov3_vitb16
    _dino_model = dinov3_vitb16(pretrained=False)
    state = torch.load(DINOV3_CKPT, map_location="cpu", weights_only=True)
    # Checkpoint may be wrapped in a 'model' key
    if "model" in state:
        state = state["model"]
    _dino_model.load_state_dict(state, strict=False)
    _dino_model.to(_device)
    _dino_model.eval()
    logger.info("DINOv3 ready")

    logger.info(f"Loading {CLIP_MODEL_NAME} ...")
    _clip_processor = CLIPProcessor.from_pretrained(CLIP_MODEL_NAME)
    _clip_model = CLIPModel.from_pretrained(CLIP_MODEL_NAME)
    _clip_model.to(_device)
    _clip_model.eval()
    logger.info("CLIP ready")

    logger.info("Both models loaded — server is ready")
    yield

    _dino_model     = None
    _clip_model     = None
    _clip_processor = None


app = FastAPI(title="DINOv3 + CLIP Embedding Server", lifespan=lifespan)


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

@app.get("/health")
def health():
    if _dino_model is None or _clip_model is None:
        raise HTTPException(status_code=503, detail="Models not loaded")
    return {
        "status": "ok",
        "device": str(_device),
        "dino": "dinov3-vitb16",
        "clip": CLIP_MODEL_NAME,
    }


# ---------------------------------------------------------------------------
# /embed  — DINOv3 CLS token embedding
# ---------------------------------------------------------------------------

@app.post("/embed")
async def embed(image: UploadFile = File(...)):
    """
    Returns the DINOv3 CLS token embedding for property matching.

    Response: { "embedding": [float, ...], "dim": 768 }
    """
    if _dino_model is None:
        raise HTTPException(status_code=503, detail="DINOv3 not loaded")

    raw = await image.read()
    try:
        pil_image = Image.open(io.BytesIO(raw)).convert("RGB")
    except (UnidentifiedImageError, Exception) as exc:
        raise HTTPException(status_code=422, detail=f"Invalid image: {exc}")

    try:
        tensor = _DINO_TRANSFORM(pil_image).unsqueeze(0).to(_device)
        with torch.no_grad():
            out = _dino_model(tensor)
        # DINOv3 backbone returns (batch, 768) tensor directly
        if isinstance(out, dict):
            cls_emb = out.get("x_norm_clstoken") or next(iter(out.values()))
        else:
            cls_emb = out
        cls_emb = cls_emb.squeeze(0).cpu().numpy().tolist()
    except Exception as exc:
        logger.error(f"DINOv3 inference error: {exc}\n{traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"Inference error: {exc}")

    return {"embedding": cls_emb, "dim": len(cls_emb)}


# ---------------------------------------------------------------------------
# /classify  — CLIP zero-shot image classification
# ---------------------------------------------------------------------------

DEFAULT_LABELS = [
    "swimming pool",
    "house exterior facade",
    "garden with plants and trees",
    "interior room of a house",
]

@app.post("/classify")
async def classify(
    image: UploadFile = File(...),
    labels: str = Form(None),
):
    """
    Zero-shot image classification using CLIP.

    Response: { "label": str, "score": float, "all_scores": {label: float} }
    """
    if _clip_model is None:
        raise HTTPException(status_code=503, detail="CLIP not loaded")

    raw = await image.read()
    try:
        pil_image = Image.open(io.BytesIO(raw)).convert("RGB")
    except (UnidentifiedImageError, Exception) as exc:
        raise HTTPException(status_code=422, detail=f"Invalid image: {exc}")

    label_list = (
        [l.strip() for l in labels.split(",") if l.strip()]
        if labels
        else DEFAULT_LABELS
    )

    try:
        inputs = _clip_processor(
            text=label_list, images=pil_image, return_tensors="pt", padding=True,
        )
        inputs = {k: v.to(_device) for k, v in inputs.items()}
        with torch.no_grad():
            outputs = _clip_model(**inputs)
        probs = outputs.logits_per_image.softmax(dim=1).squeeze(0).cpu().numpy()
    except Exception as exc:
        logger.error(f"CLIP inference error: {exc}\n{traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"Inference error: {exc}")

    top_idx = int(np.argmax(probs))
    return {
        "label": label_list[top_idx],
        "score": float(probs[top_idx]),
        "all_scores": {label_list[i]: float(probs[i]) for i in range(len(label_list))},
    }
