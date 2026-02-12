#!/bin/bash
# Migration script: Move existing flat data into alphaville-1/ subdirectory
# This is a one-time migration for multi-compound support
set -euo pipefail

echo "=== Multi-Compound Data Migration ==="
echo "Moving existing data into alphaville-1/ subdirectory..."

# --- Migrate data/ directory ---
DATA_DIR="data"
COMPOUND_DIR="$DATA_DIR/alphaville-1"

if [ -d "$COMPOUND_DIR/vivaprimeimoveis" ]; then
  echo "SKIP: $COMPOUND_DIR/vivaprimeimoveis already exists. Migration may have already run."
else
  mkdir -p "$COMPOUND_DIR"

  for item in vivaprimeimoveis coelhodafonseca mosaics; do
    if [ -d "$DATA_DIR/$item" ]; then
      echo "  Moving $DATA_DIR/$item → $COMPOUND_DIR/$item"
      mv "$DATA_DIR/$item" "$COMPOUND_DIR/"
    else
      echo "  SKIP: $DATA_DIR/$item not found"
    fi
  done

  for file in deterministic-matches.json manual-matches.json manual-matches.log.jsonl pipeline-state.json; do
    if [ -f "$DATA_DIR/$file" ]; then
      echo "  Moving $DATA_DIR/$file → $COMPOUND_DIR/$file"
      mv "$DATA_DIR/$file" "$COMPOUND_DIR/"
    else
      echo "  SKIP: $DATA_DIR/$file not found"
    fi
  done

  echo "data/ migration complete."
fi

# --- Migrate server-deploy/data/ directory ---
SD_DATA="server-deploy/data"
SD_COMPOUND="$SD_DATA/alphaville-1"

if [ -d "$SD_DATA" ]; then
  if [ -d "$SD_COMPOUND/mosaics" ]; then
    echo "SKIP: $SD_COMPOUND/mosaics already exists. Migration may have already run."
  else
    mkdir -p "$SD_COMPOUND"

    for item in mosaics listings; do
      if [ -d "$SD_DATA/$item" ]; then
        echo "  Moving $SD_DATA/$item → $SD_COMPOUND/$item"
        mv "$SD_DATA/$item" "$SD_COMPOUND/"
      else
        echo "  SKIP: $SD_DATA/$item not found"
      fi
    done

    for file in deterministic-matches.json manual-matches.json manual-matches.log.jsonl; do
      if [ -f "$SD_DATA/$file" ]; then
        echo "  Moving $SD_DATA/$file → $SD_COMPOUND/$file"
        mv "$SD_DATA/$file" "$SD_COMPOUND/"
      else
        echo "  SKIP: $SD_DATA/$file not found"
      fi
    done

    echo "server-deploy/data/ migration complete."
  fi
else
  echo "SKIP: server-deploy/data/ not found"
fi

echo ""
echo "=== Migration Complete ==="
echo "Verify with: ls -la data/alphaville-1/ && ls -la server-deploy/data/alphaville-1/"
