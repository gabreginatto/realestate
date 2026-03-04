# Property Matching Pipeline — Operator Guide

This document tells you exactly how to run the full AI property matching pipeline.
Read it top to bottom before touching anything.

---

## What this system does

Matches luxury property listings between two real estate agencies:
- **Viva Prime Imóveis** (`vivaprimeimoveis`) — 70 listings
- **Coelho da Fonseca** (`coelhodafonseca`) — 81 listings

Pipeline: scrape images → CLIP classifies images (pool/facade/garden) →
DINOv3 embeds selected images → Hungarian algorithm finds best matches →
human reviews matches in browser.

---

## Architecture

```
Mac (heavy compute)              GCS Bucket                      Cloud Run
────────────────────             ──────────────────────          ─────────────────
Playwright scrapers        →     images/{site}/{code}/
CLIP selector              →     selected/{site}/{code}/
DINOv3 recursive matcher   →     matches/auto-matches.json  →    Review UI
sync-to-gcs.sh             →     listings/{site}.json            (always on,
                                 review-sessions/                 scales to zero)
```

**Key rule:** Mac does all AI compute. GCS stores everything. Cloud Run only serves the review UI.
You do NOT need a GPU VM. You do NOT need the Mac on during review.

---

## GCP Resources

| Resource | Value |
|----------|-------|
| Project | `realestate-475615` |
| GCS bucket | `realestate-475615-data` (public read) |
| Cloud Run service | `match-review` (us-east1) |
| Review UI URL | `https://match-review-n3z7pwcwsa-ue.a.run.app` |

---

## Prerequisites (already set up — do not redo)

- [x] GCS bucket created and public
- [x] Cloud Run service deployed
- [x] DINOv3 server code in `dino-server/`
- [x] DINOv3 checkpoint downloaded to `dino-server/dinov3_vitb16_pretrain_lvd1689m-73cec8be.pth`
  - If missing: see `dino-server/SETUP.md` to re-download (327MB from HuggingFace)
- [x] `selected_for_matching/` — CLIP-curated image selection per listing
- [x] `data/{site}/cache/{code}/` — full image cache per listing

---

## Step 0 — Start the DINOv3+CLIP server (Mac, keep running during steps 1-3)

```bash
cd dino-server
python3.11 -m uvicorn main:app --host 0.0.0.0 --port 8000 --workers 1
```

Wait until you see: `Both models loaded — server is ready`

Check it: `curl http://localhost:8000/health`

The server loads DINOv3 + CLIP. It will use MPS (Apple Silicon GPU) if compatible,
otherwise CPU. Either way it works — MPS is just faster (~10×).

---

## Step 1 — Scrape all images (skip if cache already exists)

Run only if `data/{site}/cache/` is empty or you want fresh images.

```bash
# Both sites in parallel — takes 20-40 min
npx playwright test \
  scripts/cache-images-viva.spec.ts \
  scripts/cache-images-coelho.spec.ts \
  --project=chromium --workers=2
```

Output: `data/vivaprimeimoveis/cache/{code}/01.jpg, 02.jpg ...`
        `data/coelhodafonseca/cache/{code}/01.jpg, 02.jpg ...`

Both scripts are resumable — re-run if interrupted, they skip cached listings.

---

## Step 2 — CLIP image selection (pool-first)

Classifies every image as pool / facade / garden / interior.
Selects up to 4 pool + 2 facade + 2 garden per listing.
Discards interiors. Pools are the strongest fingerprint for luxury properties.

```bash
python scripts/dino-select-exteriors.py \
  --source-type cache \
  --data-root data/ \
  --dino-url http://localhost:8000
```

Output: `selected_for_matching/{site}/{code}/` + `_manifest.json`

---

## Step 3 — DINOv3 recursive matching

Runs 10 internal optimization rounds. Uses the `selected_for_matching/` images.
Caches embeddings to disk so re-runs are fast (only re-embeds new/changed listings).

```bash
python scripts/recursive-matcher-v2.py \
  --dino-url http://localhost:8000 \
  --data-root data/ \
  --output data/auto-matches.json \
  --cache data/embedding-cache-v3.pkl
```

Output: `data/auto-matches.json`

Previous results for reference:
- DINOv3-vitb16: 62/62 Viva matched, min_sim=0.87, mean_sim=0.93
- precision=0.19, recall=0.80 against 15 human-confirmed ground truth pairs

---

## Step 4 — Sync to GCS

Pushes everything to GCS so the review UI can see it.
Run from repo root.

```bash
./scripts/sync-to-gcs.sh
```

**After this step the Mac can sleep.** All data is in GCS.

---

## Step 5 — Review matches in browser

Open: `https://match-review-n3z7pwcwsa-ue.a.run.app`

Controls:
- `→` or `M` — confirm match
- `←` or `S` — skip (not a match)
- `D` — done
- Click image area → lightbox with all images

Session is saved to GCS after every action. Close and reopen anytime — it resumes.

When all pairs are reviewed, click **Finalizar** → downloads `final-matches.json`.

---

## Step 6 — Re-matching skipped pairs (optional)

If you skipped pairs you want to retry at a lower threshold:

1. Note the skipped Viva codes from the review UI
2. Mac on, server running
3. Re-run recursive matcher (it will pick up the skipped ones)
4. `./scripts/sync-to-gcs.sh`
5. Open review UI → click **Recarregar matches**

---

## Re-deploying the review UI (only if code changes)

```bash
./scripts/deploy-review-server.sh
```

Takes ~3 min. Prints the new URL (usually stays the same).

---

## Key files

| File | Purpose |
|------|---------|
| `dino-server/main.py` | FastAPI server: DINOv3 `/embed` + CLIP `/classify` |
| `dino-server/SETUP.md` | How to download the DINOv3 checkpoint |
| `scripts/cache-images-viva.spec.ts` | Playwright: scrape all Viva images |
| `scripts/cache-images-coelho.spec.ts` | Playwright: scrape all Coelho images |
| `scripts/dino-select-exteriors.py` | CLIP pool-first image selector |
| `scripts/recursive-matcher-v2.py` | DINOv3 recursive matching (10 rounds) |
| `scripts/sync-to-gcs.sh` | Push results from Mac to GCS |
| `scripts/review-server.js` | Cloud Run review UI server |
| `scripts/deploy-review-server.sh` | Build + deploy to Cloud Run |
| `data/auto-matches.json` | Latest matcher output |
| `data/embedding-cache-v3.pkl` | DINOv3 embedding cache (speeds up re-runs) |
| `MATCHES.md` | Human-confirmed ground truth pairs |

---

## Troubleshooting

**Server won't start / checkpoint missing:**
```bash
# Re-download checkpoint (327MB)
python3.11 -c "
from huggingface_hub import hf_hub_download
hf_hub_download(
    repo_id='Shio-Koube/Dinov3-reupload',
    filename='dinov3_vitb16_pretrain_lvd1689m-73cec8be.pth',
    local_dir='dino-server/'
)
"
```

**Review UI shows empty / no matches:**
GCS hasn't been synced yet. Run `./scripts/sync-to-gcs.sh` on Mac first.

**Review UI shows old matches after re-run:**
Click the **Recarregar matches** button, or POST `/api/reload`.

**Playwright scraper times out:**
It won't — `test.setTimeout(0)` is set. If it crashes, just re-run. It skips cached listings.

**Embedding cache is stale after re-scraping images:**
Delete `data/embedding-cache-v3.pkl` and re-run the matcher. It will re-embed everything.
