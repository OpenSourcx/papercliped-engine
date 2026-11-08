#!/usr/bin/env bash
# DEV-ONLY signed catalog for live checks. Generates a throwaway keypair OUTSIDE the repository, publishes a one-entry
# catalog with the real scripts, and prints nothing secret. Not a production key and never to be pinned on a real device.
#   REGISTRY=http://127.0.0.1:4873 scripts/live-engine/publish-dev-catalog.sh /project/.work/dev-keys
set -euo pipefail
OUT="${1:?usage: publish-dev-catalog.sh <dir outside the repo>}"; REPO="$(cd "$(dirname "$0")/../.." && pwd)"
case "$(cd "$OUT" 2>/dev/null && pwd || echo "$OUT")" in "$REPO"*) echo "refusing to write keys inside the repository" >&2; exit 2;; esac
mkdir -p "$OUT"; chmod 700 "$OUT"; cd "$REPO"
umask 077
node scripts/marketplace-keygen.mjs > "$OUT/keygen.out"
python3 - "$OUT" <<'PY'
import re,sys
o=sys.argv[1]; t=open(o+'/keygen.out').read()
pub=re.search(r'(-----BEGIN PUBLIC KEY-----.*?-----END PUBLIC KEY-----)',t,re.S).group(1)
prv=re.search(r'(-----BEGIN PRIVATE KEY-----.*?-----END PRIVATE KEY-----)',t,re.S).group(1)
open(o+'/dev-public.pem','w').write(pub+'\n'); open(o+'/dev-private.pem','w').write(prv+'\n')
PY
rm -f "$OUT/keygen.out"
REGISTRY="${REGISTRY:-http://127.0.0.1:4873}" node scripts/marketplace-entry.mjs @epc-live/plugin-proxmox-sandbox 0.1.0 epc-live-sandbox "Live sandbox plugin" "ePaperclip tests" "A real plugin package served by a local registry." environment.drivers.register > "$OUT/entry.json"
python3 -c "import json,sys; print(json.dumps({'entries':[json.load(open('$OUT/entry.json'))]}))" > "$OUT/catalog.json"
MARKETPLACE_SIGNING_KEY="$(cat "$OUT/dev-private.pem")" MARKETPLACE_CATALOG="$OUT/catalog.json" MARKETPLACE_OUT="$OUT/dist" node scripts/marketplace-publish.mjs
echo "published $OUT/dist (public key: $OUT/dev-public.pem)"
