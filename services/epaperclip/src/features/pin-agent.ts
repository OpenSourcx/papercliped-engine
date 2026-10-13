import { ProxmoxError, type ProxmoxClient, type GuestType } from "@papercliped-engine/proxmox-client";
import type { EngineGateway } from "../engine.ts";
import type { Session } from "../sessions.ts";
import type { FeatureCtx } from "./index.ts";
import { PLANS_MAX, newId, runtimeFor, type Plan, type PlanStep, type PinRuntime, type StepKind } from "./pin-core.ts";
import { pushNotice } from "./pin-notify.ts";

/**
 * Pin's Agent mode: a multi-step plan the person reviews and approves one step at a time. Pin (or an automation in
 * Assistant mode) only ever writes the plan down. Nothing runs until the signed-in owner approves a step in the
 * console, the step runs as that person (so Proxmox's permissions decide), and every decision and result is kept on the
 * plan and in the audit trail. A step that interrupts a running machine or can't be undone needs its phrase typed.
 */

export class PlanProblem extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const bad = (m: string) => new PlanProblem(400, "bad_plan", m);

export const MAX_PLAN_STEPS = 8;
const ORG_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SNAP = /^[A-Za-z][\w-]{1,39}$/;
const POWER = ["start", "shutdown", "stop", "reboot"] as const;
const clean = (v: unknown, max: number): string => (typeof v === "string" ? v : "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);

/** Pin's tool for Agent mode. It writes a plan down; it can't run one. */
export const AGENT_TOOLS = [
  {
    name: "propose_plan",
    action: true,
    description: "Write down a multi-step plan for the person to review. Nothing runs: they approve each step in the console, and steps that interrupt a machine need their typed confirmation. Use it when a goal needs several changes in order.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short name for the plan" },
        summary: { type: "string", description: "One or two sentences on why" },
        steps: {
          type: "array",
          maxItems: MAX_PLAN_STEPS,
          description: "In the order they should run",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["power", "snapshot", "snapshot_delete", "snapshot_rollback", "create_task"] },
              vmid: { type: "integer" },
              action: { type: "string", enum: [...POWER], description: "For power steps" },
              name: { type: "string", description: "Snapshot name: 2 to 40 letters, digits, - or _, starting with a letter" },
              description: { type: "string" },
              companyId: { type: "string", description: "For create_task" },
              title: { type: "string", description: "For create_task" },
            },
            required: ["kind"],
            additionalProperties: false,
          },
        },
      },
      required: ["title", "steps"],
      additionalProperties: false,
    },
  },
] as const;

export interface StepInput {
  kind: StepKind;
  args: Record<string, unknown>;
}

const KEYS: Record<StepKind, string[]> = {
  power: ["kind", "vmid", "action"],
  snapshot: ["kind", "vmid", "name", "description"],
  snapshot_delete: ["kind", "vmid", "name"],
  snapshot_rollback: ["kind", "vmid", "name"],
  create_task: ["kind", "companyId", "title", "description"],
};

/** Strict check of one step; returns what to store. */
export function parseStep(raw: unknown): StepInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw bad("each step must be an object");
  const r = raw as Record<string, unknown>;
  const kind = r.kind as StepKind;
  if (!Object.hasOwn(KEYS, String(kind))) throw bad(`a step's kind must be one of ${Object.keys(KEYS).join(", ")}`);
  for (const k of Object.keys(r)) if (!KEYS[kind].includes(k)) throw bad(`a ${kind} step has no field ${k}`);
  const vmid = () => {
    if (!Number.isInteger(r.vmid) || (r.vmid as number) < 100 || (r.vmid as number) > 999_999_999) throw bad("vmid must be a machine id (an integer from 100)");
    return r.vmid as number;
  };
  const snap = () => {
    if (typeof r.name !== "string" || !SNAP.test(r.name)) throw bad("a snapshot name is 2 to 40 letters, digits, - or _, starting with a letter");
    return r.name;
  };
  switch (kind) {
    case "power":
      if (!POWER.includes(r.action as (typeof POWER)[number])) throw bad(`power action must be one of ${POWER.join(", ")}`);
      return { kind, args: { vmid: vmid(), action: r.action } };
    case "snapshot":
      return { kind, args: { vmid: vmid(), name: snap(), ...(r.description !== undefined ? { description: clean(r.description, 200) } : {}) } };
    case "snapshot_delete":
    case "snapshot_rollback":
      return { kind, args: { vmid: vmid(), name: snap() } };
    case "create_task": {
      if (typeof r.companyId !== "string" || !ORG_ID.test(r.companyId)) throw bad("companyId must be an organization id");
      const title = clean(r.title, 200);
      if (!title) throw bad("a task needs a title");
      return { kind, args: { companyId: r.companyId, title, ...(r.description !== undefined ? { description: clean(r.description, 4000) } : {}) } };
    }
  }
}

