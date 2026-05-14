#!/usr/bin/env bash
set -euo pipefail

echo "  Testing CC-v3 cross-compatibility..."

FIXTURE="/plugin/tests/fixtures/cc-v3-handoff.yaml"

if [ ! -f "$FIXTURE" ]; then
    echo "  FAIL: Fixture not found at $FIXTURE"
    exit 1
fi

# Copy fixture to handoffs directory
mkdir -p /work/thoughts/shared/handoffs/cc-v3-fixture
cp "$FIXTURE" /work/thoughts/shared/handoffs/cc-v3-fixture/2026-01-01T00-00-00Z.yaml

HANDOFF="/work/thoughts/shared/handoffs/cc-v3-fixture/2026-01-01T00-00-00Z.yaml"

# Validate YAML
if ! yq '.' "$HANDOFF" > /dev/null 2>&1; then
    echo "  FAIL: CC-v3 fixture YAML parsing failed"
    exit 1
fi

# Check ALL CC-v3 schema fields
REQUIRED_FIELDS="goal now test done_this_session blockers questions decisions findings worked failed next files"
for field in $REQUIRED_FIELDS; do
    if ! yq -e ".$field" "$HANDOFF" > /dev/null 2>&1; then
        echo "  FAIL: CC-v3 fixture missing field: $field"
        exit 1
    fi
done

# Verify specific values from the fixture
GOAL=$(yq '.goal' "$HANDOFF")
if [[ "$GOAL" != *"authentication"* ]]; then
    echo "  FAIL: Fixture goal doesn't match expected content"
    exit 1
fi

FILES_COUNT=$(yq '.files | length' "$HANDOFF")
if [ "$FILES_COUNT" -lt 1 ]; then
    echo "  FAIL: Fixture should have at least one file listed"
    exit 1
fi

echo "  CC-v3 cross-compatibility: all schema fields match"

# Clean up
rm -rf /work/thoughts/shared/handoffs/cc-v3-fixture
