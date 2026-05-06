# Property Matching Pipeline — Operator Guide

This document tells you exactly how to run the full AI property matching pipeline.
Read it top to bottom before touching anything.

---

## What this system does

Matches luxury property listings between two real estate agencies:
- **Viva Prime Imóveis** (`vivaprimeimoveis`) — 70 listings
- **Coelho da Fonseca** (`coelhodafonseca`) — 81 listings

Pipeline: scrape images → CLIP classifies images (pool/facade/garden) →
DINOv3 embeds selected images → AnyLoc-style VLAD or late-interaction scoring +
Hungarian assignment finds best candidates → human reviews matches in browser.

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

### Mosaic selector decision — 2026-05-06

The review UI should show the small curated mosaic first, then open the larger
outdoor-only mosaic in the lightbox. The standard mosaic uses the CLIP-selected
`pool/facade/garden` images from `manifest.selected`; the expanded mosaic uses
all outdoor `pool/facade/garden` images from `manifest.all_categories`. Interior
photos are intentionally excluded from both surfaces because they slow down human
confirmation and make same-property evidence less obvious.

Local benchmark on the 21 confirmed pairs:

| Selector | R@1 | R@3 | R@5 | MRR | Interior leakage |
|----------|-----|-----|-----|-----|------------------|
| CLIP selected 8 | 0.50 | 0.55 | 0.65 | 0.558 | 0.0% |
| CLIP expanded outdoor 16 | 0.40 | 0.50 | 0.55 | 0.483 | 0.0% |
| Source first 8 | 0.40 | 0.45 | 0.50 | 0.457 | 50.1% |
| Source first 16 | 0.40 | 0.50 | 0.55 | 0.494 | 62.5% |
| Legacy heuristic 12 | 0.47 | 0.53 | 0.59 | 0.522 | 0.0% |

Model architecture sanity check on the same confirmed-pair listing set:

| Model | R@1 | R@3 | R@5 | MRR | Mean selected images |
|-------|-----|-----|-----|-----|----------------------|
| `openai/clip-vit-base-patch32` | 0.50 | 0.55 | 0.55 | 0.572 | 3.8 |
| `google/siglip-base-patch16-224` | 0.05 | 0.25 | 0.30 | 0.218 | 1.9 |

Decision: keep the current OpenAI CLIP selector for the first-screen mosaic.
Do not switch to SigLIP base for this task. The expanded outdoor mosaic is still
valuable for human confirmation, but it should not replace the curated first
screen because it ranked worse and adds more visual workload.

Reproduce:

```bash
node scripts/make-clip-mosaics.js both --force
python3 scripts/mosaic-selector-benchmark.py
python3 scripts/vlm-mosaic-model-benchmark.py \
  --models openai/clip-vit-base-patch32 google/siglip-base-patch16-224 \
  --max-images-per-listing 16
```

Outputs:
- `data/mosaic-selector-benchmark.json`
- `data/vlm-mosaic-model-benchmark.json`

Limitations: the benchmark uses perceptual-hash similarity as a proxy for
visual evidence and the current CLIP labels as a weak leakage oracle. The SigLIP
test covered base SigLIP, not every newer SigLIP2/DFN/EVA variant. A stronger
future test would add a small human-labeled image-level set for pool/facade/
garden/interior and then rerun candidate selection.

---

## Step 3 — DINOv3 recursive matching

Runs 10 internal optimization rounds. Uses the `selected_for_matching/` images.
Caches embeddings to disk so re-runs are fast (only re-embeds new/changed listings).

The recommended mode is now `--matrix-mode vlad`. It builds an AnyLoc-inspired
VLAD descriptor over the selected per-image DINOv3 vectors. This captures the
distribution of pool/facade/garden photos for each listing better than a single
mean vector and is designed for the exact hard case where two brokers photograph
the same house with different angles, colors, and staging.

`--matrix-mode late` is still available. It compares every selected Viva image
against every selected Coelho image and keeps the strongest cross-photo evidence.

If `data/embedding-cache-v3.pkl` was created before this change, run once with
`--refresh-cache` while the DINO server is running. Without that refresh, the
script automatically falls back to the old mean-vector scoring for compatibility.

```bash
python scripts/recursive-matcher-v2.py \
  --dino-url http://localhost:8000 \
  --data-root data/ \
  --output data/auto-matches.json \
  --cache data/embedding-cache-v3.pkl \
  --matrix-mode vlad \
  --refresh-cache
```

