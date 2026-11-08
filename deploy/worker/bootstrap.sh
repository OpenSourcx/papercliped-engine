#!/usr/bin/env bash
# Turns a CLEAN Linux machine (NVIDIA Jetson, x86 with or without an NVIDIA GPU, any ARM64 board) into an ePaperclip AI server:
# prerequisites, Tailscale, Ollama (checksum verified, bound to the tailnet or loopback only), models that fit the hardware,
# the epaperclip-worker daemon as a system service under its own unprivileged user, and a small root helper for the
# management actions the console can ask for. Run it as root from the unpacked worker release (next to install.sh).
#
#   sudo ./bootstrap.sh --check                  show what it found and what it would do; changes nothing
#   sudo ./bootstrap.sh                          set everything up (asks before downloading models)
#   sudo ./bootstrap.sh --yes --models auto      no questions; pull the recommended model(s) for this hardware
#   sudo ./bootstrap.sh --upgrade                move Ollama to the newest release and the worker to this bundle
#   sudo ./bootstrap.sh --uninstall [--purge] [--purge-models]
#   sudo ./bootstrap.sh --pin-host-key           (re)record the host key from the worker's adoption, enabling signed updates
#   Options: --models auto|none|name[,name]  --name NAME  --host-code CODE  --host-url URL --host-key KEY
#            --no-tailscale  --no-ollama  --ollama-version V  --ollama-sha256 HEX  --tarball FILE --sha256 HEX  --yes
#   Environment: TS_AUTHKEY (Tailscale auth key, read from the environment so it never appears in a process list)
#
# Promises: reads and reports before changing; every change is appended to /var/lib/epaperclip-worker/bootstrap.log and the
# things it created are listed in bootstrap.manifest so --uninstall removes exactly those; it never installs or replaces GPU
# drivers (Jetson: the system's L4T runtime is used as is; x86: nvidia-smi is checked and driver install is documented);
# it never listens on a public address (Ollama: tailnet or loopback; the worker only connects out); no curl-pipe-shell.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${EPB_ROOT:-}"                       # tests point hardware detection at recorded fixtures
STATE="${EPB_STATE:-/var/lib/epaperclip-worker}"
LOG="$STATE/bootstrap.log"; MANIFEST="$STATE/bootstrap.manifest"
SVC_USER="${EPW_USER:-epaperclip-worker}"
ADMIN_DIR="/usr/local/lib/epaperclip-worker"; ADMIN="$ADMIN_DIR/epw-admin"
KEY_FILE="/etc/epaperclip-worker/host.pub"
SUDOERS="/etc/sudoers.d/epaperclip-worker"
OLLAMA_UNIT_DIR="/etc/systemd/system"
OLLAMA_PORT=11434
MODE=setup CHECK=0 YES=0 PURGE=0 PURGE_MODELS=0
MODELS=ask NAME="" HOST_CODE="" HOST_URL="" HOST_KEY="" NO_TS=0 NO_OLLAMA=0 OLLAMA_VERSION="${EPB_OLLAMA_VERSION:-}" OLLAMA_SHA="" TARBALL="" SHA=""

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then B=$'\e[1m'; R=$'\e[0m'; else B=""; R=""; fi
say()  { echo "bootstrap: $*"; }
warn() { echo "bootstrap: WARNING: $*" >&2; }
die()  { echo "bootstrap: $*" >&2; exit 1; }
# One line per change; the manifest says what --uninstall may remove.
note() { [ "$CHECK" = 1 ] && return 0; mkdir -p "$STATE"; printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >> "$LOG"; }
made() { [ "$CHECK" = 1 ] && return 0; mkdir -p "$STATE"; grep -qxF "$*" "$MANIFEST" 2>/dev/null || echo "$*" >> "$MANIFEST"; note "created $*"; }
did()  { if [ "$CHECK" = 1 ]; then echo "  would: $*"; return 1; fi; say "$*"; return 0; }

