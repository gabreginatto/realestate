#!/bin/bash
# gcp-run-matcher.sh
#
# Spin up the GCP DINOv3+CLIP VM, run the recursive matcher, spin down the VM.
# The VM is stopped via a trap so it is always shut down — even on failure.
#
# VM spec (create once, stop between runs):
#   gcloud compute instances create dino-embed-server \
#     --machine-type=n1-standard-4 \
#     --accelerator=type=nvidia-tesla-t4,count=1 \
#     --maintenance-policy=TERMINATE \
#     --image-family=pytorch-latest-gpu \
#     --image-project=deeplearning-platform-release \
#     --boot-disk-size=50GB \
#     --zone=us-central1-a
#
# First-time setup (deploy code + download models onto the VM):
#   ./scripts/gcp-run-matcher.sh --project PROJECT_ID --deploy --setup
#
# Subsequent runs (code + models already on VM):
#   ./scripts/gcp-run-matcher.sh --project PROJECT_ID

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── defaults ──────────────────────────────────────────────────────────────────
INSTANCE="dino-embed-server"
ZONE="us-east1-d"
PROJECT=""
PORT=8000
DATA_ROOT="${REPO_ROOT}/data"
OUTPUT="${REPO_ROOT}/data/auto-matches.json"
EMBED_CACHE="${REPO_ROOT}/data/embedding-cache-v3.pkl"
HEALTH_TIMEOUT=600   # seconds — first run slow (pip install + model download)
SSH_TIMEOUT=120
DEPLOY=false
SETUP=false
VERBOSE=false

REMOTE_DIR="/opt/dino-server"

# ── helpers ───────────────────────────────────────────────────────────────────
log() { echo "[$(date '+%H:%M:%S')] $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

usage() {
  cat <<EOF
Usage: $(basename "$0") --project PROJECT_ID [OPTIONS]

Required:
  --project PROJECT_ID      GCP project ID

Options:
  --instance NAME           VM instance name           (default: dino-embed-server)
  --zone ZONE               GCP zone                   (default: us-central1-a)
  --port PORT               Server port                (default: 8000)
  --data-root PATH          Local path to data/        (default: ./data)
  --output PATH             Output JSON path           (default: ./data/auto-matches.json)
  --embed-cache PATH        Local embedding cache pkl  (default: ./data/embedding-cache-v3.pkl)
  --deploy                  Upload dino-server/ code to the VM
                            (required on first run, or after code changes)
  --setup                   Clone DINOv3 repo + download checkpoint on the VM
                            (required on first run, safe to re-run)
  --health-timeout SECS     Max wait for /health       (default: 600)
  --verbose                 Enable debug logging in matcher
  -h, --help                Show this help
EOF
  exit 0
}

# ── parse args ────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)        PROJECT="$2";        shift 2 ;;
    --instance)       INSTANCE="$2";       shift 2 ;;
    --zone)           ZONE="$2";           shift 2 ;;
    --port)           PORT="$2";           shift 2 ;;
    --data-root)      DATA_ROOT="$2";      shift 2 ;;
    --output)         OUTPUT="$2";         shift 2 ;;
    --embed-cache)    EMBED_CACHE="$2";    shift 2 ;;
    --health-timeout) HEALTH_TIMEOUT="$2"; shift 2 ;;
    --deploy)         DEPLOY=true;         shift   ;;
    --setup)          SETUP=true;          shift   ;;
    --verbose)        VERBOSE=true;        shift   ;;
    -h|--help)        usage ;;
    *) die "Unknown argument: $1" ;;
  esac
done

[[ -z "$PROJECT" ]] && die "--project PROJECT_ID is required"

DINO_URL="http://PLACEHOLDER:${PORT}"

# ── cleanup trap (always stop VM) ─────────────────────────────────────────────
VM_STARTED=false

cleanup() {
  local exit_code=$?
  if $VM_STARTED; then
    log "Stopping VM ${INSTANCE} ..."
    if gcloud compute instances stop "$INSTANCE" \
        --zone="$ZONE" --project="$PROJECT" --quiet 2>/dev/null; then
      log "VM stopped."
    else
      log "WARNING: could not stop VM automatically — check GCP console!"
    fi
  fi
  exit $exit_code
}
trap cleanup EXIT INT TERM

# ── 1. Start VM ───────────────────────────────────────────────────────────────
log "Starting VM ${INSTANCE} (${ZONE}) ..."
gcloud compute instances start "$INSTANCE" \
  --zone="$ZONE" --project="$PROJECT"
VM_STARTED=true

