#!/usr/bin/env bash
# Builds the LXC template that the Proxmox sandbox provider clones for every agent run.
#
# Run on a Proxmox VE host as root:
#
#   ./build-template.sh --ssh-public-key /path/to/engine_key.pub
#
# It downloads a Debian standard CT template with pveam, creates an unprivileged
# container, installs openssh-server, git, tar, curl, ca-certificates, Node.js
# (official tarball, checksum verified) and the agent CLIs, creates an `agent`
# user with a writable home, cleans up and converts the container to a template.
#
# It is safe to run again: an existing template built by this script is left
# alone (use --rebuild to replace it), a half-built one from a failed run is
# replaced, and anything else using the vmid is never touched.
set -euo pipefail

# ---------------------------------------------------------------------------
# Pinned versions. Checksums are from https://nodejs.org/dist/v24.21.0/SHASUMS256.txt
# ---------------------------------------------------------------------------
NODE_VERSION="24.21.0"
NODE_SHA256_X64="fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6"
NODE_SHA256_ARM64="6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2"

TEMPLATE_TAG="epaperclip-template"

# ---------------------------------------------------------------------------
# Defaults (override with flags)
# ---------------------------------------------------------------------------
VMID=9000
DEBIAN_RELEASE=12
ROOTFS_STORAGE="local-lvm"
TEMPLATE_STORAGE="local"
BRIDGE="vmbr0"
DISK_GB=8
MEMORY_MB=2048
CORES=2
HOSTNAME_VALUE="epaperclip-agent-template"
AGENT_USER="agent"
SSH_PUBLIC_KEY_FILE=""
CLAUDE_CODE_VERSION="latest"
CODEX_VERSION="latest"
REBUILD=0

usage() {
  cat <<'EOF'
Usage: build-template.sh [options]

  --ssh-public-key FILE    Public key the engine connects with (the public half of the
                           environment's sshPrivateKey). Authorized for root and the agent
                           user. Strongly recommended: clones cannot get keys any other way.
  --vmid N                 vmid of the template (default 9000)
  --debian 12|13           Debian release (default 12)
  --storage ID             Storage for the root disk (default local-lvm)
  --template-storage ID    Storage that holds CT templates (vztmpl) (default local)
  --bridge NAME            Bridge for the build container's network, DHCP (default vmbr0)
  --disk GB                Root disk size (default 8; clones can be grown, not shrunk)
  --memory MB              Memory while building (default 2048)
  --cores N                Cores while building (default 2)
  --hostname NAME          Hostname of the template (default epaperclip-agent-template)
  --agent-user NAME        Unprivileged user created for agents (default agent)
  --claude-code-version V  npm version of @anthropic-ai/claude-code (default latest)
  --codex-version V        npm version of @openai/codex (default latest)
  --rebuild                Replace an existing template built by this script
  -h, --help               Show this help
EOF
}

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

need_value() { [[ $# -ge 2 && -n "$2" ]] || die "$1 needs a value"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ssh-public-key) need_value "$@"; SSH_PUBLIC_KEY_FILE="$2"; shift 2 ;;
    --vmid) need_value "$@"; VMID="$2"; shift 2 ;;
    --debian) need_value "$@"; DEBIAN_RELEASE="$2"; shift 2 ;;
    --storage) need_value "$@"; ROOTFS_STORAGE="$2"; shift 2 ;;
    --template-storage) need_value "$@"; TEMPLATE_STORAGE="$2"; shift 2 ;;
    --bridge) need_value "$@"; BRIDGE="$2"; shift 2 ;;
    --disk) need_value "$@"; DISK_GB="$2"; shift 2 ;;
    --memory) need_value "$@"; MEMORY_MB="$2"; shift 2 ;;
    --cores) need_value "$@"; CORES="$2"; shift 2 ;;
    --hostname) need_value "$@"; HOSTNAME_VALUE="$2"; shift 2 ;;
    --agent-user) need_value "$@"; AGENT_USER="$2"; shift 2 ;;
    --claude-code-version) need_value "$@"; CLAUDE_CODE_VERSION="$2"; shift 2 ;;
    --codex-version) need_value "$@"; CODEX_VERSION="$2"; shift 2 ;;
    --rebuild) REBUILD=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------
