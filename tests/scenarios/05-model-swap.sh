#!/usr/bin/env bash
set -euo pipefail

echo "  Testing per-agent model configuration..."

CONFIG="/plugin/opencode.json"

# Check each agent has a model assigned
AGENTS="scout oracle sleuth kraken spark arbiter judge plan-agent phoenix architect scribe memory-extractor"

for agent in $AGENTS; do
    # Use jq with bracket notation for hyphenated names
    MODEL=$(jq -r ".agent[\"$agent\"].model // empty" "$CONFIG")
    if [ -z "$MODEL" ]; then
        echo "  FAIL: Agent '$agent' has no model configured"
        exit 1
    fi

    # Verify model is an ollama-cloud model
    if [[ "$MODEL" != ollama-cloud/* ]]; then
        echo "  FAIL: Agent '$agent' model '$MODEL' is not an ollama-cloud model"
        exit 1
    fi
done

echo "  Per-agent model configuration: all 12 agents have ollama-cloud models"
