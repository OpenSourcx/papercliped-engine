import type { Rule } from "@papercliped-engine/automations";

export type PinMode = "assistant" | "agent";

export interface SetupState {
  ownerName: string;
  deviceName: string; // routing root: /<device>/home
  pinMode: PinMode;
  aiProvider: string | null; // null = connect later
  pinAccess: { system: boolean; orgs: boolean; connectors: boolean; docs: boolean };
  completedAt: string;
}

export interface HostMetrics {
  hostname: string;
  ip: string;
  version: string;
  cpuModel: string;
  cpus: number;
  cpuPct: number;
  memUsed: number;
  memTotal: number;
  diskUsed: number;
  diskTotal: number;
  uptimeSec: number;
}

export type AgentStatus = "working" | "idle" | "paused" | "error";

export interface Agent {
  id: string;
  name: string;
  role: string;
  adapter: string;
  engine: "native" | "container";
  status: AgentStatus;
  task: string | null;
}

export interface ResourceGroup {
  pool: string;
  cores: number;
  memoryMb: number;
  diskGb: number;
  maxGuests: number;
}

export interface Org {
  slug: string;
  name: string;
  hue: number; // identity tint for the org's avatar, not used for data
  createdBy: "user" | "pin";
  resourceGroup: ResourceGroup;
  usage: { cpuCores: number; memoryMb: number; diskGb: number; guests: number };
  memory: "postgres" | "postgres+files";
  agents: Agent[];
  tasks: { id: string; title: string; status: "todo" | "in_progress" | "done" | "blocked"; agent: string | null }[];
}

export interface Guest {
  vmid: number;
  name: string;
  type: "lxc" | "qemu";
  status: "running" | "stopped";
  cpuPct: number;
  cores: number;
  memUsed: number;
  memMax: number;
  diskMax: number;
  org: string | null;
  protected: boolean;
}

export type Role = "owner" | "admin" | "member" | "viewer";

export interface User {
  id: string;
  name: string;
  email: string;
  pveUser: string; // the matching Proxmox user (Integrated Access Control keeps them in sync)
  synced: boolean;
  role: Role;
  twoFactor: boolean;
  orgs: { slug: string; role: Role }[];
  tools: string[];
  connectors: string[];
  policies: string[];
}

export interface Policy {
  id: string;
  name: string;
  description: string;
  effect: "allow" | "deny";
  actions: string[];
  resources: string[];
}

export interface Connector {
  id: string;
  name: string;
  kind: "model" | "code" | "chat" | "mail" | "storage";
  status: "connected" | "needs_setup";
  access: { pin: boolean; orgs: string[] };
}

export interface Notice {
  id: string;
  kind: "update" | "automation" | "approval" | "info";
  title: string;
  body: string;
  at: string;
  read: boolean;
  action?: { label: string; ruleId?: string; vmid?: number };
}

export interface EngineData {
  orgs: Org[];
  guests: Guest[];
  users: User[];
  policies: Policy[];
  connectors: Connector[];
  rules: Rule[];
  notices: Notice[];
}

/** Top-level routes under /<device>/. An org slug can never take one of these names. */
export const RESERVED = ["home", "guests", "access", "connectors", "automations", "appearance", "settings", "updates", "setup", "orgs", "new"] as const;