const VERB: Record<string, string> = { start: "Start", shutdown: "Shut down", stop: "Stop", reboot: "Reboot" };

/** What the step says in words, and what must be typed to approve it when it interrupts or can't be undone. */
export function describeStep(s: StepInput, names?: ReadonlyMap<number, string>): { label: string; destructive: boolean; confirmPhrase: string | null } {
  const vm = typeof s.args.vmid === "number" ? `machine ${s.args.vmid}${names?.get(s.args.vmid) ? ` (${names.get(s.args.vmid)})` : ""}` : "";
  switch (s.kind) {
    case "power": {
      const a = s.args.action as string;
      const destructive = a !== "start";
      return { label: `${VERB[a]} ${vm}`, destructive, confirmPhrase: destructive ? `${a} ${s.args.vmid}` : null };
    }
    case "snapshot":
      return { label: `Take snapshot ${s.args.name} of ${vm}`, destructive: false, confirmPhrase: null };
    case "snapshot_delete":
      return { label: `Delete snapshot ${s.args.name} of ${vm}`, destructive: true, confirmPhrase: `delete ${s.args.vmid}` };
    case "snapshot_rollback":
      return { label: `Roll ${vm} back to snapshot ${s.args.name}`, destructive: true, confirmPhrase: `rollback ${s.args.vmid}` };
    case "create_task":
      return { label: `Create task "${s.args.title}"`, destructive: false, confirmPhrase: null };
  }
}

export function createPlan(rt: PinRuntime, p: { owner: string; title: string; summary?: string; steps: unknown[]; createdBy: Plan["createdBy"]; automationId?: string; names?: ReadonlyMap<number, string> }): Plan {
  const title = clean(p.title, 120);
  if (!title) throw bad("a plan needs a title");
  if (!Array.isArray(p.steps) || p.steps.length === 0 || p.steps.length > MAX_PLAN_STEPS) throw bad(`a plan has 1 to ${MAX_PLAN_STEPS} steps`);
  const steps: PlanStep[] = p.steps.map((raw) => {
    const s = parseStep(raw);
    const d = describeStep(s, p.names);
    return { id: newId(4), kind: s.kind, args: s.args, label: d.label, destructive: d.destructive, confirmPhrase: d.confirmPhrase, state: "pending" };
  });
  const plan: Plan = { id: newId(8), owner: p.owner, title, summary: clean(p.summary, 600), createdAt: rt.now(), createdBy: p.createdBy, ...(p.automationId ? { automationId: p.automationId } : {}), status: "pending", steps };
  rt.store.putPlan(plan);
  rt.audit(p.createdBy === "automation" ? `automation:${p.automationId}` : "pin", "pin.plan.propose", plan.id, `${plan.title} (${steps.length} step${steps.length === 1 ? "" : "s"}) for ${p.owner}`);
  pushNotice(rt, p.owner, { key: `plan:${plan.id}`, kind: "proposal", level: "warning", title: `Pin proposes: ${plan.title}`, body: `${steps.length} step${steps.length === 1 ? "" : "s"} waiting for your review. Nothing runs until you approve it.`, link: "pin?tab=plans" });
  return plan;
}

/** Resolves the machines a plan mentions as the person sees them: names for the labels, and a clear error for ones they can't see. */
export async function machineNames(pve: ProxmoxClient, steps: unknown[]): Promise<Map<number, string>> {
  const res = await pve.clusterResources();
  const names = new Map<number, string>();
  for (const r of res) if ((r.type === "lxc" || r.type === "qemu") && typeof r.vmid === "number") names.set(r.vmid, r.name ?? String(r.vmid));
  for (const raw of steps) {
    const v = (raw as { vmid?: unknown } | null)?.vmid;
    if (typeof v === "number" && !names.has(v)) throw bad(`There is no machine ${v} that you can see.`);
  }
  return names;
}

/** What the model gets back after writing a plan. */
export async function proposeFromChat(rt: PinRuntime, owner: string, pve: () => Promise<ProxmoxClient>, args: Record<string, unknown>) {
  const steps = Array.isArray(args.steps) ? args.steps : [];
  const names = await machineNames(await pve(), steps);
  const plan = createPlan(rt, { owner, title: String(args.title ?? ""), summary: args.summary === undefined ? "" : String(args.summary), steps, createdBy: "pin", names });
  return plan;
}

// ---- Running a step

type Action = "approve" | "skip" | "reject";

