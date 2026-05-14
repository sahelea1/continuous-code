#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- Parse flags and optional positional argument ---
BUILD_FLAG=""
SHELL_MODE=false
PROJECT_PATH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --build)
      BUILD_FLAG="--build"
      shift
      ;;
    --shell)
      SHELL_MODE=true
      shift
      ;;
    --help|-h)
      echo "Usage: launch.sh [project_dir] [--build] [--shell]"
      echo ""
      echo "  project_dir   Optional path to your project directory (default: ./workspace)"
      echo "  --build       Force rebuild of the Docker image"
      echo "  --shell       Drop into bash instead of starting opencode"
      exit 0
      ;;
    -*)
      echo "Unknown option: $1"
      exit 1
      ;;
    *)
      if [ -n "$PROJECT_PATH" ]; then
        echo "Error: unexpected extra argument '$1' (project_dir already set to '$PROJECT_PATH')"
        exit 1
      fi
      PROJECT_PATH="$1"
      shift
      ;;
  esac
done

# --- Resolve project directory ---
if [ -n "$PROJECT_PATH" ]; then
  # Ensure the directory exists
  mkdir -p "$PROJECT_PATH"
  # Resolve to absolute path
  export PROJECT_DIR="$(cd "$PROJECT_PATH" && pwd)"
  echo "Using project directory: $PROJECT_DIR"
else
  export PROJECT_DIR="$SCRIPT_DIR/workspace"
fi

WORKSPACE_DIR="$PROJECT_DIR"

# --- Create workspace directory if needed ---
if [ ! -d "$WORKSPACE_DIR" ]; then
  echo "Creating workspace directory..."
  mkdir -p "$WORKSPACE_DIR"
fi

# --- Check for host auth ---
AUTH_FILE="$HOME/.local/share/opencode/auth.json"
if [ ! -f "$AUTH_FILE" ]; then
  echo "WARNING: No opencode auth found at $AUTH_FILE"
  echo "Run 'opencode auth login' on the host first."
  echo ""
fi

# --- Initialize git in workspace if needed ---
if [ ! -d "$WORKSPACE_DIR/.git" ]; then
  echo "Initializing git repo in workspace (opencode requires it)..."
  (
    cd "$WORKSPACE_DIR"
    git init
    echo "# Workspace" > README.md
    git add README.md
    git commit -m "init workspace"
  )
fi

# --- Copy opencode.json template if not present ---
if [ ! -f "$WORKSPACE_DIR/opencode.json" ]; then
  echo "Copying opencode.json template into workspace..."
  cp "$SCRIPT_DIR/opencode.json" "$WORKSPACE_DIR/opencode.json"
fi

# --- Launch ---
cd "$SCRIPT_DIR"

if [ "$SHELL_MODE" = true ]; then
  echo "Starting shell in container..."
  docker compose run --rm $BUILD_FLAG opencode bash
else
  echo "Starting opencode..."
  docker compose run --rm $BUILD_FLAG opencode
fi
