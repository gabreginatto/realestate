# DINOv3 Server Setup

The model checkpoint is too large for git (327MB). Download it once:

```bash
python3.11 -c "
from huggingface_hub import hf_hub_download
hf_hub_download(
    repo_id='Shio-Koube/Dinov3-reupload',
    filename='dinov3_vitb16_pretrain_lvd1689m-73cec8be.pth',
    local_dir='dino-server/'
)
"
```

Then start the server:

```bash
cd dino-server
python3.11 -m uvicorn main:app --host 0.0.0.0 --port 8000 --workers 1
```

To regenerate embeddings after downloading:

```bash
python3.11 scripts/recursive-matcher-v2.py \
  --dino-url http://localhost:8000 \
  --cache data/embedding-cache-dinov3.pkl \
  --output data/auto-matches.json
```
