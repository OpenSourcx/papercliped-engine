import { ProxmoxError, type GuestType, type ProxmoxClient } from "@papercliped-engine/proxmox-client";
import type { EngineGateway } from "../engine.ts";
import { HttpError } from "../http.ts";
import { PinError, runTool, TOOLS, type PinToolHost } from "../pin.ts";
import type { Session } from "../sessions.ts";
import type { StateStore } from "../state.ts";
import { fetchVendorText } from "../vendorFetch.ts";
import { type GrantRec, SCOPE_CONTROL } from "./connect-oauth.ts";
import { cleanText } from "./connect-util.ts";
import { MAX_PLAN_STEPS, createPlan, describeStep, machineNames, parseStep } from "./pin-agent.ts";
import { runtimeFor } from "./pin-core.ts";

/**
 * The tools an outside AI app gets over MCP (docs/CONNECTORS.md). Two access levels decide which exist:
 *
 *  - Read only (`paperclip:read`): the tools marked `read`. They can't change anything; the Proxmox client the app
 *    acts through also refuses everything but GET, so a mistake here still can't write.
 *  - Full control (`paperclip:control`): all of them. Engine tools (tasks, comments, agents, approvals, goals) run as
 *    the person's own engine account, limited to the organizations the person chose for the app. Host-changing tools
 *    (power, snapshots) never run at once by default: they write a plan the person approves in the console, one step at
 *    a time, with typed confirmation for anything destructive. A person may allow an app to run the non-destructive
 *    ones directly ("act without asking"); destructive steps are still always a plan the person confirms with their own
 *    typed phrase (a phrase sent by the app is ignored), and machines tagged `protected` are refused.
 *
 * Proxmox decides everything either way: tools act through the person's own Proxmox API token.
 */

export interface ToolEnv {
  grant: GrantRec;
  username: string;
  node: string;
  pve: ProxmoxClient;
  gateway: EngineGateway | null;
  session: Session;
  state: StateStore;
  now: () => number;
  /** Whether the admin switched on tools that reach out to the internet. */
  allowFetch: boolean;
}

export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  access: "read" | "control";
  /** MCP annotation hints, so apps can warn or ask before calling. */
  destructive?: boolean;
  idempotent?: boolean;
  run(args: Record<string, unknown>, env: ToolEnv): Promise<unknown>;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const SNAP = /^[A-Za-z][\w-]{1,39}$/;
const noArgs = { type: "object", properties: {}, additionalProperties: false };
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false });
const bad = (m: string) => new PinError("bad_args", m);

function strictArgs(args: Record<string, unknown>, allowed: string[]) {
  for (const k of Object.keys(args)) if (!allowed.includes(k)) throw bad(`Unknown argument ${cleanText(k, 40)}.`);
}
const idArg = (v: unknown, what: string): string => {
  if (typeof v !== "string" || !ID.test(v)) throw bad(`${what} must be an id from a list tool.`);
  return v;
};
const textArg = (v: unknown, what: string, max: number, required = true): string => {
  if (v === undefined && !required) return "";
  if (typeof v !== "string") throw bad(`${what} must be text.`);
  const t = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (required && !t) throw bad(`${what} can't be empty.`);
  if (t.length > max) throw bad(`${what} is longer than ${max} characters.`);
  return t;
};
const vmidArg = (v: unknown): number => {
  if (!Number.isInteger(v) || (v as number) < 100 || (v as number) > 999_999_999) throw bad("vmid must be a machine id (an integer from 100).");
  return v as number;
};
const oneOf = <T extends string>(v: unknown, list: readonly T[], what: string): T => {
  if (typeof v !== "string" || !list.includes(v as T)) throw bad(`${what} must be one of ${list.join(", ")}.`);
  return v as T;
};

function engine(env: ToolEnv) {
  const gw = env.gateway;
  if (!gw) throw new HttpError(503, "engine_unavailable", "The engine isn't set up on this host.");
  return <T,>(method: string, path: string, body?: unknown) => gw.userJson<T>(env.session, method, path, body);
}

