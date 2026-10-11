import type { Connector } from "./types.ts";

/**
 * Plugins the Store offers for ePaperclip and Pin. Connectors join the system-wide connector list (and then get the
 * per-organization access switches); adapters are how agents run (Claude Code, Codex ...); skills teach Pin new jobs.
 * Which are installed is kept on this device; the runtime that executes adapters and skills arrives with the
 * ePaperclip fork, and the Store says so on those cards.
 */
export type PluginKind = "connector" | "adapter" | "skill";

export interface PluginEntry {
  id: string;
  name: string;
  vendor: string;
  kind: PluginKind;
  summary: string;
  connectorKind?: Connector["kind"];
}

export const PLUGINS: PluginEntry[] = [
  { id: "anthropic", kind: "connector", connectorKind: "model", name: "Anthropic", vendor: "Anthropic", summary: "Claude models for Pin and your agents, with a subscription or an API key." },
  { id: "openai", kind: "connector", connectorKind: "model", name: "OpenAI", vendor: "OpenAI", summary: "ChatGPT and Codex models, with a subscription or an API key." },
  { id: "gemini", kind: "connector", connectorKind: "model", name: "Google Gemini", vendor: "Google", summary: "Gemini models through an API key." },
  { id: "github", kind: "connector", connectorKind: "code", name: "GitHub", vendor: "GitHub", summary: "Let agents read repositories, open pull requests and follow issues." },
  { id: "linear", kind: "connector", connectorKind: "code", name: "Linear", vendor: "Linear", summary: "Sync agent tasks with your Linear issues." },
  { id: "slack", kind: "connector", connectorKind: "chat", name: "Slack", vendor: "Slack", summary: "Agents and Pin can post updates and take requests in channels." },
  { id: "discord", kind: "connector", connectorKind: "chat", name: "Discord", vendor: "Discord", summary: "Talk to Pin and your agents from a Discord server." },
  { id: "gmail", kind: "connector", connectorKind: "mail", name: "Gmail", vendor: "Google", summary: "Let agents draft and read mail you choose to share." },
  { id: "tailscale", kind: "connector", connectorKind: "network", name: "Tailscale", vendor: "Tailscale", summary: "Reach this device and your connected AI apps from anywhere, without opening ports." },
  { id: "cloudflared", kind: "connector", connectorKind: "network", name: "Cloudflare Tunnel", vendor: "Cloudflare", summary: "Publish this console and the connector address through a tunnel." },
  { id: "claude-code", kind: "adapter", name: "Claude Code", vendor: "Anthropic", summary: "Run agents with Claude Code, in a container or on the device." },
  { id: "codex", kind: "adapter", name: "Codex", vendor: "OpenAI", summary: "Run agents with OpenAI's Codex." },
  { id: "gemini-cli", kind: "adapter", name: "Gemini CLI", vendor: "Google", summary: "Run agents with Google's Gemini command-line agent." },
  { id: "opencode", kind: "adapter", name: "OpenCode", vendor: "OpenCode", summary: "Run agents with the open-source OpenCode, with any model you connect." },
  { id: "update-guardian", kind: "skill", name: "Update guardian", vendor: "ePaperclip", summary: "Pin snapshots every machine, applies Proxmox updates and checks they came back healthy." },
  { id: "security-auditor", kind: "skill", name: "Security auditor", vendor: "ePaperclip", summary: "Pin reviews your firewall, open ports and users weekly and tells you what looks risky." },
  { id: "cost-watcher", kind: "skill", name: "Cost watcher", vendor: "ePaperclip", summary: "Pin watches agent spending against budgets and warns before a limit is hit." },
  { id: "weekly-report", kind: "skill", name: "Weekly report", vendor: "ePaperclip", summary: "Every Monday, Pin writes up what your machines and organizations did." },
];

/** Installed by default in a fresh console: what the demo organizations already use. */
export const DEFAULT_PLUGINS = ["claude-code", "codex"];

export const pluginById = (id: string) => PLUGINS.find((p) => p.id === id);
