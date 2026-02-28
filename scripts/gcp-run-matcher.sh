#!/bin/bash
# gcp-run-matcher.sh
#
# Spin up the GCP DINOv2 VM, run the auto-matcher, spin down the VM.
# The VM is stopped via a trap, so it is always shut down — even on failure.
#
# First-time setup on a new VM:
#   ./scripts/gcp-run-matcher.sh --project PROJECT_ID --deploy [--compound tambore-11]
#
# Subsequent runs (code already on VM):
#   ./scripts/gcp-run-matcher.sh --project PROJECT_ID [--compound tambore-11]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── defaults ──────────────────────────────────────────────────────────────────
INSTANCE="dino-embed-server"
ZONE="us-central1-a"
PROJECT=""
PORT=8000
THRESHOLD=0.85
DATA_ROOT="${REPO_ROOT}/data"
OUTPUT="${REPO_ROOT}/data/auto-matches.json"
COMPOUND=""
HEALTH_TIMEOUT=360   # seconds — first run is slow (pip install + model download)
SSH_TIMEOUT=120      # seconds to wait for SSH after VM start
DEPLOY=false
DRY_RUN=false
VERBOSE=false

REMOTE_SERVER_DIR="/opt/dino-server"

# ── helpers ───────────────────────────────────────────────────────────────────
log() { echo "[$(date '+%H:%M:%S')] $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

usage() {
  cat <<EOF
Usage: $(basename "$0") --project PROJECT_ID [OPTIONS]

Required:
  --project PROJECT_ID      GCP project ID

Options:
  --instance NAME           VM instance name          (default: dino-embed-server)
  --zone ZONE               GCP zone                  (default: us-central1-a)
  --port PORT               DINOv2 server port        (default: 8000)
  --compound NAME           Compound name for mosaic path resolution
  --threshold FLOAT         Cosine similarity cutoff  (default: 0.85)
  --data-root PATH          Local path to data/       (default: ./data)
  --output PATH             Output JSON path          (default: ./data/auto-matches.json)
  --deploy                  Upload dino-server/ code to the VM before running
                            (required on first run after VM creation)
  --health-timeout SECS     Max wait for /health      (default: 360)
  --dry-run                 Use random embeddings — no actual GPU calls
  --verbose                 Enable debug logging in auto-matcher
  -h, --help                Show this help
EOF
  exit 0
}

# ── parse args ────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)         PROJECT="$2";         shift 2 ;;
    --instance)        INSTANCE="$2";        shift 2 ;;
    --zone)            ZONE="$2";            shift 2 ;;
    --port)            PORT="$2";            shift 2 ;;
    --compound)        COMPOUND="$2";        shift 2 ;;
    --threshold)       THRESHOLD="$2";       shift 2 ;;
    --data-root)       DATA_ROOT="$2";       shift 2 ;;
    --output)          OUTPUT="$2";          shift 2 ;;
    --health-timeout)  HEALTH_TIMEOUT="$2";  shift 2 ;;
    --deploy)          DEPLOY=true;          shift   ;;
    --dry-run)         DRY_RUN=true;         shift   ;;
    --verbose)         VERBOSE=true;         shift   ;;
    -h|--help)         usage ;;
    *) die "Unknown argument: $1" ;;
  esac
done

[[ -z "$PROJECT" ]] && die "--project PROJECT_ID is required"

DINO_URL="http://PLACEHOLDER:${PORT}"   # filled in after VM starts

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

# ── 4. Deploy server code (--deploy flag, required on first run) ───────────────
if $DEPLOY; then
  log "Deploying dino-server/ to VM:${REMOTE_SERVER_DIR} ..."

  # Ensure the target parent directory exists and is writable by the current user
  gcloud compute ssh "$INSTANCE" \
    --zone="$ZONE" --project="$PROJECT" \
    --command="sudo mkdir -p /opt && sudo chown \"\$USER\" /opt"

  # Copy dino-server/ directory → creates /opt/dino-server/ on the VM
  gcloud compute scp --recurse \
    "${REPO_ROOT}/dino-server" \
    "${INSTANCE}:/opt/" \
    --zone="$ZONE" --project="$PROJECT"

  log "Deploy complete."
fi

# ── 5. Start DINOv2 server on VM ─────────────────────────────────────────────
log "Starting DINOv2 server on VM ..."
gcloud compute ssh "$INSTANCE" \
  --zone="$ZONE" --project="$PROJECT" \
  --command="
    # Kill any existing server instance
    pkill -f 'uvicorn main:app' 2>/dev/null && echo 'Killed previous server' || true

    # Verify the server directory exists
    [[ -d '${REMOTE_SERVER_DIR}' ]] || {
      echo 'ERROR: ${REMOTE_SERVER_DIR} not found on VM. Run with --deploy first.'
      exit 1
    }

    # Start server (pip install runs first inside start.sh on each boot)
    cd '${REMOTE_SERVER_DIR}'
    nohup bash start.sh > /tmp/dino-server.log 2>&1 &
    echo \"Server PID: \$!\"
    echo \$! > /tmp/dino-server.pid
  "

# ── 6. Poll /health until ready ───────────────────────────────────────────────
log "Waiting for DINOv2 server to be healthy (timeout: ${HEALTH_TIMEOUT}s) ..."
log "(First run may take ~5 min while pip and model weights download)"
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

# ── 7. Build matcher args ─────────────────────────────────────────────────────
MATCHER_ARGS=(
  --dino-url  "$DINO_URL"
  --threshold "$THRESHOLD"
  --data-root "$DATA_ROOT"
  --output    "$OUTPUT"
)
[[ -n "$COMPOUND" ]] && MATCHER_ARGS+=(--compound "$COMPOUND")
$DRY_RUN   && MATCHER_ARGS+=(--dry-run)
$VERBOSE   && MATCHER_ARGS+=(--verbose)

# ── 8. Run auto-matcher ───────────────────────────────────────────────────────
log "Running auto-matcher ..."
log "  Command: python3 scripts/dino-auto-matcher.py ${MATCHER_ARGS[*]}"
echo ""

python3 "${REPO_ROOT}/scripts/dino-auto-matcher.py" "${MATCHER_ARGS[@]}"

echo ""
log "Matching complete. Results saved to: ${OUTPUT}"

# cleanup trap fires here → VM stopped