Output: `data/auto-matches.json`

Normal re-runs after the refreshed cache exists do not need `--refresh-cache`:

```bash
python scripts/recursive-matcher-v2.py \
  --dino-url http://localhost:8000 \
  --data-root data/ \
  --output data/auto-matches.json \
  --cache data/embedding-cache-v3.pkl \
  --matrix-mode vlad
```

Previous mean-vector results for reference:
- DINOv3-vitb16: 62/62 Viva matched, min_sim=0.87, mean_sim=0.93
- precision=0.19, recall=0.80 against 15 human-confirmed ground truth pairs

Refreshed late-interaction benchmark on the same 15 confirmed pairs:
- best internal strategy: precision=0.58, recall=0.47, F1=0.52
- review queue: 25 ranked pairs, precision=0.32, recall=0.53
- high tier: 16 pairs, precision=0.50, recall=0.53

VLAD benchmark on the same refreshed per-image cache:
- best internal strategy: precision=0.67, recall=0.53, F1=0.59
- review queue: 12 ranked pairs, precision=0.67, recall=0.53
- high tier: 9 pairs, precision=0.89, recall=0.53

The VLAD mode gives the best measured precision/F1 so far. Use
`--matrix-mode mean` when you want the broader legacy queue, and
`--matrix-mode late` as an alternate high-precision image-set scorer.

MegaLoc experiment:

```bash
python scripts/megaloc-matcher.py \
  --data-root data \
  --cache data/embedding-cache-megaloc.pkl \
  --output data/auto-matches-megaloc.json
```

MegaLoc runs locally on the Mac via PyTorch Hub. In the May 4, 2026 run it used
MPS and cached descriptors in `data/embedding-cache-megaloc.pkl`.

Measured result after the 2026-05-06 ground-truth expansion to 21 confirmed
pairs:
- MegaLoc set-similarity: precision=0.79, recall=0.71, F1=0.75
- DINOv3+VLAD: precision=0.75, recall=0.43, F1=0.55

Recommendation: MegaLoc is now the best standalone matcher on the corrected
benchmark. Keep VLAD as a high-precision signal, but do not treat it as the
default best model until the benchmark changes again.

VLAD + MegaLoc consensus experiment:

```bash
python3 scripts/ensemble-matcher.py \
  --vlad data/auto-matches-vlad.json \
  --megaloc data/auto-matches-megaloc.json \
  --output data/auto-matches-ensemble.json
```

This is a conservative intersection of the two matchers. It is meant to
increase precision, not recall.

Measured result after the 2026-05-06 ground-truth expansion:
- consensus tier: precision=0.89, recall=0.38, F1=0.53
- union of VLAD + MegaLoc: precision=0.73, recall=0.76, F1=0.74

Recommendation: use the consensus tier as the strictest high-confidence lane.
For broader recall, the VLAD + MegaLoc union is now competitive with MegaLoc.

Patch-token VLAD experiment:

```bash
python3 scripts/patch-vlad-matcher.py \
  --data-root data \
  --cache data/embedding-cache-patch-vlad.pkl \
  --output data/auto-matches-patch-vlad.json \
  --clusters 32 \
  --max-train-tokens 40000
```

This is closer to AnyLoc than the production VLAD mode: it extracts DINOv3
patch tokens from each selected image, trains a small VLAD vocabulary, encodes
each image, then compares listing image sets.

Measured result after the 2026-05-06 ground-truth expansion:
- 32 clusters: precision=0.65, recall=0.81, F1=0.72
- 64 clusters: precision=0.50, recall=0.53, F1=0.52

Recommendation: patch-token VLAD is useful as a recall-expansion signal, but it
is still noisier than MegaLoc. Do not use it alone for a high-confidence queue.

Geometric reranker experiment:

```bash
python3 scripts/geometric-reranker.py \
  --inputs data/auto-matches-vlad.json \
           data/auto-matches-megaloc.json \
           data/auto-matches-patch-vlad.json \
  --output data/auto-matches-geometric-rerank.json
```

This reranks the union of retrieval candidates using local ORB feature matching
and RANSAC homography across the selected images.

Measured result after the 2026-05-06 ground-truth expansion:
- geometric rerank output: precision=0.87, recall=0.62, F1=0.72
- selected 15 pairs from 29 retrieval candidates
- true positives=13, false positives=2

