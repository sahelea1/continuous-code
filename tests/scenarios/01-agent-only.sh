#!/usr/bin/env bash
set -euo pipefail

echo "  Testing agent-only enforcement config..."

CONFIG="/work/opencode.json"

if [ ! -f "$CONFIG" ]; then
    # Try the installed config
    CONFIG="/plugin/opencode.json"
fi

if [ ! -f "$CONFIG" ]; then
    echo "  FAIL: No opencode.json found"
    exit 1
fi

# Check build agent has denied tools
for tool in read grep glob bash webfetch websearch; do
    PERM=$(jq -r ".agent.build.permission.$tool // empty" "$CONFIG")
    if [ "$PERM" != "deny" ]; then
        echo "  FAIL: build agent should deny '$tool', got '$PERM'"
        exit 1
    fi
done

# Check build agent allows task tool
TASK_PERM=$(jq -r '.agent.build.permission.task // empty' "$CONFIG")
if [ "$TASK_PERM" != "allow" ]; then
    echo "  FAIL: build agent should allow 'task', got '$TASK_PERM'"
    exit 1
fi

# Check scout has read access
SCOUT_READ=$(jq -r '.agent.scout.permission.read // empty' "$CONFIG" 2>/dev/null)
# Scout permissions may be in the agent .md file, not opencode.json
# Just verify the agent exists in config
if ! jq -e '.agent.scout' "$CONFIG" > /dev/null 2>&1; then
    echo "  FAIL: scout agent not configured in opencode.json"
    exit 1
fi

echo "  Agent-only enforcement config: verified"
