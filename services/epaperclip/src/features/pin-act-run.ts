import type { ProxmoxClient } from "@papercliped-engine/proxmox-client";
import { ACTS, actFailure, gate, type ActHost, type Permission } from "./pin-act.ts";
import { cancelPlan, createPlan } from "./pin-agent.ts";
import type { PinRuntime, PlanStep } from "./pin-core.ts";

/**
 * Pin's action tools inside a chat turn. The person's permission setting (pin-act.ts) decides what a call does:
 * it runs now, or it becomes a one-step plan the person approves right in the chat (the same plan the Plans tab shows,
 * approved through the same checks), and the conversation continues with what happened either way.
 */

export const MAX_ACTIONS_PER_CHAT = 30;
/** How long a person has to answer, and how often the stream is checked; tests shorten both. */
export const approvalWait = { maxMs: 15 * 60_000, pollMs: 1000, pingMs: 15_000 };

export interface ActEnv {
  rt: PinRuntime;
  host: { node: string; username: string; pve: () => Promise<ProxmoxClient>; enginePost?: (path: string, body: unknown) => Promise<{ id?: string; identifier?: string }> };
  permission: Permission;
  send: (event: string, data: unknown) => void;
  /** Keeps the stream alive while waiting for the person. */
  ping: () => void;
  signal: AbortSignal;
  counter: { n: number };
}

const cap = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v)).slice(0, 4000);

async function namesOf(env: ActEnv): Promise<Map<number, string>> {
  const names = new Map<number, string>();
  try {
    for (const r of await (await env.host.pve()).clusterResources()) if ((r.type === "lxc" || r.type === "qemu") && typeof r.vmid === "number") names.set(r.vmid, r.name ?? String(r.vmid));
  } catch {
    /* labels fall back to ids */
  }
  return names;
}

