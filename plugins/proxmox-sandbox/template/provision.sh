#!/usr/bin/env bash
# Runs inside the build container as root.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
step() { printf '  -> %s\n' "$*"; }

step "Installing packages"
apt-get update -qq
apt-get -y -qq -o Dpkg::Options::=--force-confold full-upgrade
apt-get -y -qq --no-install-recommends install \
  openssh-server git tar xz-utils curl ca-certificates procps less util-linux bash

step "Installing Node.js ${NODE_VERSION}"
case "$(dpkg --print-architecture)" in
  amd64) node_arch=x64; node_sha="$NODE_SHA256_X64" ;;
  arm64) node_arch=arm64; node_sha="$NODE_SHA256_ARM64" ;;
  *) echo "unsupported architecture $(dpkg --print-architecture)" >&2; exit 1 ;;
esac
tarball="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"
curl -fsSL --retry 3 -o "/tmp/${tarball}" "https://nodejs.org/dist/v${NODE_VERSION}/${tarball}"
echo "${node_sha}  /tmp/${tarball}" | sha256sum -c --quiet -
tar -xJf "/tmp/${tarball}" -C /usr/local --strip-components=1 --no-same-owner \
  --exclude='*/CHANGELOG.md' --exclude='*/README.md' --exclude='*/LICENSE'
rm -f "/tmp/${tarball}"
[[ "$(/usr/local/bin/node --version)" == "v${NODE_VERSION}" ]]

step "Installing agent CLIs"
/usr/local/bin/npm install -g --no-fund --no-audit --loglevel=error \
  "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" "@google/gemini-cli@${GEMINI_CLI_VERSION}" \
 "opencode-ai@${OPENCODE_VERSION}" "@mimo-ai/cli@${MIMO_CLI_VERSION}" "@mariozechner/pi-coding-agent@${PI_VERSION}" "@xai-official/grok@${GROK_CLI_VERSION}"

step "Creating user ${AGENT_USER}"
if ! id -u "$AGENT_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$AGENT_USER"
fi
agent_home="$(getent passwd "$AGENT_USER" | cut -d: -f6)"
install -d -m 0755 -o "$AGENT_USER" -g "$AGENT_USER" "$agent_home/paperclip-workspace" "$agent_home/.cache" "$agent_home/.config"

step "Authorizing the engine's SSH key"
for home_dir in /root "$agent_home"; do
  owner="$(stat -c %U "$home_dir")"
  install -d -m 0700 -o "$owner" -g "$owner" "$home_dir/.ssh"
  if [[ -s /root/engine_key.pub ]]; then
    install -m 0600 -o "$owner" -g "$owner" /root/engine_key.pub "$home_dir/.ssh/authorized_keys"
  fi
done
rm -f /root/engine_key.pub

step "Configuring sshd"
cat > /etc/ssh/sshd_config.d/10-epaperclip.conf <<'EOF'
# Key-only logins; nothing forwarded.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
X11Forwarding no
AllowAgentForwarding no
AllowTcpForwarding no
PermitTunnel no
EOF
sshd -t
systemctl enable ssh >/dev/null 2>&1 || true

step "Making every clone get its own SSH host keys and machine id"
cat > /etc/systemd/system/epaperclip-ssh-host-keys.service <<'EOF'
[Unit]
Description=Generate SSH host keys on first boot of a clone
ConditionPathExists=!/etc/ssh/ssh_host_ed25519_key
Before=ssh.service ssh.socket

[Service]
Type=oneshot
ExecStart=/usr/bin/ssh-keygen -A

[Install]
WantedBy=multi-user.target
RequiredBy=ssh.service
EOF
systemctl enable epaperclip-ssh-host-keys.service >/dev/null
rm -f /etc/ssh/ssh_host_*
truncate -s 0 /etc/machine-id
rm -f /var/lib/dbus/machine-id

step "Self-test"
for cmd in sh bash tar git curl node npm claude codex gemini opencode mimo pi grok sshd setsid; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "missing: $cmd" >&2; exit 1; }
done
printf '     node %s, npm %s, git %s\n' "$(node --version)" "$(npm --version)" "$(git --version | awk '{print $3}')"
printf '     claude %s\n' "$(claude --version 2>/dev/null | head -n 1 || echo '?')"
printf '     codex %s\n' "$(codex --version 2>/dev/null | head -n 1 || echo '?')"
printf '     gemini %s\n' "$(gemini --version 2>/dev/null | head -n 1 || echo '?')"
printf '     opencode %s\n' "$(opencode --version 2>/dev/null | head -n 1 || echo '?')"
printf '     mimo %s\n' "$(mimo --version 2>/dev/null | head -n 1 || echo '?')"
printf '     pi %s\n' "$(pi --version 2>/dev/null | head -n 1 || echo '?')"
printf '     grok %s\n' "$(grok --version 2>/dev/null | head -n 1 || echo '?')"

step "Cleaning up"
apt-get -y -qq autoremove --purge
apt-get clean
rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/* /root/.npm /root/.cache "$agent_home/.npm"
rm -f /root/.bash_history "$agent_home/.bash_history"
find /var/log -type f -exec truncate -s 0 {} +
journalctl --vacuum-time=1s >/dev/null 2>&1 || true
