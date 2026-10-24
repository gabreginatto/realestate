#!/usr/bin/env bash
# Deploy the broker labeling page to Firebase Hosting + Firestore rules.
# Usage: scripts/deploy_label_site.sh [BUILD_DIR]   (BUILD_DIR holds index.html + img/)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="${1:-/private/tmp/claude-501/-Users-gabrielreginatto-Desktop-Code-realestate/07c7be28-b63e-4f01-8c69-a267b80717c3/scratchpad/label-page3}"
PROJECT="property-matcher-139a4"
APP_ID="1:208105692639:web:f585b7b4a2dbd67a4b386a"
PUB="$ROOT/firebase/public"

[ -f "$BUILD/index.html" ] || { echo "no index.html in $BUILD" >&2; exit 1; }
cd "$ROOT"
CFG="$(firebase apps:sdkconfig WEB "$APP_ID" --project "$PROJECT" | sed -n '/{/,/}/p' | tr -d '\n')"

rm -rf "$PUB"; mkdir -p "$PUB"
cp -R "$BUILD/img" "$PUB/img"
BUILD_HTML="$BUILD/index.html" PUB_HTML="$PUB/index.html" CFG="$CFG" python3 - <<'PY'
import os
s = open(os.environ["BUILD_HTML"], encoding="utf-8").read()
tag = '<script>window.LABEL_BACKEND="firestore";window.FIREBASE_CONFIG=%s;</script>\n' % os.environ["CFG"]
marker = '<script type="application/json" id="items">'
assert marker in s, "items script marker not found"
open(os.environ["PUB_HTML"], "w", encoding="utf-8").write(s.replace(marker, tag + marker, 1))
PY

firebase deploy --config firebase/firebase.json --only hosting,firestore:rules --project "$PROJECT"
echo "https://$PROJECT.web.app"
