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

# --- Optional: tear down the standalone memory postgres (guarded) ---
# Only offers the STANDALONE db (db/docker-compose.yml). It NEVER touches a
# reused CC-v3 postgres (continuous-claude-postgres) — that is not ours to stop.
DB_COMPOSE="$PLUGIN_DIR/db/docker-compose.yml"
if [ -f "$DB_COMPOSE" ] && command -v docker >/dev/null 2>&1; then
  if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx 'continuous-code-postgres'; then
    echo ""
    echo "Found standalone memory postgres container 'continuous-code-postgres'."
    if [ -t 0 ]; then
      printf "Stop it with 'docker compose -f db/docker-compose.yml down'? (data volume kept) [y/N] "
      read -r reply || reply=""
      case "$reply" in
        [yY]*) docker compose -f "$DB_COMPOSE" down || echo "  (compose down failed; stop it manually)" ;;
        *)     echo "  Left running. Stop later with: docker compose -f db/docker-compose.yml down" ;;
      esac
    else
      echo "  Non-interactive: left running. Stop with: docker compose -f $DB_COMPOSE down"
      echo "  (Add 'down -v' to also delete the data volume.)"
    fi
  fi
fi

# --- Optional: remove runtime config files (guarded; never forced) ---
for runtime_file in "$PWD/.env" "$PWD/memory.json"; do
  if [ -f "$runtime_file" ]; then
    echo ""
    if [ -t 0 ]; then
      printf "Remove runtime file %s? [y/N] " "$runtime_file"
      read -r reply || reply=""
      case "$reply" in
        [yY]*) rm -f "$runtime_file" && echo "  Removed $runtime_file" ;;
        *)     echo "  Kept $runtime_file" ;;
      esac
    else
      echo "NOTE: runtime file $runtime_file was NOT removed (non-interactive)."
      echo "  Delete it manually if you no longer need it: rm -f \"$runtime_file\""
    fi
  fi
done

# --- Preserve user data ---
echo ""
echo "NOTE: thoughts/ directory was NOT removed (contains user session data)."
echo "  Delete it manually if you no longer need it: rm -rf thoughts/"

echo ""
echo "=== Uninstall complete ==="
