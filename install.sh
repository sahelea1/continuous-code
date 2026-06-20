#!/usr/bin/env bash
# Require bash (the script uses bash-only features like BASH_SOURCE)
if [ -z "${BASH_VERSION:-}" ]; then
  echo "ERROR: This installer requires bash. Run it as:  ./install.sh   (not 'sh install.sh')" >&2
  exit 1
fi
set -euo pipefail

# opencode-continuous (continuous-code) install script.
# Config-driven, standalone (no dependency on any Continuous-Claude-v3 install),
# idempotent: running twice is a no-op. Translates the pre-install file
# `continuous-code.config.jsonc` into runtime files (memory.json + .env) that the
# plugin reads, provisions memory, installs extras, and runs install-time model
# autoconfig.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$SCRIPT_DIR"

# ============================================================================
# Flags
# ============================================================================
SYMLINK=false
NO_ALIAS=false
NO_AUTOCONFIG=false
DRY_RUN=false
DOCTOR=false
CONFIG_FILE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --symlink)        SYMLINK=true ;;
    --no-alias)       NO_ALIAS=true ;;
    --no-autoconfig)  NO_AUTOCONFIG=true ;;
    --dry-run)        DRY_RUN=true ;;
    --doctor)         DOCTOR=true ;;
    --config=*)       CONFIG_FILE="${1#--config=}" ;;
    --config)
      shift
      [ $# -gt 0 ] || { echo "ERROR: --config requires a value." >&2; exit 1; }
      CONFIG_FILE="$1"
      ;;
    --help|-h)
      cat <<'EOF'
Usage: install.sh [options]

  --config <path>   Use a specific continuous-code.config.jsonc (else autodetected)
  --symlink         Symlink agent/command files instead of copying (contributors)
  --no-alias        Skip the 'opencode' shell alias (background subagents)
  --no-autoconfig   Skip install-time model autoconfig (keep committed defaults)
  --dry-run         Resolve + print what would happen; make no changes
  --doctor          Print resolved state only (no install); for diagnostics
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
  shift
done

say()  { printf '%s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
run()  { if [ "$DRY_RUN" = true ]; then say "[dry-run] $*"; else eval "$@"; fi; }

# ============================================================================
# Locate the pre-install config file
#   precedence: --config, $PWD, $SCRIPT_DIR. Missing => all defaults.
# ============================================================================
if [ -z "$CONFIG_FILE" ]; then
  if   [ -f "$PWD/continuous-code.config.jsonc" ];        then CONFIG_FILE="$PWD/continuous-code.config.jsonc"
  elif [ -f "$SCRIPT_DIR/continuous-code.config.jsonc" ]; then CONFIG_FILE="$SCRIPT_DIR/continuous-code.config.jsonc"
  fi
fi
if [ -n "$CONFIG_FILE" ] && [ -f "$CONFIG_FILE" ]; then
  say "Pre-install config: $CONFIG_FILE"
else
  CONFIG_FILE=""
  say "Pre-install config: none found — using built-in defaults."
fi

JSONC="$SCRIPT_DIR/scripts/jsonc.mjs"

# cfg <dot.path> <default> — read a value from the JSONC config (or default).
cfg() {
  local path="$1" def="${2:-}"
  if [ -z "$CONFIG_FILE" ] || [ ! -f "$JSONC" ]; then
    printf '%s' "$def"
    return 0
  fi
  node "$JSONC" "$CONFIG_FILE" "$path" "$def"
}

# Expand a leading ~ to $HOME.
expand_tilde() { case "$1" in "~"*) printf '%s' "${HOME}${1#\~}" ;; *) printf '%s' "$1" ;; esac; }

# ============================================================================
# Detect config directory (opencode global config dir)
# ============================================================================
if [ -n "${XDG_CONFIG_HOME:-}" ]; then
  CONFIG_DIR="$XDG_CONFIG_HOME/opencode"
else
  CONFIG_DIR="$HOME/.config/opencode"
