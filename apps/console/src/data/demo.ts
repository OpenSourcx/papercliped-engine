import { validateRule } from "@papercliped-engine/automations";
import { slugify } from "../lib/storage.ts";
import type { Agent, AppActivity, AppSession, Connector, EngineData, Guest, HostMetrics, Notice, Org, Policy, User } from "./types.ts";

/**
 * Demo data. The console runs against this until it is connected to the host broker and ePaperclip; the top bar shows
 * a "Demo data" chip the whole time. Numbers are shaped like a small home server.
 */

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

export function demoHost(deviceName: string): HostMetrics {
  return {
    hostname: deviceName,
    ip: "192.168.1.10",
    version: "9.2",
    cpuModel: "Intel Xeon W3520 @ 2.67GHz",
    cpus: 8,
    cpuPct: 4,
    memUsed: 8.0 * GiB,
    memTotal: 31.33 * GiB,
    diskUsed: 131.37 * GiB,
    diskTotal: 2.39 * 1024 * GiB,
    uptimeSec: 108_000,
  };
}

const agents = (list: [string, string, Agent["status"], string | null, Agent["engine"]?][]): Agent[] =>
  list.map(([name, role, status, task, engine], i) => ({ id: `${slugify(name)}-${i}`, name, role, adapter: i % 2 ? "Codex" : "Claude Code", engine: engine ?? (i === 0 ? "native" : "container"), status, task }));

export function newOrg(name: string, opts: { createdBy?: "user" | "pin"; cores?: number; memoryMb?: number; diskGb?: number; maxGuests?: number; hue?: number } = {}): Org {
  const slug = slugify(name);
  return {
    slug,
    name,
    hue: opts.hue ?? [32, 12, 260, 150, 200][name.length % 5],
    createdBy: opts.createdBy ?? "user",
    resourceGroup: { pool: `co-${slug}`, cores: opts.cores ?? 4, memoryMb: opts.memoryMb ?? 8192, diskGb: opts.diskGb ?? 64, maxGuests: opts.maxGuests ?? 4 },
    usage: { cpuCores: 0, memoryMb: 0, diskGb: 0, guests: 0 },
    memory: "postgres",
    agents: [],
    tasks: [],
    goals: [],
    projects: [],
    routines: [],
    approvals: [],
    inbox: [],
    activity: [],
  };
}

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

