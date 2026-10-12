import type { Entry as MarketEntry } from "@papercliped-engine/marketplace/types";
import type { Connector } from "./types.ts";

/**
 * Plugins the Store offers for ePaperclip and Pin. Connectors join the system-wide connector list (and then get the
 * per-organization access switches); adapters are Paperclip's built-in ways to run agents (Claude Code, Codex ...), which the Store switches on and off; skills teach Pin new jobs.
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
  /** Set for entries from the signed marketplace catalog. */
  version?: string;
  permissions?: string[];
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
  // Paperclip's built-in adapters, by their Paperclip type. They come with Paperclip, so the Store enables and disables them.
  { id: "claude_local", kind: "adapter", name: "Claude Code", vendor: "Built in to Paperclip", summary: "Run agents with Claude Code, on the device." },
  { id: "codex_local", kind: "adapter", name: "Codex", vendor: "Built in to Paperclip", summary: "Run agents with Codex, on the device." },
  { id: "cursor", kind: "adapter", name: "Cursor", vendor: "Built in to Paperclip", summary: "Run agents with Cursor's agent." },
  { id: "cursor_cloud", kind: "adapter", name: "Cursor Cloud", vendor: "Built in to Paperclip", summary: "Hand work to Cursor's cloud agents." },
  { id: "gemini_local", kind: "adapter", name: "Gemini CLI", vendor: "Built in to Paperclip", summary: "Run agents with Gemini CLI, on the device." },
  { id: "grok_local", kind: "adapter", name: "Grok Build", vendor: "Built in to Paperclip", summary: "Run agents with Grok Build, on the device." },
  { id: "hermes_local", kind: "adapter", name: "Hermes", vendor: "Built in to Paperclip", summary: "Run agents with Hermes, on the device." },
  { id: "hermes_gateway", kind: "adapter", name: "Hermes Gateway", vendor: "Built in to Paperclip", summary: "Reach a Hermes agent through its gateway." },
  { id: "kimi_local", kind: "adapter", name: "Kimi Code", vendor: "Built in to Paperclip", summary: "Run agents with Kimi Code, on the device." },
  { id: "opencode_local", kind: "adapter", name: "OpenCode", vendor: "Built in to Paperclip", summary: "Run agents with OpenCode and any model you connect." },
  { id: "openclaw_gateway", kind: "adapter", name: "OpenClaw Gateway", vendor: "Built in to Paperclip", summary: "Reach an OpenClaw agent through its gateway." },
  { id: "pi_local", kind: "adapter", name: "Pi", vendor: "Built in to Paperclip", summary: "Run agents with Pi, on the device." },
  { id: "paperclip_runner", kind: "adapter", name: "Paperclip Runner", vendor: "Built in to Paperclip", summary: "Paperclip's own runner for agent work." },
  { id: "http", kind: "adapter", name: "HTTP", vendor: "Built in to Paperclip", summary: "Wake an agent that lives behind a web address." },
  { id: "process", kind: "adapter", name: "Process", vendor: "Built in to Paperclip", summary: "Run any command as an agent." },
  { id: "update-guardian", kind: "skill", name: "Update guardian", vendor: "ePaperclip", summary: "Pin snapshots every machine, applies Proxmox updates and checks they came back healthy." },
  { id: "security-auditor", kind: "skill", name: "Security auditor", vendor: "ePaperclip", summary: "Pin reviews your firewall, open ports and users weekly and tells you what looks risky." },
  { id: "cost-watcher", kind: "skill", name: "Cost watcher", vendor: "ePaperclip", summary: "Pin watches agent spending against budgets and warns before a limit is hit." },
  { id: "weekly-report", kind: "skill", name: "Weekly report", vendor: "ePaperclip", summary: "Every Monday, Pin writes up what your machines and organizations did." },
];

/** Installed by default in a fresh console: what the demo organizations already use. */
export const DEFAULT_PLUGINS = ["claude_local", "codex_local"];

/** A marketplace catalog entry as a Store plugin. */
export const fromMarket = (e: MarketEntry): PluginEntry => ({ id: e.id, name: e.name, vendor: e.vendor, summary: e.summary, kind: e.kind, connectorKind: e.connectorKind, version: e.version, permissions: e.permissions });

export const pluginById = (id: string) => PLUGINS.find((p) => p.id === id);