Recommendation: geometric reranking is now useful as a high-precision verifier
over the broad retrieval union. It still misses some true matches, so use it as
a prioritized review queue rather than as the only output.

Ground-truth expansion review:

```bash
python3 scripts/geometric-groundtruth-review.py \
  --geometric data/auto-matches-geometric-rerank.json \
  --data-root data \
  --output data/geometric-groundtruth-review.json
```

This creates:
- `data/geometric-groundtruth-review.json`
- `data/geometric-groundtruth-review.md`

The review file contains high-geometric-evidence pairs that are not in the
active `CONFIRMED_PAIRS` benchmark and not in the local rejected-pair list.
Review these manually before adding any of them to ground truth.

2026-05-06 review outcome:
- confirmed: `7597↔358601`, `18035↔661014`, `14138↔660058`,
  `16117↔628299`, `17378↔425516`, `12814↔682781`
- rejected/excluded: `6930↔395513` because the Coelho page is blank / code not found

Duplicate-aware evaluation:

```bash
python3 scripts/duplicate-aware-evaluator.py \
  data/auto-matches-vlad.json \
  data/auto-matches-megaloc.json \
  data/auto-matches-patch-vlad.json \
  data/auto-matches-geometric-rerank.json
```

This evaluates exact pairs and property-entity components built from the
confirmed graph. It also excludes locally rejected/dead-code pairs such as
`6930↔395513` from benchmark scoring.

Tiered matcher experiment:

```bash
python3 scripts/tiered-matcher.py \
  --geometric data/auto-matches-geometric-rerank.json \
  --output data/auto-matches-tiered.json
```

The tiered policy uses the broad retrieval candidate pool, then assigns:
- `auto-review-high`: MegaLoc candidate with geometric score >= 0.76 and at least 20 RANSAC inliers
- `review-normal`: MegaLoc candidate without strong geometry
- `review-recall`: patch-VLAD candidate without MegaLoc
- `reject-low`: weak geometry + weak model agreement, kept for audit but not review

Measured result:
- `auto-review-high`: 13 pairs, precision=1.00, recall=0.62, F1=0.76
- `auto-review-high` + `review-normal`: 18 pairs, precision=0.83, recall=0.71, F1=0.77
- review output through `review-recall`: 25 pairs, precision=0.68, recall=0.81, F1=0.74
- review output entity recall: 17/20 property components, 85%
- `reject-low`: 3 pairs, kept out of the review queue

Recommendation: use `review_matches` from the tiered output for the review UI.
Review `auto-review-high` first as the cleanest queue, then `review-normal`,
then `review-recall` only when chasing coverage. Keep `reject-low` visible only
for audit/debugging, not normal review.

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
| `scripts/ensemble-matcher.py` | Conservative VLAD + MegaLoc consensus |
| `scripts/patch-vlad-matcher.py` | Experimental DINOv3 patch-token VLAD matcher |
| `scripts/geometric-reranker.py` | Experimental ORB + RANSAC candidate verifier |
| `scripts/geometric-groundtruth-review.py` | Builds high-evidence review files for ground-truth expansion |
| `scripts/duplicate-aware-evaluator.py` | Pair and entity-level benchmark evaluator |
| `scripts/tiered-matcher.py` | Tiered MegaLoc / patch-VLAD / geometry review queue |
| `scripts/sync-to-gcs.sh` | Push results from Mac to GCS |
| `scripts/review-server.js` | Cloud Run review UI server |
| `scripts/deploy-review-server.sh` | Build + deploy to Cloud Run |
| `data/auto-matches.json` | Latest matcher output |
| `data/auto-matches-ensemble.json` | VLAD + MegaLoc consensus output |
| `data/auto-matches-patch-vlad.json` | Experimental patch-token VLAD output |
| `data/auto-matches-geometric-rerank.json` | Experimental geometric reranker output |
| `data/geometric-groundtruth-review.json` | High-geometric-evidence pairs for manual ground-truth review |
| `data/auto-matches-tiered.json` | Recommended tiered review queue experiment |
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

**Embedding cache is stale after re-scraping images or mean-only after this upgrade:**
Run the matcher with `--refresh-cache`, or delete `data/embedding-cache-v3.pkl`
and re-run it. It will re-embed everything.
