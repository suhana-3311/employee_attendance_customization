#!/usr/bin/env bash
# Applies the selfie check-in screen to HRMS 15.x. Safe to re-run.
# Usage: ./install_hrms_patch.sh [--dry-run]
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BENCH_DIR="$(cd "$APP_DIR/../.." && pwd)"
HRMS_DIR="$BENCH_DIR/apps/hrms"
PATCH="$APP_DIR/frontend_patch/CheckInPanel.patch"
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1

[ -d "$HRMS_DIR/.git" ] || { echo "ERROR: HRMS not found at $HRMS_DIR"; exit 1; }
[ -f "$PATCH" ] || { echo "ERROR: patch file missing: $PATCH"; exit 1; }

VER=$(grep -oP '__version__ = "\K[^"]+' "$HRMS_DIR/hrms/__init__.py")
case "$VER" in
  15.*) echo "HRMS version: $VER" ;;
  *) echo "ERROR: HRMS $VER not supported (need 15.x)"; exit 1 ;;
esac

if git -C "$HRMS_DIR" apply --check -R "$PATCH" 2>/dev/null; then
  echo "Patch already applied. Nothing to patch."
  ALREADY=1
elif git -C "$HRMS_DIR" apply --check "$PATCH" 2>/dev/null; then
  echo "Patch can be applied cleanly."
  ALREADY=0
else
  echo "ERROR: patch does not fit this HRMS version. No changes made."
  exit 1
fi

if [ "$DRY" = "1" ]; then echo "Dry run finished. No changes made."; exit 0; fi

if [ "$ALREADY" = "0" ]; then
  git -C "$HRMS_DIR" apply "$PATCH"
  echo "Patch applied."
fi

yarn --cwd "$HRMS_DIR/frontend" install
(cd "$BENCH_DIR" && bench build --app hrms)
echo "Done. Hard-refresh the browser (Ctrl+Shift+R)."