export function demoData(firstOrgName: string | null): EngineData {
  const orgs: Org[] = [];
  if (firstOrgName) {
    const o = newOrg(firstOrgName, { cores: 4, memoryMb: 8192, diskGb: 80, maxGuests: 4, hue: 32 });
    o.agents = agents([
      ["Atlas", "CEO", "working", "Weekly plan for Q4", "native"],
      ["Forge", "Engineer", "working", "Fix flaky deploy check"],
      ["Scout", "Researcher", "idle", null],
    ]);
    o.usage = { cpuCores: 1.4, memoryMb: 3_400, diskGb: 22, guests: 2 };
    const [atlas, forge, scout] = o.agents;
    forge.reportsTo = atlas.id;
    scout.reportsTo = atlas.id;
    Object.assign(atlas, { spendUsd: 18.4, budgetUsd: 50 });
    Object.assign(forge, { spendUsd: 31.2, budgetUsd: 60 });
    Object.assign(scout, { spendUsd: 4.1, budgetUsd: 25 });
    o.tasks = [
      { id: "BEH-12", title: "Weekly plan for Q4", status: "in_progress", agent: "Atlas", priority: "high", project: "Operations" },
      { id: "BEH-14", title: "Fix flaky deploy check", status: "in_progress", agent: "Forge", priority: "high", project: "Platform" },
      { id: "BEH-15", title: "Review status page copy", status: "in_review", agent: "Scout", priority: "medium", project: "Platform" },
      { id: "BEH-16", title: "Competitor pricing scan", status: "todo", agent: null, priority: "medium", project: "Research" },
      { id: "BEH-17", title: "Rotate staging credentials", status: "blocked", agent: "Forge", priority: "high", project: "Platform" },
      { id: "BEH-9", title: "Set up status page", status: "done", agent: "Forge", priority: "low", project: "Platform" },
    ];
    o.goals = [
      { id: "g1", title: "Ship the public beta", progress: 64, due: "2026-11-30" },
      { id: "g2", title: "Keep monthly AI spend under $150", progress: 36, due: null },
    ];
    o.projects = [
      { id: "p1", name: "Platform", tasks: 9, done: 5, lead: "Forge" },
      { id: "p2", name: "Research", tasks: 4, done: 1, lead: "Scout" },
      { id: "p3", name: "Operations", tasks: 6, done: 4, lead: "Atlas" },
    ];
    o.routines = [
      { id: "r1", name: "Morning standup summary", schedule: "Weekdays 08:45", agent: "Atlas", lastRun: ago(60 * 9), enabled: true },
      { id: "r2", name: "Dependency update check", schedule: "Mondays 06:00", agent: "Forge", lastRun: ago(60 * 24 * 3), enabled: true },
      { id: "r3", name: "Weekly market digest", schedule: "Fridays 16:00", agent: "Scout", lastRun: null, enabled: false },
    ];
    o.approvals = [
      { id: "ap1", title: "Hire a QA agent (Codex, $40/month budget)", requestedBy: "Atlas", kind: "hire", status: "pending", at: ago(50) },
      { id: "ap2", title: "Raise Forge's budget to $80 this month", requestedBy: "Forge", kind: "budget", status: "pending", at: ago(130) },
    ];
    o.inbox = [
      { id: "i1", title: "Atlas needs a decision on the beta launch date", from: "Atlas", at: ago(35), read: false },
      { id: "i2", title: "Forge finished \"Set up status page\"", from: "Forge", at: ago(60 * 5), read: true },
    ];
    o.activity = [
      { id: "ac1", who: "Forge", what: "moved BEH-14 to In progress", at: ago(18) },
      { id: "ac2", who: "Atlas", what: "requested approval to hire a QA agent", at: ago(50) },
      { id: "ac3", who: "Scout", what: "submitted BEH-15 for review", at: ago(75) },
      { id: "ac4", who: "Pin", what: "started container behive-scout (#9001)", at: ago(60 * 3) },
    ];
    orgs.push(o);
  }
  const nw = newOrg("Northwind Labs", { cores: 2, memoryMb: 4096, diskGb: 40, maxGuests: 2, hue: 200 });
  nw.agents = agents([["Juniper", "Analyst", "idle", null], ["Quill", "Writer", "paused", null]]);
  nw.usage = { cpuCores: 0, memoryMb: 0, diskGb: 6, guests: 0 };
  nw.tasks = [{ id: "NW-1", title: "Draft onboarding email", status: "todo", agent: null, priority: "low", project: null }];
  nw.goals = [{ id: "ng1", title: "Publish the first newsletter", progress: 10, due: "2026-12-15" }];
  nw.activity = [{ id: "nac1", who: "Quill", what: "was paused by you", at: ago(60 * 26) }];
  orgs.push(nw);

  const first = orgs[0]?.slug ?? null;
  const guests: Guest[] = [
    { vmid: 100, name: "discord-bot-a", type: "lxc", status: "stopped", cpuPct: 0, cores: 2, memUsed: 0, memMax: 2 * GiB, diskMax: 20 * GiB, org: null, protected: false },
    { vmid: 101, name: "discord-bot-b", type: "lxc", status: "stopped", cpuPct: 0, cores: 2, memUsed: 0, memMax: 2 * GiB, diskMax: 6 * GiB, org: null, protected: false },
    { vmid: 105, name: "adguard", type: "lxc", status: "stopped", cpuPct: 0, cores: 1, memUsed: 0, memMax: 2 * GiB, diskMax: 8 * GiB, org: null, protected: true, ip: "192.168.1.20", os: "Debian 12" },
    { vmid: 106, name: "twingate-connector", type: "lxc", status: "running", cpuPct: 1, cores: 1, memUsed: 43 * MiB, memMax: 1 * GiB, diskMax: 3 * GiB, org: null, protected: true, ip: "192.168.1.31", os: "Ubuntu 24.04" },
    { vmid: 109, name: "lab", type: "qemu", status: "running", cpuPct: 6, cores: 4, memUsed: 5.7 * GiB, memMax: 8 * GiB, diskMax: 32 * GiB, org: null, protected: false, ip: "192.168.1.44", os: "Arch Linux", snapshots: [{ name: "before-upgrade", at: ago(60 * 24 * 12), description: "Before kernel 7 upgrade" }] },
    ...(first
      ? ([
          { vmid: 9000, name: `${first}-forge`, type: "lxc", status: "running", cpuPct: 22, cores: 2, memUsed: 1.3 * GiB, memMax: 2 * GiB, diskMax: 8 * GiB, org: first, protected: false, ip: "10.10.0.20", os: "Debian 13" },
          { vmid: 9001, name: `${first}-scout`, type: "lxc", status: "running", cpuPct: 3, cores: 2, memUsed: 0.6 * GiB, memMax: 2 * GiB, diskMax: 8 * GiB, org: first, protected: false, ip: "10.10.0.21", os: "Debian 13" },
        ] satisfies Guest[])
      : []),
  ];

  for (const g of guests) {
    g.os ??= g.type === "qemu" ? "Linux" : "Debian 13";
    g.snapshots ??= [];
    g.tasks ??= [{ id: `${g.vmid}-t0`, what: g.status === "running" ? "Start" : "Shutdown", at: ago(60 * 30 + g.vmid % 50), ok: true }, { id: `${g.vmid}-t1`, what: "Backup (vzdump)", at: ago(60 * 9), ok: true }];
  }

  const users: User[] = [
    { id: "u-owner", name: "You", email: "owner@local", pveUser: "owner@pve", synced: true, role: "owner", twoFactor: false, orgs: orgs.map((o) => ({ slug: o.slug, role: "owner" as const })), tools: ["*"], connectors: ["*"], policies: ["p-owner"] },
    { id: "u-sam", name: "Sam Rivera", email: "sam@example.com", pveUser: "sam@pve", synced: true, role: "member", twoFactor: true, orgs: first ? [{ slug: first, role: "member" }] : [], tools: ["tasks", "agents.read", "guests.console"], connectors: ["github"], policies: ["p-org-member"] },
    { id: "u-ana", name: "Ana Okafor", email: "ana@example.com", pveUser: "ana@pve", synced: false, role: "viewer", twoFactor: false, orgs: [{ slug: "northwind-labs", role: "viewer" }], tools: ["agents.read"], connectors: [], policies: ["p-read"] },
  ];

  const policies: Policy[] = [
    { id: "p-owner", name: "Owner", description: "Everything on this device, including access control.", effect: "allow", actions: ["*"], resources: ["/"] },
    { id: "p-org-member", name: "Org member", description: "Work in assigned orgs and open consoles of their guests.", effect: "allow", actions: ["tasks.*", "agents.read", "guests.console"], resources: ["/orgs/{assigned}"] },
    { id: "p-read", name: "Read only", description: "See dashboards and status, change nothing.", effect: "allow", actions: ["*.read"], resources: ["/orgs/{assigned}"] },
    { id: "p-no-host", name: "No host power", description: "Never start, stop or snapshot host guests.", effect: "deny", actions: ["guests.power", "guests.snapshot"], resources: ["/guests"] },
  ];

  const connectors: Connector[] = [
    { id: "anthropic", name: "Anthropic", kind: "model", status: "connected", access: { pin: true, orgs: orgs.map((o) => o.slug) } },
    { id: "openai", name: "OpenAI", kind: "model", status: "needs_setup", access: { pin: false, orgs: [] } },
    { id: "github", name: "GitHub", kind: "code", status: "connected", access: { pin: true, orgs: first ? [first] : [] } },
    { id: "slack", name: "Slack", kind: "chat", status: "connected", access: { pin: true, orgs: [] } },
    { id: "gmail", name: "Gmail", kind: "mail", status: "needs_setup", access: { pin: false, orgs: [] } },
  ];

  const rule = validateRule({ id: "mem-guard", name: "Shut down containers over 90% memory", when: { metric: "memory_percent", op: ">", value: 90, forSeconds: 120 }, scope: { guestType: "lxc" }, then: { action: "shutdown" }, createdBy: "pin" });
  const notices: Notice[] = [
    { id: "n-update", kind: "update", title: "Proxmox VE 9.2.4 is available", body: "Security and bug fixes, including QEMU and LXC updates. Pin can apply it after taking snapshots.", at: new Date(Date.now() - 3_600_000).toISOString(), read: false, action: { label: "Review update" } },
    { id: "n-backup", kind: "info", title: "Nightly backup finished", body: "5 guests backed up to drive2. Retention keeps 1 copy; Pin suggests keeping 3.", at: new Date(Date.now() - 9 * 3_600_000).toISOString(), read: true },
  ];

  const sessions: AppSession[] = [
    { id: "s-claude", app: "Claude", client: "claude.ai connector", userId: "u-owner", level: "control", orgs: null, agents: null, connectedAt: ago(60 * 24 * 6), lastUsedAt: ago(4), calls24h: 86 },
    { id: "s-chatgpt", app: "ChatGPT", client: "ChatGPT app", userId: "u-owner", level: "read", orgs: first ? [first] : null, agents: null, connectedAt: ago(60 * 24 * 2), lastUsedAt: ago(95), calls24h: 12 },
    { id: "s-codex", app: "Codex", client: "Codex CLI", userId: "u-sam", level: "control", orgs: first ? [first] : [], agents: orgs[0]?.agents.slice(1, 2).map((a) => a.id) ?? [], connectedAt: ago(60 * 30), lastUsedAt: ago(22), calls24h: 31 },
  ];
  const activity: AppActivity[] = [
    { id: "a1", sessionId: "s-claude", tool: "paperclip_report_status", outcome: "ok", at: ago(4) },
    { id: "a2", sessionId: "s-codex", tool: "paperclip_update_issue", outcome: "ok", at: ago(22) },
    { id: "a3", sessionId: "s-claude", tool: "host_guest_power", outcome: "ok", at: ago(41) },
    { id: "a4", sessionId: "s-chatgpt", tool: "paperclip_pause_agent", outcome: "blocked", at: ago(95) },
    { id: "a5", sessionId: "s-codex", tool: "paperclip_list_issues", outcome: "ok", at: ago(120) },
  ];

  const host: EngineData["host"] = {
    storage: [
      { id: "local", type: "dir", path: "/var/lib/vz", used: 45.6 * GiB, total: 624 * GiB, content: ["Backups", "Containers", "Disk images", "ISO images", "Templates"] },
      { id: "drive2", type: "dir", path: "/mnt/pve/drive2", used: 95.2 * GiB, total: 2000 * GiB, content: ["Backups", "Containers", "Disk images", "ISO images", "Templates", "Snippets"] },
    ],
    network: [
      { name: "vmbr0", type: "bridge", cidr: "192.168.1.10/24", gateway: "192.168.1.254", ports: "nic0", active: true },
      { name: "nic0", type: "nic", cidr: null, gateway: null, ports: "", active: true },
      { name: "nic1", type: "nic", cidr: null, gateway: null, ports: "", active: false },
    ],
    backups: [{ id: "daily", schedule: "Daily 21:00", storage: "drive2", selection: "All guests", keep: 1, lastRun: ago(60 * 9), lastOk: true }],
  };

  return { orgs, guests, users, policies, connectors, rules: rule.ok ? [rule.rule] : [], notices, apps: { mode: "full", sessions, activity }, host };
}
