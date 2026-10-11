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
  reportsTo?: string | null; // agent id, for the org chart
  spendUsd?: number; // this month
  budgetUsd?: number;
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
  tasks: Task[];
  goals: { id: string; title: string; progress: number; due: string | null }[];
  projects: { id: string; name: string; tasks: number; done: number; lead: string | null }[];
  routines: { id: string; name: string; schedule: string; agent: string; lastRun: string | null; enabled: boolean }[];
  approvals: { id: string; title: string; requestedBy: string; kind: "hire" | "budget" | "action"; status: "pending" | "approved" | "rejected"; at: string }[];
  inbox: { id: string; title: string; from: string; at: string; read: boolean }[];
  activity: { id: string; who: string; what: string; at: string }[];
}

export type TaskStatus = "todo" | "in_progress" | "in_review" | "done" | "blocked";
export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  agent: string | null;
  priority?: "low" | "medium" | "high";
  project?: string | null;
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
  template?: boolean; // a template: can be cloned, never started
  diskUsed?: number; // live only; Proxmox reports it for containers
  uptimeSec?: number; // live only
  org: string | null;
  protected: boolean;
  ip?: string | null;
  os?: string;
  snapshots?: { name: string; at: string; description: string }[];
  tags?: string[];
  tasks?: { id: string; what: string; at: string; ok: boolean }[];
}

export interface HostStorage {
  id: string;
  type: string; // dir, zfspool, lvmthin, lvm, nfs, cifs, pbs ...
  path?: string;
  used: number;
  total: number;
  content: string[];
  active?: boolean;
  shared?: boolean;
}

export interface HostNetwork {
  name: string;
  type: "bridge" | "nic" | "vlan";
  cidr: string | null;
  gateway: string | null;
  ports: string;
  active: boolean;
}

export interface BackupJob {
  id: string;
  schedule: string;
  storage: string;
  selection: string;
  keep: number;
  lastRun: string;
  lastOk: boolean;
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
  kind: "model" | "code" | "chat" | "mail" | "storage" | "network";
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

/** Papercliped, native: one connected AI app (an OAuth grant) owned by an ePaperclip user. */
export type AccessLevel = "read" | "control"; // exactly two: Read only, Full control
export type AppMode = "api" | "full" | "agent";

export interface AppSession {
  id: string;
  app: string; // Claude, ChatGPT, Codex, or any MCP client
  client: string; // what the app reported when it connected
  userId: string; // the IAC user who approved it; the session can never exceed that user's access
  level: AccessLevel;
  orgs: string[] | null; // null = every org the user can reach
  agents: string[] | null; // null = all agents
  connectedAt: string;
  lastUsedAt: string;
  calls24h: number;
}

export interface AppActivity {
  id: string;
  sessionId: string;
  tool: string;
  outcome: "ok" | "blocked" | "error";
  at: string;
}

export interface PinLogEntry {
  id: string;
  at: string;
  kind: "did" | "proposed" | "learned" | "changed";
  text: string;
}

/** Pin's own files and history. SOUL.md is who Pin is; MEMORY.md is what it has learned about you and this device. */
export interface PinData {
  soul: string;
  memory: string;
  editedAt: { soul: string | null; memory: string | null };
  log: PinLogEntry[];
}

export interface EngineData {
  orgs: Org[];
  guests: Guest[];
  users: User[];
  policies: Policy[];
  connectors: Connector[];
  rules: Rule[];
  notices: Notice[];
  apps: { mode: AppMode; sessions: AppSession[]; activity: AppActivity[] };
  host: { storage: HostStorage[]; network: HostNetwork[]; backups: BackupJob[] };
  pin?: PinData;
  /** Installed Store plugins that aren't connectors (adapters and Pin skills). Undefined means the defaults. */
  plugins?: string[];
}

/** Top-level routes under /<device>/. An org slug can never take one of these names. */
export const RESERVED = ["home", "guests", "access", "connectors", "automations", "appearance", "settings", "updates", "setup", "orgs", "new", "apps", "machines", "shell", "storage", "network", "backups", "summary", "resources", "tasks", "pin", "firewall", "store", "library"] as const;
