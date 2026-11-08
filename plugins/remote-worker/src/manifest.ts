import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { DEFAULT_CONTROL_URL, DEFAULT_TIMEOUT_MS } from "./config.js";

export const PLUGIN_ID = "epaperclip.remote-worker-provider";
export const PLUGIN_VERSION = "0.1.0";
export const PROVIDER_KEY = "remote-worker";

const advanced = (group: string) => ({ "x-paperclip-advanced": true, "x-paperclip-group": group });

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Remote Worker Provider",
  description: "Runs Paperclip agents on persistent machines you adopted into the ePaperclip Worker Fabric.",
  author: "ePaperclip",
  categories: ["automation"],
  capabilities: ["environment.drivers.register"],
  entrypoints: { worker: "./dist/worker.js" },
  environmentDrivers: [
    {
      driverKey: PROVIDER_KEY,
      kind: "sandbox_provider",
      displayName: "Remote worker",
      description: "Picks a compatible adopted worker for each run, gives the agent its own workspace on it and runs commands there. The machine itself is never created or destroyed by this provider.",
      defaultAcquireTimeoutMs: DEFAULT_TIMEOUT_MS,
      sandboxCapabilities: { reusableLeases: true },
      configSchema: {
        type: "object",
        properties: {
          controlToken: { type: "string", format: "secret-ref", title: "Control token", description: "Created by ePaperclip when it makes the environment. It only lets this organization lease workers." },
          workerId: { type: "string", title: "Worker", description: "Pin this environment to one worker (for example the reference node). Empty lets the scheduler choose." },
          requirements: {
            type: "object",
            title: "Requirements",
            description: "arch, tools (list), gpu, localModel, minFreeMemMb. The scheduler only picks workers that match.",
          },
          reuseLease: { type: "boolean", title: "Keep workspaces between runs", description: "Keep each agent's workspace on the worker between runs instead of deleting it when the run ends.", default: true },
          controlUrl: { type: "string", description: "The Worker Fabric control address on the ePaperclip host.", default: DEFAULT_CONTROL_URL, ...advanced("Connection") },
          needsInference: { type: "boolean", description: "Only use workers with a local model runtime.", default: false, ...advanced("Connection") },
          timeoutMs: { type: "number", description: "Time limit in ms for reserving a worker and for commands that set none.", default: DEFAULT_TIMEOUT_MS, ...advanced("Connection") },
        },
      },
    },
  ],
};

export default manifest;
