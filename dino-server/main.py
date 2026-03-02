"""
DINOv2-Large + CLIP FastAPI server.

Endpoints:
  POST /embed     — DINOv2 CLS token embedding (1024-dim) for property matching
  POST /classify  — CLIP zero-shot image classification (pool/exterior/garden/interior)
  GET  /health    — liveness check for both models

Both models load on startup. Device priority: CUDA → MPS → CPU.
MPS is validated with a real DINOv2 forward pass before use; falls back to
CPU automatically if the check fails (older PyTorch had unreliable attention).

Start:  uvicorn main:app --host 0.0.0.0 --port 8000 --workers 1
Test embed:    curl -F "image=@test.jpg" http://localhost:8000/embed | python -m json.tool
Test classify: curl -F "image=@test.jpg" http://localhost:8000/classify | python -m json.tool
"""

import io
import logging
import traceback
from contextlib import asynccontextmanager
from typing import List

import numpy as np
import torch
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from PIL import Image, UnidentifiedImageError
from transformers import (
    AutoImageProcessor,
    AutoModel,
    CLIPModel,
    CLIPProcessor,
)

logger = logging.getLogger("dino-server")
logging.basicConfig(level=logging.INFO)

import os
# DINOv3 is gated — run `huggingface-cli login` and accept the license at
# https://huggingface.co/facebook/dinov3-vitb16-pretrain-lvd1689m
# then set: DINO_MODEL=facebook/dinov3-vitb16-pretrain-lvd1689m
DINO_MODEL_NAME = os.getenv("DINO_MODEL", "facebook/dinov2-large")
CLIP_MODEL_NAME = "openai/clip-vit-base-patch32"

# Default CLIP labels for luxury real estate image classification
DEFAULT_LABELS = [
    "swimming pool",
    "house exterior facade",
    "garden with plants and trees",
    "interior room of a house",
]

# Global model state
_dino_processor = None
_dino_model = None
_clip_processor = None
_clip_model = None
_device = None


def _select_device() -> str:
    """
    Pick the best available device, validating MPS with a real forward pass
    before committing to it (older PyTorch has unreliable DINOv2 attention on MPS).
    """
    if torch.cuda.is_available():
        return "cuda"

    if torch.backends.mps.is_available():
        logger.info("MPS detected — running compatibility check ...")
        try:
            from transformers import AutoImageProcessor, AutoModel
            _proc = AutoImageProcessor.from_pretrained(DINO_MODEL_NAME)
            _mdl  = AutoModel.from_pretrained(DINO_MODEL_NAME).to("mps").eval()
            _dummy = torch.zeros(1, 3, 224, 224, device="mps")
            _inputs = _proc(images=Image.new("RGB", (224, 224)), return_tensors="pt")
            _inputs = {k: v.to("mps") for k, v in _inputs.items()}
            with torch.no_grad():
                _mdl(**_inputs)
            del _mdl, _proc, _inputs, _dummy
            logger.info("MPS check passed — using MPS")
            return "mps"
        except Exception as exc:
            logger.warning(f"MPS check failed ({exc}) — falling back to CPU")

    return "cpu"


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _dino_processor, _dino_model, _clip_processor, _clip_model, _device

    _device = _select_device()

    logger.info(f"Device: {_device}")
    logger.info(f"Loading {DINO_MODEL_NAME} ...")
    _dino_processor = AutoImageProcessor.from_pretrained(DINO_MODEL_NAME)
    _dino_model = AutoModel.from_pretrained(DINO_MODEL_NAME)
    _dino_model.to(_device)
    _dino_model.eval()
    logger.info(f"DINOv2 ready")

    logger.info(f"Loading {CLIP_MODEL_NAME} ...")
    _clip_processor = CLIPProcessor.from_pretrained(CLIP_MODEL_NAME)
    _clip_model = CLIPModel.from_pretrained(CLIP_MODEL_NAME)
    _clip_model.to(_device)
    _clip_model.eval()
    logger.info(f"CLIP ready")

    logger.info("Both models loaded — server is ready")
    yield

    _dino_model = None
    _dino_processor = None
    _clip_model = None
    _clip_processor = None


app = FastAPI(title="DINOv2 + CLIP Embedding Server", lifespan=lifespan)


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
        "dino": DINO_MODEL_NAME,
        "clip": CLIP_MODEL_NAME,
    }


# ---------------------------------------------------------------------------
# /embed  — DINOv2 property matching embedding
# ---------------------------------------------------------------------------

@app.post("/embed")
async def embed(image: UploadFile = File(...)):
    """
    Returns the DINOv2 CLS token embedding for property matching.

    Response: { "embedding": [float, ...], "dim": 1024 }
    """
    if _dino_model is None:
        raise HTTPException(status_code=503, detail="DINOv2 not loaded")

    raw = await image.read()
    try:
        pil_image = Image.open(io.BytesIO(raw)).convert("RGB")
    except (UnidentifiedImageError, Exception) as exc:
        raise HTTPException(status_code=422, detail=f"Invalid image: {exc}")

    try:
        inputs = _dino_processor(images=pil_image, return_tensors="pt")
        inputs = {k: v.to(_device) for k, v in inputs.items()}

        with torch.no_grad():
            outputs = _dino_model(**inputs)

        cls_emb = outputs.last_hidden_state[:, 0, :].squeeze(0).cpu().numpy().tolist()
    except Exception as exc:
        logger.error(f"DINOv2 inference error: {exc}\n{traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"Inference error: {exc}")

    return {"embedding": cls_emb, "dim": len(cls_emb)}


# ---------------------------------------------------------------------------
# /classify  — CLIP zero-shot image classification
# ---------------------------------------------------------------------------

@app.post("/classify")
async def classify(
    image: UploadFile = File(...),
    labels: str = Form(None),
):
    """
    Zero-shot image classification using CLIP.

    Args:
        image: image file (multipart)
        labels: optional comma-separated list of category labels.
                Defaults to: swimming pool, house exterior facade,
                             garden with plants and trees,
                             interior room of a house

    Response:
        {
            "label": "swimming pool",       # top predicted category
            "score": 0.91,                  # softmax probability
            "all_scores": {                 # scores for all labels
                "swimming pool": 0.91,
                "house exterior facade": 0.05,
                ...
            }
        }
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
            text=label_list,
            images=pil_image,
            return_tensors="pt",
            padding=True,
        )
        inputs = {k: v.to(_device) for k, v in inputs.items()}

        with torch.no_grad():
            outputs = _clip_model(**inputs)

        # logits_per_image: (1, num_labels)
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
