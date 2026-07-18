#!/usr/bin/env bash
#
# Runs ON THE SERVER, invoked over SSH by .github/workflows/deploy.yml.
#
# The workflow has already rsynced the repo into STAGE_DIR. This script swaps
# staging into the live directory and reinstalls dependencies.
#
# Why the lock: cron fires `npm run sync`, which hits production Plaid and writes
# to the owner's real spreadsheet. Swapping source files out from under a run in
# progress could execute a half-old/half-new mix against real financial data. So
# we wait for any in-flight run to finish before touching the live tree, and cron
# takes the same lock so it won't start one mid-swap.

set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/apps/bubber-banking}"
STAGE_DIR="${STAGE_DIR:-$HOME/staging/bubber-banking}"
LOCK="${LOCK:-$HOME/.locks/bubber-banking.lock}"

mkdir -p "$APP_DIR" "$(dirname "$LOCK")"

echo "==> waiting for lock (any in-flight sync must finish first)"
flock -w 900 "$LOCK" env APP_DIR="$APP_DIR" STAGE_DIR="$STAGE_DIR" bash -euo pipefail -c '
  echo "==> swapping code into $APP_DIR"

  # --delete keeps the live tree honest (removed files actually disappear), but
  # every --exclude below is a file that lives ONLY on the server and must
  # survive the swap. Losing tokens.json means re-linking every bank by hand.
  rsync -a --delete \
    --exclude ".env" \
    --exclude "tokens.json" \
    --exclude "service-account.json" \
    --exclude "bubberbanking-*.json" \
    --exclude "node_modules" \
    "$STAGE_DIR/" "$APP_DIR/"

  cd "$APP_DIR"

  # tsx is a runtime dependency (the service runs `tsx src/sync.ts`), so it lives
  # in "dependencies" and survives --omit=dev. Only typescript and the @types
  # packages are dev-only, and those are needed just for `npm run typecheck`,
  # which runs in CI as a gate before this script is ever reached.
  echo "==> npm ci"
  npm ci --omit=dev
'

echo "==> deployed. cron picks up the new code on its next run."
