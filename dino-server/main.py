"""
DINOv2 FastAPI embedding server.

Accepts image uploads and returns DINOv2 CLS token embeddings (768-dim).
Runs on CUDA when available; falls back to CPU otherwise.
MPS (Apple Silicon) is intentionally skipped — DINOv2 attention ops are
not fully supported on MPS in current PyTorch/transformers versions.

Start:  uvicorn main:app --host 0.0.0.0 --port 8000 --workers 1
Test:   curl -F "image=@test.jpg" http://localhost:8000/embed | python -m json.tool
"""

import io
import logging
import traceback
from contextlib import asynccontextmanager

import numpy as np
import torch
from fastapi import FastAPI, File, HTTPException, UploadFile
from PIL import Image, UnidentifiedImageError
from transformers import AutoImageProcessor, AutoModel

logger = logging.getLogger("dino-server")
logging.basicConfig(level=logging.INFO)

MODEL_NAME = "facebook/dinov2-base"

# Global model state (loaded once at startup)
_processor = None
_model = None
_device = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _processor, _model, _device

    # MPS skipped: DINOv2 scaled_dot_product_attention is unreliable on MPS.
    # CPU is used for local testing; CUDA is used on the GCP GPU VM.
    _device = "cuda" if torch.cuda.is_available() else "cpu"
    logger.info(f"Loading {MODEL_NAME} on {_device} ...")

    _processor = AutoImageProcessor.from_pretrained(MODEL_NAME)
    _model = AutoModel.from_pretrained(MODEL_NAME)
    _model.to(_device)
    _model.eval()

    logger.info(f"Model ready on {_device}")
    yield

    # Cleanup on shutdown
    _model = None
    _processor = None


app = FastAPI(title="DINOv2 Embedding Server", lifespan=lifespan)


@app.get("/health")
def health():
    if _model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")
    return {"status": "ok", "device": str(_device), "model": MODEL_NAME}


@app.post("/embed")
async def embed(image: UploadFile = File(...)):
    """
    Accept a multipart image upload and return its DINOv2 CLS token embedding.

    Response:
        {
            "embedding": [float, ...],   # 768-dim vector
            "dim": 768
        }
    """
    if _model is None or _processor is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    # Read and decode image
    raw = await image.read()
    try:
        pil_image = Image.open(io.BytesIO(raw)).convert("RGB")
    except (UnidentifiedImageError, Exception) as exc:
        raise HTTPException(status_code=422, detail=f"Invalid image: {exc}")

    # Preprocess + forward pass
    try:
        inputs = _processor(images=pil_image, return_tensors="pt")
        inputs = {k: v.to(_device) for k, v in inputs.items()}

        with torch.no_grad():
            outputs = _model(**inputs)

        cls_embedding = outputs.last_hidden_state[:, 0, :]  # shape: (1, 768)
        vector = cls_embedding.squeeze(0).cpu().numpy().tolist()
    except Exception as exc:
        logger.error(f"Inference error: {exc}\n{traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"Inference error: {exc}")

    return {"embedding": vector, "dim": len(vector)}
