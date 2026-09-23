#!/usr/bin/env bash
# Sets bushwhack up from a clone: dependencies, the extension, and the `bushwhack` command
# on your PATH. Safe to run again (after a pull, for instance). Needs no root.
#
#   ./setup.sh                 # links the command into ~/.local/bin
#   ./setup.sh --dev           # the same, for development: no production extension build
#   ./setup.sh --standalone    # a minimal install: no Docker, no octopod — the chat's app is
#                              # the project's files served as they are, nothing run
#   BIN_DIR=~/bin ./setup.sh   # … or elsewhere
#
# The command is a link to bin/bushwhack, which runs the sources: a change to the code
# needs no new setup, only a restart of what runs it. Run it again after a dependency
# change. The mode (standalone or octopod) is kept across runs: `bushwhack mode` says it and
# changes it.
set -euo pipefail

DEV=0
STANDALONE=0
for arg in "$@"; do
  case "$arg" in
    --dev) DEV=1 ;;
    --standalone) STANDALONE=1 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg (see --help)" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

say "Checking requirements"
command -v node >/dev/null || fail "Node.js is not installed (22 or later is needed)"
major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 22 ] || fail "Node.js $(node -v) is too old: 22 or later is needed"
command -v npm >/dev/null || fail "npm is not installed"
echo "  node $(node -v)"

say "Installing dependencies"
(cd "$ROOT" && npm install --no-fund --no-audit)

if [ "$DEV" = 1 ]; then
  say "Extension: development build"
  echo "  not built here: npm run ext:watch builds extension/dist-dev on every change and reloads it"
else
  say "Building the extension"
  (cd "$ROOT" && npm run --silent ext:build)
  echo "  built into $ROOT/extension/dist"
fi

say "Linking the bushwhack command"
mkdir -p "$BIN_DIR"
target="$BIN_DIR/bushwhack"
if [ -e "$target" ] && [ "$(readlink -f "$target")" != "$ROOT/bin/bushwhack" ]; then
  fail "$target exists and is not this bushwhack; move it away, or run with BIN_DIR=<another folder>"
fi
ln -sfn "$ROOT/bin/bushwhack" "$target"
echo "  $target → $ROOT/bin/bushwhack"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not on your PATH: add  export PATH=\"$BIN_DIR:\$PATH\"  to your shell's profile" ;;
esac

[ "$STANDALONE" = 1 ] && "$ROOT/bin/bushwhack" mode standalone >/dev/null
MODE="$("$ROOT/bin/bushwhack" mode | awk '{print $1}')"

if [ "$MODE" = standalone ]; then
  say "Web app: standalone"
  echo "  the chat's app is the project's files served as they are, at http://<project>.localhost:<port>/:"
  echo "  HTML, CSS and JavaScript in the browser, nothing run on this machine — no Docker, no octopod"
  echo "  (for an app in containers, with a dev server and databases: bushwhack mode octopod)"
else
  say "Web app tools (optional)"
  if ! command -v docker >/dev/null; then
    warn "Docker is not installed: the chat will get the file and secret tools only (./setup.sh --standalone: its files served as a site instead)"
  elif ! docker compose version >/dev/null 2>&1; then
    warn "Docker Compose v2 (docker compose) is missing: the app tools need it"
  elif [ -n "${BUSHWHACK_OCTOPOD:-}" ] || command -v octopod >/dev/null; then
    OCTOPOD="${BUSHWHACK_OCTOPOD:-$(command -v octopod)}"
    # The contract bushwhack speaks (OCTOPOD_CONTRACT in packages/daemon/src/octopod-client.ts).
    said="$("$OCTOPOD" version --json 2>/dev/null || true)"
    contract="$(printf '%s' "$said" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s);console.log(v.contract+" "+v.version)}catch{console.log("none")}})')"
    case "$contract" in
      "1 "*) echo "  octopod: $OCTOPOD (${contract#* }, contract 1)" ;;
      none)  warn "octopod at $OCTOPOD does not answer \`octopod version\` (older than 0.1, or a broken install): npm i -g @quazardous/octopod — the app tools stay off until then" ;;
      *)     warn "octopod at $OCTOPOD speaks contract ${contract%% *}, this bushwhack contract 1: update the older of the two" ;;
    esac
  else
    warn "octopod is not on your PATH (nor BUSHWHACK_OCTOPOD set): the app tools stay off until it is"
    echo "  to install it:  npm i -g @quazardous/octopod && octopod setup   (not \`octopod\` alone: another project on npm)"
  fi
fi

if [ "$DEV" = 1 ]; then
  EXTENSION_STEP="1. Keep npm run ext:watch running, and start the browser with npm run chromium:
     it loads extension/dist-dev. Do not load extension/dist in the same browser too —
     two bushwhack extensions would both act on the chat pages."
else
  EXTENSION_STEP="1. Load the extension once: chrome://extensions → Developer mode → Load unpacked →
     $ROOT/extension/dist
     (after a later ./setup.sh, press its reload button there)"
fi

cat <<EOF

$(say "Done. Next:")
  $EXTENSION_STEP
  2. In each folder a chat should work on:  bushwhack add
     (the first bushwhack command starts the service: systemd --user, or in the background)
  3. In a terminal you keep open:  bushwhack approvals   (writes wait for your yes there)
  4. On a meta.ai or Gemini conversation, open the bushwhack popup: pair once with the code
     bushwhack list shows, then "Use for this chat" and "Insert the tools manifest".

  More: $ROOT/docs/QUICKSTART.md
EOF