# ---------------------------------------------------------------- hardware (pure; reads $ROOT so tests can use fixtures)
detect_hw() {
  ARCH_RAW="${EPB_ARCH:-$(uname -m)}"
  case "$ARCH_RAW" in x86_64|amd64) ARCH=amd64 ;; aarch64|arm64) ARCH=arm64 ;; *) ARCH="$ARCH_RAW" ;; esac
  RAM_MB=0
  if [ -r "$ROOT/proc/meminfo" ]; then RAM_MB=$(awk '/^MemTotal:/ {printf "%d", $2/1024}' "$ROOT/proc/meminfo"); fi
  MODEL="$(tr -d '\0' < "$ROOT/proc/device-tree/model" 2>/dev/null | sed 's/ *$//' || true)"
  L4T=""; JP=""
  if [ -r "$ROOT/etc/nv_tegra_release" ]; then
    L4T="$(sed -n 's/^# R\([0-9]*\) .*/\1/p' "$ROOT/etc/nv_tegra_release" | head -1)"
  fi
  if [ -n "$L4T" ] || printf '%s' "$MODEL" | grep -qiE 'jetson|tegra|orin'; then
    HW=jetson
    # Ollama publishes JetPack 5 (L4T R35) and JetPack 6 (R36) bundles; newer L4T (JetPack 7) uses the regular arm64 bundle.
    case "$L4T" in 35) JP=jetpack5 ;; 36) JP=jetpack6 ;; *) JP="" ;; esac
  elif [ "$ARCH" = arm64 ]; then HW=arm64
  else HW=x86; fi
  GPU=none
  if [ "$HW" = jetson ]; then GPU="${MODEL:-NVIDIA Jetson}"
  elif command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then GPU="$(nvidia-smi --query-gpu=name --format=csv,noheader | head -1)"
  elif command -v lspci >/dev/null 2>&1 && lspci 2>/dev/null | grep -qiE 'nvidia.*(vga|3d|display)'; then GPU="NVIDIA GPU (driver not working: nvidia-smi fails or is missing)"
  fi
  # Memory tier decides context length and the model list. Orin Nano class (8 GB) is "small".
  if   [ "$RAM_MB" -lt 3500 ];  then TIER=tiny;   CTX=2048;  MODEL_LIST="qwen2.5-coder:0.5b"; MODEL_MB=400
  elif [ "$RAM_MB" -lt 6000 ];  then TIER=tiny;   CTX=2048;  MODEL_LIST="qwen2.5-coder:1.5b"; MODEL_MB=1000
  elif [ "$RAM_MB" -lt 12000 ]; then TIER=small;  CTX=4096;  MODEL_LIST="qwen2.5-coder:3b";   MODEL_MB=1950
  elif [ "$RAM_MB" -lt 24000 ]; then TIER=medium; CTX=8192;  MODEL_LIST="qwen2.5-coder:7b";   MODEL_MB=4800
  else                               TIER=large;  CTX=16384; MODEL_LIST="qwen2.5-coder:14b";  MODEL_MB=9200; fi
}

# Approximate download sizes (MB) of models we recommend or accept by name, for the guard. Unknown names are refused unless sized.
model_mb() { case "$1" in
  qwen2.5-coder:0.5b) echo 400 ;; qwen2.5-coder:1.5b) echo 1000 ;; qwen2.5-coder:3b) echo 1950 ;; qwen2.5-coder:7b) echo 4800 ;; qwen2.5-coder:14b) echo 9200 ;;
  llama3.2:1b) echo 1300 ;; llama3.2:3b) echo 2100 ;; *) echo 0 ;; esac; }

# A model is allowed when it fits memory with headroom (weights x1.5 <= 85% of RAM) and disk (x2 plus 2 GB free).
guard_model() {
  local m="$1" mb free
  mb="$(model_mb "$m")"
  [ "$mb" -gt 0 ] || { warn "$m: unknown size, not pulled automatically (pull it from the console once you know it fits)"; return 1; }
  [ $((mb * 15 / 10)) -le $((RAM_MB * 85 / 100)) ] || { warn "$m (about $mb MB) does not fit comfortably in $RAM_MB MB of RAM; skipped"; return 1; }
  free=$(df -Pm "${OLLAMA_MODELS_DIR:-/var/lib}" 2>/dev/null | awk 'NR==2 {print $4}' || echo 0)
  [ "${free:-0}" -ge $((mb * 2 + 2048)) ] || { warn "$m needs about $((mb * 2 + 2048)) MB free disk, only ${free:-0} MB is free; skipped"; return 1; }
  return 0
}

