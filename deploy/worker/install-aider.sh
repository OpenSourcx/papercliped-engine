#!/usr/bin/env bash
# Run through `sudo epaperclip-worker install-aider` so this runs as the worker account.
# Tool installation is independent of model download and coding qualification.
set -euo pipefail
[[ $(id -u) != 0 ]] || { echo 'Run this as the worker account, not root.' >&2; exit 1; }
command -v python3 >/dev/null || { echo 'Install Python 3 and its venv package first.' >&2; exit 1; }
[[ -n ${HOME:-} && -d $HOME && -w $HOME ]] || { echo 'The worker account needs a writable home directory.' >&2; exit 1; }
umask 077
aider_env="$HOME/.local/share/epaperclip/aider-0.86.2"
python3 -m venv "$aider_env"
"$aider_env/bin/python" -m pip install --disable-pip-version-check 'aider-chat==0.86.2'
"$aider_env/bin/aider" --version
mkdir -p "$HOME/.local/bin"
ln -sfn "$aider_env/bin/aider" "$HOME/.local/bin/aider"
echo 'Aider is installed for this account. No model was loaded or qualified.'
echo 'With the worker drained and its inference gate running: epaperclip-worker qualify --model qwen2.5-coder:3b'