[[ $EUID -eq 0 ]] || die "run as root on the Proxmox host"
for tool in pveam pct pvesm awk sort; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool not found: run this on a Proxmox VE host"
done
[[ "$VMID" =~ ^[1-9][0-9]{2,8}$ ]] || die "--vmid must be a number of 100 or more"
[[ "$DEBIAN_RELEASE" == 12 || "$DEBIAN_RELEASE" == 13 ]] || die "--debian must be 12 or 13"
[[ "$DISK_GB" =~ ^[1-9][0-9]*$ ]] || die "--disk must be a positive number of GB"
[[ "$MEMORY_MB" =~ ^[1-9][0-9]*$ ]] || die "--memory must be a positive number of MB"
[[ "$CORES" =~ ^[1-9][0-9]*$ ]] || die "--cores must be a positive number"
[[ "$AGENT_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ && "$AGENT_USER" != root ]] || die "--agent-user must be a plain user name other than root"
[[ "$HOSTNAME_VALUE" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$ ]] || die "--hostname must be a DNS label"
[[ "$CLAUDE_CODE_VERSION" =~ ^[A-Za-z0-9._-]+$ ]] || die "--claude-code-version looks wrong"
[[ "$CODEX_VERSION" =~ ^[A-Za-z0-9._-]+$ ]] || die "--codex-version looks wrong"
pvesm status --storage "$ROOTFS_STORAGE" >/dev/null 2>&1 || die "storage '$ROOTFS_STORAGE' not found (see pvesm status)"
pvesm status --storage "$TEMPLATE_STORAGE" >/dev/null 2>&1 || die "storage '$TEMPLATE_STORAGE' not found (see pvesm status)"
[[ -d "/sys/class/net/$BRIDGE" ]] || die "bridge '$BRIDGE' not found on this host"

SSH_PUBLIC_KEY=""
if [[ -n "$SSH_PUBLIC_KEY_FILE" ]]; then
  [[ -r "$SSH_PUBLIC_KEY_FILE" ]] || die "cannot read $SSH_PUBLIC_KEY_FILE"
  SSH_PUBLIC_KEY="$(grep -E '^(ssh-(ed25519|rsa)|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/=]+' "$SSH_PUBLIC_KEY_FILE" | head -n 1 || true)"
  [[ -n "$SSH_PUBLIC_KEY" ]] || die "$SSH_PUBLIC_KEY_FILE does not contain an OpenSSH public key"
  grep -q 'PRIVATE KEY' "$SSH_PUBLIC_KEY_FILE" && die "$SSH_PUBLIC_KEY_FILE is a private key; pass the .pub file"
else
  warn "no --ssh-public-key: clones will not accept the engine's key. Rebuild with --rebuild --ssh-public-key FILE before using the template."
fi

# ---------------------------------------------------------------------------
# What already uses the vmid?
# ---------------------------------------------------------------------------
CONF="/etc/pve/lxc/${VMID}.conf"
if [[ -e "/etc/pve/qemu-server/${VMID}.conf" ]]; then
  die "vmid $VMID is a virtual machine; pick another --vmid"
fi
if [[ -e "$CONF" ]]; then
  if ! grep -Eq "^tags:.*\b${TEMPLATE_TAG}\b" "$CONF"; then
    die "vmid $VMID is in use by a container this script did not build; pick another --vmid"
  fi
  if grep -Eq '^template: *1' "$CONF"; then
    if [[ $REBUILD -eq 0 ]]; then
      log "Template $VMID already exists (built by this script). Nothing to do; pass --rebuild to replace it."
      exit 0
    fi
    log "Replacing existing template $VMID (--rebuild)"
  else
    log "Found an unfinished build in container $VMID; replacing it"
  fi
  if pct status "$VMID" 2>/dev/null | grep -q running; then
    pct stop "$VMID"
  fi
  pct destroy "$VMID" --purge 1
fi

# ---------------------------------------------------------------------------
# Debian standard template
# ---------------------------------------------------------------------------
log "Updating the CT template catalogue"
pveam update >/dev/null || warn "pveam update failed; using the cached catalogue"
TEMPLATE_FILE="$(pveam available --section system | awk '{print $2}' | grep -E "^debian-${DEBIAN_RELEASE}-standard_.*_(amd64|arm64)\.tar\.(zst|gz|xz)$" | sort -V | tail -n 1 || true)"
[[ -n "$TEMPLATE_FILE" ]] || die "no debian-${DEBIAN_RELEASE}-standard template in the catalogue (pveam available --section system)"
if pveam list "$TEMPLATE_STORAGE" | awk '{print $1}' | grep -qx "${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE_FILE}"; then
  log "Using cached ${TEMPLATE_FILE}"
else
  log "Downloading ${TEMPLATE_FILE} to ${TEMPLATE_STORAGE}"
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE_FILE"
fi

# ---------------------------------------------------------------------------
# Build container
# ---------------------------------------------------------------------------
log "Creating unprivileged container $VMID"
pct create "$VMID" "${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE_FILE}" \
  --hostname "$HOSTNAME_VALUE" \
  --unprivileged 1 \
  --features nesting=1 \
  --ostype debian \
  --cores "$CORES" \
  --memory "$MEMORY_MB" \
  --swap 512 \
  --rootfs "${ROOTFS_STORAGE}:${DISK_GB}" \
  --net0 "name=eth0,bridge=${BRIDGE},ip=dhcp" \
  --onboot 0 \
  --tags "$TEMPLATE_TAG" \
  --description "Agent template for the ePaperclip Proxmox sandbox provider. Built $(date -u +%Y-%m-%dT%H:%M:%SZ) with Node.js ${NODE_VERSION}."

log "Starting container $VMID"
pct start "$VMID"

log "Waiting for the network"
for attempt in $(seq 1 60); do
  if pct exec "$VMID" -- sh -c 'getent hosts deb.debian.org >/dev/null 2>&1'; then
    break
  fi
  [[ $attempt -eq 60 ]] && die "container $VMID has no working network after 60 s (DHCP on $BRIDGE? DNS?)"
  sleep 1
done

# ---------------------------------------------------------------------------
# Provision inside the container
# ---------------------------------------------------------------------------
PROVISION="$(mktemp)"
KEYFILE="$(mktemp)"
trap 'rm -f "$PROVISION" "$KEYFILE"' EXIT
if [[ -n "$SSH_PUBLIC_KEY" ]]; then
  printf '%s\n' "$SSH_PUBLIC_KEY" > "$KEYFILE"
else
  : > "$KEYFILE"
fi

cat > "$PROVISION" <<'PROVISION_EOF'
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
  "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}"

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
for cmd in sh bash tar git curl node npm claude codex sshd setsid; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "missing: $cmd" >&2; exit 1; }
done
printf '     node %s, npm %s, git %s\n' "$(node --version)" "$(npm --version)" "$(git --version | awk '{print $3}')"
printf '     claude %s\n' "$(claude --version 2>/dev/null | head -n 1 || echo '?')"
printf '     codex %s\n' "$(codex --version 2>/dev/null | head -n 1 || echo '?')"

step "Cleaning up"
apt-get -y -qq autoremove --purge
apt-get clean
rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/* /root/.npm /root/.cache "$agent_home/.npm"
rm -f /root/.bash_history "$agent_home/.bash_history"
find /var/log -type f -exec truncate -s 0 {} +
journalctl --vacuum-time=1s >/dev/null 2>&1 || true
PROVISION_EOF

log "Provisioning (packages, Node.js ${NODE_VERSION}, agent CLIs)"
pct push "$VMID" "$PROVISION" /root/provision.sh --perms 0700
pct push "$VMID" "$KEYFILE" /root/engine_key.pub --perms 0600
pct exec "$VMID" -- env \
  NODE_VERSION="$NODE_VERSION" \
  NODE_SHA256_X64="$NODE_SHA256_X64" \
  NODE_SHA256_ARM64="$NODE_SHA256_ARM64" \
  CLAUDE_CODE_VERSION="$CLAUDE_CODE_VERSION" \
  CODEX_VERSION="$CODEX_VERSION" \
  AGENT_USER="$AGENT_USER" \
  bash /root/provision.sh
pct exec "$VMID" -- rm -f /root/provision.sh

# ---------------------------------------------------------------------------
# Convert to a template
# ---------------------------------------------------------------------------
log "Shutting down container $VMID"
pct shutdown "$VMID" --timeout 60 || pct stop "$VMID"
for _ in $(seq 1 30); do
  pct status "$VMID" | grep -q stopped && break
  sleep 1
done
pct status "$VMID" | grep -q stopped || die "container $VMID did not stop"

log "Converting container $VMID to a template"
pct template "$VMID"

cat <<EOF

Template ready: vmid ${VMID} (unprivileged, Debian ${DEBIAN_RELEASE}, Node.js ${NODE_VERSION}).

Use it in the Paperclip environment config:
  template: "${VMID}"
  sshUser:  "root"   (or "${AGENT_USER}" to run agents as the unprivileged user)

Give the engine's API token VM.Clone and VM.Audit on /vms/${VMID} only; keep the
template out of the agents' pool so the token cannot change or delete it.
EOF
