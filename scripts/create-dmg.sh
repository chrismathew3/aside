#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/dist/Aside-darwin-arm64/Aside.app"
OUTPUT="$ROOT/dist/Aside-0.1.0-arm64.dmg"
[[ "$(uname -s)" == Darwin ]] || { echo 'Requires macOS hdiutil.' >&2; exit 1; }
[[ -d "$APP" ]] || { echo "Missing built app: $APP" >&2; exit 1; }
STAGING="$(mktemp -d "${TMPDIR:-/tmp}/aside-dmg.XXXXXX")"
trap 'rm -rf "$STAGING"' EXIT
/usr/bin/ditto "$APP" "$STAGING/Aside.app"
ln -s /Applications "$STAGING/Applications"
hdiutil create -volname Aside -srcfolder "$STAGING" -format UDZO -ov "$OUTPUT"
hdiutil verify "$OUTPUT"
echo "Created $OUTPUT"
