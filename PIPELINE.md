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

## Local Mac operations console

Run the local control panel on the Mac that performs the heavy work:

```bash
npm run ops
```

Default URL:

```text
http://127.0.0.1:3030
```

For access from another device on the same home network, bind it to the LAN:

```bash
OPS_HOST=0.0.0.0 npm run ops
```

The console can start/stop the DINO/CLIP server, run the fresh compound scrape
and GCS sync, verify GCS assets, and run the Mac review-round worker. Keep it on
your trusted home network only because it launches local Mac commands.

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

## Step 0.5 — Fresh live listing inventory audit

Before replacing official listing JSON, run a read-only live scrape of listing
codes and URLs for each compound/site:

```bash
node scripts/audit-live-listing-counts.js --compound all --site both --max-pages 10
```

Outputs:
- `data/live-listing-count-audit.json`
- `data/<compound>/live-listing-inventory/vivaprimeimoveis.json`
- `data/<compound>/live-listing-inventory/coelhodafonseca.json`

This does not overwrite official listing JSON. It compares current live counts
against the local listing files and writes fresh code/URL inventories for review.
Coelho's current production search uses the newer query model:
`category`, `transaction`, `purpose`, `location=enterprise_name:<name>`, and
`propertyType`; do not use the old `enterprises`/`kind_of` URL as proof of live
inventory because production now treats it as a generic search.

To collect full detail-page listing JSON from those live inventories without
touching production listing files, run:

```bash
node scripts/scrape-live-listing-details.js --compound all --site both
node scripts/compare-fresh-listings.js
node scripts/download-fresh-listing-images.js --compound all --site both --concurrency 10
```

Outputs:
- `data/<compound>/fresh-listings/vivaprimeimoveis.json`
- `data/<compound>/fresh-listings/coelhodafonseca.json`
- `data/live-listing-detail-scrape-report.json`
- `data/fresh-listing-comparison.json`
- `data/fresh-image-download-report.json`
- `data/<compound>/fresh-images/<site>/<code>/01.jpg`

The detail scraper is intentionally source-scoped:
- Viva image URLs must come from `/vista.imobi/fotos/<propertyCode>/`.
- Coelho image URLs come from the property hero gallery, not recommendation
  sections further down the page.

To classify those fresh downloads and build reviewable fresh mosaics without
touching the production selected-image directories, keep the DINOv3+CLIP server
running and run:

```bash
python3 scripts/dino-select-exteriors.py \
  --source-type fresh-images \
  --source-root data \
  --compound alphaville-1 \
  --sites vivaprimeimoveis coelhodafonseca \
  --output-dir selected_for_matching_fresh

python3 scripts/dino-select-exteriors.py \
  --source-type fresh-images \
  --source-root data \
  --compound tambore-xi \
  --sites vivaprimeimoveis coelhodafonseca \
  --output-dir selected_for_matching_fresh

node scripts/make-fresh-mosaics.js both --compound alphaville-1 --force --clean-extra
node scripts/make-fresh-mosaics.js both --compound tambore-xi --force --clean-extra
```

Outputs:
- `selected_for_matching_fresh/<site>/<code>/_manifest.json`
- `data/<compound>/fresh-mosaics/viva/<code>.png`
- `data/<compound>/fresh-mosaics/viva/<code>_full.png`
- `data/<compound>/fresh-mosaics/coelho/<code>.png`
- `data/<compound>/fresh-mosaics/coelho/<code>_full.png`

`selected_for_matching_fresh` is intentionally separate from
`selected_for_matching`, so this audit path can be compared before promoting any
fresh scrape into the active review pipeline.

## Step 0.6 — All-compound fresh scrape and GCS sync

For the current Mac-heavy / GCS-storage workflow, use the orchestrator instead
of running each fresh audit command manually:

```bash
./scripts/scrape-all-compounds-to-gcs.sh
```

It discovers the active compounds, audits both listing sites, scrapes current
detail pages, downloads fresh galleries, runs the local DINO/CLIP selection,
builds fresh mosaics, uploads compound-scoped assets to GCS, and verifies the
result. The assets are stored under:

```text
gs://realestate-475615-data/compounds/<compound>/
```

Important subfolders:
- `live-listing-inventory/`
- `fresh-listings/`
- `fresh-images/`
- `selected-for-matching-fresh/`
- `fresh-mosaics/`

To verify the stored assets after any run:

```bash
node scripts/verify-compound-fresh-assets.js \
  --compound all \
  --bucket realestate-475615-data \
  --require-gcs \
  --require-selected \
  --require-mosaics
```

This verifier checks every live fresh listing, every downloaded gallery image,
the selected matching assets, and both standard and expanded mosaics in GCS.

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

For another compound, set `COMPOUND=<slug>` so the scraper uses that compound's
official listing JSON as the gallery source, for example:

```bash
COMPOUND=tambore-xi npx playwright test \
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
  --source-root data/ \
  --dino-url http://localhost:8000 \
  --official-listings data/alphaville-1/listings/vivaprimeimoveis_listings.json \
  --official-listings data/alphaville-1/listings/coelhodafonseca_listings.json
```

