#!/usr/bin/env bash
# Disposable engine for live checks only. The secrets below are throwaway values for a loopback test engine; never reuse them.
# Disposable engine 2026.1023.0 on loopback. Data in ${EPC_LIVE_DIR:-/project/.work/engine-1023}/home. Not a service; kill with the pid file.
cd "${EPC_LIVE_DIR:-/project/.work/engine-1023}/tree"
export PAPERCLIP_HOME=${EPC_LIVE_DIR:-/project/.work/engine-1023}/home HOME=${EPC_LIVE_DIR:-/project/.work/engine-1023}/home
export PAPERCLIP_DEPLOYMENT_MODE=authenticated PAPERCLIP_DEPLOYMENT_EXPOSURE=private HOST=127.0.0.1 PORT=3199 PAPERCLIP_PUBLIC_URL=http://127.0.0.1:3199 PAPERCLIP_ALLOWED_HOSTNAMES=127.0.0.1,localhost PAPERCLIP_API_URL=http://127.0.0.1:3199 PAPERCLIP_MIGRATION_AUTO_APPLY=true SERVE_UI=false PAPERCLIP_AUTH_RATE_LIMIT_ENABLED=false PAPERCLIP_TELEMETRY_DISABLED=1
export PAPERCLIP_TOOL_ACTION_SIGNING_SECRET=disposable-tool-action-signing-not-for-production-0123456789abcdef0123
export BETTER_AUTH_SECRET=disposable-test-secret-not-for-production-0123456789abcdef PAPERCLIP_AGENT_JWT_SECRET=disposable-test-jwt-not-for-production-0123456789abcdef
exec ${EPC_LIVE_DIR:-/project/.work/engine-1023}/node-v24.21.0-linux-x64/bin/node --max-old-space-size=2048 node_modules/@paperclipai/server/dist/index.js
