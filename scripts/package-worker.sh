#!/usr/bin/env bash
# Builds the worker release: release/epaperclip-worker-<version>.tar.gz and its SHA256SUMS. Deterministic: the same
# commit gives the same bytes (sorted names, fixed times and owners, gzip without a timestamp).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
VER="$(node -p "require('./packages/worker-daemon/package.json').version")"
OUT="${1:-$ROOT/release}"
STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
D="$STAGE/epaperclip-worker-$VER"
mkdir -p "$D" "$OUT"
( cd packages/worker-daemon && ./node_modules/.bin/esbuild src/cli.ts --bundle --platform=node --target=node22 --format=esm --minify-syntax --outfile="$D/epaperclip-worker.mjs" --banner:js="#!/usr/bin/env node" >/dev/null )
cp deploy/worker/install.sh deploy/worker/bootstrap.sh deploy/worker/epaperclip-worker.service deploy/worker/epaperclip-worker.user.service "$D/"
echo "$VER" > "$D/VERSION"
cp docs/WORKER-FABRIC-GUIDE.md "$D/README.md" 2>/dev/null || true
chmod 0755 "$D/install.sh" "$D/bootstrap.sh"
( cd "$STAGE" && tar --sort=name --mtime='UTC 2026-01-01' --owner=0 --group=0 --numeric-owner -cf - "epaperclip-worker-$VER" | gzip -n -9 > "$OUT/epaperclip-worker-$VER.tar.gz" )
( cd "$OUT" && sha256sum "epaperclip-worker-$VER.tar.gz" > SHA256SUMS )
echo "built $OUT/epaperclip-worker-$VER.tar.gz"; cat "$OUT/SHA256SUMS"