Output: `selected_for_matching/{site}/{code}/` + `_manifest.json`

The `--official-listings` guard is important: it prevents page-level or
related-listing images from polluted cache directories being classified into a
property's manifest.

For compounds that store images under `data/<compound>/<site>/images/{code}/`,
use `compound-images` mode and restrict selection to the current official
listing JSON:

```bash
python3 scripts/dino-select-exteriors.py \
  --source-type compound-images \
  --source-root data \
  --compound tambore-xi \
  --sites vivaprimeimoveis coelhodafonseca \
  --official-listings data/tambore-xi/vivaprimeimoveis/listings/all-listings.json \
  --official-listings data/tambore-xi/coelhodafonseca/listings/all-listings.json \
  --only-listed \
  --clean-extra-output
```

`--clean-extra-output` only removes generated output directories that also exist
in the current compound image source but are absent from that compound's listing
JSON. It must not be used without `--official-listings`.

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
node scripts/make-clip-mosaics.js both --force --compound alphaville-1 --only-listed --clean-extra
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

### Lane order (work top to bottom)

The reviewer ships precision first, recall second:

1. **Alta confiança** (`auto-review-high`) — MegaLoc + strong geometry. Most matches here are correct; confirm fast.
2. **Normal** (`review-normal`) — MegaLoc without strong geometry. Slower; expect mixed quality.
3. **Recall** (`review-recall`) — patch-VLAD candidates without MegaLoc. Lower yield, kept to recover near-misses.
4. **Auditoria** (`reject-low`) — kept for audit only; not part of the normal flow. Open it explicitly when you want to spot-check what the system rejected.

Switch lanes with the header tabs. Each lane has its own progress bar and pending count. Finishing one lane does **not** auto-advance you to the next.

### Visual surface (default)

The first-screen view is the generated **standard mosaic** for each property — `mosaics/viva/{code}.png` and `mosaics/coelho/{code}.png`. If the mosaic PNG isn't in GCS yet, the UI falls back to the CLIP-selected outdoor image grid.

Click either mosaic to open the **side-by-side comparison modal**. The modal opens in **Outdoor expandido** mode by default, which prefers the expanded mosaic (`{code}_full.png`) and falls back to up to 32 outdoor photos.

Modal modes:
- **Padrão** — standard outdoor mosaic.
- **Outdoor expandido** *(default)* — expanded outdoor mosaic; the right tool for confirming pool/facade/garden.
- **Todas as fotos** — fallback that intentionally includes interiors. Use when the outdoor evidence is ambiguous and you need interior context.

### Evidence panel

A compact strip above the action buttons surfaces what the matcher saw:
- Source chips (`MegaLoc`, `VLAD`, `patch-VLAD`) with per-source scores.
- Geometry: `score`, `inliers`, `ratio`, `support_pairs_8/12`.
- Top image-to-image evidence pairs (`Viva 04.jpg ↔ Coelho 02.jpg`).

Fields are hidden when not available, so legacy match files still render cleanly.

### Keyboard

- `→` or `M` — Match
- `←` or `S` — Não match (skip)
- `U` — Incerto (revisit later)
- `D` — Finalizar
- `Esc` — fecha o modal de comparação

Session is saved to GCS after every action. Close and reopen anytime — it resumes, restoring per-lane progress.

When all lanes you care about are reviewed, click **Finalizar** → downloads `final-matches.json`.

---

## Step 6 — Re-matching skipped pairs (optional)

If you need another review pass, use the round runner. It filters out already
confirmed properties, progressively relaxes the thresholds for the remaining
ambiguous pairs, rebuilds matcher evidence, uploads the new match file, and can
reset the live session pointer.

Use `--refresh-cache` whenever selected images, manifests, caches, or mosaic
inputs changed. Otherwise stale embedding caches can keep deleted image names in
Pass 2 evidence.

```bash
curl -sS https://match-review-n3z7pwcwsa-ue.a.run.app/api/trial-summary \
  -o /private/tmp/live-trial-summary.json

./scripts/run-next-review-round.sh \
  --summary /private/tmp/live-trial-summary.json \
  --round 2 \
  --refresh-cache \
  --reset-session

curl -sS -X POST https://match-review-n3z7pwcwsa-ue.a.run.app/api/reload \
  -H 'Content-Type: application/json' \
  -d '{"source":"local-round-regeneration"}'
```

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
| `scripts/audit-live-listing-counts.js` | Read-only live listing inventory audit |
| `scripts/scrape-live-listing-details.js` | Detail-page fresh listing scraper |
| `scripts/compare-fresh-listings.js` | Fresh-vs-previous listing count comparison |
| `scripts/download-fresh-listing-images.js` | Fresh listing image downloader |
| `scripts/dino-select-exteriors.py` | CLIP pool-first image selector |
| `scripts/make-fresh-mosaics.js` | Fresh selected-image mosaic generator |
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
