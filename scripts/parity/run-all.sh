#!/usr/bin/env bash
# Re-run every parity check against the two disposable engines and rebuild the matrix. Needs: scripts/parity/engine.sh start native|epc and host.sh.
set -euo pipefail
cd "$(dirname "$0")/../.."; E=docs/evidence/parity
node scripts/parity/journey.mjs both --out $E/journey.json
node scripts/parity/access.mjs --out $E/access.json
node scripts/parity/seed.mjs --out $E/seed.json
node scripts/parity/gov.mjs --out $E/gov.json
node scripts/parity/probe.mjs --out $E/probe.json
node scripts/parity/extras.mjs ${PARITY_SKIP_ORION:+--skip-orion} --out $E/extras.json   # one Orion Ollama request unless PARITY_SKIP_ORION=1 (shared host: one at a time)
node --experimental-strip-types scripts/parity/coverage.mjs
node --experimental-strip-types scripts/parity/ui-routes.mjs | head -1
node scripts/parity/build-matrix.mjs