fi
say "OpenCode config directory: $CONFIG_DIR"

# ============================================================================
# Resolve effective settings from config (+ CC-v3 detection + overrides)
# ============================================================================

# --- Component toggles ---
COMP_AGENTS="$(cfg components.agents true)"
COMP_COMMANDS="$(cfg components.commands true)"
COMP_PLUGIN="$(cfg components.plugin true)"
COMP_OPENCODEJSON="$(cfg components.opencodeJson true)"
COMP_THOUGHTS="$(cfg components.thoughts true)"
COMP_SHELLALIAS="$(cfg components.shellAlias true)"
COMP_CONSENSUS="$(cfg components.consensus true)"

# --no-alias flag overrides the toggle.
if [ "$NO_ALIAS" = true ]; then COMP_SHELLALIAS=false; fi

# --- Memory config ---
MEM_MODE="$(cfg memory.mode sqlite)"
MEM_SQLITE_PATH="$(expand_tilde "$(cfg memory.sqlite.path "$HOME/.config/opencode/continuous/memory.db")")"
PG_PROVISION="$(cfg memory.postgres.provision docker)"
PG_DBNAME="$(cfg memory.postgres.dbName continuous_code)"
PG_USER="$(cfg memory.postgres.user continuous)"
PG_PASSWORD="$(cfg memory.postgres.password continuous_dev)"
PG_PORT="$(cfg memory.postgres.port 5433)"
PG_URL="$(cfg memory.postgres.url '')"

EMB_PROVIDER="$(cfg memory.embeddings.provider none)"
EMB_MODEL="$(cfg memory.embeddings.model '')"
EMB_APIKEYENV="$(cfg memory.embeddings.apiKeyEnv VOYAGE_API_KEY)"

# --- Extras ---
EXTRA_TLDR="$(cfg extras.tldr auto)"
EXTRA_LOCALEMB="$(cfg extras.localEmbeddings false)"
EXTRA_MCP="$(cfg extras.mcpServers '{}')"

# --- Autoconfig ---
AUTOCONFIG_ENABLED="$(cfg autoconfig.enabled true)"
AUTOCONFIG_PREFER="$(cfg autoconfig.prefer '')"
AUTOCONFIG_DRYRUN="$(cfg autoconfig.dryRun false)"
AUTOCONFIG_FALLBACK="$(cfg autoconfig.fallbackModel ollama-cloud/deepseek-v4-pro)"

# --- Reuse policy ---
REUSE_CCV3="$(cfg reuseExistingCcV3 true)"
FORCE_STANDALONE="$(cfg forceStandalone false)"

# Resolved memory runtime values (filled below).
MEMORY_BACKEND="$MEM_MODE"
RESOLVED_DB_URL=""
MEMORY_REUSED_CCV3=false
TLDR_ENABLED=0

# --- Effective backend / url resolution ---
case "$MEM_MODE" in
  sqlite)  MEMORY_BACKEND="sqlite" ;;
  postgres) MEMORY_BACKEND="postgres" ;;
  none)    MEMORY_BACKEND="none" ;;
  *) warn "Unknown memory.mode '$MEM_MODE' — defaulting to sqlite."; MEM_MODE="sqlite"; MEMORY_BACKEND="sqlite" ;;
esac

# Explicit postgres url always wins (and forces postgres backend).
if [ -n "$PG_URL" ]; then
  MEMORY_BACKEND="postgres"
  RESOLVED_DB_URL="$PG_URL"
fi

# CC-v3 opportunistic detection (only when allowed and no explicit url).
CCV3_DB_URL=""
if [ "$REUSE_CCV3" = "true" ] && [ "$FORCE_STANDALONE" != "true" ] && [ -z "$PG_URL" ]; then
  if command -v docker >/dev/null 2>&1; then
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx 'continuous-claude-postgres' \
       && docker exec continuous-claude-postgres pg_isready -U claude -d continuous_claude >/dev/null 2>&1; then
      CCV3_DB_URL="postgresql://claude:claude_dev@127.0.0.1:5432/continuous_claude"
    fi
  fi
