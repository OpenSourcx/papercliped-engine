#!/usr/bin/env bash
# Disposable engine 2026.1023.0 for the Worker Fabric live test: own home, port 3298, loopback. Throwaway secrets only.
cd /project/.work/engine-1023/tree
export PAPERCLIP_HOME=/project/.work/orion-e2e/home HOME=/project/.work/orion-e2e/home
export PAPERCLIP_DEPLOYMENT_MODE=authenticated PAPERCLIP_DEPLOYMENT_EXPOSURE=private HOST=127.0.0.1 PORT=3298 PAPERCLIP_PUBLIC_URL=http://127.0.0.1:3298 PAPERCLIP_ALLOWED_HOSTNAMES=127.0.0.1,localhost PAPERCLIP_API_URL=http://127.0.0.1:3298 PAPERCLIP_MIGRATION_AUTO_APPLY=true SERVE_UI=false PAPERCLIP_AUTH_RATE_LIMIT_ENABLED=false PAPERCLIP_TELEMETRY_DISABLED=1
export PAPERCLIP_TOOL_ACTION_SIGNING_SECRET=disposable-tool-action-signing-not-for-production-0123456789abcdef0123
export BETTER_AUTH_SECRET=disposable-test-secret-not-for-production-0123456789abcdef PAPERCLIP_AGENT_JWT_SECRET=disposable-test-jwt-not-for-production-0123456789abcdef
exec /project/.work/engine-1023/node-v24.21.0-linux-x64/bin/node --max-old-space-size=2048 node_modules/@paperclipai/server/dist/index.js
