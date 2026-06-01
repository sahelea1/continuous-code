#!/usr/bin/env bash
set -euo pipefail

# Resolve repo root (two levels up from this script).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"

echo "==> Compiling TypeScript (npx tsc)"
npx tsc

echo "==> Running config unit test (no network)"
node --test tests/consensus/config.test.mjs

if [ -n "${OPENROUTER_API_KEY:-}" ]; then
  echo "==> Running live test (OPENROUTER_API_KEY is set)"
  node --test tests/consensus/live.test.mjs
else
  echo "==> Skipping live test (OPENROUTER_API_KEY not set)"
fi