# Sourcing for tests: functions only.
[ -z "${EPB_LIB:-}" ] || return 0 2>/dev/null || true

# ---------------------------------------------------------------- args
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1 ;; --yes|-y) YES=1 ;; --upgrade) MODE=upgrade ;; --uninstall) MODE=uninstall ;; --pin-host-key) MODE=pin ;;
    --purge) PURGE=1 ;; --purge-models) PURGE_MODELS=1 ;;
    --models) MODELS="${2:?--models needs auto, none or a list}"; shift ;;
    --name) NAME="${2:?}"; shift ;; --host-code) HOST_CODE="${2:?}"; shift ;; --host-url) HOST_URL="${2:?}"; shift ;; --host-key) HOST_KEY="${2:?}"; shift ;;
    --no-tailscale) NO_TS=1 ;; --no-ollama) NO_OLLAMA=1 ;;
    --ollama-version) OLLAMA_VERSION="${2:?}"; shift ;; --ollama-sha256) OLLAMA_SHA="${2:?}"; shift ;;
    --tarball) TARBALL="${2:?}"; shift ;; --sha256) SHA="${2:?}"; shift ;;
    -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
  shift
done

# ---------------------------------------------------------------- helpers
have() { command -v "$1" >/dev/null 2>&1; }
sha_of() { sha256sum "$1" | cut -d' ' -f1; }
apt_ok() { have apt-get; }
need_root() { [ "$CHECK" = 1 ] || [ "$(id -u)" = 0 ] || die "run as root (sudo ./bootstrap.sh)"; }
installed_pkg() { dpkg -s "$1" >/dev/null 2>&1; }

preflight() {
  [ "$(uname -s)" = Linux ] || die "Linux only ($(uname -s) found)"
  case "$ARCH" in amd64|arm64) ;; *) die "unsupported CPU architecture $ARCH_RAW" ;; esac
  HAVE_SYSTEMD=0; [ -d /run/systemd/system ] && HAVE_SYSTEMD=1
  [ "$HAVE_SYSTEMD" = 1 ] || { [ "$CHECK" = 1 ] && warn "systemd is not running here; a real setup needs it" || die "systemd must be running (PID 1) so the services start at boot"; }
  [ -r /etc/os-release ] && . /etc/os-release || true
  DISTRO="${ID:-unknown}"; CODENAME="${VERSION_CODENAME:-}"
  case "$DISTRO" in debian|ubuntu) ;; *) warn "$DISTRO is not Debian/Ubuntu: packages are not installed for you. Install curl, ca-certificates, zstd, tar, sudo and tailscale yourself first." ;; esac
  case "$TIER" in tiny) [ "$RAM_MB" -ge 3500 ] || warn "only $RAM_MB MB of RAM: only the smallest models will run" ;; esac
}

report() {
  echo
  echo "  ${B}What this machine is${R}"
  echo "    class      : $HW$([ -n "$L4T" ] && echo " (L4T R$L4T${JP:+, Ollama bundle: $JP})")  arch: $ARCH"
  echo "    board      : ${MODEL:-n/a}"
  echo "    memory     : $RAM_MB MB -> tier $TIER (context $CTX, recommended model: $MODEL_LIST)"
  echo "    GPU        : $GPU"
  case "$HW" in
    jetson) echo "    CUDA       : uses the system's L4T runtime; this script never installs or changes NVIDIA drivers" ;;
    x86|arm64) if [ "$GPU" != none ]; then echo "    CUDA       : $(have nvidia-smi && echo 'nvidia-smi present' || echo 'NO nvidia-smi: install the NVIDIA driver from your distribution first (Ubuntu: ubuntu-drivers install), then re-run. Until then Ollama runs on the CPU.')"; else echo "    CUDA       : no NVIDIA GPU; models run on the CPU (slower)"; fi ;;
  esac
  echo "    OS         : ${PRETTY_NAME:-$DISTRO}   systemd: $([ "${HAVE_SYSTEMD:-0}" = 1 ] && echo yes || echo no)"
  echo "    installed  : tailscale $(have tailscale && echo yes || echo no), ollama $(have ollama && echo "yes ($(ollama --version 2>&1 | grep -o '[0-9][0-9.]*' | head -1))" || echo no), worker $([ -f /opt/epaperclip-worker/epaperclip-worker.mjs ] && echo yes || echo no)"
  echo
}