function findStep(plan: Plan, sid: string): { step: PlanStep; index: number } {
  const index = plan.steps.findIndex((s) => s.id === sid);
  if (index < 0) throw new PlanProblem(404, "not_found", "That step isn't in this plan");
  return { step: plan.steps[index], index };
}

const settle = (plan: Plan) => {
  if (plan.steps.some((s) => s.state === "running")) plan.status = "running";
  else if (plan.steps.some((s) => s.state === "failed")) plan.status = "failed";
  else if (plan.steps.every((s) => s.state === "done" || s.state === "skipped")) plan.status = "done";
  else if (plan.steps.every((s) => s.state !== "pending") ) plan.status = plan.steps.some((s) => s.state === "rejected") ? "cancelled" : "done";
  else plan.status = "pending";
};

const reasonOf = (e: unknown): string => {
  if (e instanceof ProxmoxError) {
    if (e.status === 403) return "Proxmox says you don't have permission for this.";
    return e.detail ? `Proxmox: ${e.detail.slice(0, 300)}` : "Proxmox couldn't do it.";
  }
  if (e instanceof Error && "code" in e && "status" in e) return e.message.slice(0, 300);
  return "It failed.";
};

async function execute(step: PlanStep, pve: ProxmoxClient, s: Session, node: string, gw: EngineGateway | null, rt: PinRuntime): Promise<{ upid?: string; result: string }> {
  const a = step.args;
  if (step.kind === "create_task") {
    if (!gw) throw new PlanProblem(503, "engine_unavailable", "The engine isn't set up on this host.");
    const issue = await gw.userJson<{ id?: string; identifier?: string }>(s, "POST", `/api/companies/${encodeURIComponent(a.companyId as string)}/issues`, { title: a.title, ...(a.description ? { description: a.description } : {}) });
    return { result: `Created task ${issue.identifier ?? issue.id ?? ""}`.trim() };
  }
  const vmid = a.vmid as number;
  const g = (await pve.clusterResources()).find((r) => r.vmid === vmid && (r.type === "lxc" || r.type === "qemu"));
  if (!g) throw new PlanProblem(404, "not_found", `There is no machine ${vmid} that you can see.`);
  const type = g.type as GuestType;
  const where = g.node ?? node;
  let upid: string;
  if (step.kind === "power") upid = await pve.guestPower(where, type, vmid, a.action as "start" | "shutdown" | "stop" | "reboot");
  else if (step.kind === "snapshot") upid = await pve.createSnapshot(where, type, vmid, a.name as string, a.description as string | undefined);
  else if (step.kind === "snapshot_rollback") upid = await pve.rollbackSnapshot(where, type, vmid, a.name as string);
  else upid = await pve.deleteSnapshot(where, type, vmid, a.name as string);
  if (typeof upid === "string" && upid.startsWith("UPID:")) {
    await pve.waitTask(where, upid, { timeoutMs: 120_000, pollMs: 2000, sleep: rt.sleep });
    return { upid, result: "Done on Proxmox." };
  }
  return { result: "Done on Proxmox." };
}

