#!/usr/bin/env bash
# install.sh — Install opencode-prompt-enhancer locally without npm publish.
#
# Registers the plugin in ~/.config/opencode/tui.json and installs deps.
# Run `install.sh --uninstall` to remove it from config.
# Restart opencode after install for changes to take effect.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_DIR="${HOME}/.config/opencode"
TUI_CONFIG_FILE="${CONFIG_DIR}/tui.json"
LEGACY_CONFIG_FILE="${CONFIG_DIR}/opencode.json"
PLUGIN_PATH="${PROJECT_DIR}/dist/index.js"
LEGACY_PLUGIN_PATH="${PROJECT_DIR}/index.ts"
RELEASE_PLUGIN_ENTRY="@mtayfur/opencode-prompt-enhancer@latest"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}✓${NC} $1"; }
warn()  { echo -e "${YELLOW}⚠${NC} $1"; }
err()   { echo -e "${RED}✗${NC} $1"; }

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "Missing required command: $1"
    exit 1
  fi
}

# ---- helpers ----
json_set_plugin() {
  local file="$1" action="$2" local_entry="$3" release_entry="$4"
  bun -e '
    const fs = require("fs");
    const f = process.argv[1], action = process.argv[2], localEntry = process.argv[3], releaseEntry = process.argv[4];

    let cfg = {};
    if (fs.existsSync(f)) {
      try {
        const raw = fs.readFileSync(f, "utf8").trim();
        cfg = raw === "" ? {} : JSON.parse(raw);
      } catch (error) {
        console.error(`Invalid JSON in ${f}: ${error.message}`);
        process.exit(2);
      }
    }

    if (cfg === null || Array.isArray(cfg) || typeof cfg !== "object") {
      console.error(`${f} must contain a JSON object.`);
      process.exit(2);
    }

    if (cfg.plugin === undefined) {
      cfg.plugin = [];
    } else if (!Array.isArray(cfg.plugin)) {
      console.error(`${f}.plugin must be an array.`);
      process.exit(2);
    }

    const matchesEntry = (p, entry) => {
      if (typeof p === "string") return p === entry;
      if (Array.isArray(p)) return p[0] === entry;
      return false;
    };

    const localIdx = cfg.plugin.findIndex(p => matchesEntry(p, localEntry));
    const releaseIdx = cfg.plugin.findIndex(p => matchesEntry(p, releaseEntry));

    if (action === "install") {
      if (localIdx >= 0) {
        cfg.plugin = cfg.plugin.filter((p, idx) => idx === localIdx || !matchesEntry(p, releaseEntry));
        fs.writeFileSync(f, JSON.stringify(cfg, null, 2) + "\n");
        process.stdout.write(releaseIdx >= 0 ? "deduped" : "exists");
        process.exit(0);
      }

      if (releaseIdx >= 0) {
        cfg.plugin[releaseIdx] = localEntry;
        cfg.plugin = cfg.plugin.filter((p, idx) => idx === releaseIdx || !matchesEntry(p, releaseEntry));
        fs.writeFileSync(f, JSON.stringify(cfg, null, 2) + "\n");
        process.stdout.write("replaced-release");
        process.exit(0);
      }

      cfg.plugin.push(localEntry);
    } else if (action === "uninstall") {
      if (localIdx < 0) {
        process.stdout.write(releaseIdx >= 0 ? "release-exists" : "notfound");
        process.exit(0);
      }

      cfg.plugin[localIdx] = releaseEntry;
      cfg.plugin = cfg.plugin.filter((p, idx) => idx === localIdx || !matchesEntry(p, releaseEntry));
    } else if (action === "remove") {
      if (localIdx < 0) { process.stdout.write("notfound"); process.exit(0); }
      cfg.plugin.splice(localIdx, 1);
    }

    fs.writeFileSync(f, JSON.stringify(cfg, null, 2) + "\n");
    process.stdout.write("ok");
  ' "$file" "$action" "$local_entry" "$release_entry"
}

plugin_file_url() {
  bun -e '
    const { pathToFileURL } = require("url");
    process.stdout.write(pathToFileURL(process.argv[1]).href);
  ' "$1"
}

