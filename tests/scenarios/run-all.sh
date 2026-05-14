#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0
FAIL=0
SKIP=0

run_scenario() {
    local name="$1"
    local script="$2"

    echo ""
    echo "--- Scenario: $name ---"

    if [ ! -f "$script" ]; then
        echo "  SKIP (not implemented)"
        SKIP=$((SKIP + 1))
        return
    fi

    if bash "$script"; then
        echo "  PASS"
        PASS=$((PASS + 1))
    else
        echo "  FAIL"
        FAIL=$((FAIL + 1))
    fi
}

echo "=== opencode-continuous E2E Test Suite ==="
echo "Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

# Verify opencode is available
if ! command -v opencode &>/dev/null; then
    echo "ERROR: opencode not found on PATH"
    exit 1
fi
echo "opencode version: $(opencode --version)"

# Verify plugin is installed
echo "Plugin install check..."
if [ -f /plugin/dist/index.js ]; then
    echo "  Plugin built: OK"
else
    echo "  Building plugin..."
    cd /plugin && npm run build && cd /work
fi

# Create thoughts/ skeleton if missing
mkdir -p /work/thoughts/shared/handoffs
mkdir -p /work/thoughts/ledgers
mkdir -p /work/thoughts/shared/plans

# Run scenarios
run_scenario "Agent-only enforcement" "$SCRIPT_DIR/01-agent-only.sh"
run_scenario "Handoff round-trip" "$SCRIPT_DIR/02-handoff-roundtrip.sh"
run_scenario "Resume from handoff" "$SCRIPT_DIR/03-resume.sh"
run_scenario "Parallel delegation" "$SCRIPT_DIR/04-parallel-delegation.sh"
run_scenario "Per-agent model swap" "$SCRIPT_DIR/05-model-swap.sh"
run_scenario "CC-v3 cross-compat" "$SCRIPT_DIR/06-cc-v3-compat.sh"

echo ""
echo "=== Results ==="
echo "  PASS: $PASS"
echo "  FAIL: $FAIL"
echo "  SKIP: $SKIP"
echo ""

if [ $FAIL -gt 0 ]; then
    exit 1
fi