const ORG_ID = /^[A-Za-z0-9_-]{1,64}$/;
const clean = (v: unknown, max: number) => (typeof v === "string" ? v : "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);

/** Waits for the person to decide a one-step plan; resolves with the step once it is no longer pending or running. */
async function awaitStep(env: ActEnv, planId: string, stepId: string): Promise<PlanStep | null> {
  const { rt } = env;
  const giveUp = () => {
    try {
      cancelPlan(rt, env.host.username, planId);
    } catch {
      /* already decided */
    }
    return null;
  };
  const deadline = Date.now() + approvalWait.maxMs;
  let lastPing = Date.now();
  for (;;) {
    if (env.signal.aborted) return giveUp();
    const step = rt.store.plan(planId)?.steps.find((s) => s.id === stepId);
    if (step && step.state !== "pending" && step.state !== "running") return step;
    if (Date.now() > deadline) return giveUp();
    if (Date.now() - lastPing >= approvalWait.pingMs) {
      env.ping();
      lastPing = Date.now();
    }
    await new Promise<void>((r) => setTimeout(r, approvalWait.pollMs));
  }
}

/** Runs or asks. Returns what the model should be told, or null when this isn't an action tool. */
export async function handleActCall(env: ActEnv, call: { id: string; name: string; args: Record<string, unknown> }): Promise<string | null> {
  const isTask = call.name === "create_task";
  const def = Object.hasOwn(ACTS, call.name) ? ACTS[call.name] : null;
  if (!def && !isTask) return null;
  const { send, rt } = env;
  const who = env.host.username;
  const fail = (message: string) => {
    send("tool", { id: call.id, name: call.name, args: call.args, status: "error", error: message });
    return cap({ error: message });
  };

  let parsed: Record<string, unknown>;
  let label: string;
  let phrase: string | null = null;
  let risk: "safe" | "disruptive" | "destructive" = "safe";
  const names = await namesOf(env);
  try {
    if (def) {
      parsed = def.parse(call.args);
      risk = def.risk(parsed);
      const d = def.describe(parsed, names);
      label = d.label;
      phrase = risk === "destructive" ? d.phrase : null;
    } else {
      const companyId = typeof call.args.companyId === "string" && ORG_ID.test(call.args.companyId) ? call.args.companyId : null;
      const title = clean(call.args.title, 200);
      if (!companyId || !title) throw new Error("create_task needs a companyId from list_organizations and a title");
      parsed = { companyId, title, ...(call.args.description !== undefined ? { description: clean(call.args.description, 4000) } : {}) };
      label = `Create task "${title}"`;
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message.slice(0, 400) : "That can't be used.");
  }

  if (env.counter.n >= MAX_ACTIONS_PER_CHAT) return fail(`Pin has already made ${MAX_ACTIONS_PER_CHAT} changes in this conversation and stops here. Ask again to continue.`);
  const verdict = gate(env.permission, risk);

  if (verdict === "ask" || verdict === "plan") {
    const step = def ? { kind: "act", tool: def.name, params: parsed } : { kind: "create_task", ...parsed };
    let plan;
    try {
      plan = createPlan(rt, { owner: who, title: label, steps: [step], createdBy: "pin", names });
    } catch (e) {
      return fail(actFailure(e));
    }
    const s = plan.steps[0];
    send("approval", { id: call.id, name: call.name, planId: plan.id, stepId: s.id, label: s.label, destructive: s.destructive, confirmPhrase: s.confirmPhrase, risk });
    const decided = await awaitStep(env, plan.id, s.id);
    if (!decided) {
      send("tool", { id: call.id, name: call.name, args: call.args, status: "error", error: "Not decided in time" });
      return cap({ outcome: "not_decided", message: "The person did not approve it in time, so NOTHING was done. The request was cancelled." });
    }
    env.counter.n++;
    if (decided.state === "done") {
      send("tool", { id: call.id, name: call.name, args: call.args, status: "done", label, result: decided.result ?? "Done." });
      return cap({ outcome: "done", message: decided.result ?? "Done.", ...(decided.upid ? { upid: decided.upid } : {}) });
    }
    if (decided.state === "failed") {
      send("tool", { id: call.id, name: call.name, args: call.args, status: "error", label, error: decided.error ?? "It failed." });
      return cap({ outcome: "failed", error: decided.error ?? "It failed." });
    }
    send("tool", { id: call.id, name: call.name, args: call.args, status: "error", label, error: "The person declined it." });
    return cap({ outcome: "declined", message: "The person declined it. NOTHING was done. Don't try it again unless they ask." });
  }

  // Run now, as the person.
  env.counter.n++;
  rt.audit(who, "pin.act.run", call.name, `${label} (${env.permission} mode)`);
  send("tool", { id: call.id, name: call.name, args: call.args, status: "running", label });
  try {
    let result: string;
    let upid: string | undefined;
    let vmid: number | undefined;
    if (def) {
      const host: ActHost = { node: env.host.node, username: who, pve: env.host.pve, sleep: rt.sleep };
      const r = await def.run(host, parsed);
      result = r.result;
      upid = r.upid;
      vmid = r.vmid;
    } else {
      if (!env.host.enginePost) throw new Error("The engine isn't set up on this host.");
      const issue = await env.host.enginePost(`/api/companies/${encodeURIComponent(parsed.companyId as string)}/issues`, { title: parsed.title, ...(parsed.description ? { description: parsed.description } : {}) });
      result = `Created task ${issue.identifier ?? issue.id ?? ""}`.trim();
    }
    rt.audit(who, "pin.act.done", call.name, `${label}: ${result}`.slice(0, 300));
    send("tool", { id: call.id, name: call.name, args: call.args, status: "done", label, result, ...(vmid ? { vmid } : {}) });
    return cap({ outcome: "done", message: result, ...(upid ? { upid } : {}), ...(vmid ? { vmid } : {}) });
  } catch (e) {
    const message = actFailure(e);
    rt.audit(who, "pin.act.failed", call.name, `${label}: ${message}`.slice(0, 300));
    send("tool", { id: call.id, name: call.name, args: call.args, status: "error", label, error: message });
    return cap({ outcome: "failed", error: message });
  }
}