/** Applies the person's decision on one step. The step runs now, as them, when they approve it. */
export async function decide(rt: PinRuntime, ctx: { pve: ProxmoxClient; session: Session; node: string; gateway: EngineGateway | null }, planId: string, sid: string, action: Action, confirm: unknown): Promise<Plan> {
  const plan = rt.store.plan(planId);
  if (!plan || plan.owner !== ctx.session.username) throw new PlanProblem(404, "not_found", "There is no such plan");
  const { step, index } = findStep(plan, sid);
  if (step.state !== "pending") throw new PlanProblem(409, "not_pending", "That step has already been decided");
  if (plan.status === "failed" || plan.status === "cancelled" || plan.status === "done") throw new PlanProblem(409, "plan_closed", `This plan is ${plan.status}`);
  if (plan.steps.some((s) => s.state === "running")) throw new PlanProblem(409, "busy", "A step of this plan is still running");
  const now = rt.now();
  const who = ctx.session.username;

  if (action === "reject") {
    // Rejecting stops the plan: the later steps were written assuming this one, so none of them runs.
    for (const s of plan.steps) if (s.state === "pending") Object.assign(s, { state: s === step ? "rejected" : "skipped", decidedBy: who, decidedAt: now });
    plan.status = "cancelled";
    rt.store.putPlan(plan);
    rt.audit(who, "pin.plan.reject", plan.id, `step ${index + 1}: ${step.label}`);
    return plan;
  }
  if (plan.steps.slice(0, index).some((s) => s.state === "pending")) throw new PlanProblem(409, "out_of_order", "Decide the earlier steps first");
  if (action === "skip") {
    Object.assign(step, { state: "skipped", decidedBy: who, decidedAt: now });
    settle(plan);
    rt.store.putPlan(plan);
    rt.audit(who, "pin.plan.skip", plan.id, `step ${index + 1}: ${step.label}`);
    return plan;
  }

  if (step.destructive && (typeof confirm !== "string" || confirm.trim() !== step.confirmPhrase)) throw new PlanProblem(409, "confirm", `Type "${step.confirmPhrase}" to approve this step.`);
  Object.assign(step, { state: "running", decidedBy: who, decidedAt: now });
  plan.status = "running";
  rt.store.putPlan(plan);
  rt.audit(who, "pin.plan.approve", plan.id, `step ${index + 1}: ${step.label}${step.destructive ? " (typed confirmation)" : ""}`);
  try {
    const r = await execute(step, ctx.pve, ctx.session, ctx.node, ctx.gateway, rt);
    Object.assign(step, { state: "done", finishedAt: rt.now(), result: r.result, ...(r.upid ? { upid: r.upid } : {}) });
    rt.audit(who, "pin.plan.step.done", plan.id, `step ${index + 1}: ${step.label}`);
  } catch (e) {
    const error = reasonOf(e);
    Object.assign(step, { state: "failed", finishedAt: rt.now(), error });
    // A failed step ends the plan: the steps after it were written assuming it worked.
    for (const s of plan.steps) if (s.state === "pending") Object.assign(s, { state: "skipped" });
    rt.audit(who, "pin.plan.step.failed", plan.id, `step ${index + 1}: ${step.label}: ${error}`);
    pushNotice(rt, who, { key: `plan:${plan.id}:failed`, kind: "proposal", level: "critical", title: `A step of "${plan.title}" failed`, body: `${step.label}: ${error}`, link: "pin?tab=plans" });
  }
  settle(plan);
  rt.store.putPlan(plan);
  return plan;
}

export function cancelPlan(rt: PinRuntime, who: string, planId: string): Plan {
  const plan = rt.store.plan(planId);
  if (!plan || plan.owner !== who) throw new PlanProblem(404, "not_found", "There is no such plan");
  if (plan.status !== "pending") throw new PlanProblem(409, "plan_closed", `This plan is ${plan.status}`);
  for (const s of plan.steps) if (s.state === "pending") Object.assign(s, { state: "skipped", decidedBy: who, decidedAt: rt.now() });
  plan.status = "cancelled";
  rt.store.putPlan(plan);
  rt.audit(who, "pin.plan.cancel", plan.id, plan.title);
  return plan;
}

export async function planRoutes(ctx: FeatureCtx): Promise<boolean> {
  if (!ctx.path.startsWith("/api/pin/plans")) return false;
  const { HttpError, method } = ctx;
  const rt = runtimeFor(ctx.state);
  const wrap = async <T,>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof PlanProblem) throw new HttpError(e.status, e.code, e.message);
      throw e;
    }
  };

  if (ctx.path === "/api/pin/plans" && method === "GET") {
    const s = ctx.session();
    const list = Object.values(rt.store.plans()).filter((p) => p.owner === s.username).sort((a, b) => b.createdAt - a.createdAt).slice(0, PLANS_MAX);
    return ctx.json(200, { plans: list, waiting: list.filter((p) => p.status === "pending").length }), true;
  }
  const one = ctx.path.match(/^\/api\/pin\/plans\/([0-9a-f]{16})(?:\/(cancel)|\/steps\/([0-9a-f]{8})\/(approve|skip|reject))?$/);
  if (!one) throw new HttpError(404, "not_found", "Not found");
  const s = ctx.session();
  if (method === "GET" && !one[2] && !one[3]) {
    const p = rt.store.plan(one[1]);
    if (!p || p.owner !== s.username) throw new HttpError(404, "not_found", "There is no such plan");
    return ctx.json(200, { plan: p }), true;
  }
  if (method !== "POST") throw new HttpError(405, "method", "Method not allowed");
  ctx.sameSite();
  // A person decides in the console. A script's API token can read plans but not approve them.
  if (s.apiToken) throw new HttpError(403, "ticket_only", "Plans are approved in the console, by a signed-in person. API tokens can only read them.");
  if (one[2]) return ctx.json(200, { plan: await wrap(async () => cancelPlan(rt, s.username, one[1])) }), true;
  const b = await ctx.readJson();
  const plan = await ctx.asUser((pve, sess) => wrap(() => decide(rt, { pve, session: sess, node: ctx.node, gateway: ctx.gateway }, one[1], one[3], one[4] as Action, b.confirm)));
  return ctx.json(200, { plan }), true;
}
