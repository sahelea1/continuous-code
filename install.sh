#!/usr/bin/env bash
set -euo pipefail

# opencode-continuous install script
# Idempotent: running twice is a no-op.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$SCRIPT_DIR"

# --- Flags ---
SYMLINK=false
for arg in "$@"; do
  case "$arg" in
    --symlink) SYMLINK=true ;;
    --help|-h)
      echo "Usage: install.sh [--symlink]"
      echo ""
      echo "  --symlink   Symlink agent/command files instead of copying (for contributors)"
      exit 0
      ;;
    *)
      echo "Unknown option: $arg"
      exit 1
      ;;
  esac
done

# --- Detect config directory ---
if [ -n "${XDG_CONFIG_HOME:-}" ]; then
  CONFIG_DIR="$XDG_CONFIG_HOME/opencode"
else
  CONFIG_DIR="$HOME/.config/opencode"
fi
echo "Config directory: $CONFIG_DIR"

# --- Install npm dependencies and build ---
echo "Installing dependencies..."
if command -v bun &>/dev/null; then
  (cd "$PLUGIN_DIR" && bun install)
elif command -v npm &>/dev/null; then
  (cd "$PLUGIN_DIR" && npm install)
else
  echo "ERROR: Neither npm nor bun found. Install one and retry."
  exit 1
fi

echo "Building plugin..."
(cd "$PLUGIN_DIR" && npx tsc)

# --- Install plugin into OpenCode's config directory ---
# OpenCode resolves plugins from its own node_modules inside the config dir.
# We install the local package there so "opencode-continuous" resolves by name.
echo "Installing plugin into OpenCode config..."
OPENCODE_PKG="$CONFIG_DIR/package.json"
if [ ! -f "$OPENCODE_PKG" ]; then
  echo '{"dependencies":{}}' > "$OPENCODE_PKG"
fi
(cd "$CONFIG_DIR" && npm install "file://$PLUGIN_DIR" --save 2>&1) || {
  echo "WARN: npm install into config dir failed. Trying bun..."
  (cd "$CONFIG_DIR" && bun add "file://$PLUGIN_DIR" 2>&1) || true
}

# --- Copy or symlink agent files ---
AGENTS_DIR="$CONFIG_DIR/agents"
mkdir -p "$AGENTS_DIR"
echo "Installing agents to $AGENTS_DIR..."
for agent_file in "$PLUGIN_DIR"/agents/*.md; do
  [ -f "$agent_file" ] || continue
  basename="$(basename "$agent_file")"
  target="$AGENTS_DIR/$basename"
  if [ "$SYMLINK" = true ]; then
    if [ -L "$target" ] && [ "$(readlink "$target")" = "$agent_file" ]; then
      echo "  $basename (symlink already exists)"
    else
      ln -sf "$agent_file" "$target"
      echo "  $basename (symlinked)"
    fi
  else
    if [ -f "$target" ] && diff -q "$agent_file" "$target" &>/dev/null; then
      echo "  $basename (already up to date)"
    else
      cp "$agent_file" "$target"
      echo "  $basename (copied)"
    fi
  fi
done

# --- Copy or symlink command files ---
COMMANDS_DIR="$CONFIG_DIR/commands"
mkdir -p "$COMMANDS_DIR"
echo "Installing commands to $COMMANDS_DIR..."
for cmd_file in "$PLUGIN_DIR"/commands/*.md; do
  [ -f "$cmd_file" ] || continue
  basename="$(basename "$cmd_file")"
  target="$COMMANDS_DIR/$basename"
  if [ "$SYMLINK" = true ]; then
    if [ -L "$target" ] && [ "$(readlink "$target")" = "$cmd_file" ]; then
      echo "  $basename (symlink already exists)"
    else
      ln -sf "$cmd_file" "$target"
      echo "  $basename (symlinked)"
    fi
  else
    if [ -f "$target" ] && diff -q "$cmd_file" "$target" &>/dev/null; then
      echo "  $basename (already up to date)"
    else
      cp "$cmd_file" "$target"
      echo "  $basename (copied)"
    fi
  fi
done

# --- Deploy opencode.json ---
PROJECT_CONFIG="$PWD/opencode.json"
if [ -f "$PROJECT_CONFIG" ]; then
  echo "Backing up existing opencode.json to opencode.json.bak"
  cp "$PROJECT_CONFIG" "$PROJECT_CONFIG.bak"
fi

if [ ! -f "$PROJECT_CONFIG" ]; then
  echo "Copying template opencode.json..."
  cp "$PLUGIN_DIR/opencode.json" "$PROJECT_CONFIG"
else
  echo "opencode.json already exists (backed up to .bak). Review and merge manually if needed."
fi

# Ensure the plugin reference uses the package name (not a relative path).
if command -v jq &>/dev/null && [ -f "$PROJECT_CONFIG" ]; then
  CURRENT_PLUGIN=$(jq -r '.plugin[0] // ""' "$PROJECT_CONFIG" 2>/dev/null || true)
  if [ "$CURRENT_PLUGIN" = "./dist/index.js" ]; then
    echo "Rewriting plugin path to package name..."
    jq '.plugin = ["opencode-continuous"]' "$PROJECT_CONFIG" > "$PROJECT_CONFIG.tmp" && mv "$PROJECT_CONFIG.tmp" "$PROJECT_CONFIG"
  fi
fi

# --- Create thoughts/ skeleton ---
THOUGHTS_DIR="$PWD/thoughts"
if [ ! -d "$THOUGHTS_DIR" ]; then
  echo "Creating thoughts/ directory skeleton..."
  mkdir -p "$THOUGHTS_DIR/shared/handoffs"
  mkdir -p "$THOUGHTS_DIR/ledgers"
  echo "# Thoughts Directory" > "$THOUGHTS_DIR/README.md"
  echo "" >> "$THOUGHTS_DIR/README.md"
  echo "Session continuity data for opencode-continuous." >> "$THOUGHTS_DIR/README.md"
  echo "" >> "$THOUGHTS_DIR/README.md"
  echo "- shared/handoffs/ - Session handoff YAML files" >> "$THOUGHTS_DIR/README.md"
  echo "- ledgers/ - Continuity ledger markdown files" >> "$THOUGHTS_DIR/README.md"
else
  echo "thoughts/ directory already exists (skipping)"
fi

# --- Done ---
echo ""
echo "=== Installation complete ==="
echo ""
echo "Next steps:"
echo "  1. Review opencode.json and adjust model assignments if needed"
echo "  2. See opencode.example.jsonc for model swap examples"
echo "  3. Run 'opencode' to start using the agent-only workflow"
echo "  4. Use /build, /fix, /explore etc. to trigger skill workflows"
echo ""