# ---------------------------------------------------------------- steps
step_packages() {
  local want=(curl ca-certificates zstd tar xz-utils sudo) miss=()
  for p in "${want[@]}"; do installed_pkg "$p" || miss+=("$p"); done
  [ ${#miss[@]} -gt 0 ] || return 0
  apt_ok || { warn "missing packages: ${miss[*]} (install them with your package manager)"; return 0; }
  did "installing prerequisite packages: ${miss[*]}" || return 0
  DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "${miss[@]}" >/dev/null
  note "installed packages ${miss[*]}"
}

step_tailscale() {
  [ "$NO_TS" = 0 ] || { say "skipping Tailscale (--no-tailscale)"; return 0; }
  if ! have tailscale; then
    if [ "$DISTRO" != debian ] && [ "$DISTRO" != ubuntu ]; then warn "install Tailscale for $DISTRO: https://tailscale.com/download/linux (then re-run)"; return 0; fi
    did "adding the Tailscale apt repository and installing tailscale" || return 0
    install -d -m 0755 /usr/share/keyrings
    curl -fsSL "https://pkgs.tailscale.com/stable/$DISTRO/$CODENAME.noarmor.gpg" -o /usr/share/keyrings/tailscale-archive-keyring.gpg
    curl -fsSL "https://pkgs.tailscale.com/stable/$DISTRO/$CODENAME.tailscale-keyring.list" -o /etc/apt/sources.list.d/tailscale.list
    made "file /usr/share/keyrings/tailscale-archive-keyring.gpg"; made "file /etc/apt/sources.list.d/tailscale.list"
    DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq tailscale >/dev/null
    made "pkg tailscale"
  fi
  [ "${HAVE_SYSTEMD:-0}" = 1 ] && { systemctl enable --now tailscaled >/dev/null 2>&1 || true; }
  if [ -n "${TS_AUTHKEY:-}" ] && ! tailscale ip -4 >/dev/null 2>&1; then
    did "joining the tailnet with TS_AUTHKEY" && { local kf; kf="$(mktemp)"; chmod 600 "$kf"; printf '%s' "$TS_AUTHKEY" > "$kf"; tailscale up --auth-key="file:$kf" --hostname="${NAME:-$(hostname)}" >/dev/null || warn "tailscale up failed"; rm -f "$kf"; note "tailscale up"; }
  fi
  TS_IP="$(tailscale ip -4 2>/dev/null | head -1 || true)"
  if [ -z "$TS_IP" ]; then say "Tailscale is installed but this machine is not on a tailnet yet. Run:  sudo tailscale up   (or re-run with TS_AUTHKEY set). Until then Ollama listens on loopback only."; else say "Tailscale address $TS_IP"; fi
}

ollama_asset_names() {
  OLLAMA_ASSETS=("ollama-linux-$ARCH.tar.zst")
  [ -z "$JP" ] || OLLAMA_ASSETS+=("ollama-linux-arm64-$JP.tar.zst")
}

step_ollama() {
  [ "$NO_OLLAMA" = 0 ] || { say "skipping Ollama (--no-ollama)"; return 0; }
  local base mirror="${EPB_MIRROR:-https://github.com/ollama/ollama/releases/download}"
  if [ -z "$OLLAMA_VERSION" ]; then
    if [ "$CHECK" = 1 ] && [ -n "${EPB_NO_NET:-}" ]; then OLLAMA_VERSION="(latest)"; else
      OLLAMA_VERSION="$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/ollama/ollama/releases/latest 2>/dev/null | sed 's|.*/||' || true)"
      [ -n "$OLLAMA_VERSION" ] || { [ "$CHECK" = 1 ] && OLLAMA_VERSION="(latest)" || die "could not find the latest Ollama release; pass --ollama-version vX.Y.Z"; }
    fi
  fi
  case "$OLLAMA_VERSION" in v*|\(*) ;; *) OLLAMA_VERSION="v$OLLAMA_VERSION" ;; esac
  ollama_asset_names
  local have_v=""; have ollama && have_v="v$(ollama --version 2>&1 | grep -o '[0-9]\+\.[0-9]\+\.[0-9]\+' | head -1)"
  if [ "$have_v" = "$OLLAMA_VERSION" ] || { [ -n "$have_v" ] && [ "$MODE" != upgrade ]; }; then say "Ollama $have_v already installed"; else
    did "downloading Ollama $OLLAMA_VERSION (${OLLAMA_ASSETS[*]}) and verifying SHA-256" || true
    if [ "$CHECK" = 0 ]; then
      base="$mirror/$OLLAMA_VERSION"
      local d; d="$(mktemp -d /var/tmp/epb.XXXXXX)"; TMPD="$d"; trap 'rm -rf "${TMPD:-}"' EXIT
      curl -fsSL --retry 3 -o "$d/sha256sum.txt" "$base/sha256sum.txt" || die "could not download $base/sha256sum.txt"
      local a want
      for a in "${OLLAMA_ASSETS[@]}"; do
        want="${OLLAMA_SHA:-$(awk -v f="$a" '$2==f || $2=="*"f || $2=="./"f {print $1}' "$d/sha256sum.txt" | head -1)}"
        [ -n "$want" ] || die "no checksum for $a in the release's sha256sum.txt"
        curl -fL --retry 3 -o "$d/$a" "$base/$a" || die "download of $a failed"
        [ "$(sha_of "$d/$a")" = "$want" ] || die "checksum mismatch for $a (expected $want). Nothing was installed."
        say "$a verified"
      done
      for a in "${OLLAMA_ASSETS[@]}"; do tar -I zstd -xf "$d/$a" -C /usr/local; done
      made "file /usr/local/bin/ollama"; made "dir /usr/local/lib/ollama"
      note "installed ollama $OLLAMA_VERSION"
      rm -rf "$d"; TMPD=""
    fi
  fi
  # Service user and unit (same shape as the reference node's).
  if ! id ollama >/dev/null 2>&1; then
    did "creating the system user ollama" && { useradd --system --user-group --home-dir /var/lib/ollama --create-home --shell /usr/sbin/nologin ollama; made "user ollama"; }
  fi
  if [ "$CHECK" = 0 ]; then for g in render video; do getent group "$g" >/dev/null 2>&1 && usermod -aG "$g" ollama || true; done; fi
  local bind="127.0.0.1" wait=""
  [ -z "${TS_IP:-}" ] || { bind="$TS_IP"; wait="ExecStartPre=/bin/sh -c 'for i in \$(seq 1 120); do ip -4 addr show | grep -q \"inet $TS_IP/\" && exit 0; sleep 1; done; exit 1'"; }
  OLLAMA_BIND="$bind:$OLLAMA_PORT"
  if did "writing the Ollama service (listens on $OLLAMA_BIND only; 1 model loaded, 1 request at a time, context $CTX, keep-alive 10m)"; then
    cat > "$OLLAMA_UNIT_DIR/ollama.service" <<UNIT
[Unit]
Description=Ollama Service (set up by the ePaperclip worker bootstrap)
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/ollama serve
User=ollama
Group=ollama
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectHome=true
Environment="PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

[Install]
WantedBy=multi-user.target
UNIT
    mkdir -p "$OLLAMA_UNIT_DIR/ollama.service.d"
    cat > "$OLLAMA_UNIT_DIR/ollama.service.d/epaperclip.conf" <<CONF
# Written by the ePaperclip worker bootstrap. Never 0.0.0.0: Ollama has no login of its own.
[Service]
Environment="OLLAMA_HOST=$OLLAMA_BIND"
Environment="OLLAMA_MAX_LOADED_MODELS=1"
Environment="OLLAMA_NUM_PARALLEL=1"
Environment="OLLAMA_CONTEXT_LENGTH=$CTX"
Environment="OLLAMA_KEEP_ALIVE=10m"
${wait}
TimeoutStartSec=130
CONF
    made "file $OLLAMA_UNIT_DIR/ollama.service"; made "file $OLLAMA_UNIT_DIR/ollama.service.d/epaperclip.conf"
    if [ "${HAVE_SYSTEMD:-0}" = 1 ]; then systemctl daemon-reload; systemctl enable ollama >/dev/null 2>&1; systemctl restart ollama; fi
  fi
}

wait_ollama() {
  local i; for i in $(seq 1 60); do curl -fsS -m 2 "http://$OLLAMA_BIND/api/version" >/dev/null 2>&1 && return 0; sleep 1; done; return 1
}

step_worker() {
  local args=(--workspaces "${EPW_WORKSPACES:-/workspaces}")
  [ -n "$NAME" ] || NAME="$(hostname)"
  args+=(--name "$NAME" --max-context "$CTX" --slots 1)
  [ "$NO_OLLAMA" = 1 ] || args+=(--ollama-url "http://${OLLAMA_BIND:-127.0.0.1:$OLLAMA_PORT}")
  local nv=0; for n in /opt/epaperclip-worker/node/bin/node "$(command -v node || true)"; do [ -x "$n" ] && nv="$("$n" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" && [ "$nv" -ge 22 ] && break; done
  [ "$nv" -ge 22 ] 2>/dev/null || args+=(--fetch-node)
  if [ -n "$TARBALL" ]; then args+=(--tarball "$TARBALL" --sha256 "$SHA"); fi
  [ -f "$HERE/install.sh" ] || die "install.sh is not next to bootstrap.sh; run this from the unpacked worker release"
  if did "installing the worker as a system service under the user $SVC_USER (install.sh ${args[*]})"; then
    EPW_USER="$SVC_USER" bash "$HERE/install.sh" "${args[@]}"
    made "dir /opt/epaperclip-worker"; made "file /etc/systemd/system/epaperclip-worker.service"; made "file /usr/local/bin/epaperclip-worker"; made "user $SVC_USER"
    getent group systemd-journal >/dev/null 2>&1 && usermod -aG systemd-journal "$SVC_USER" || true
  fi
}

step_admin() {
  if did "installing the root helper $ADMIN and its sudo rule (restart worker, restart Ollama, signed update only)"; then
    install -d -m 0755 -o root -g root "$ADMIN_DIR" /etc/epaperclip-worker
    cat > "$ADMIN.tmp" <<'ADMINSH'
#!/bin/sh
# Root helper for the ePaperclip worker. Installed by bootstrap.sh; owned by root; run by the worker user through sudo, by exact verb.
# It takes no arguments beyond the verb. Nothing here runs a command line supplied by the host or an agent.
set -eu
STATE="${EPW_STATE:-/var/lib/epaperclip-worker}"; PREFIX=/opt/epaperclip-worker; PUB=/etc/epaperclip-worker/host.pub
case "${1:-}" in
  restart-worker) exec systemctl restart --no-block epaperclip-worker ;;
  restart-ollama) systemctl restart ollama; for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do systemctl is-active --quiet ollama && exit 0; sleep 1; done; echo "ollama did not come back" >&2; exit 1 ;;
  update-worker)
    [ -s "$PUB" ] || { echo "no pinned host key ($PUB): run 'sudo bootstrap.sh --pin-host-key' once after adoption" >&2; exit 1; }
    T="$STATE/staging/update.tar.gz"; Q="$STATE/staging/request.json"
    [ -f "$T" ] && [ -f "$Q" ] || { echo "nothing staged" >&2; exit 1; }
    NODE="$PREFIX/node/bin/node"; [ -x "$NODE" ] || NODE="$(command -v node)"
    # Copy first so the worker user cannot swap files between the check and the install.
    W="$(mktemp -d /var/tmp/epw-upd.XXXXXX)"; install -m 0600 "$T" "$W/update.tar.gz"; install -m 0600 "$Q" "$W/request.json"
    ID="$("$NODE" -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).workerId||""' "$STATE/config.json")"
    "$NODE" "$PREFIX/epaperclip-worker.mjs" verify-update --pub "$PUB" --request "$W/request.json" --tarball "$W/update.tar.gz" --worker-id "$ID" || { rm -rf "$W"; exit 1; }
    SHA="$(sha256sum "$W/update.tar.gz" | cut -d' ' -f1)"
    rm -f "$T" "$Q"
    mkdir "$W/x"; tar -xzf "$W/update.tar.gz" -C "$W/x" --no-same-owner
    INST="$(dirname "$(find "$W/x" -name install.sh | head -1)")"
    # Outside the worker's cgroup, because the install restarts the worker.
    exec systemd-run --quiet --no-block --unit="epw-update-$$" /bin/sh -c "bash '$INST/install.sh' --tarball '$W/update.tar.gz' --sha256 '$SHA'; rm -rf '$W'"
    ;;
  *) echo "usage: epw-admin restart-worker|restart-ollama|update-worker" >&2; exit 2 ;;
