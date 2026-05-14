#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "=== opencode-continuous Docker Test Harness ==="
echo ""

# Cleanup trap — remove staged auth on exit
cleanup() {
    rm -rf "$SCRIPT_DIR/.host-auth"
}
trap cleanup EXIT

# Check for host auth
AUTH_DIR="$HOME/.local/share/opencode"
AUTH_FILE="$AUTH_DIR/auth.json"
if [ ! -f "$AUTH_FILE" ]; then
    echo "WARNING: No auth.json found at $AUTH_FILE"
    echo "Tests will use the stub provider for responses."
    echo "For full testing, run: opencode auth login"
    echo ""
    export USE_STUB_PROVIDER=1
else
    # Stage host auth into a local directory that gets bind-mounted into the container.
    # We copy rather than mount the host directory directly to avoid SQLite WAL issues.
    echo "Staging host auth to $SCRIPT_DIR/.host-auth/ ..."
    rm -rf "$SCRIPT_DIR/.host-auth"
    cp -r "$AUTH_DIR" "$SCRIPT_DIR/.host-auth"
fi

# Create scratch dir
mkdir -p "$SCRIPT_DIR/scratch"

# Initialize a git repo in scratch (opencode requires it)
if [ ! -d "$SCRIPT_DIR/scratch/.git" ]; then
    cd "$SCRIPT_DIR/scratch"
    git init
    echo "# Test Project" > README.md
    git add README.md
    git commit -m "init test project"
    cd "$PROJECT_DIR"
fi

echo "Building test container..."
cd "$SCRIPT_DIR"
docker compose build

echo "Running test scenarios..."
docker compose run --rm test
EXIT_CODE=$?

echo ""
if [ $EXIT_CODE -eq 0 ]; then
    echo "=== ALL TESTS PASSED ==="
else
    echo "=== TESTS FAILED (exit code: $EXIT_CODE) ==="
fi

exit $EXIT_CODE