fi

# Policy (R4): reuse a detected CC-v3 db for memory unless the user explicitly
# opted out (reuseExistingCcV3:false / forceStandalone:true / explicit url).
# This OVERRIDES the sqlite default — the intended "utilize when present" behavior.
if [ -n "$CCV3_DB_URL" ] && { [ "$MEM_MODE" = "sqlite" ] || [ "$MEM_MODE" = "postgres" ]; }; then
  MEMORY_BACKEND="postgres"
  RESOLVED_DB_URL="$CCV3_DB_URL"
  MEMORY_REUSED_CCV3=true
fi

# Standalone docker provision derives a URL when none chosen yet.
if [ "$MEMORY_BACKEND" = "postgres" ] && [ -z "$RESOLVED_DB_URL" ]; then
  case "$PG_PROVISION" in
    docker|native)
      RESOLVED_DB_URL="postgresql://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${PG_DBNAME}"
      ;;
    skip)
      warn "memory.mode=postgres provision=skip but no memory.postgres.url set — memory will degrade to none at runtime."
      ;;
  esac
fi

# --- tldr resolution ---
case "$EXTRA_TLDR" in
  auto)  if command -v tldr >/dev/null 2>&1; then TLDR_ENABLED=1; fi ;;
  true)  TLDR_ENABLED=1 ;;   # may attempt install below
  false) TLDR_ENABLED=0 ;;
  *)     warn "Unknown extras.tldr '$EXTRA_TLDR' — treating as auto."
         if command -v tldr >/dev/null 2>&1; then TLDR_ENABLED=1; fi ;;
esac

# --- Embeddings 1024-dim guard (R5): openai (1536) is incompatible with shared pg ---
if [ "$MEMORY_BACKEND" = "postgres" ] && [ "$EMB_PROVIDER" = "openai" ]; then
  warn "embeddings.provider=openai (1536-dim) is incompatible with the shared vector(1024) postgres."
  warn "Forcing embeddings provider to 'none'. Use 'voyage' (1024) for postgres, or sqlite for openai."
  EMB_PROVIDER="none"
fi

redact_url() { printf '%s' "$1" | sed -E 's#(://[^:]+:)[^@]+@#\1***@#'; }

print_summary() {
  say ""
  say "=== Resolved configuration ==="
  say "  Components : agents=$COMP_AGENTS commands=$COMP_COMMANDS plugin=$COMP_PLUGIN opencodeJson=$COMP_OPENCODEJSON thoughts=$COMP_THOUGHTS shellAlias=$COMP_SHELLALIAS consensus=$COMP_CONSENSUS"
  say "  Memory     : backend=$MEMORY_BACKEND"
  if [ "$MEMORY_BACKEND" = "sqlite" ]; then
    say "               sqlitePath=$MEM_SQLITE_PATH"
  elif [ "$MEMORY_BACKEND" = "postgres" ]; then
    say "               url=$(redact_url "$RESOLVED_DB_URL")"
    say "               reusedCcV3=$MEMORY_REUSED_CCV3 provision=$PG_PROVISION"
  fi
  say "  Embeddings : provider=$EMB_PROVIDER"
  if [ "$TLDR_ENABLED" = "1" ]; then say "  tldr       : enabled"; else say "  tldr       : disabled"; fi
  say "  Autoconfig : enabled=$AUTOCONFIG_ENABLED prefer='${AUTOCONFIG_PREFER}' dryRun=$AUTOCONFIG_DRYRUN fallback=$AUTOCONFIG_FALLBACK"
  say ""
}

if [ "$MEMORY_REUSED_CCV3" = "true" ]; then
  say "Reusing existing CC-v3 postgres at :5432/continuous_claude for memory."
fi

print_summary

# Doctor mode: print state and exit (no install).
if [ "$DOCTOR" = true ]; then
  say "(--doctor) No changes made."
  exit 0
fi

