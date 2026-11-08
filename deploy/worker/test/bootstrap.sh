#!/usr/bin/env bash
# Tests the pure parts of deploy/worker/bootstrap.sh against recorded fixtures of the reference Jetson Orin Nano and synthetic machines.
# No root, no network, no systemd. The full install on a clean Debian/Ubuntu with real systemd is deploy/worker/test/container.sh.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$HERE/../../.." && pwd)"
FX="$REPO/packages/worker-daemon/test/fixtures/orion/root"
pass=0; fail=0
eq() { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ok   $1"; else fail=$((fail+1)); echo "  FAIL $1: expected '$3' got '$2'"; fi; }
detect() { ( export EPB_LIB=1 EPB_ROOT="$1" EPB_ARCH="$2"; source "$REPO/deploy/worker/bootstrap.sh"; detect_hw; echo "$HW $ARCH $TIER $CTX $MODEL_LIST L4T=$L4T JP=$JP RAM=$RAM_MB" ); }

echo "hardware detection"
eq "Orion fixture is a Jetson, arm64, small tier" "$(detect "$FX" aarch64)" "jetson arm64 small 4096 qwen2.5-coder:3b L4T=39 JP= RAM=7485"

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mk() { mkdir -p "$T/$1/proc" "$T/$1/etc"; printf 'MemTotal: %d kB\n' $(($2 * 1024)) > "$T/$1/proc/meminfo"; }
mk x86-16 16000; eq "x86 16 GB is x86/medium" "$(detect "$T/x86-16" x86_64)" "x86 amd64 medium 8192 qwen2.5-coder:7b L4T= JP= RAM=16000"
mk x86-64 64000; eq "x86 64 GB is large" "$(detect "$T/x86-64" x86_64 | cut -d' ' -f1-5)" "x86 amd64 large 16384 qwen2.5-coder:14b"
mk pi-4 4000; eq "generic arm64 4 GB is tiny with the 1.5b model" "$(detect "$T/pi-4" aarch64 | cut -d' ' -f1-5)" "arm64 arm64 tiny 2048 qwen2.5-coder:1.5b"
mk pi-2 2000; eq "2 GB gets the 0.5b model" "$(detect "$T/pi-2" aarch64 | cut -d' ' -f5)" "qwen2.5-coder:0.5b"
mk jp6 8000; printf '# R36 (release), REVISION: 4.0, GCID: 1, BOARD: generic, EABI: aarch64\n' > "$T/jp6/etc/nv_tegra_release"
eq "L4T R36 maps to the JetPack 6 Ollama bundle" "$(detect "$T/jp6" aarch64 | cut -d' ' -f1,6,7)" "jetson L4T=36 JP=jetpack6"
mk jp5 8000; printf '# R35 (release), REVISION: 6.0\n' > "$T/jp5/etc/nv_tegra_release"
eq "L4T R35 maps to the JetPack 5 bundle" "$(detect "$T/jp5" aarch64 | cut -d' ' -f7)" "JP=jetpack5"

echo "model guard"
guard() { ( export EPB_LIB=1 EPB_ROOT="$FX" EPB_ARCH=aarch64; source "$REPO/deploy/worker/bootstrap.sh"; detect_hw; OLLAMA_MODELS_DIR=/tmp; guard_model "$1" >/dev/null 2>&1 && echo allow || echo refuse ); }
eq "3b fits the 8 GB Orin" "$(guard qwen2.5-coder:3b)" allow
eq "7b (about 4.8 GB) is refused on 8 GB" "$(guard qwen2.5-coder:7b)" refuse
eq "14b refused" "$(guard qwen2.5-coder:14b)" refuse
eq "unknown model name is not pulled automatically" "$(guard some/unknown:99b)" refuse

echo "arguments"
eq "--help exits 0 and mentions --check" "$(bash "$REPO/deploy/worker/bootstrap.sh" --help | grep -c -- '--check')" 1
bash "$REPO/deploy/worker/bootstrap.sh" --bogus >/dev/null 2>&1; eq "unknown option fails" "$?" 1
out="$(EPB_ROOT="$FX" EPB_ARCH=aarch64 EPB_NO_NET=1 bash "$REPO/deploy/worker/bootstrap.sh" --check --ollama-version v0.40.15 --name orion 2>&1)"
eq "--check names the Jetson and changes nothing" "$(echo "$out" | grep -c 'class      : jetson')" 1
eq "--check says drivers are never touched" "$(echo "$out" | grep -c 'never installs or changes NVIDIA drivers')" 1
eq "--check plans a loopback or tailnet Ollama" "$(echo "$out" | grep -Ec 'would: writing the Ollama service \(listens on (127\.0\.0\.1|100\.)')" 1
eq "--check never writes the state log" "$(test -e /var/lib/epaperclip-worker/bootstrap.log && echo yes || echo no)" no

echo; echo "bootstrap (fixtures): $pass passed, $fail failed"
[ "$fail" = 0 ]