# ── 2. Get external IP ────────────────────────────────────────────────────────
log "Fetching external IP ..."
EXTERNAL_IP=$(gcloud compute instances describe "$INSTANCE" \
  --zone="$ZONE" --project="$PROJECT" \
  --format='get(networkInterfaces[0].accessConfigs[0].natIP)')

[[ -z "$EXTERNAL_IP" ]] && die "No external IP found. Is the VM configured with an external IP?"

DINO_URL="http://${EXTERNAL_IP}:${PORT}"
log "VM IP: ${EXTERNAL_IP}  →  server URL: ${DINO_URL}"

# ── 3. Wait for SSH ───────────────────────────────────────────────────────────
log "Waiting for SSH (timeout: ${SSH_TIMEOUT}s) ..."
SSH_ELAPSED=0
until gcloud compute ssh "$INSTANCE" \
    --zone="$ZONE" --project="$PROJECT" \
    --command="echo ssh-ok" --quiet 2>/dev/null; do
  [[ $SSH_ELAPSED -ge $SSH_TIMEOUT ]] && die "SSH not available after ${SSH_TIMEOUT}s"
  sleep 5
  SSH_ELAPSED=$((SSH_ELAPSED + 5))
  printf "."
done
echo ""
log "SSH ready."

# ── 4. Deploy server code (--deploy) ──────────────────────────────────────────
if $DEPLOY; then
  log "Deploying dino-server/ to VM:${REMOTE_DIR} ..."

  gcloud compute ssh "$INSTANCE" \
    --zone="$ZONE" --project="$PROJECT" \
    --command="sudo mkdir -p /opt && sudo chown \"\$USER\" /opt"

  # Copy everything except the submodule directory (it's a gitlink, not real files)
  gcloud compute scp --recurse \
    "${REPO_ROOT}/dino-server/main.py" \
    "${REPO_ROOT}/dino-server/requirements.txt" \
    "${REPO_ROOT}/dino-server/start.sh" \
    "${INSTANCE}:${REMOTE_DIR}/" \
    --zone="$ZONE" --project="$PROJECT"

  log "Deploy complete."
fi