# ============================================================================
# Component install: dependencies + plugin build
# ============================================================================
if [ "$COMP_PLUGIN" = "true" ]; then
  say "Installing dependencies..."
  if command -v bun &>/dev/null; then
    run "(cd \"$PLUGIN_DIR\" && bun install)"
  elif command -v npm &>/dev/null; then
    run "(cd \"$PLUGIN_DIR\" && npm install)"
  else
    echo "ERROR: Neither npm nor bun found. Install one and retry." >&2
    exit 1
  fi

  say "Building plugin..."
  run "(cd \"$PLUGIN_DIR\" && npx tsc)"

  # Install plugin into OpenCode's config dir so "opencode-continuous" resolves by name.
  say "Installing plugin into OpenCode config..."
  OPENCODE_PKG="$CONFIG_DIR/package.json"
  if [ "$DRY_RUN" != true ]; then
    mkdir -p "$CONFIG_DIR"
    if [ ! -f "$OPENCODE_PKG" ]; then
      echo '{"dependencies":{}}' > "$OPENCODE_PKG"
    fi
    (cd "$CONFIG_DIR" && npm install "file://$PLUGIN_DIR" --save 2>&1) || {
      echo "WARN: npm install into config dir failed. Trying bun..." >&2
      (cd "$CONFIG_DIR" && bun add "file://$PLUGIN_DIR" 2>&1) || true
    }
  else
    say "[dry-run] npm install file://$PLUGIN_DIR into $CONFIG_DIR"
  fi
else
  say "Skipping plugin build/install (components.plugin=false)."
fi

# ============================================================================
# Copy or symlink agent files
# ============================================================================
copy_or_link() { # <src> <dst>
  local src="$1" dst="$2" name; name="$(basename "$src")"
  if [ "$SYMLINK" = true ]; then
    if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then
      say "  $name (symlink already exists)"
    else
      run "ln -sf \"$src\" \"$dst\""; say "  $name (symlinked)"
    fi
  else
    if [ -f "$dst" ] && diff -q "$src" "$dst" &>/dev/null; then
      say "  $name (already up to date)"
    else
      run "cp \"$src\" \"$dst\""; say "  $name (copied)"
    fi
  fi
}

