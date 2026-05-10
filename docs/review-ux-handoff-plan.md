# Review UX Handoff Plan

Date: 2026-05-06

## Objective

Redesign the human review interface around the tiered matcher and the improved
outdoor mosaic policy. The reviewer should be able to confirm obvious matches
from the standard mosaic, expand into a side-by-side outdoor mosaic comparison
when needed, and move through match tiers in the order that maximizes precision
first and recall second.

## Current State Reviewed

Evidence inspected:
- `scripts/review-server.js`
- `PIPELINE.md`
- `data/auto-matches-tiered.json`
- Local server startup with `node scripts/review-server.js`
- Local `curl http://localhost:3001/`
- Local `curl http://localhost:3001/api/session`

Local server caveat: in this environment the server starts only with escalated
local networking permission and cannot load the live GCS JSON correctly. The
API returned an empty session locally, so this review is based on the served HTML,
the source code, and the tiered data artifact rather than a live populated review
session screenshot.

## Current UX Assessment

What already matches the recommendation:
- `/api/images/:site/:code?mode=standard` returns CLIP-selected outdoor images,
  max 8.
- `/api/images/:site/:code?mode=expanded` returns expanded outdoor images,
  max 32.
- The main review screen opens standard images first.
- The lightbox uses expanded outdoor images instead of dumping all listing photos.

Gaps against the recommendation:
- The UI does not display the generated mosaic assets (`{code}.png` and
  `{code}_full.png`). It renders six individual images in a 3x2 grid, so it does
  not show the intended 4x2 standard mosaic.
- The expanded view opens one property at a time. A reviewer needs side-by-side
  expanded Viva and Coelho mosaics to confirm the same exterior/pool/facade
  evidence quickly.
- Tier names from `data/auto-matches-tiered.json` are not normalized. Values like
  `auto-review-high`, `review-normal`, and `review-recall` fall through the
  current `high/medium/low` UI logic and are treated visually like low confidence.
- The review queue does not expose lane navigation. The reviewer cannot review
  `auto-review-high`, then `review-normal`, then `review-recall` as separate
  operational phases.
- `reject-low` is present in the tiered artifact for audit, but the UI loader does
  not explicitly filter it out if that artifact is synced as `auto-matches.json`.
- The UI hides the model evidence that should explain why a pair is in a tier:
  MegaLoc/VLAD/patch-VLAD source agreement, geometric score, RANSAC inliers,
  and top image-pair evidence.
- The current main layout is two generic cards plus a footer. It does not put the
  decision mechanics close to the visual evidence.
- Mobile falls back to vertical cards, but there is no special mobile decision
  layout for comparing mosaics efficiently.
- The operator guide still says "Click image area -> lightbox with all images",
  while the current code now opens expanded outdoor images.

## Target UX

The product should behave like a compact verification console:

1. Queue header:
   - Show lane tabs: `High`, `Normal`, `Recall`, `Audit`.
   - Default to `High`.
   - Hide `Audit/reject-low` from normal flow behind an explicit audit toggle.
   - Show count, completed count, and expected precision/recall copy per lane.

2. Main evidence area:
   - Show Viva and Coelho side by side.
   - Use the generated standard mosaic image as the primary visual surface:
     `mosaics/viva/{code}.png` and `mosaics/coelho/{code}.png`.
   - Preserve a fallback to `/api/images/...mode=standard` when mosaic PNGs are
     unavailable.
   - Keep property code, price, area, beds, and source links visible above each
     mosaic.

3. Expanded comparison:
   - Clicking either standard mosaic opens a two-column comparison modal.
   - Left column: Viva expanded mosaic or expanded outdoor image grid.
   - Right column: Coelho expanded mosaic or expanded outdoor image grid.
   - Include tabs/toggles: `Standard`, `Expanded outdoor`, `All photos`.
   - Default modal mode: `Expanded outdoor`.
   - `All photos` should be a fallback, not the default.

4. Evidence panel:
   - Show tier label with normalized labels:
     `auto-review-high -> High confidence`, `review-normal -> Normal review`,
     `review-recall -> Recall candidate`, `reject-low -> Audit only`.
   - Show source agreement chips: `MegaLoc`, `VLAD`, `patch-VLAD`.
   - Show geometric evidence: score, best inliers, inlier ratio, support pairs.
   - Show top image-pair evidence if available, e.g. `Viva 04.jpg <-> Coelho 02.jpg`.