esac
ADMINSH
    chmod 0755 "$ADMIN.tmp"; chown root:root "$ADMIN.tmp"; mv -f "$ADMIN.tmp" "$ADMIN"
    printf '%s ALL=(root) NOPASSWD: %s restart-worker, %s restart-ollama, %s update-worker\n' "$SVC_USER" "$ADMIN" "$ADMIN" "$ADMIN" > "$SUDOERS.tmp"
    chmod 0440 "$SUDOERS.tmp"
    if have visudo && ! visudo -cf "$SUDOERS.tmp" >/dev/null; then rm -f "$SUDOERS.tmp"; die "the sudo rule did not validate; nothing was changed"; fi
    mv -f "$SUDOERS.tmp" "$SUDOERS"
    made "file $ADMIN"; made "file $SUDOERS"; made "dir $ADMIN_DIR"
  fi
}

# Records the host key that adoption pinned, in a file only root can change. Signed updates are checked against it.
pin_host_key() {
  local cfg="$STATE/config.json" node
  node="/opt/epaperclip-worker/node/bin/node"; [ -x "$node" ] || node="$(command -v node)"
  [ -f "$cfg" ] || die "$cfg not found: adopt this worker first (epaperclip-worker adopt <code>)"
  local k; k="$("$node" -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).hostKey||""' "$cfg")"
  [ -n "$k" ] || die "this worker has not been adopted yet; no host key to pin"
  install -d -m 0755 /etc/epaperclip-worker
  printf '%s\n' "$k" > "$KEY_FILE.tmp"; chmod 0644 "$KEY_FILE.tmp"; mv -f "$KEY_FILE.tmp" "$KEY_FILE"
  made "file $KEY_FILE"; say "pinned host key (signed updates from that host are now accepted)"
}

