#!/bin/bash
# deploy-review-server.sh
#
# Build and deploy the review server to Cloud Run.
# Run from repo root:
#   ./scripts/deploy-review-server.sh
#
# First deploy takes ~3 minutes. Subsequent deploys: ~1 minute.
# After deploy, prints the permanent HTTPS URL.

set -euo pipefail

PROJECT="realestate-475615"
REGION="us-east1"
SERVICE="match-review"
IMAGE="gcr.io/${PROJECT}/${SERVICE}"
GCS_BUCKET="realestate-475615-data"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

# ── Enable required APIs (idempotent) ────────────────────────────────────────
log "Enabling Cloud Run + Artifact Registry APIs ..."
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  --project="$PROJECT" --quiet

# ── Build image with Cloud Build (no local Docker needed) ────────────────────
log "Building container image with Cloud Build ..."
gcloud builds submit \
  --tag "$IMAGE" \
  --project="$PROJECT" \
  --quiet

# ── Deploy to Cloud Run ───────────────────────────────────────────────────────
log "Deploying to Cloud Run (${REGION}) ..."
gcloud run deploy "$SERVICE" \
  --image="$IMAGE" \
  --region="$REGION" \
  --project="$PROJECT" \
  --platform=managed \
  --allow-unauthenticated \
  --set-env-vars="GCS_BUCKET=${GCS_BUCKET}" \
  --memory=512Mi \
  --cpu=1 \
  --min-instances=0 \
  --max-instances=2 \
  --timeout=60 \
  --quiet

# ── Print URL ─────────────────────────────────────────────────────────────────
URL=$(gcloud run services describe "$SERVICE" \
  --region="$REGION" --project="$PROJECT" \
  --format='value(status.url)')

log "Deploy complete!"
echo ""
echo "  Review UI → ${URL}"
echo ""
echo "  Mac workflow:"
echo "    1. python scripts/recursive-matcher-v2.py ..."
echo "    2. ./scripts/sync-to-gcs.sh"
echo "    3. Open ${URL} — click 'Recarregar matches' if session was in progress"
