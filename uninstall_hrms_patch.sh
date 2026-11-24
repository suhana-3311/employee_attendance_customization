#!/usr/bin/env bash
# Removes the selfie check-in screen from HRMS. Safe to re-run.
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BENCH_DIR="$(cd "$APP_DIR/../.." && pwd)"
HRMS_DIR="$BENCH_DIR/apps/hrms"
PATCH="$APP_DIR/frontend_patch/CheckInPanel.patch"

if git -C "$HRMS_DIR" apply --check -R "$PATCH" 2>/dev/null; then
  git -C "$HRMS_DIR" apply -R "$PATCH"
  echo "Patch removed."
else
  echo "Patch is not applied (or HRMS was changed). Nothing to remove."
  exit 0
fi
yarn --cwd "$HRMS_DIR/frontend" install
(cd "$BENCH_DIR" && bench build --app hrms)
echo "Done."