if [ "$COMP_AGENTS" = "true" ]; then
  AGENTS_DIR="$CONFIG_DIR/agents"
  run "mkdir -p \"$AGENTS_DIR\""
  say "Installing agents to $AGENTS_DIR..."
  for agent_file in "$PLUGIN_DIR"/agents/*.md; do
    [ -f "$agent_file" ] || continue
    copy_or_link "$agent_file" "$AGENTS_DIR/$(basename "$agent_file")"
  done
else
  say "Skipping agents (components.agents=false)."
fi

# ============================================================================
# Copy or symlink command files
# ============================================================================
if [ "$COMP_COMMANDS" = "true" ]; then
  COMMANDS_DIR="$CONFIG_DIR/commands"
  run "mkdir -p \"$COMMANDS_DIR\""
  say "Installing commands to $COMMANDS_DIR..."
  for cmd_file in "$PLUGIN_DIR"/commands/*.md; do
    [ -f "$cmd_file" ] || continue
    copy_or_link "$cmd_file" "$COMMANDS_DIR/$(basename "$cmd_file")"
  done
else
  say "Skipping commands (components.commands=false)."
fi

# ============================================================================
# Deploy opencode.json
# ============================================================================
PROJECT_CONFIG="$PWD/opencode.json"
if [ "$COMP_OPENCODEJSON" = "true" ]; then
  if [ -f "$PROJECT_CONFIG" ]; then
    say "Backing up existing opencode.json to opencode.json.bak"
    run "cp \"$PROJECT_CONFIG\" \"$PROJECT_CONFIG.bak\""
    say "opencode.json already exists (backed up to .bak). Review and merge manually if needed."
  else
    say "Copying template opencode.json..."
    run "cp \"$PLUGIN_DIR/opencode.json\" \"$PROJECT_CONFIG\""
  fi

  # Ensure the plugin reference uses the package name (not a relative path).
  if [ "$DRY_RUN" != true ] && command -v jq &>/dev/null && [ -f "$PROJECT_CONFIG" ]; then
    CURRENT_PLUGIN=$(jq -r '.plugin[0] // ""' "$PROJECT_CONFIG" 2>/dev/null || true)
    if [ "$CURRENT_PLUGIN" = "./dist/index.js" ]; then
      say "Rewriting plugin path to package name..."
      jq '.plugin = ["opencode-continuous"]' "$PROJECT_CONFIG" > "$PROJECT_CONFIG.tmp" && mv "$PROJECT_CONFIG.tmp" "$PROJECT_CONFIG"
    fi
  fi
else
  say "Skipping opencode.json deploy (components.opencodeJson=false)."
fi

# ============================================================================
# Deploy consensus.json
# ============================================================================
if [ "$COMP_CONSENSUS" = "true" ]; then
  PROJECT_CONSENSUS="$PWD/consensus.json"
  if [ -f "$PLUGIN_DIR/consensus.json" ]; then
    if [ -f "$PROJECT_CONSENSUS" ]; then
      say "consensus.json already exists (skipping; edit via /consensus)."
    else
      say "Deploying consensus.json..."
      run "cp \"$PLUGIN_DIR/consensus.json\" \"$PROJECT_CONSENSUS\""
    fi
  fi
else
  say "Skipping consensus.json (components.consensus=false)."
fi

# ============================================================================
# Create thoughts/ skeleton
# ============================================================================
if [ "$COMP_THOUGHTS" = "true" ]; then
  THOUGHTS_DIR="$PWD/thoughts"
  if [ ! -d "$THOUGHTS_DIR" ]; then
    say "Creating thoughts/ directory skeleton..."
    if [ "$DRY_RUN" != true ]; then
      mkdir -p "$THOUGHTS_DIR/shared/handoffs"
      mkdir -p "$THOUGHTS_DIR/ledgers"
      {
        echo "# Thoughts Directory"
        echo ""
        echo "Session continuity data for opencode-continuous."
        echo ""
        echo "- shared/handoffs/ - Session handoff YAML files"
        echo "- ledgers/ - Continuity ledger markdown files"
      } > "$THOUGHTS_DIR/README.md"
    else
      say "[dry-run] mkdir thoughts/{shared/handoffs,ledgers} + README"
    fi
  else
    say "thoughts/ directory already exists (skipping)"
  fi
else
  say "Skipping thoughts/ skeleton (components.thoughts=false)."
fi

# ============================================================================
# Memory provisioning — write memory.json + .env (runtime config the plugin reads)
# ============================================================================
PROJECT_MEMORY_JSON="$PWD/memory.json"
PROJECT_ENV="$PWD/.env"

apply_pg_schema_docker() { # <container> <user> <db>
  local container="$1" user="$2" db="$3"
  if [ -f "$PLUGIN_DIR/db/schema.sql" ]; then
    say "Applying db/schema.sql to $container ($db)..."
    run "docker exec -i \"$container\" psql -U \"$user\" -d \"$db\" < \"$PLUGIN_DIR/db/schema.sql\""
  fi
}

case "$MEMORY_BACKEND" in
  sqlite)
    say "Memory: sqlite at $MEM_SQLITE_PATH"
    run "mkdir -p \"$(dirname "$MEM_SQLITE_PATH")\""
    ;;
  none)
    say "Memory: disabled (backend=none)."
    ;;
  postgres)
    if [ "$MEMORY_REUSED_CCV3" = "true" ]; then
      # Re-apply schema to the reused CC-v3 db (idempotent).
      apply_pg_schema_docker "continuous-claude-postgres" "claude" "continuous_claude"
    elif [ -n "$PG_URL" ]; then
      say "Memory: postgres (explicit url). Schema is applied by the backend on first open."
    else
      case "$PG_PROVISION" in
        docker)
          if command -v docker >/dev/null 2>&1; then
            say "Provisioning standalone postgres via db/docker-compose.yml..."
            if [ "$DRY_RUN" != true ]; then
              CC_PG_USER="$PG_USER" CC_PG_PASSWORD="$PG_PASSWORD" CC_PG_DB="$PG_DBNAME" CC_PG_PORT="$PG_PORT" \
                docker compose -f "$PLUGIN_DIR/db/docker-compose.yml" up -d
              # Wait for healthcheck.
              container="continuous-code-postgres"
              say "Waiting for $container to become ready..."
              for _ in $(seq 1 30); do
                if docker exec "$container" pg_isready -U "$PG_USER" -d "$PG_DBNAME" >/dev/null 2>&1; then
                  break
                fi
                sleep 2
              done
              apply_pg_schema_docker "$container" "$PG_USER" "$PG_DBNAME"
            else
              say "[dry-run] docker compose -f db/docker-compose.yml up -d (db=$PG_DBNAME port=$PG_PORT)"
            fi
          else
            warn "docker not found — cannot provision postgres. Memory will degrade to none at runtime."
          fi
          ;;
        native)
          if command -v psql >/dev/null 2>&1; then
            say "Provisioning postgres on native host (db=$PG_DBNAME)..."
            if [ "$DRY_RUN" != true ]; then
              PGPASSWORD="$PG_PASSWORD" createdb -h 127.0.0.1 -p "$PG_PORT" -U "$PG_USER" "$PG_DBNAME" 2>/dev/null || true
              PGPASSWORD="$PG_PASSWORD" psql -h 127.0.0.1 -p "$PG_PORT" -U "$PG_USER" -d "$PG_DBNAME" -f "$PLUGIN_DIR/db/schema.sql" || \
                warn "Native schema apply failed; backend will retry idempotently on first open."
            fi
          else
            warn "psql not on PATH — cannot provision native postgres. Memory will degrade to none at runtime."
          fi
          ;;
        skip)
          say "Memory: postgres provision=skip; relying on memory.postgres.url (none set => degrades to none)."
          ;;
      esac
    fi
    ;;
esac

# --- Write memory.json (runtime config; mirrors MemoryConfig) ---
write_memory_json() {
  local pg_json="null"
  if [ -n "$RESOLVED_DB_URL" ]; then pg_json="$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$RESOLVED_DB_URL")"; fi
  local model_json="null"
  if [ -n "$EMB_MODEL" ]; then model_json="$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$EMB_MODEL")"; fi
  cat > "$PROJECT_MEMORY_JSON" <<EOF
{
  "backend": "$MEMORY_BACKEND",
  "sqlitePath": "$MEM_SQLITE_PATH",
  "postgresUrl": $pg_json,
  "dedupThreshold": 0.85,
  "recallLimit": 5,
  "embeddings": {
    "provider": "$EMB_PROVIDER",
    "model": $model_json,
    "apiKeyEnv": "$EMB_APIKEYENV",
    "baseURL": null,
    "dimension": 1024
  }
}
EOF
}

if [ "$DRY_RUN" != true ]; then
  say "Writing runtime memory.json ($PROJECT_MEMORY_JSON)..."
  write_memory_json
else
  say "[dry-run] write memory.json (backend=$MEMORY_BACKEND)"
fi

# --- Write/refresh .env with the locked env var names (idempotent) ---
set_env_var() { # <key> <value>  (rewrite key in .env, append if absent)
  local key="$1" val="$2"
  [ "$DRY_RUN" = true ] && { say "[dry-run] .env $key=$val"; return 0; }
  touch "$PROJECT_ENV"
  if grep -q "^${key}=" "$PROJECT_ENV" 2>/dev/null; then
    # Replace existing line (use a temp file to avoid sed -i portability issues).
    grep -v "^${key}=" "$PROJECT_ENV" > "$PROJECT_ENV.tmp" || true
    mv "$PROJECT_ENV.tmp" "$PROJECT_ENV"
  fi
  printf '%s=%s\n' "$key" "$val" >> "$PROJECT_ENV"
}

unset_env_var() { # <key>  (remove key from .env; no-op if file or key absent)
  local key="$1"
  [ "$DRY_RUN" = true ] && { say "[dry-run] .env unset $key"; return 0; }
  [ -f "$PROJECT_ENV" ] || return 0
  grep -v "^${key}=" "$PROJECT_ENV" > "$PROJECT_ENV.tmp" || true
  mv "$PROJECT_ENV.tmp" "$PROJECT_ENV"
}

say "Writing runtime .env ($PROJECT_ENV)..."
# Remove stale keys that do not apply to the resolved backend/provider.
if [ "$MEMORY_BACKEND" != "postgres" ]; then
  unset_env_var "CONTINUOUS_CODE_DB_URL"
fi
if [ "$MEMORY_BACKEND" != "sqlite" ]; then
  unset_env_var "MEMORY_DB_PATH"
fi
if [ "$EMB_PROVIDER" = "none" ]; then
  unset_env_var "MEMORY_EMBEDDINGS"
  unset_env_var "MEMORY_EMBEDDINGS_MODEL"
fi
set_env_var "MEMORY_BACKEND" "$MEMORY_BACKEND"
if [ "$MEMORY_BACKEND" = "sqlite" ]; then
  set_env_var "MEMORY_DB_PATH" "$MEM_SQLITE_PATH"
fi
if [ "$MEMORY_BACKEND" = "postgres" ] && [ -n "$RESOLVED_DB_URL" ]; then
  set_env_var "CONTINUOUS_CODE_DB_URL" "$RESOLVED_DB_URL"
fi
if [ "$EMB_PROVIDER" != "none" ]; then
  set_env_var "MEMORY_EMBEDDINGS" "$EMB_PROVIDER"
  [ -n "$EMB_MODEL" ] && set_env_var "MEMORY_EMBEDDINGS_MODEL" "$EMB_MODEL"
fi

# ============================================================================
# Extras: tldr / localEmbeddings / mcpServers merge
# ============================================================================
if [ "$EXTRA_TLDR" = "true" ] && ! command -v tldr >/dev/null 2>&1; then
  say "Attempting to install tldr (llm-tldr)..."
  if command -v npm >/dev/null 2>&1; then
    run "npm install -g llm-tldr" || warn "tldr install failed; install it manually to enable tldr usage."
  else
    warn "npm not found — cannot auto-install tldr."
  fi
  command -v tldr >/dev/null 2>&1 && TLDR_ENABLED=1
fi

if [ "$EXTRA_LOCALEMB" = "true" ]; then
  say "Installing local embedding stack (extras.localEmbeddings=true)..."
  if command -v uv >/dev/null 2>&1; then
    run "uv pip install --system sentence-transformers" || warn "local embedding stack install failed (uv)."
  elif command -v pip >/dev/null 2>&1; then
    run "pip install sentence-transformers" || warn "local embedding stack install failed (pip)."
  else
    warn "neither uv nor pip found — cannot install local embedding stack."
  fi
fi

# Merge extras.mcpServers into opencode.json's mcp block.
if [ "$COMP_OPENCODEJSON" = "true" ] && [ -f "$PROJECT_CONFIG" ] && [ "$EXTRA_MCP" != "{}" ] && [ -n "$EXTRA_MCP" ]; then
  say "Merging extras.mcpServers into opencode.json mcp block..."
  if [ "$DRY_RUN" != true ]; then
    node -e '
      import("node:fs").then(({readFileSync,writeFileSync})=>{
        const [file, mcp] = process.argv.slice(2);
        let obj = {};
        try { obj = JSON.parse(readFileSync(file,"utf8")); } catch { obj = {}; }
        let extra = {};
        try { extra = JSON.parse(mcp); } catch { extra = {}; }
        obj.mcp = Object.assign({}, obj.mcp || {}, extra);
        writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
      });
    ' "$PROJECT_CONFIG" "$EXTRA_MCP" || warn "mcpServers merge failed; merge manually into opencode.json."
  else
    say "[dry-run] merge mcpServers into opencode.json"
  fi
fi

# ============================================================================
# Install-time autoconfig (per-agent model/effort assignment)
#   Runs AFTER the plugin is built (dist/autoconfig/cli.js exists) and AFTER
#   opencode.json is deployed.
# ============================================================================
run_autoconfig() {
  local cli="$PLUGIN_DIR/dist/autoconfig/cli.js"
  if [ ! -f "$cli" ]; then
    warn "dist/autoconfig/cli.js not found (plugin not built?) — skipping autoconfig, keeping $AUTOCONFIG_FALLBACK."
    return 0
  fi
  local args=(apply --config "$PROJECT_CONFIG" --fallback-model "$AUTOCONFIG_FALLBACK")
  [ -n "$AUTOCONFIG_PREFER" ] && args+=(--prefer "$AUTOCONFIG_PREFER")
  { [ "$AUTOCONFIG_DRYRUN" = "true" ] || [ "$DRY_RUN" = true ]; } && args+=(--dry-run)
  say "Running install-time autoconfig..."
  if [ "$DRY_RUN" = true ]; then
    say "[dry-run] node $cli ${args[*]}"
    return 0
  fi
  node "$cli" "${args[@]}" || \
    say "autoconfig skipped (no authenticated provider) — keeping $AUTOCONFIG_FALLBACK. Run /autoconfagent later."
}

if [ "$AUTOCONFIG_ENABLED" = "true" ] && [ "$NO_AUTOCONFIG" != true ] && [ "$COMP_OPENCODEJSON" = true ]; then
  run_autoconfig
else
  say "Skipping install-time autoconfig (disabled, --no-autoconfig, or opencode.json not deployed)."
fi

# ============================================================================
# Shell alias for background subagents
# ============================================================================
if [ "$COMP_SHELLALIAS" = "true" ]; then
  USER_SHELL="$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7 || true)"
  [ -z "$USER_SHELL" ] && USER_SHELL="${SHELL:-}"

  RC_FILE=""
  case "$USER_SHELL" in
    */zsh)  RC_FILE="$HOME/.zshrc" ;;
    */bash) RC_FILE="$HOME/.bashrc" ;;
    *)
      if   [ -f "$HOME/.zshrc" ];  then RC_FILE="$HOME/.zshrc"
      elif [ -f "$HOME/.bashrc" ]; then RC_FILE="$HOME/.bashrc"
      else RC_FILE="$HOME/.bashrc"; fi
      ;;
  esac

  say "Configuring opencode alias in $RC_FILE..."
  ALIAS_MARKER='OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS'
  if grep -q "alias opencode=.*${ALIAS_MARKER}" "$RC_FILE" 2>/dev/null; then
    say "  opencode alias already configured in $RC_FILE (skipping)"
  else
    if [ "$DRY_RUN" != true ]; then
      {
        echo ""
        echo "# opencode-continuous: enable experimental background subagents"
        echo "alias opencode='OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true opencode'"
      } >> "$RC_FILE"
    fi
    say "  opencode alias added to $RC_FILE"
    say "  Run: source $RC_FILE  (or open a new shell) for the alias to take effect"
  fi
else
  say "Skipping opencode alias configuration (components.shellAlias=false or --no-alias)."
fi

# ============================================================================
# Doctor / final summary
# ============================================================================
say ""
say "=== Installation complete ==="
print_summary
say "Next steps:"
say "  1. Review opencode.json and adjust model assignments if needed"
say "  2. Memory runtime config written to memory.json + .env (gitignored)"
say "  3. Run 'opencode' inside a project to start the agent-only workflow"
say "  4. Use /build, /fix, /explore etc. to trigger skill workflows"
say "  5. Diagnostics any time:  ./install.sh --doctor"
say ""