5. Decision actions:
   - Put `Match` and `Not match` adjacent to the evidence panel.
   - Keep keyboard shortcuts.
   - Add `Unsure` as a separate state if we want a later revisit queue.
   - After each action, advance within the current lane.

6. Review mechanics:
   - Persist per-pair status, lane, reviewer timestamp, and optional note.
   - Completion modal should summarize by lane:
     confirmed, rejected, unsure, skipped.
   - Reload should preserve lane progress.

## Handoff Prompts

### Prompt 1: Normalize tiered match data for the review UI

```text
You are working in /Users/gabrielreginatto/Desktop/Code/RealEstate.

Implement the data plumbing for the review UI in scripts/review-server.js.

Requirements:
1. Load tiered matcher outputs robustly from matches/auto-matches.json.
2. Support both legacy match files and the current tiered structure from data/auto-matches-tiered.json.
3. Exclude matches where include_in_review is false.
4. Exclude tier === "reject-low" from the default review queue, but keep those pairs available through a new audit-only API route.
5. Preserve evidence fields on each pair:
   - tier
   - confidence / confidence_score / similarity_score
   - sources
   - source_scores
   - geometric_score
   - best_inliers
   - best_inlier_ratio
   - support_pairs_8
   - support_pairs_12
   - top_image_pairs
6. Add a normalizeTier(match) helper that maps:
   - auto-review-high -> { lane: "high", label: "High confidence" }
   - review-normal -> { lane: "normal", label: "Normal review" }
   - review-recall -> { lane: "recall", label: "Recall candidate" }
   - reject-low -> { lane: "audit", label: "Audit only" }
   - legacy high/medium/low values into the closest lane.
7. Update /api/session so pairData includes lane, tier_label, evidence fields, and lane counts.
8. Add /api/session?lane=high|normal|recall|audit so the UI can review one lane at a time.

Acceptance checks:
- node --check scripts/review-server.js passes.
- A small local unit-style script or fixture proves normalizeTier handles all four tiered values and legacy high/medium/low values.
- No unrelated files are changed.
```

### Prompt 2: Display generated standard mosaics as the primary review surface

```text
You are working in /Users/gabrielreginatto/Desktop/Code/RealEstate.

Update the review UI in scripts/review-server.js so the first-screen visual
surface is the generated standard mosaic, not a six-image ad hoc grid.

Requirements:
1. Add a mosaicUrl(site, code, mode) helper:
   - standard: {GCS_BASE}/mosaics/{site}/{code}.png
   - expanded: {GCS_BASE}/mosaics/{site}/{code}_full.png
   Use site names "viva" and "coelho" consistently with the generated local paths.
2. Add /api/mosaic/:site/:code?mode=standard|expanded that returns:
   - { available: true, url } when the GCS object exists
   - { available: false } otherwise
3. Update renderImage() to try the standard mosaic first.
4. If the standard mosaic is unavailable, fall back to /api/images/:site/:code?mode=standard.
5. Change the card image CSS for mosaics:
   - stable 2:1 aspect ratio for standard mosaic
   - object-fit: cover or contain based on actual generated dimensions
   - no layout shift while loading
6. Keep the click target opening expanded comparison.

Acceptance checks:
- node --check scripts/review-server.js passes.
- With a mocked /api/mosaic response, the DOM renders one mosaic image per property.
- With unavailable mosaic response, the existing image-grid fallback still works.
```

### Prompt 3: Build side-by-side expanded mosaic comparison modal

```text
You are working in /Users/gabrielreginatto/Desktop/Code/RealEstate.

Replace the current one-property lightbox with a comparison modal that shows
Viva and Coelho together.

Requirements:
1. Rename openLightbox(site) to openComparison().
2. Clicking either property visual opens the same comparison modal.
3. Modal layout:
   - header: "Compare expanded mosaics"
   - left: Viva code + expanded mosaic/images
   - right: Coelho code + expanded mosaic/images
   - close button and Escape support
4. Add mode segmented control:
   - Standard
   - Expanded outdoor
   - All photos
5. Default mode must be Expanded outdoor.
6. Expanded outdoor should prefer generated `{code}_full.png`, then fall back to
   /api/images/:site/:code?mode=expanded.
7. All photos should call a separate endpoint or query mode that intentionally
   includes interiors; it must not change the default standard/expanded outdoor
   behavior.
8. The modal must fit desktop and mobile:
   - desktop: two columns
   - mobile: stacked sections with sticky mode control

Acceptance checks:
- node --check scripts/review-server.js passes.
- Browser/manual check: clicking either mosaic opens both properties in the modal.
- Browser/manual check: Expanded outdoor is the default mode.
- Browser/manual check: Escape closes the modal.
```