/** The organization limits the person set for this app. */
function orgOk(env: ToolEnv, companyId: string) {
  if (env.grant.orgs && !env.grant.orgs.includes(companyId)) throw new PinError("not_allowed", "This app wasn't given access to that organization. The person can change that in Connected apps.");
}

/** For tools that take a task, agent or approval id: find its organization and check the limit. */
async function orgOfEntity(env: ToolEnv, path: string): Promise<Record<string, any>> {
  const e = await engine(env)<Record<string, any>>("GET", path);
  if (typeof e?.companyId === "string") orgOk(env, e.companyId);
  else if (env.grant.orgs) throw new PinError("not_allowed", "This app is limited to some organizations, and that item's organization couldn't be determined.");
  return e;
}

const hostFor = (env: ToolEnv): PinToolHost => ({
  node: env.node,
  username: env.username,
  pve: async () => env.pve,
  engine: <T,>(p: string) => engine(env)<T>("GET", p),
});

const pinRead = (name: string, title: string): McpTool => {
  const def = TOOLS.find((t) => t.name === name)!;
  return {
    name, title, description: def.description, inputSchema: def.parameters as Record<string, unknown>, access: "read", idempotent: true,
    async run(args, env) {
      if (name === "org_summary") orgOk(env, idArg(args.companyId, "companyId"));
      const out = await runTool(name, args, hostFor(env));
      if (name === "list_organizations" && env.grant.orgs) {
        const o = out as { organizations: { id: string }[] };
        return { organizations: o.organizations.filter((x) => env.grant.orgs!.includes(x.id)) };
      }
      return out;
    },
  };
};

const cap = <T,>(list: T[], n: number): T[] => list.slice(0, n);
const guestFor = async (env: ToolEnv, vmid: number) => {
  const g = (await env.pve.clusterResources()).find((r) => r.vmid === vmid && (r.type === "lxc" || r.type === "qemu"));
  if (!g) throw new PinError("not_found", `There is no machine ${vmid} that this person can see.`);
  return g;
};

const POWER = ["start", "shutdown", "stop", "reboot"] as const;

/**
 * Runs a host change now (only non-destructive ones, only for apps the person allowed to), or writes the plan for the person to approve.
 * A destructive step (anything Pin's plan code marks destructive: shutdown, stop, reboot, delete, rollback) is ALWAYS a plan, even for an
 * app allowed to act without asking: the person types its confirmation phrase in the console themselves. A phrase the app sends is ignored,
 * so no app can confirm on the person's behalf. Machines tagged `protected` are refused outright.
 */
async function hostChange(env: ToolEnv, step: Record<string, unknown>, confirm: unknown, title: string): Promise<unknown> {
  const parsed = parseStep(step);
  const names = await machineNames(env.pve, [step]);
  const info = describeStep(parsed, names);
  const vmid = parsed.args.vmid as number;
  const g = await guestFor(env, vmid);
  if (info.destructive && /(^|[;,])protected($|[;,])/.test(g.tags ?? "")) throw new PinError("protected", `Machine ${vmid} is tagged protected. Apps can't do this to it; the person can do it in the console.`);
  if (info.destructive || !env.grant.direct) {
    const plan = createPlan(runtimeFor(env.state), { owner: env.username, title: `${env.grant.clientName}: ${title}`, summary: `Proposed by the connected app ${env.grant.clientName}.`, steps: [step], createdBy: "app", names });
    const ignored = typeof confirm === "string" && confirm !== "" ? " The confirmation phrase you sent was ignored: only the person can type it, in the console." : "";
    const why = info.destructive && env.grant.direct ? " This step is destructive, so it is always a plan, even though the person let this app act without asking." : "";
    return { status: "proposed", planId: plan.id, summary: info.label, note: `NOTHING has run. The person reviews this in the console (Pin, Plans) and approves it there; destructive steps need their own typed confirmation.${why}${ignored}` };
  }
  const type = g.type as GuestType;
  const where = g.node ?? env.node;
  let upid: string;
  if (parsed.kind === "power") upid = await env.pve.guestPower(where, type, vmid, parsed.args.action as (typeof POWER)[number]);
  else if (parsed.kind === "snapshot") upid = await env.pve.createSnapshot(where, type, vmid, parsed.args.name as string, parsed.args.description as string | undefined);
  else throw new PinError("bad_args", "This step can't run directly.");
  return { status: "started", task: upid, summary: info.label, note: "Proxmox started the task. Check recent_tasks for the result." };
}