step_adopt() {
  if [ -n "$HOST_CODE" ]; then
    did "adopting with the pairing code" && { /usr/local/bin/epaperclip-worker adopt "$HOST_CODE" ${NAME:+--name "$NAME"}; pin_host_key; }
  elif [ -n "$HOST_URL" ] && [ -n "$HOST_KEY" ]; then
    did "asking the host at $HOST_URL to adopt this worker" && { /usr/local/bin/epaperclip-worker adopt --url "$HOST_URL" --host-key "$HOST_KEY" ${NAME:+--name "$NAME"}; pin_host_key; }
  fi
}

step_models() {
  [ "$NO_OLLAMA" = 0 ] || return 0
  local list=()
  case "$MODELS" in
    none) return 0 ;;
    auto) list=("$MODEL_LIST") ;;
    ask) list=("$MODEL_LIST") ;;
    *) IFS=, read -r -a list <<< "$MODELS" ;;
  esac
  local m ok=()
  OLLAMA_MODELS_DIR=/var/lib/ollama
  for m in "${list[@]}"; do if guard_model "$m"; then ok+=("$m"); fi; done
  [ ${#ok[@]} -gt 0 ] || { say "no model passed the size check; pull one later from the console (Workers, Manage)"; return 0; }
  if [ "$CHECK" = 1 ]; then echo "  would: pull ${ok[*]} (after asking)"; return 0; fi
  if [ "$MODELS" = ask ] && [ "$YES" = 0 ]; then
    if [ -t 0 ]; then read -r -p "bootstrap: download ${ok[*]} (about $(model_mb "${ok[0]}") MB)? [y/N] " a; case "$a" in y|Y|yes) ;; *) say "skipped models; add them later from the console"; return 0 ;; esac
    else say "not asking (no terminal): skipped models. Re-run with --models auto (or --yes) to download ${ok[*]}"; return 0; fi
  fi
  wait_ollama || { warn "Ollama did not answer on $OLLAMA_BIND; models not pulled (journalctl -u ollama)"; return 0; }
  for m in "${ok[@]}"; do say "pulling $m"; OLLAMA_HOST="$OLLAMA_BIND" ollama pull "$m" && note "pulled model $m"; done
}

