#!/usr/bin/env bash
set -euo pipefail

echo "  Testing handoff round-trip..."

# Create test handoff directory
mkdir -p /work/thoughts/shared/handoffs/test-roundtrip

# Write a test handoff in CC-v3 format
cat > /work/thoughts/shared/handoffs/test-roundtrip/2026-01-01T00-00-00Z.yaml <<'EOF'
goal: "Test handoff round-trip"
now: "Verifying YAML format compatibility"
test: "bash tests/scenarios/02-handoff-roundtrip.sh"
done_this_session:
  - Created test fixture
  - Validated YAML parsing
blockers: []
questions:
  - Does the format match CC-v3?
decisions:
  - Using pure YAML format
findings:
  - Format is compatible
worked:
  - YAML round-trip works
failed: []
next:
  - Run cross-compat test
files:
  - tests/scenarios/02-handoff-roundtrip.sh
EOF

HANDOFF="/work/thoughts/shared/handoffs/test-roundtrip/2026-01-01T00-00-00Z.yaml"

# Validate YAML parses
if ! yq '.' "$HANDOFF" > /dev/null 2>&1; then
    echo "  FAIL: YAML parsing failed"
    exit 1
fi

# Check required fields
for field in goal now done_this_session next files; do
    if ! yq -e ".$field" "$HANDOFF" > /dev/null 2>&1; then
        echo "  FAIL: Missing required field: $field"
        exit 1
    fi
done

# Check goal is not empty
GOAL=$(yq '.goal' "$HANDOFF")
if [ "$GOAL" = "null" ] || [ -z "$GOAL" ]; then
    echo "  FAIL: goal field is empty"
    exit 1
fi

# Check array fields are arrays
for field in done_this_session blockers questions decisions findings worked failed next files; do
    TYPE=$(yq ".$field | type" "$HANDOFF")
    if [ "$TYPE" != "!!seq" ]; then
        echo "  FAIL: $field should be an array, got $TYPE"
        exit 1
    fi
done

echo "  Handoff round-trip: all fields valid"

# Clean up
rm -rf /work/thoughts/shared/handoffs/test-roundtrip