### Prompt 4: Add lane navigation and queue progress

```text
You are working in /Users/gabrielreginatto/Desktop/Code/RealEstate.

Add tier lane navigation to the review UI.

Requirements:
1. Add lane tabs in the header:
   - High
   - Normal
   - Recall
   - Audit
2. Default lane: High.
3. Audit lane must be visually separated and not part of normal keyboard flow
   unless the user explicitly selects it.
4. Each lane tab shows remaining / total.
5. Confirm, Not match, and Unsure advance within the selected lane only.
6. The progress bar should represent the selected lane, not the whole session.
7. Add a global summary chip with total confirmed across all lanes.
8. Update the completion modal to summarize decisions by lane.

Acceptance checks:
- node --check scripts/review-server.js passes.
- Session API returns lane counts.
- Manual/browser check: switching lanes changes the current pair.
- Manual/browser check: completing the High lane does not auto-start Audit.
```

### Prompt 5: Surface model and geometry evidence near the decision

```text
You are working in /Users/gabrielreginatto/Desktop/Code/RealEstate.

Add a compact evidence panel to the review UI so the reviewer understands why a
pair is being shown.

Requirements:
1. Show normalized tier label and raw score.
2. Show source chips for sources[]:
   - MegaLoc
   - VLAD
   - patch-VLAD
3. Show source_scores in a compact table or chip row.
4. Show geometric_score, best_inliers, best_inlier_ratio, support_pairs_8,
   support_pairs_12 when available.
5. Show top_image_pairs as "Viva image <-> Coelho image" rows.
6. Keep this panel compact; it should not push the mosaics below the fold on a
   normal laptop viewport.
7. Hide unavailable fields cleanly.

Acceptance checks:
- node --check scripts/review-server.js passes.
- Manual/browser check: a tiered sample pair shows MegaLoc/VLAD/geometry evidence.
- Manual/browser check: a legacy pair without evidence still renders cleanly.
```

### Prompt 6: Clean up interaction labels, accessibility, and operator docs

```text
You are working in /Users/gabrielreginatto/Desktop/Code/RealEstate.

Polish the review UI and operator guide after the lane/mosaic changes.

Requirements:
1. Replace emoji-dependent button labels with plain labels plus accessible names:
   - Match
   - Not match
   - Unsure
   - Done
2. Add aria-labels to icon-only or compact controls.
3. Use buttons for actions and links only for external property pages.
4. Ensure focus states are visible.
5. Update PIPELINE.md Step 5:
   - explain lane order
   - explain standard mosaic vs expanded outdoor comparison
   - explain all-photos fallback
   - update keyboard shortcuts
6. Keep Portuguese/English text consistent. Prefer Portuguese for reviewer-facing
   text if the rest of the UI remains Portuguese.

Acceptance checks:
- node --check scripts/review-server.js passes.
- Manual/browser check on desktop width.
- Manual/browser check on mobile width.
- PIPELINE.md no longer says the lightbox opens "all images" by default.
```

## Suggested Implementation Order

1. Prompt 1: data plumbing and tier normalization.
2. Prompt 2: primary standard mosaic display.
3. Prompt 3: expanded side-by-side comparison modal.
4. Prompt 4: lane navigation and progress.
5. Prompt 5: model evidence panel.
6. Prompt 6: accessibility, labels, and docs.

This order avoids redesigning the screen before the UI has the correct data
contract. The most important product gain comes from prompts 1-3.

## Verification Checklist For The Implementing AI

- `node --check scripts/review-server.js`
- Start local server with `node scripts/review-server.js`
- Open local UI at `http://localhost:3001`
- Confirm standard mosaics are shown by default
- Confirm expanded comparison opens both properties together
- Confirm lane tabs show high/normal/recall/audit counts
- Confirm `reject-low` is not in default review flow
- Confirm tier labels render correctly for `auto-review-high`, `review-normal`,
  `review-recall`, and `reject-low`
- Confirm legacy high/medium/low data still renders
- Confirm mobile layout does not require horizontal scrolling
- Confirm `PIPELINE.md` matches the implemented workflow