firewall_notes() {
  echo "  ${B}Firewall${R}: nothing was opened and nothing needs opening. The worker only connects out to your ePaperclip host;"
  echo "  Ollama listens on ${OLLAMA_BIND:-127.0.0.1:$OLLAMA_PORT} only$([ -z "${TS_IP:-}" ] && echo ' (loopback until this machine joins a tailnet)')."
  if have ufw && ufw status 2>/dev/null | grep -q "Status: active"; then echo "  ufw is active: no rule is needed for this setup; do not open $OLLAMA_PORT to the LAN."; fi
  if have firewall-cmd && firewall-cmd --state >/dev/null 2>&1; then echo "  firewalld is running: no rule is needed; do not open $OLLAMA_PORT."; fi
}

summary() {
  echo
  say "${B}done.${R} Log of every change: $LOG   Reverse it: sudo $0 --uninstall"
  firewall_notes
  echo
  if [ -z "$HOST_CODE$HOST_URL" ]; then
    echo "  ${B}Next: adopt this machine${R}"
    echo "    1. In the ePaperclip console open Workers, Add worker, choose Tailscale, copy the code (valid 15 minutes)."
    echo "    2. Run:  sudo epaperclip-worker adopt <code>"
    echo "    3. Then:  sudo $0 --pin-host-key     (enables signed updates from the console)"
    echo "    Check:   epaperclip-worker status    epaperclip-worker diagnose    epaperclip-worker stats"
  else
    echo "  Adoption was started; approve it in the console if it asks, then check:  epaperclip-worker status"
  fi
}

