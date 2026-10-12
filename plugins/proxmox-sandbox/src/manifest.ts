import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  DEFAULT_API_URL,
  DEFAULT_BRIDGE,
  DEFAULT_CORES,
  DEFAULT_MEMORY_MB,
  DEFAULT_NAME_PREFIX,
  DEFAULT_SSH_PORT,
  DEFAULT_SSH_USER,
  DEFAULT_TIMEOUT_MS,
} from "./config.js";

export const PLUGIN_ID = "epaperclip.proxmox-sandbox-provider";
export const PLUGIN_VERSION = "0.1.0";

const advanced = (group: string) => ({ "x-paperclip-advanced": true, "x-paperclip-group": group });

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Proxmox Sandbox Provider",
  description: "Runs Paperclip agents in unprivileged Proxmox VE LXC containers instead of on the host.",
  author: "ePaperclip",
  categories: ["automation"],
  capabilities: ["environment.drivers.register"],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  environmentDrivers: [
    {
      driverKey: "proxmox",
      kind: "sandbox_provider",
      displayName: "Proxmox LXC container",
      description:
        "Clones an LXC template into a Proxmox pool for each run (or reuses one per agent and workspace), then runs commands over SSH.",
      // Clone, boot, DHCP and SSH share this budget when the config has no timeoutMs.
      defaultAcquireTimeoutMs: DEFAULT_TIMEOUT_MS,
      sandboxCapabilities: {
        // resume, release and destroy are implemented; release keeps the container when reuseLease is on.
        reusableLeases: true,
      },
      configSchema: {
        type: "object",
        properties: {
          // ---- Essentials ----
          apiUrl: {
            type: "string",
            title: "Proxmox API URL",
            description: "Base URL of the Proxmox VE API. On the Proxmox host itself the default is right.",
            default: DEFAULT_API_URL,
          },
          node: {
            type: "string",
            title: "Node",
            description: "Proxmox node that runs the containers, e.g. `pve`.",
          },
          apiTokenId: {
            type: "string",
            title: "API token ID",
            description: "Token ID as Proxmox shows it, e.g. `epaperclip-engine@pve!sandbox`. Give it rights only on the pool, the template and the storage (see the docs).",
          },
          apiTokenSecret: {
            type: "string",
            format: "secret-ref",
            title: "API token secret",
            description: "Paste the token secret, or pick a saved Paperclip secret.",
          },
          template: {
            type: "string",
            title: "Template",
            description:
              "vmid of an LXC template to clone (e.g. `9000`, built with build-template.sh), or a CT template volid such as `local:vztmpl/debian-12-standard_12.12-1_amd64.tar.zst` to create from.",
          },
          pool: {
            type: "string",
            title: "Pool",
            description: "Proxmox pool (resource group) the containers are placed in.",
          },
          sshPrivateKey: {
            type: "string",
            format: "secret-ref",
            maxLength: 16384,
            title: "SSH private key",
            description:
              "Private key the engine uses to reach the containers (no passphrase). Its public half is installed when creating from a volid; a cloned template must already trust it.",
          },
          // ---- Advanced: container ----
          storage: {
            type: "string",
            description: "Storage for container disks, e.g. `local-lvm`. Required when creating from a volid; for clones, empty means the template's storage.",
            ...advanced("Container"),
          },
          bridge: {
            type: "string",
            description: "Linux bridge for the container's network (DHCP).",
            default: DEFAULT_BRIDGE,
            ...advanced("Container"),
          },
          cores: {
            type: "number",
            description: "CPU cores per container.",
            default: DEFAULT_CORES,
            ...advanced("Container"),
          },
          memoryMb: {
            type: "number",
            description: "Memory per container in MiB.",
            default: DEFAULT_MEMORY_MB,
            ...advanced("Container"),
          },
          diskGb: {
            type: "number",
            description: "Root disk in GiB. Clones are grown to this size (never shrunk); new containers are created with it (default 16).",
            ...advanced("Container"),
          },
          unprivileged: {
            type: "boolean",
            description: "Run containers unprivileged. Keep this on: root in a privileged container is root on the host.",
            default: true,
            ...advanced("Container"),
          },
          allowPrivileged: {
            type: "boolean",
            description: "Allow privileged containers or templates. Off by default; turning it on removes the main isolation guarantee.",
            default: false,
            ...advanced("Container"),
          },
          namePrefix: {
            type: "string",
            description: "Prefix for container hostnames (`<prefix>-<vmid>`).",
            default: DEFAULT_NAME_PREFIX,
            ...advanced("Container"),
          },
          // ---- Advanced: SSH ----
          sshUser: {
            type: "string",
            description: "User the engine logs in as inside the container.",
            default: DEFAULT_SSH_USER,
            ...advanced("SSH"),
          },
          sshPort: {
            type: "number",
            description: "SSH port inside the container.",
            default: DEFAULT_SSH_PORT,
            ...advanced("SSH"),
          },
          // ---- Advanced: API and runtime ----
          caCert: {
            type: "string",
            maxLength: 65536,
            description:
              "PEM CA certificate for the Proxmox API (on the host: /etc/pve/pve-root-ca.pem). Empty means the system trust store.",
            ...advanced("API and runtime"),
          },
          allowInsecureTls: {
            type: "boolean",
            description: "Skip TLS verification when no caCert is set. Off by default; avoid it.",
            default: false,
            ...advanced("API and runtime"),
          },
          reuseLease: {
            type: "boolean",
            description: "Keep a container running between runs of the same agent and workspace instead of deleting it.",
            default: false,
            ...advanced("API and runtime"),
          },
          timeoutMs: {
            type: "number",
            description: "Time limit in ms for creating a container and for commands that set none.",
            default: DEFAULT_TIMEOUT_MS,
            ...advanced("API and runtime"),
          },
        },
      },
    },
  ],
};

export default manifest;