# ---- main ----
case "${1:-install}" in
  install|--install)
    echo -e "${GREEN}=== Installing opencode-prompt-enhancer ===${NC}"
    echo ""

    require_command bun

    # 1. Install project dependencies without mutating lockfile.
    echo -e "${YELLOW}[1/4] Installing project dependencies...${NC}"
    bun install --cwd "${PROJECT_DIR}" --frozen-lockfile
    info "Dependencies installed"
    echo ""

    # 2. Build plugin (compile TSX → JS for runtime compatibility)
    echo -e "${YELLOW}[2/4] Building plugin...${NC}"
    bun run --cwd "${PROJECT_DIR}" build
    info "Build complete"
    echo ""

    if [ ! -f "${PLUGIN_PATH}" ]; then
      err "Plugin entry point not found after build: ${PLUGIN_PATH}"
      exit 1
    fi

    PLUGIN_ENTRY="$(plugin_file_url "${PLUGIN_PATH}")"
    LEGACY_PLUGIN_ENTRY="$(plugin_file_url "${LEGACY_PLUGIN_PATH}")"

    # 3. Ensure config directory exists
    echo -e "${YELLOW}[3/4] Ensuring opencode config directory...${NC}"
    mkdir -p "${CONFIG_DIR}"
    info "Config directory ready: ${CONFIG_DIR}"
    echo ""

    # 4. Register plugin in tui.json.
    echo -e "${YELLOW}[4/4] Registering plugin in OpenCode TUI config...${NC}"
    legacy_tui_result=$(json_set_plugin "${TUI_CONFIG_FILE}" "remove" "${LEGACY_PLUGIN_ENTRY}" "${RELEASE_PLUGIN_ENTRY}")
    if [ "$legacy_tui_result" = "ok" ]; then
      warn "Removed previous local source entry from ${TUI_CONFIG_FILE}"
    fi

    result=$(json_set_plugin "${TUI_CONFIG_FILE}" "install" "${PLUGIN_ENTRY}" "${RELEASE_PLUGIN_ENTRY}")
    case "$result" in
      replaced-release) info "Replaced release plugin with local plugin in ${TUI_CONFIG_FILE}" ;;
      exists)           warn "Local plugin already registered in ${TUI_CONFIG_FILE}" ;;
      deduped)          warn "Local plugin already registered; removed duplicate release entry" ;;
      ok)               info "Plugin added to ${TUI_CONFIG_FILE}" ;;
      *)      err "Unexpected result: $result"; exit 1 ;;
    esac

    # Clean up the old installer target from the previous implementation only for this plugin.
    if [ -f "${LEGACY_CONFIG_FILE}" ]; then
      legacy_result=$(json_set_plugin "${LEGACY_CONFIG_FILE}" "remove" "${LEGACY_PLUGIN_PATH}" "${RELEASE_PLUGIN_ENTRY}")
      if [ "$legacy_result" = "ok" ]; then
        warn "Removed previous local entry from ${LEGACY_CONFIG_FILE}"
      fi
    fi
    echo ""

    echo -e "${GREEN}=== Installation complete ===${NC}"
    echo ""
    echo "  Plugin:  ${PLUGIN_ENTRY}"
    echo "  Config:  ${TUI_CONFIG_FILE}"
    echo ""
    echo -e "${YELLOW}Restart opencode for changes to take effect.${NC}"
    ;;

  uninstall|--uninstall)
    echo -e "${YELLOW}=== Uninstalling opencode-prompt-enhancer ===${NC}"
    echo ""

    require_command bun
    PLUGIN_ENTRY="$(plugin_file_url "${PLUGIN_PATH}")"
    LEGACY_PLUGIN_ENTRY="$(plugin_file_url "${LEGACY_PLUGIN_PATH}")"

    if [ ! -f "${TUI_CONFIG_FILE}" ]; then
      warn "Config file not found, nothing to uninstall."
      exit 0
    fi

    result=$(json_set_plugin "${TUI_CONFIG_FILE}" "uninstall" "${PLUGIN_ENTRY}" "${RELEASE_PLUGIN_ENTRY}")
    if [ "$result" = "notfound" ]; then
      result=$(json_set_plugin "${TUI_CONFIG_FILE}" "uninstall" "${LEGACY_PLUGIN_ENTRY}" "${RELEASE_PLUGIN_ENTRY}")
    else
      json_set_plugin "${TUI_CONFIG_FILE}" "remove" "${LEGACY_PLUGIN_ENTRY}" "${RELEASE_PLUGIN_ENTRY}" >/dev/null
    fi
    case "$result" in
      release-exists) warn "Release plugin already registered in ${TUI_CONFIG_FILE}" ;;
      notfound)       warn "Plugin not found in ${TUI_CONFIG_FILE}" ;;
      ok)             info "Restored release plugin in ${TUI_CONFIG_FILE}" ;;
      *)              err "Unexpected result: $result"; exit 1 ;;
    esac
    echo ""
    echo -e "${GREEN}Uninstallation complete. Restart opencode.${NC}"
    ;;

  *)
    echo "Usage: $0 [install|uninstall]"
    echo "  Default: install"
    exit 1
    ;;
esac
