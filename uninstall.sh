#!/usr/bin/env bash
set -euo pipefail

# opencode-continuous uninstall script
# Removes plugin files from config. Does NOT remove thoughts/ (user data).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$SCRIPT_DIR"

# --- Detect config directory ---
if [ -n "${XDG_CONFIG_HOME:-}" ]; then
  CONFIG_DIR="$XDG_CONFIG_HOME/opencode"
else
  CONFIG_DIR="$HOME/.config/opencode"
fi
echo "Config directory: $CONFIG_DIR"

# --- Remove agent files ---
AGENTS_DIR="$CONFIG_DIR/agents"
if [ -d "$AGENTS_DIR" ]; then
  echo "Removing agent files..."
  for agent_file in "$PLUGIN_DIR"/agents/*.md; do
    [ -f "$agent_file" ] || continue
    basename="$(basename "$agent_file")"
    target="$AGENTS_DIR/$basename"
    if [ -f "$target" ] || [ -L "$target" ]; then
      rm -f "$target"
      echo "  Removed $basename"
    fi
  done
fi

# --- Remove command files ---
COMMANDS_DIR="$CONFIG_DIR/commands"
if [ -d "$COMMANDS_DIR" ]; then
  echo "Removing command files..."
  for cmd_file in "$PLUGIN_DIR"/commands/*.md; do
    [ -f "$cmd_file" ] || continue
    basename="$(basename "$cmd_file")"
    target="$COMMANDS_DIR/$basename"
    if [ -f "$target" ] || [ -L "$target" ]; then
      rm -f "$target"
      echo "  Removed $basename"
    fi
  done
fi

# --- Remove plugin reference from opencode.json ---
PROJECT_CONFIG="$PWD/opencode.json"
if [ -f "$PROJECT_CONFIG" ]; then
  if grep -q "opencode-continuous\|dist/index.js" "$PROJECT_CONFIG"; then
    echo "Removing plugin reference from opencode.json..."
    echo "NOTE: Manual edit required - remove the plugin entry from opencode.json"
    echo "  Look for: \"./dist/index.js\" or \"opencode-continuous\" in the \"plugin\" array"
  fi
fi

# --- Preserve user data ---
echo ""
echo "NOTE: thoughts/ directory was NOT removed (contains user session data)."
echo "  Delete it manually if you no longer need it: rm -rf thoughts/"

echo ""
echo "=== Uninstall complete ==="
