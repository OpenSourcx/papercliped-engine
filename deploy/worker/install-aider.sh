#!/usr/bin/env bash
set -euo pipefail

AIDER_VERSION="${EPC_AIDER_VERSION:-0.86.2}"
STATE_ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/epaperclip"
CONFIG_ROOT="${XDG_CONFIG_HOME:-$HOME/.config}/epaperclip"
BIN_ROOT="$HOME/.local/bin"
PIPX_HOME="${PIPX_HOME:-$HOME/.local/share/pipx}"
PIPX_BIN_DIR="${PIPX_BIN_DIR:-$HOME/.local/bin}"
export PIPX_HOME PIPX_BIN_DIR

say() { printf '[epaperclip-aider] %s\n' "$*"; }
die() { printf '[epaperclip-aider] ERROR: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required"; }

need python3
need git
need curl
need ollama

mem_mb=$(awk '/MemTotal:/ { printf "%d", $2/1024 }' /proc/meminfo)
if (( mem_mb < 3072 )); then die "Aider small-device lane needs at least 3 GiB RAM; detected ${mem_mb} MiB"; fi
if (( mem_mb < 6144 )); then
  tier=4gb; model=qwen2.5-coder:3b; aider_model=ollama_chat/qwen2.5-coder:3b; edit_format=whole; num_ctx=8192; map_tokens=512; max_files=1
elif (( mem_mb < 12288 )); then
  tier=8gb; model=qwen2.5-coder:7b; aider_model=ollama_chat/qwen2.5-coder:7b; edit_format=diff; num_ctx=8192; map_tokens=768; max_files=3
else
  tier=12gb+; model=qwen2.5-coder:7b; aider_model=ollama_chat/qwen2.5-coder:7b; edit_format=diff; num_ctx=16384; map_tokens=1024; max_files=3
fi
say "profile ${tier}: ${model}, ${edit_format}, num_ctx=${num_ctx}, max files=${max_files}"

if ! command -v pipx >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1 && command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    say "installing pipx from the OS package"
    sudo apt-get update -qq
    sudo apt-get install -y pipx python3-venv
  else
    say "bootstrapping pipx in a private venv"
    px="$HOME/.local/share/epaperclip/pipx-bootstrap"
    python3 -m venv "$px"
    "$px/bin/python" -m pip install --disable-pip-version-check --upgrade pip pipx
    mkdir -p "$BIN_ROOT"
    ln -sf "$px/bin/pipx" "$BIN_ROOT/pipx"
    export PATH="$BIN_ROOT:$PATH"
  fi
fi

say "installing pinned aider-chat ${AIDER_VERSION} with pipx"
pipx install --force "aider-chat==${AIDER_VERSION}"
aider_bin="$PIPX_BIN_DIR/aider"
[[ -x "$aider_bin" ]] || aider_bin=$(command -v aider || true)
[[ -n "$aider_bin" && -x "$aider_bin" ]] || die "pipx installed aider but no executable was found"

ollama_base="${EPC_OLLAMA_URL:-${OLLAMA_API_BASE:-}}"
if [[ -z "$ollama_base" && -n "${OLLAMA_HOST:-}" ]]; then
  ollama_base="$OLLAMA_HOST"
  [[ "$ollama_base" == http* ]] || ollama_base="http://$ollama_base"
fi
if [[ -z "$ollama_base" ]]; then
  listen=$(ss -ltnH 2>/dev/null | awk '$4 ~ /:11434$/ {print $4; exit}')
  addr=${listen%:11434}
  addr=$(printf '%s' "$addr" | sed 's/^\[//;s/\]$//')
  case "$addr" in
    ""|0.0.0.0|"*"|::) addr=127.0.0.1 ;;
  esac
  ollama_base="http://${addr}:11434"
fi
ollama_base=${ollama_base%/}
curl -fsS --max-time 5 "$ollama_base/api/tags" >/dev/null || die "Ollama is not reachable at $ollama_base"

say "ensuring ${model} is present through the existing Ollama listener"
OLLAMA_HOST="$ollama_base" ollama pull "$model"

mkdir -p "$CONFIG_ROOT" "$STATE_ROOT" "$BIN_ROOT"
settings="$CONFIG_ROOT/aider-model-settings.yml"
cat >"$settings" <<YAML
- name: ${aider_model}
  extra_params:
    num_ctx: ${num_ctx}
YAML
chmod 600 "$settings"
cat >"$CONFIG_ROOT/aider-profile.json" <<JSON
{"version":1,"tier":"${tier}","memoryMb":${mem_mb},"model":"${model}","aiderModel":"${aider_model}","editFormat":"${edit_format}","numCtx":${num_ctx},"mapTokens":${map_tokens},"maxEditableFiles":${max_files},"ollamaApiBase":"${ollama_base}","aiderVersion":"${AIDER_VERSION}"}
JSON
chmod 600 "$CONFIG_ROOT/aider-profile.json"

say "running local-model self-test"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cd "$tmp"
git init -q
git config user.email epaperclip-worker@localhost
git config user.name "ePaperclip Worker"
cat >calc.py <<'PY'
def add(a, b):
    return a - b
PY
cat >test_calc.py <<'PY'
import unittest
from calc import add
class AddTest(unittest.TestCase):
    def test_add(self):
        self.assertEqual(add(7, 5), 12)
if __name__ == "__main__":
    unittest.main()
PY
git add calc.py test_calc.py && git commit -qm baseline
cat >task.md <<'TASK'
Fix calc.py so add(a, b) returns the arithmetic sum. Edit calc.py only. Do not commit. The task is complete only when `python3 -m unittest -q` passes.
TASK
self_test_ok=0
for attempt in 1 2 3; do
  say "self-test attempt $attempt/3"
  OLLAMA_API_BASE="$ollama_base" "$aider_bin" \
    --model "$aider_model" --weak-model "$aider_model" --edit-format "$edit_format" \
    --model-settings-file "$settings" --map-tokens "$map_tokens" \
    --message-file task.md --test-cmd "python3 -m unittest -q" --auto-test \
    --yes-always --no-auto-commits --no-dirty-commits --no-auto-lint --no-gitignore \
    --no-check-update --no-show-release-notes --no-show-model-warnings --no-check-model-accepts-settings \
    --no-suggest-shell-commands --analytics-disable --no-pretty --no-stream calc.py || true
  if python3 -m unittest -q; then self_test_ok=1; break; fi
done
[[ "$self_test_ok" -eq 1 ]] || die "Aider self-test did not produce passing code after 3 attempts"
cat >"$BIN_ROOT/epaperclip-aider" <<WRAP
#!/bin/sh
export OLLAMA_API_BASE='${ollama_base}'
exec '${aider_bin}' "\$@"
WRAP
chmod 755 "$BIN_ROOT/epaperclip-aider"
cat >"$STATE_ROOT/aider-ready.json" <<JSON
{"ready":true,"aiderVersion":"${AIDER_VERSION}","model":"${model}","numCtx":${num_ctx},"testedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
JSON
chmod 600 "$STATE_ROOT/aider-ready.json"
say "aider ready: $($BIN_ROOT/epaperclip-aider --version | head -n1)"
say "restart/reconnect the worker daemon to publish the new aider capability immediately"
