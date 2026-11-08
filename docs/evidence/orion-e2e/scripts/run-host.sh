#!/usr/bin/env bash
cd /project/papercliped-engine-worktrees/orion-e2e/services/epaperclip
export EPC_LIVE_ENGINE=http://127.0.0.1:3298 EPC_FABRIC_STATE=/project/.work/orion-e2e/host-state EPC_FABRIC_LISTEN=0.0.0.0:7853 EPC_FABRIC_CONTROL=127.0.0.1:3230 EPC_FABRIC_ADMIN=127.0.0.1:3231
exec node --experimental-strip-types scripts/fabric-host-live.ts