export const MCP_TOOLS: McpTool[] = [
  // ---- Read: this host
  pinRead("host_status", "Host status"),
  pinRead("list_machines", "List machines"),
  pinRead("machine_detail", "Machine detail"),
  pinRead("storage_overview", "Storage overview"),
  pinRead("recent_tasks", "Recent tasks"),
  {
    name: "cluster_status", title: "Cluster status", access: "read", idempotent: true, inputSchema: noArgs,
    description: "Whether this host is part of a cluster, its nodes, quorum and whether each node is online.",
    async run(_a, env) {
      const rows = await env.pve.call<{ type: string; name: string; online?: number; quorate?: number; nodes?: number; version?: number; local?: number; ip?: string }[]>("GET", "/cluster/status");
      return { entries: cap(rows, 64).map((r) => ({ type: r.type, name: r.name, online: r.online === 1, quorate: r.quorate === 1 ? true : r.quorate === 0 ? false : null, nodes: r.nodes ?? null, local: r.local === 1, ip: r.ip ?? null })) };
    },
  },
  {
    name: "machine_snapshots", title: "Machine snapshots", access: "read", idempotent: true,
    description: "The snapshots of one machine.", inputSchema: schema({ vmid: { type: "integer", description: "The machine's numeric id" } }, ["vmid"]),
    async run(a, env) {
      strictArgs(a, ["vmid"]);
      const g = await guestFor(env, vmidArg(a.vmid));
      const snaps = await env.pve.snapshots(g.node ?? env.node, g.type as GuestType, g.vmid!);
      return { vmid: g.vmid, snapshots: cap(snaps as unknown as Record<string, unknown>[], 100).map((s) => ({ name: s.name, description: s.description ?? null, time: s.snaptime ?? null, parent: s.parent ?? null })) };
    },
  },
  // ---- Read: organizations
  pinRead("list_organizations", "List organizations"),
  pinRead("org_summary", "Organization summary"),
  {
    name: "list_agents", title: "List agents", access: "read", idempotent: true, description: "The agents of one organization with role and status.",
    inputSchema: schema({ companyId: { type: "string" } }, ["companyId"]),
    async run(a, env) {
      strictArgs(a, ["companyId"]);
      const id = idArg(a.companyId, "companyId");
      orgOk(env, id);
      const list = await engine(env)<{ id: string; name: string; role?: string; status?: string; adapterType?: string }[]>("GET", `/api/companies/${encodeURIComponent(id)}/agents`);
      return { agents: cap(list, 100).map((x) => ({ id: x.id, name: x.name, role: x.role ?? null, status: x.status ?? null, adapter: x.adapterType ?? null })) };
    },
  },
  {
    name: "get_agent", title: "Get an agent", access: "read", idempotent: true, description: "One agent: role, status, adapter and budget.",
    inputSchema: schema({ agentId: { type: "string" } }, ["agentId"]),
    async run(a, env) {
      strictArgs(a, ["agentId"]);
      const x = await orgOfEntity(env, `/api/agents/${encodeURIComponent(idArg(a.agentId, "agentId"))}`);
      return { id: x.id, name: x.name, role: x.role ?? null, status: x.status ?? null, adapter: x.adapterType ?? null, companyId: x.companyId ?? null, budgetMonthlyCents: x.budgetMonthlyCents ?? null, spentMonthlyCents: x.spentMonthlyCents ?? null };
    },
  },
  {
    name: "list_issues", title: "List tasks", access: "read", idempotent: true, description: "The tasks (issues) of one organization, optionally by status.",
    inputSchema: schema({ companyId: { type: "string" }, status: { type: "string", enum: ["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"] } }, ["companyId"]),
    async run(a, env) {
      strictArgs(a, ["companyId", "status"]);
      const id = idArg(a.companyId, "companyId");
      orgOk(env, id);
      const status = a.status === undefined ? null : oneOf(a.status, ["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"] as const, "status");
      const list = await engine(env)<{ id: string; identifier?: string; title: string; status: string; priority?: string; assigneeAgentId?: string | null }[]>("GET", `/api/companies/${encodeURIComponent(id)}/issues${status ? `?status=${status}` : ""}`);
      return { count: list.length, issues: cap(list, 100).map((i) => ({ id: i.id, identifier: i.identifier ?? null, title: i.title, status: i.status, priority: i.priority ?? null, assignee: i.assigneeAgentId ?? null })) };
    },
  },
  {
    name: "get_issue", title: "Get a task", access: "read", idempotent: true, description: "One task with its description.",
    inputSchema: schema({ issueId: { type: "string" } }, ["issueId"]),
    async run(a, env) {
      strictArgs(a, ["issueId"]);
      const i = await orgOfEntity(env, `/api/issues/${encodeURIComponent(idArg(a.issueId, "issueId"))}`);
      return { id: i.id, identifier: i.identifier ?? null, title: i.title, status: i.status, priority: i.priority ?? null, description: typeof i.description === "string" ? i.description.slice(0, 8000) : null, assignee: i.assigneeAgentId ?? null, companyId: i.companyId ?? null };
    },
  },
  {
    name: "list_approvals", title: "List approvals", access: "read", idempotent: true, description: "Decisions waiting for a person in one organization.",
    inputSchema: schema({ companyId: { type: "string" }, status: { type: "string", enum: ["pending", "approved", "rejected"] } }, ["companyId"]),
    async run(a, env) {
      strictArgs(a, ["companyId", "status"]);
      const id = idArg(a.companyId, "companyId");
      orgOk(env, id);
      const status = a.status === undefined ? "pending" : oneOf(a.status, ["pending", "approved", "rejected"] as const, "status");
      const list = await engine(env)<{ id: string; type?: string; status: string; createdAt?: string }[]>("GET", `/api/companies/${encodeURIComponent(id)}/approvals?status=${status}`);
      return { approvals: cap(list, 50).map((x) => ({ id: x.id, type: x.type ?? null, status: x.status, createdAt: x.createdAt ?? null })) };
    },
  },
  {
    name: "list_goals", title: "List goals", access: "read", idempotent: true, description: "The goals of one organization.",
    inputSchema: schema({ companyId: { type: "string" } }, ["companyId"]),
    async run(a, env) {
      strictArgs(a, ["companyId"]);
      const id = idArg(a.companyId, "companyId");
      orgOk(env, id);
      const list = await engine(env)<{ id: string; title: string; level?: string; status?: string }[]>("GET", `/api/companies/${encodeURIComponent(id)}/goals`);
      return { goals: cap(list, 100).map((g) => ({ id: g.id, title: g.title, level: g.level ?? null, status: g.status ?? null })) };
    },
  },
  {
    name: "list_projects", title: "List projects", access: "read", idempotent: true, description: "The projects of one organization.",
    inputSchema: schema({ companyId: { type: "string" } }, ["companyId"]),
    async run(a, env) {
      strictArgs(a, ["companyId"]);
      const id = idArg(a.companyId, "companyId");
      orgOk(env, id);
      const list = await engine(env)<{ id: string; name?: string; title?: string; status?: string }[]>("GET", `/api/companies/${encodeURIComponent(id)}/projects`);
      return { projects: cap(list, 100).map((p) => ({ id: p.id, name: p.name ?? p.title ?? null, status: p.status ?? null })) };
    },
  },
  {
    name: "org_costs", title: "Organization costs", access: "read", idempotent: true, description: "What one organization's agents cost this month.",
    inputSchema: schema({ companyId: { type: "string" } }, ["companyId"]),
    async run(a, env) {
      strictArgs(a, ["companyId"]);
      const id = idArg(a.companyId, "companyId");
      orgOk(env, id);
      return engine(env)("GET", `/api/companies/${encodeURIComponent(id)}/costs/summary`);
    },
  },
  // ---- Read: generic, harmless
  {
    name: "current_time", title: "Current time", access: "read", idempotent: true, description: "The host's current date and time (UTC and the host's own clock).", inputSchema: noArgs,
    async run(_a, env) {
      const d = new Date(env.now());
      return { utc: d.toISOString(), epochSeconds: Math.floor(d.getTime() / 1000), hostLocal: d.toString() };
    },
  },
  {
    name: "calculate", title: "Calculate", access: "read", idempotent: true, description: "Evaluates an arithmetic expression (numbers, + - * / % ^, parentheses). Nothing else.",
    inputSchema: schema({ expression: { type: "string", maxLength: 200 } }, ["expression"]),
    async run(a) {
      strictArgs(a, ["expression"]);
      return { result: calculate(textArg(a.expression, "expression", 200)) };
    },
  },
  // ---- Control: engine
  {
    name: "create_issue", title: "Create a task", access: "control", description: "Create a task in an organization.",
    inputSchema: schema({ companyId: { type: "string" }, title: { type: "string", maxLength: 200 }, description: { type: "string", maxLength: 8000 }, priority: { type: "string", enum: ["critical", "high", "medium", "low"] } }, ["companyId", "title"]),
    async run(a, env) {
      strictArgs(a, ["companyId", "title", "description", "priority"]);
      const id = idArg(a.companyId, "companyId");
      orgOk(env, id);
      const description = textArg(a.description, "description", 8000, false);
      const priority = a.priority === undefined ? null : oneOf(a.priority, ["critical", "high", "medium", "low"] as const, "priority");
      const i = await engine(env)<{ id?: string; identifier?: string }>("POST", `/api/companies/${encodeURIComponent(id)}/issues`, { title: textArg(a.title, "title", 200), ...(description ? { description } : {}), ...(priority ? { priority } : {}) });
      return { created: true, id: i.id ?? null, identifier: i.identifier ?? null };
    },
  },
  {
    name: "comment_issue", title: "Comment on a task", access: "control", description: "Add a comment to a task, as the person.",
    inputSchema: schema({ issueId: { type: "string" }, body: { type: "string", maxLength: 8000 } }, ["issueId", "body"]),
    async run(a, env) {
      strictArgs(a, ["issueId", "body"]);
      const id = idArg(a.issueId, "issueId");
      await orgOfEntity(env, `/api/issues/${encodeURIComponent(id)}`);
      await engine(env)("POST", `/api/issues/${encodeURIComponent(id)}/comments`, { body: textArg(a.body, "body", 8000) });
      return { commented: true };
    },
  },
  {
    name: "update_issue", title: "Update a task", access: "control", idempotent: true, description: "Change a task's status, priority or title.",
    inputSchema: schema({ issueId: { type: "string" }, status: { type: "string", enum: ["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"] }, priority: { type: "string", enum: ["critical", "high", "medium", "low"] }, title: { type: "string", maxLength: 200 } }, ["issueId"]),
    async run(a, env) {
      strictArgs(a, ["issueId", "status", "priority", "title"]);
      const id = idArg(a.issueId, "issueId");
      await orgOfEntity(env, `/api/issues/${encodeURIComponent(id)}`);
      const patch: Record<string, unknown> = {};
      if (a.status !== undefined) patch.status = oneOf(a.status, ["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"] as const, "status");
      if (a.priority !== undefined) patch.priority = oneOf(a.priority, ["critical", "high", "medium", "low"] as const, "priority");
      if (a.title !== undefined) patch.title = textArg(a.title, "title", 200);
      if (!Object.keys(patch).length) throw bad("Give at least one of status, priority or title.");
      await engine(env)("PATCH", `/api/issues/${encodeURIComponent(id)}`, patch);
      return { updated: true, changed: Object.keys(patch) };
    },
  },
  {
    name: "wake_agent", title: "Wake an agent", access: "control", description: "Ask an agent to start a run now.",
    inputSchema: schema({ agentId: { type: "string" }, reason: { type: "string", maxLength: 300 } }, ["agentId"]),
    async run(a, env) {
      strictArgs(a, ["agentId", "reason"]);
      const id = idArg(a.agentId, "agentId");
      await orgOfEntity(env, `/api/agents/${encodeURIComponent(id)}`);
      const reason = textArg(a.reason, "reason", 300, false);
      await engine(env)("POST", `/api/agents/${encodeURIComponent(id)}/wakeup`, { source: "on_demand", triggerDetail: "manual", forceFreshSession: false, ...(reason ? { reason } : {}) });
      return { woken: true };
    },
  },
  ...(["pause", "resume"] as const).map(
    (verb): McpTool => ({
      name: `${verb}_agent`, title: `${verb === "pause" ? "Pause" : "Resume"} an agent`, access: "control", idempotent: true, description: `${verb === "pause" ? "Pause" : "Resume"} an agent.`,
      inputSchema: schema({ agentId: { type: "string" } }, ["agentId"]),
      async run(a, env) {
        strictArgs(a, ["agentId"]);
        const id = idArg(a.agentId, "agentId");
        await orgOfEntity(env, `/api/agents/${encodeURIComponent(id)}`);
        await engine(env)("POST", `/api/agents/${encodeURIComponent(id)}/${verb}`);
        return { [verb === "pause" ? "paused" : "resumed"]: true };
      },
    }),
  ),
  {
    name: "decide_approval", title: "Decide an approval", access: "control", destructive: true, description: "Approve or reject a decision waiting for the person. Only do this when the person asked you to.",
    inputSchema: schema({ approvalId: { type: "string" }, decision: { type: "string", enum: ["approve", "reject"] }, note: { type: "string", maxLength: 500 } }, ["approvalId", "decision"]),
    async run(a, env) {
      strictArgs(a, ["approvalId", "decision", "note"]);
      const id = idArg(a.approvalId, "approvalId");
      const decision = oneOf(a.decision, ["approve", "reject"] as const, "decision");
      await orgOfEntity(env, `/api/approvals/${encodeURIComponent(id)}`);
      const note = textArg(a.note, "note", 500, false);
      await engine(env)("POST", `/api/approvals/${encodeURIComponent(id)}/${decision}`, note ? { decisionNote: note } : {});
      return { decided: decision };
    },
  },
  {
    name: "create_goal", title: "Create a goal", access: "control", description: "Create a goal in an organization.",
    inputSchema: schema({ companyId: { type: "string" }, title: { type: "string", maxLength: 200 }, level: { type: "string", enum: ["company", "team", "agent", "task"] } }, ["companyId", "title"]),
    async run(a, env) {
      strictArgs(a, ["companyId", "title", "level"]);
      const id = idArg(a.companyId, "companyId");
      orgOk(env, id);
      const level = a.level === undefined ? null : oneOf(a.level, ["company", "team", "agent", "task"] as const, "level");
      const g = await engine(env)<{ id?: string }>("POST", `/api/companies/${encodeURIComponent(id)}/goals`, { title: textArg(a.title, "title", 200), ...(level ? { level } : {}) });
      return { created: true, id: g.id ?? null };
    },
  },
  // ---- Control: the host (plans by default)
  {
    name: "power_machine", title: "Start, stop or reboot a machine", access: "control", destructive: true,
    description: "Start, shut down, stop or reboot a machine. By default this only writes a plan the person approves in the console; if the person allowed this app to act without asking, a start runs now, but shutdown, stop and reboot are still a plan the person approves with their own typed phrase.",
    inputSchema: schema({ vmid: { type: "integer" }, action: { type: "string", enum: [...POWER] }, confirm: { type: "string", description: "Ignored. Only the person can type the confirmation phrase, in the console." } }, ["vmid", "action"]),
    async run(a, env) {
      strictArgs(a, ["vmid", "action", "confirm"]);
      return hostChange(env, { kind: "power", vmid: vmidArg(a.vmid), action: oneOf(a.action, POWER, "action") }, a.confirm, `${a.action} machine ${a.vmid}`);
    },
  },
  {
    name: "snapshot_machine", title: "Take a snapshot", access: "control",
    description: "Take a snapshot of a machine (a plan the person approves, or run now if allowed).",
    inputSchema: schema({ vmid: { type: "integer" }, name: { type: "string", description: "2 to 40 letters, digits, - or _, starting with a letter" }, description: { type: "string", maxLength: 200 } }, ["vmid", "name"]),
    async run(a, env) {
      strictArgs(a, ["vmid", "name", "description"]);
      if (typeof a.name !== "string" || !SNAP.test(a.name)) throw bad("name is 2 to 40 letters, digits, - or _, starting with a letter.");
      const desc = textArg(a.description, "description", 200, false);
      return hostChange(env, { kind: "snapshot", vmid: vmidArg(a.vmid), name: a.name, ...(desc ? { description: desc } : {}) }, undefined, `snapshot ${a.name} of machine ${a.vmid}`);
    },
  },
  ...(["snapshot_delete", "snapshot_rollback"] as const).map(
    (kind): McpTool => ({
      name: kind === "snapshot_delete" ? "delete_snapshot" : "rollback_snapshot", title: kind === "snapshot_delete" ? "Delete a snapshot" : "Roll back to a snapshot", access: "control", destructive: true,
      description: `${kind === "snapshot_delete" ? "Delete a snapshot" : "Roll a machine back to a snapshot"} (always a plan the person approves in the console with their own typed phrase; an app can't confirm for them).`,
      inputSchema: schema({ vmid: { type: "integer" }, name: { type: "string" }, confirm: { type: "string", description: "Ignored. Only the person can type the confirmation phrase, in the console." } }, ["vmid", "name"]),
      async run(a, env) {
        strictArgs(a, ["vmid", "name", "confirm"]);
        if (typeof a.name !== "string" || !SNAP.test(a.name)) throw bad("name is 2 to 40 letters, digits, - or _, starting with a letter.");
        return hostChange(env, { kind, vmid: vmidArg(a.vmid), name: a.name }, a.confirm, `${kind === "snapshot_delete" ? "delete" : "roll back to"} snapshot ${a.name} of machine ${a.vmid}`);
      },
    }),
  ),
  {
    name: "propose_plan", title: "Propose a plan", access: "control",
    description: "Write down a multi-step plan (power, snapshots, tasks) for the person to review. Nothing runs until they approve each step in the console.",
    inputSchema: schema({
      title: { type: "string", maxLength: 120 }, summary: { type: "string", maxLength: 600 },
      steps: { type: "array", maxItems: MAX_PLAN_STEPS, items: { type: "object", properties: { kind: { type: "string", enum: ["power", "snapshot", "snapshot_delete", "snapshot_rollback", "create_task"] }, vmid: { type: "integer" }, action: { type: "string", enum: [...POWER] }, name: { type: "string" }, description: { type: "string" }, companyId: { type: "string" }, title: { type: "string" } }, required: ["kind"], additionalProperties: false } },
    }, ["title", "steps"]),
    async run(a, env) {
      strictArgs(a, ["title", "summary", "steps"]);
      const steps = Array.isArray(a.steps) ? a.steps : [];
      const names = await machineNames(env.pve, steps);
      for (const s of steps) {
        const cid = (s as { companyId?: unknown } | null)?.companyId;
        if (typeof cid === "string") orgOk(env, cid);
      }
      const plan = createPlan(runtimeFor(env.state), { owner: env.username, title: `${env.grant.clientName}: ${textArg(a.title, "title", 100)}`, summary: textArg(a.summary, "summary", 600, false), steps, createdBy: "app", names });
      return { status: "proposed", planId: plan.id, steps: plan.steps.map((s) => ({ label: s.label, destructive: s.destructive })), note: "NOTHING has run. The person reviews this in the console (Pin, Plans) and approves each step there." };
    },
  },
  // ---- Control: generic, off until an administrator allows it
  {
    name: "fetch_url", title: "Fetch a web page", access: "control", idempotent: true,
    description: "Read a public web page as text (https only, public addresses only, 2 MB, 15 seconds). Off unless an administrator turned it on in Connectors.",
    inputSchema: schema({ url: { type: "string", maxLength: 2000 } }, ["url"]),
    async run(a, env) {
      strictArgs(a, ["url"]);
      if (!env.allowFetch) throw new PinError("disabled", "An administrator hasn't allowed apps to fetch web pages. They can turn it on in Connectors.");
      const url = textArg(a.url, "url", 2000);
      let text: string;
      try {
        text = await fetchVendorText(url);
      } catch (e) {
        throw new PinError("fetch_failed", `Couldn't fetch that address: ${(e as Error).message.slice(0, 120)}`);
      }
      return { url, truncated: text.length > 60_000, text: text.slice(0, 60_000) };
    },
  },
];