do_setup() {
  need_root
  detect_hw
  . /etc/os-release 2>/dev/null || true
  preflight
  report
  [ "$CHECK" = 0 ] || say "--check: nothing will be changed. Plan:"
  step_packages
  step_tailscale
  if [ "$HW" = x86 ] && [ "$GPU" = none ]; then :; fi
  step_ollama
  step_worker
  step_admin
  step_adopt
  step_models
  [ "$CHECK" = 1 ] || summary
  [ "$CHECK" = 0 ] || say "check complete."
}

do_uninstall() {
  need_root
  [ -f "$MANIFEST" ] || warn "no manifest ($MANIFEST): removing only the worker, the helper and the Ollama files this script names"
  say "removing what bootstrap created"
  if [ -d /run/systemd/system ]; then systemctl disable --now ollama >/dev/null 2>&1 || true; fi
  rm -f "$OLLAMA_UNIT_DIR/ollama.service" "$OLLAMA_UNIT_DIR/ollama.service.d/epaperclip.conf"; rmdir "$OLLAMA_UNIT_DIR/ollama.service.d" 2>/dev/null || true
  grep -qx 'file /usr/local/bin/ollama' "$MANIFEST" 2>/dev/null && { rm -f /usr/local/bin/ollama; rm -rf /usr/local/lib/ollama; }
  rm -f "$SUDOERS" "$ADMIN"; rmdir "$ADMIN_DIR" 2>/dev/null || true
  rm -f "$KEY_FILE"; rmdir /etc/epaperclip-worker 2>/dev/null || true
  [ -d /run/systemd/system ] && systemctl daemon-reload || true
  if [ -f "$HERE/install.sh" ]; then bash "$HERE/install.sh" --uninstall $([ "$PURGE" = 1 ] && echo --purge) || true; fi
  if [ "$PURGE_MODELS" = 1 ]; then rm -rf /var/lib/ollama; userdel ollama >/dev/null 2>&1 || true; say "models deleted"; else say "kept downloaded models in /var/lib/ollama (use --purge-models to delete them)"; fi
  say "Tailscale was left installed and joined (remove with: sudo tailscale logout; sudo apt-get remove tailscale). Remove this worker in the console too (Workers, Revoke)."
  [ "$PURGE" = 1 ] && rm -f "$MANIFEST" || true
}

case "$MODE" in
  setup|upgrade) do_setup ;;
  uninstall) do_uninstall ;;
  pin) need_root; pin_host_key ;;
esac
