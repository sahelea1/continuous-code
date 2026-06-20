#!/usr/bin/env bash
# bootstrap.sh — one-liner installer for continuous-code (pipe-to-bash safe).
#
#   curl -fsSL https://raw.githubusercontent.com/sahelea1/continuous-code/prod/bootstrap.sh | bash
#
# Clones (or updates) the repo into ~/.local/share/continuous-code, seeds an
# editable config from the committed example, then runs install.sh which does
# the real work (components, memory provisioning, extras, autoconfig).
#
# Does NOT rely on $0 / BASH_SOURCE for the repo location (it may be piped).
set -euo pipefail

REPO="https://github.com/sahelea1/continuous-code.git"   # HTTPS for unauthenticated curl users
BRANCH="prod"
CONTINUOUS_CODE_HOME="${CONTINUOUS_CODE_HOME:-$HOME/.local/share/continuous-code}"

say() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# --- 1. Preflight -----------------------------------------------------------
command -v git  >/dev/null 2>&1 || die "git is required."
command -v node >/dev/null 2>&1 || die "node (>=18) is required."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "${NODE_MAJOR:-0}" -lt 18 ] 2>/dev/null; then
  die "node >=18 required (found $(node -v 2>/dev/null || echo none))."
fi

if ! command -v bun >/dev/null 2>&1 && ! command -v npm >/dev/null 2>&1; then
  die "either bun or npm is required."
fi

if ! command -v docker >/dev/null 2>&1; then
  say "NOTE: docker not found — only needed for memory.mode=postgres (provision=docker)."
fi

# --- 2. Clone or update -----------------------------------------------------
if [ -d "$CONTINUOUS_CODE_HOME/.git" ]; then
  say "Updating existing clone at $CONTINUOUS_CODE_HOME ..."
  git -C "$CONTINUOUS_CODE_HOME" fetch --depth 1 origin "$BRANCH"
  git -C "$CONTINUOUS_CODE_HOME" checkout -q "$BRANCH"
  git -C "$CONTINUOUS_CODE_HOME" reset --hard "origin/$BRANCH"
else
  say "Cloning $REPO (branch $BRANCH) into $CONTINUOUS_CODE_HOME ..."
  mkdir -p "$(dirname "$CONTINUOUS_CODE_HOME")"
  git clone --depth 1 -b "$BRANCH" "$REPO" "$CONTINUOUS_CODE_HOME"
fi

# --- 3. Seed editable config (proceed with defaults regardless) -------------
CONFIG_LIVE="$CONTINUOUS_CODE_HOME/continuous-code.config.jsonc"
CONFIG_EXAMPLE="$CONTINUOUS_CODE_HOME/continuous-code.config.example.jsonc"
if [ ! -f "$CONFIG_LIVE" ] && [ -f "$CONFIG_EXAMPLE" ]; then
  cp "$CONFIG_EXAMPLE" "$CONFIG_LIVE"
  say "Seeded editable config: $CONFIG_LIVE"
  # Only offer an interactive edit when attached to a real terminal.
  if [ -t 0 ] && [ -n "${EDITOR:-}" ]; then
    printf 'Edit config now in %s before installing? [y/N] ' "$EDITOR"
    read -r reply || reply=""
    case "$reply" in
      [yY]*) "$EDITOR" "$CONFIG_LIVE" ;;
    esac
  fi
fi

# --- 4. Run install ---------------------------------------------------------
say "Running install.sh ..."
( cd "$CONTINUOUS_CODE_HOME" && bash install.sh )

# --- 5. Final hints ---------------------------------------------------------
say ""
say "=== continuous-code bootstrap complete ==="
say "  Editable config : $CONFIG_LIVE"
say "  Re-run installer: cd \"$CONTINUOUS_CODE_HOME\" && bash install.sh"
say "  Check state     : cd \"$CONTINUOUS_CODE_HOME\" && bash install.sh --doctor"
say "  Launch          : run 'opencode' inside any project directory"