/** The tools one grant may see. */
export const toolsFor = (grant: GrantRec, allowFetch: boolean): McpTool[] => MCP_TOOLS.filter((t) => (t.access === "read" || grant.scope === SCOPE_CONTROL) && (t.name !== "fetch_url" || allowFetch));

export function toolFailureText(e: unknown): string {
  if (e instanceof PinError) return e.message;
  if (e instanceof ProxmoxError && e.status === 403) return "Proxmox says the person doesn't have permission for this.";
  if (e instanceof ProxmoxError) return `Proxmox couldn't do it${e.detail ? `: ${e.detail.slice(0, 200)}` : "."}`;
  if (e instanceof HttpError) return e.message;
  return "The tool failed.";
}

/** A small arithmetic evaluator (no eval): numbers, + - * / % ^ and parentheses. */
export function calculate(src: string): number {
  const toks = src.match(/\d+\.?\d*(?:e[+-]?\d+)?|\.\d+|[-+*/%^()]|\s+|./gi) ?? [];
  const t = toks.filter((x) => !/^\s+$/.test(x));
  let i = 0;
  const fail = (): never => {
    throw bad("That isn't an arithmetic expression.");
  };
  const primary = (): number => {
    const x = t[i++];
    if (x === undefined) return fail();
    if (x === "(") {
      const v = sum();
      if (t[i++] !== ")") fail();
      return v;
    }
    if (x === "-") return -power();
    if (x === "+") return power();
    const n = Number(x);
    return Number.isFinite(n) && /^[\d.]/.test(x) ? n : fail();
  };
  const power = (): number => {
    const b = primary();
    if (t[i] === "^") {
      i++;
      return b ** power();
    }
    return b;
  };
  const product = (): number => {
    let v = power();
    while (t[i] === "*" || t[i] === "/" || t[i] === "%") {
      const op = t[i++];
      const r = power();
      v = op === "*" ? v * r : op === "/" ? v / r : v % r;
    }
    return v;
  };
  const sum = (): number => {
    let v = product();
    while (t[i] === "+" || t[i] === "-") {
      const op = t[i++];
      const r = product();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  };
  const out = sum();
  if (i !== t.length || !Number.isFinite(out)) fail();
  return out;
}