# ── 5. First-time model setup (--setup) ───────────────────────────────────────
if $SETUP; then
  log "Setting up DINOv3 repo and checkpoint on VM ..."

  gcloud compute ssh "$INSTANCE" \
    --zone="$ZONE" --project="$PROJECT" \
    --command="
      set -e
      mkdir -p '${REMOTE_DIR}'

      # Clone DINOv3 repo if not already present
      if [ ! -d '${REMOTE_DIR}/dinov3-repo/.git' ]; then
        echo 'Cloning facebookresearch/dinov3 ...'
        git clone https://github.com/facebookresearch/dinov3.git '${REMOTE_DIR}/dinov3-repo'
      else
        echo 'dinov3-repo already cloned — skipping.'
      fi

      # Download checkpoint if not already present (327MB)
      CKPT='${REMOTE_DIR}/dinov3_vitb16_pretrain_lvd1689m-73cec8be.pth'
      if [ ! -f \"\$CKPT\" ]; then
        echo 'Downloading DINOv3 checkpoint (~327MB) ...'
        pip install -q huggingface_hub
        python3 -c \"
from huggingface_hub import hf_hub_download
hf_hub_download(
    repo_id='Shio-Koube/Dinov3-reupload',
    filename='dinov3_vitb16_pretrain_lvd1689m-73cec8be.pth',
    local_dir='${REMOTE_DIR}/'
)
print('Checkpoint downloaded.')
\"
      else
        echo 'Checkpoint already present — skipping.'
      fi

      # Install Python deps
      echo 'Installing Python dependencies ...'
      pip install -q -r '${REMOTE_DIR}/requirements.txt'

      echo 'Setup complete.'
    "

  log "Model setup done."
fi

# ── 6. Start DINOv3+CLIP server on VM ────────────────────────────────────────
log "Starting DINOv3+CLIP server on VM ..."
gcloud compute ssh "$INSTANCE" \
  --zone="$ZONE" --project="$PROJECT" \
  --ssh-flag="-o ConnectTimeout=30" \
  --command="
    source ~/.bashrc 2>/dev/null || true
    export PATH=\"\$HOME/.local/bin:\$PATH\"

    pkill -f 'uvicorn main:app' 2>/dev/null && echo 'Killed previous server' || true

    [[ -d '${REMOTE_DIR}' ]] || {
      echo 'ERROR: ${REMOTE_DIR} not found. Run with --deploy --setup first.'
      exit 1
    }

    cd '${REMOTE_DIR}'
    nohup python3 -m uvicorn main:app --host 0.0.0.0 --port ${PORT} --workers 1 \
      > /tmp/dino-server.log 2>&1 &
    echo \"Server PID: \$!\"
    echo \$! > /tmp/dino-server.pid
    sleep 1
    echo 'Server launched.'
  "

# ── 7. Poll /health until ready ───────────────────────────────────────────────
log "Waiting for DINOv3+CLIP server to be healthy (timeout: ${HEALTH_TIMEOUT}s) ..."
log "(First run may take a few minutes while models load)"
HEALTH_ELAPSED=0
while ! curl -sf "${DINO_URL}/health" >/dev/null 2>&1; do
  if [[ $HEALTH_ELAPSED -ge $HEALTH_TIMEOUT ]]; then
    echo ""
    log "Server did not become healthy in ${HEALTH_TIMEOUT}s. Last 40 lines of server log:"
    gcloud compute ssh "$INSTANCE" \
      --zone="$ZONE" --project="$PROJECT" \
      --command="tail -40 /tmp/dino-server.log" || true
    die "Aborting — VM will be stopped by cleanup trap."
  fi
  sleep 5
  HEALTH_ELAPSED=$((HEALTH_ELAPSED + 5))
  printf "."
done
echo ""

HEALTH_JSON=$(curl -s "${DINO_URL}/health")
log "Server healthy: ${HEALTH_JSON}"

# ── 8. Upload local embedding cache to VM (skip re-embedding on warm runs) ───
if [[ -f "$EMBED_CACHE" ]]; then
  log "Uploading embedding cache to VM ..."
  gcloud compute scp \
    "$EMBED_CACHE" \
    "${INSTANCE}:/tmp/embedding-cache-v3.pkl" \
    --zone="$ZONE" --project="$PROJECT"
  REMOTE_CACHE="/tmp/embedding-cache-v3.pkl"
else
  log "No local embedding cache found — embeddings will be computed from scratch."
  REMOTE_CACHE="/tmp/embedding-cache-v3.pkl"
fi

# ── 9. Upload data/ to VM ─────────────────────────────────────────────────────
log "Uploading selected_for_matching/ and listings JSON to VM ..."
gcloud compute ssh "$INSTANCE" \
  --zone="$ZONE" --project="$PROJECT" \
  --command="mkdir -p /tmp/data/vivaprimeimoveis/listings /tmp/data/coelhodafonseca/listings"

gcloud compute scp --recurse \
  "${DATA_ROOT}/vivaprimeimoveis/listings/all-listings.json" \
  "${INSTANCE}:/tmp/data/vivaprimeimoveis/listings/" \
  --zone="$ZONE" --project="$PROJECT"

gcloud compute scp --recurse \
  "${DATA_ROOT}/coelhodafonseca/listings/all-listings.json" \
  "${INSTANCE}:/tmp/data/coelhodafonseca/listings/" \
  --zone="$ZONE" --project="$PROJECT"

if [[ -d "${DATA_ROOT}/../selected_for_matching" ]]; then
  gcloud compute scp --recurse \
    "${DATA_ROOT}/../selected_for_matching" \
    "${INSTANCE}:/tmp/" \
    --zone="$ZONE" --project="$PROJECT"
else
  log "No selected_for_matching/ found locally — matcher will use raw images on VM."
fi

# ── 10. Run recursive matcher on VM ───────────────────────────────────────────
log "Running recursive matcher on VM ..."

# Upload matcher script
gcloud compute scp \
  "${REPO_ROOT}/scripts/recursive-matcher-v2.py" \
  "${INSTANCE}:/tmp/recursive-matcher-v2.py" \
  --zone="$ZONE" --project="$PROJECT"

MATCHER_CMD="python3 /tmp/recursive-matcher-v2.py \
  --dino-url http://localhost:${PORT} \
  --data-root /tmp/data \
  --output /tmp/auto-matches.json \
  --cache ${REMOTE_CACHE}"
[[ "$VERBOSE" == "true" ]] && MATCHER_CMD="$MATCHER_CMD --verbose"

gcloud compute ssh "$INSTANCE" \
  --zone="$ZONE" --project="$PROJECT" \
  --command="$MATCHER_CMD"

# ── 11. Download results back ─────────────────────────────────────────────────
log "Downloading results ..."
gcloud compute scp \
  "${INSTANCE}:/tmp/auto-matches.json" \
  "$OUTPUT" \
  --zone="$ZONE" --project="$PROJECT"

# Download updated embedding cache (saves time on next run)
gcloud compute scp \
  "${INSTANCE}:${REMOTE_CACHE}" \
  "$EMBED_CACHE" \
  --zone="$ZONE" --project="$PROJECT" 2>/dev/null || true

echo ""
log "Done. Results → ${OUTPUT}"
log "Embedding cache → ${EMBED_CACHE}  (reused on next run)"

# cleanup trap fires here → VM stopped
