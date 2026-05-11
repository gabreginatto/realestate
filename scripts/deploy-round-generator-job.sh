#!/bin/bash
# Build and deploy the Cloud Run Job that generates review rounds.

set -euo pipefail

PROJECT="${PROJECT:-realestate-475615}"
REGION="${REGION:-us-east1}"
JOB="${ROUND_GENERATOR_JOB:-match-round-generator}"
IMAGE="gcr.io/${PROJECT}/${JOB}"
GCS_BUCKET="${GCS_BUCKET:-realestate-475615-data}"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

log "Enabling Cloud Run + Cloud Build APIs ..."
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  --project="$PROJECT" --quiet

log "Building round generator image ..."
gcloud builds submit \
  --project="$PROJECT" \
  --ignore-file=.gcloudignore.round-generator \
  --config /dev/stdin <<EOF
steps:
- name: gcr.io/cloud-builders/docker
  args: ['build', '-f', 'Dockerfile.round-generator', '-t', '$IMAGE', '.']
images:
- '$IMAGE'
EOF

log "Deploying Cloud Run Job ${JOB} ..."
if gcloud run jobs describe "$JOB" --region="$REGION" --project="$PROJECT" >/dev/null 2>&1; then
  gcloud run jobs update "$JOB" \
    --image="$IMAGE" \
    --region="$REGION" \
    --project="$PROJECT" \
    --set-env-vars="GCS_BUCKET=${GCS_BUCKET}" \
    --memory=8Gi \
    --cpu=4 \
    --task-timeout=3600 \
    --max-retries=0 \
    --quiet
else
  gcloud run jobs create "$JOB" \
    --image="$IMAGE" \
    --region="$REGION" \
    --project="$PROJECT" \
    --set-env-vars="GCS_BUCKET=${GCS_BUCKET}" \
    --memory=8Gi \
    --cpu=4 \
    --task-timeout=3600 \
    --max-retries=0 \
    --quiet
fi

log "Round generator job ready: ${JOB}"
