import type { Capabilities, FabricOverview, Worker } from "../src/data/engine/fabric.ts";

export const caps = (over: Partial<Capabilities> = {}): Capabilities => ({
  os: { name: "Ubuntu", version: "22.04" },
  arch: "arm64",
  hostname: "kpnai",
  cpu: { model: "Cortex-A78AE", cores: 6 },
  memMb: 7620,
  gpu: { present: true, name: "Orin (nvgpu)", kind: "jetson" },
  storage: [{ path: "/workspaces", totalGb: 229, freeGb: 150 }],
  tools: { git: "2.34.1", node: "22.11.0", pnpm: "10.28.0" },
  inference: { runtime: "ollama", url: "http://100.93.29.26:11434", models: [{ name: "qwen2.5-coder:3b" }, { name: "qwen2.5-coder:1.5b" }], maxContext: 4096 },
  networks: [{ provider: "tailscale", address: "100.93.29.26" }],
  workspaceRoot: "/workspaces",
  ...over,
});

export const worker = (over: Partial<Worker> = {}): Worker => ({
  id: "w1",
  name: "Orion",
  state: "adopted",
  online: true,
  draining: false,
  disabled: false,
  fingerprint: "SHA256:abcd1234",
  version: "0.1.0",
  lastSeen: Date.now(),
  connectedSince: Date.now() - 3_600_000,
  transport: { provider: "tailscale", address: "100.93.29.26" },
  companies: null,
  shellSlots: 3,
  inferenceSlots: 1,
  usage: { shellLeases: 2, inferenceRunning: 1, inferenceQueued: 0, loadAvg: 1.5, freeMemMb: 3000 },
  capabilities: caps(),
  ...over,
});

export const overview = (over: Partial<FabricOverview> = {}): FabricOverview => ({
  enabled: true,
  hostKey: { fingerprint: "SHA256:host" },
  listen: { url: "ws://100.64.0.1:3131", port: 3131 },
  transports: [
    { provider: "tailscale", label: "Tailscale", available: true, recommended: true, address: "100.64.0.1", detail: "Detected on this device." },
    { provider: "lan", label: "Local network", available: true, address: "192.168.1.10", detail: "Private network address." },
    { provider: "custom", label: "Custom or existing network", available: false, detail: "Set EPC_FABRIC_PUBLIC_URL to use your own VPN or proxy." },
  ],
  workers: [],
  pending: [],
  pairings: [],
  environments: [],
  ...over,
});
