import { AutomationEngine, describeSpec, inScope, nextDue, pointless, ruleOf, validateSpec, type AutomationSpec, type GuestSnapshot } from "@papercliped-engine/automations";
import { ProxmoxClient, ProxmoxError, type ClusterResource, type GuestType } from "@papercliped-engine/proxmox-client";
import type { FeatureCtx } from "./index.ts";
import { PlanProblem, createPlan } from "./pin-agent.ts";
import { PinRuntime, automationSecret, configurePinRuntime, isConfigured, newId, runtimeFor, type Automation, type PinRuntimeOpts, type Run, type RunStep } from "./pin-core.ts";
import { pushNotice } from "./pin-notify.ts";
import { updateTick } from "./pin-update.ts";

/**
 * The automation runner. Automations (rules that watch machines, and schedules) run here, on the host service, with no
 * browser open:
 *
 * - Identity. Every automation acts through its own Proxmox API token, made for its owner when it is created. By default
 *   the token is privilege-separated and holds only the role its action needs (view, or view plus power and snapshot)
 *   on the machines in its scope, so it can never do more than that, and never more than its owner may. If the owner
 *   can't delegate permissions, they can choose "act with all my permissions" explicitly; the code still limits it to
 *   its one action and scope.
 * - No overlap. One pass at a time, and one run per automation at a time, whatever the clock does.
 * - Bounded retries. A transient Proxmox failure is retried 3 times with short waits; a refusal is never retried. A
 *   failed run backs the automation off (1, 2, 4 ... up to 60 minutes) and three failed runs in a row pause it.
 * - Visible. Every run that did something or failed is kept with its steps; failures and pauses reach the owner's inbox.
 * - Pin's mode decides. In Assistant mode an action becomes a one-step plan waiting for the owner's approval; in
 *   Agent mode it runs now. Protected machines (tag "protected") only ever notify. Nothing here can destroy a machine.
 */

export const MAX_FAILURES = 3;
export const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1000, 4000];
const STEPS_PER_RUN = 25;
const TICK_MS = 15_000;
const TASK_TIMEOUT_MS = 120_000;
const MAX_PER_USER = 50;
/** An automation's Proxmox token lives this long unless the owner picks otherwise, and can be renewed. */
export const TOKEN_DEFAULT_DAYS = 90;
export const TOKEN_MAX_DAYS = 366;
const DAY_MS = 86_400_000;
const ROLE_FOR = (action: string) => (action === "notify" ? "PVEAuditor" : "PVEVMUser");

const pad = (n: number) => String(n).padStart(2, "0");
const stamp = (t: number) => {
  const d = new Date(t);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
};

const transient = (e: unknown) => (e instanceof ProxmoxError ? e.status >= 500 : !(e instanceof PlanProblem));
const reason = (e: unknown): string => {
  if (e instanceof ProxmoxError) {
    if (e.status === 401) return "Proxmox no longer accepts this automation's token (its owner may have been disabled or removed).";
    if (e.status === 403) return "Proxmox refused: the automation's token doesn't have permission for this.";
    return e.detail ? `Proxmox: ${e.detail.slice(0, 300)}` : "Proxmox couldn't do it.";
  }
  const code = (e as { code?: unknown })?.code;
  if (typeof code === "string" && /^E[A-Z]+/.test(code)) return "Couldn't reach Proxmox.";
  return "It failed.";
};

export class AutomationRunner {
  private readonly rt: PinRuntime;
  private readonly active = new Set<string>();
  private readonly engines = new Map<string, AutomationEngine>();
  private ticking = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(rt: PinRuntime) {
    this.rt = rt;
  }

  /** Runs left "running" by a restart are finished as failed, so history never shows one that can't end. */
  recover() {
    for (const r of this.rt.store.runs()) {
      if (r.status !== "running") continue;
      this.rt.store.putRun({ ...r, status: "failed", finishedAt: this.rt.now(), error: "Interrupted: the host service restarted while this ran." });
    }
  }

  start(ms = TICK_MS) {
    this.recover();
    this.timer = setInterval(() => void this.tick().catch(() => {}), ms);
    this.timer.unref();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  isRunning(id: string) {
    return this.active.has(id);
  }

  private clientFor(a: Automation): ProxmoxClient {
    const secret = this.rt.state.getSecret(automationSecret(a.id));
    if (!secret) throw new PlanProblem(500, "no_token", "This automation's Proxmox token is missing.");
    const p = this.rt.opts.pve;
    return new ProxmoxClient({ baseUrl: p.baseUrl, caPem: p.caPem, transport: p.transport, tokenId: `${a.owner}!${a.tokenName}`, tokenSecret: secret });
  }

  /** One pass: every automation that is due, one after another. A pass that is still going is never joined by another. */
  async tick(): Promise<void> {
    if (this.ticking || !isConfigured(this.rt)) return;
    this.ticking = true;
    try {
      // Updates ride the same tick: reminders, the maintenance window, and writing down what the helper finished.
      await updateTick(this.rt).catch(() => {});
      const now = this.rt.now();
      for (const a of Object.values(this.rt.store.automations())) {
        // Tokens end. A day or more before, the owner is told; when it ends the automation stops (not fails) until renewed.
        if (a.tokenExpiresAt) {
          if (a.tokenExpiresAt <= now && !a.paused) {
            this.rt.store.patchAutomation(a.id, { paused: { at: now, reason: "Its Proxmox token expired. Renew it to resume.", by: "runner" }, retryAt: null });
            this.rt.audit(`automation:${a.id}`, "pin.automation.expired", a.id, a.spec.name);
            pushNotice(this.rt, a.owner, { key: `automation:${a.id}:expired:${a.tokenExpiresAt}`, kind: "automation", level: "critical", title: `${a.spec.name} stopped: its token expired`, body: "Renew it on Pin's Automations tab to start it again.", link: "pin?tab=automations" });
            continue;
          }
          if (a.tokenExpiresAt - now < 7 * DAY_MS && !a.paused) pushNotice(this.rt, a.owner, { key: `automation:${a.id}:expiring:${a.tokenExpiresAt}`, kind: "automation", level: "warning", title: `${a.spec.name}: its token ends soon`, body: `It ends on ${new Date(a.tokenExpiresAt).toLocaleDateString()}. Renew it on Pin's Automations tab.`, link: "pin?tab=automations" });
        }
        if (a.paused || this.active.has(a.id)) continue;
        const due = dueOf(a, now);
        if (due > this.rt.now()) continue;
        await this.run(a.id, "schedule").catch(() => {});
      }
    } finally {
      this.ticking = false;
    }
  }

  async runNow(id: string): Promise<Run> {
    return this.run(id, "manual");
  }

  private async run(id: string, trigger: Run["trigger"]): Promise<Run> {
    const a0 = this.rt.store.automation(id);
    if (!a0) throw new PlanProblem(404, "not_found", "There is no such automation");
    if (this.active.has(id)) throw new PlanProblem(409, "already_running", "This automation is already running.");
    this.active.add(id);
    const run: Run = { id: newId(6), automationId: id, automationName: a0.spec.name, owner: a0.owner, trigger, startedAt: this.rt.now(), finishedAt: null, status: "running", steps: [] };
    let fatal = false;
    try {
      this.rt.store.putRun(run);
      await this.execute(a0, run);
    } catch (e) {
      run.error = reason(e);
      run.status = "failed";
      fatal = e instanceof ProxmoxError && e.status === 401;
    } finally {
      this.active.delete(id);
    }
    run.finishedAt = this.rt.now();
    if (run.status === "running") run.status = run.steps.some((s) => s.result === "failed") ? "failed" : run.steps.some((s) => s.result === "proposed") ? "proposed" : run.steps.length ? "ok" : "skipped";
    if (run.status === "failed" && !run.error) run.error = run.steps.filter((s) => s.result === "failed").map((s) => `${s.name ?? s.vmid}: ${s.detail}`).join("; ").slice(0, 500);
    // A pass that looked and found nothing to do is not history: it would push out the runs that matter.
    if (trigger === "manual" || run.steps.length || run.status === "failed") this.rt.store.putRun(run);
    else this.dropRun(run.id);
    this.finish(id, run, fatal);
    return run;
  }

  private dropRun(runId: string) {
    this.rt.state.setSetting("pin.runs", this.rt.store.runs().filter((r) => r.id !== runId));
  }

  private finish(id: string, run: Run, fatal: boolean) {
    const a = this.rt.store.automation(id);
    if (!a) return;
    const now = this.rt.now();
    const failed = run.status === "failed";
    const consecutiveFailures = failed ? a.consecutiveFailures + 1 : 0;
    const patch: Partial<Automation> = { lastRunAt: now, lastStatus: run.status === "skipped" ? "ok" : run.status, consecutiveFailures, retryAt: failed ? now + Math.min(60 * 60_000, 60_000 * 2 ** (consecutiveFailures - 1)) : null, updatedAt: a.updatedAt };
    if (failed && (fatal || consecutiveFailures >= MAX_FAILURES)) {
      const why = fatal ? run.error! : `It failed ${consecutiveFailures} times in a row. Last error: ${run.error ?? "unknown"}`;
      patch.paused = { at: now, reason: why.slice(0, 400), by: "runner" };
      patch.retryAt = null;
      this.rt.audit(`automation:${id}`, "pin.automation.pause", id, why);
    }
    this.rt.store.patchAutomation(id, patch);
    if (failed) {
      pushNotice(this.rt, a.owner, { key: `automation:${id}:${run.id}`, kind: "automation", level: "critical", title: patch.paused ? `${a.spec.name} was paused after failing` : `${a.spec.name} failed`, body: `${run.error ?? "It failed."}${patch.paused ? " Fix the cause, then resume it on Pin's Automations tab." : " It will try again shortly."}`, link: "pin?tab=automations" });
    }
  }

  private async execute(a: Automation, run: Run) {
    const rt = this.rt;
    const pve = this.clientFor(a);
    const res = await this.retry(() => pve.clusterResources());
    const live = res.value.filter((r): r is ClusterResource & { vmid: number } => (r.type === "lxc" || r.type === "qemu") && typeof r.vmid === "number" && r.template !== 1);
    const names = new Map(live.map((g) => [g.vmid, g.name ?? String(g.vmid)]));
    const protectedIds = new Set(live.filter((g) => (g.tags ?? "").split(/[;, ]+/).includes("protected")).map((g) => g.vmid));
    const mode = (rt.state.getSetting<Record<string, { mode?: string }>>("pin.settings") ?? {})[a.owner]?.mode === "agent" ? "agent" : "assistant";
    const spec = a.spec;
    const snapshots: GuestSnapshot[] = live.map((g) => ({ vmid: g.vmid, type: g.type, node: g.node, pool: g.pool, tags: g.tags, name: g.name, status: g.status, template: g.template, mem: g.mem, maxmem: g.maxmem, cpu: g.cpu, disk: g.disk, maxdisk: g.maxdisk }));

    type Hit = { vmid: number; type: GuestType; node: string; name: string | null; action: AutomationSpec["then"]["action"]; kind: "execute" | "propose" | "notify"; why: string };
    let hits: Hit[] = [];
    if (spec.trigger.type === "condition") {
      let eng = this.engines.get(a.id);
      if (!eng) this.engines.set(a.id, (eng = new AutomationEngine({ mode })));
      eng.setMode(mode);
      eng.setProtected(protectedIds);
      hits = eng.evaluate([ruleOf(a.id, true, spec)!], snapshots, rt.now()).map((d) => ({ vmid: d.vmid, type: d.guestType, node: d.node ?? rt.opts.pve.node, name: d.name, action: d.action, kind: d.kind, why: d.reason }));
    } else {
      for (const g of snapshots as (GuestSnapshot & { vmid: number; type: "lxc" | "qemu" })[]) {
        if (!inScope({ id: a.id, name: spec.name, enabled: true, when: { metric: "status", op: "!=", value: "x", forSeconds: 0 }, scope: spec.scope, then: spec.then, cooldownSeconds: 0, createdBy: spec.createdBy }, g) || pointless(spec.then.action, g.status)) continue;
        const prot = protectedIds.has(g.vmid) && spec.then.action !== "notify";
        hits.push({ vmid: g.vmid, type: g.type, node: g.node ?? rt.opts.pve.node, name: g.name ?? null, action: spec.then.action, kind: spec.then.action === "notify" || prot ? "notify" : mode === "agent" ? "execute" : "propose", why: prot ? "scheduled; the machine is protected, so only notifying" : "scheduled" });
      }
    }

    for (const h of hits.slice(0, STEPS_PER_RUN)) {
      const step: RunStep = { vmid: h.vmid, name: h.name, action: h.action, result: "skipped" };
      run.steps.push(step);
      rt.store.putRun(run);
      try {
        if (h.kind === "notify") {
          step.result = "notified";
          step.detail = h.why;
          pushNotice(rt, a.owner, { key: `automation:${a.id}:${h.vmid}:${Math.floor(rt.now() / 60_000)}`, kind: "automation", level: "warning", title: `${spec.name}: ${h.name ?? `machine ${h.vmid}`}`, body: h.why, link: "pin?tab=automations" });
        } else if (h.kind === "propose") {
          const waiting = Object.values(rt.store.plans()).some((p) => p.status === "pending" && p.automationId === a.id && p.steps.some((s) => s.args.vmid === h.vmid));
          if (waiting) {
            step.detail = "A proposal for this machine is already waiting for approval.";
            continue;
          }
          const kind = h.action === "snapshot" ? ({ kind: "snapshot", vmid: h.vmid, name: `auto-${stamp(rt.now())}` } as const) : ({ kind: "power", vmid: h.vmid, action: h.action } as const);
          const plan = createPlan(rt, { owner: a.owner, title: `${spec.name}: ${h.action} ${h.name ?? h.vmid}`, summary: `${describeSpec(spec)} ${h.why}.`, steps: [kind], createdBy: "automation", automationId: a.id, names });
          step.result = "proposed";
          step.detail = `Waiting for approval (plan ${plan.id}).`;
        } else {
          const done = await this.act(pve, h, rt.now());
          step.result = "done";
          step.upid = done.upid;
          step.attempts = done.attempts;
          step.detail = done.detail;
          pushNotice(rt, a.owner, { key: `automation:${a.id}:${h.vmid}:${run.id}`, kind: "automation", level: "info", title: `${spec.name}: ${h.name ?? `machine ${h.vmid}`}`, body: done.detail, link: "pin?tab=automations" });
        }
      } catch (e) {
        step.result = "failed";
        step.detail = reason(e);
        step.attempts = (e as { attempts?: number }).attempts ?? 1;
        if (e instanceof ProxmoxError && e.status === 401) throw e;
      }
    }
    if (hits.length > STEPS_PER_RUN) run.steps.push({ vmid: 0, name: null, action: spec.then.action, result: "skipped", detail: `${hits.length - STEPS_PER_RUN} more machines matched; they are handled on later passes.` });
  }

  private async retry<T>(fn: () => Promise<T>): Promise<{ value: T; attempts: number }> {
    for (let attempt = 1; ; attempt++) {
      try {
        return { value: await fn(), attempts: attempt };
      } catch (e) {
        if (!transient(e) || attempt >= MAX_ATTEMPTS) throw Object.assign(e as object, { attempts: attempt });
        await this.rt.sleep(BACKOFF_MS[attempt - 1] ?? 4000);
      }
    }
  }

  /** Does the one thing the automation is for, to one machine, and waits for Proxmox to finish it. */
  private async act(pve: ProxmoxClient, h: { vmid: number; type: GuestType; node: string; action: string }, now: number): Promise<{ upid?: string; attempts: number; detail: string }> {
    const call = () => (h.action === "snapshot" ? pve.createSnapshot(h.node, h.type, h.vmid, `auto-${stamp(now)}`, "Taken by an ePaperclip automation") : pve.guestPower(h.node, h.type, h.vmid, h.action as "start" | "stop" | "shutdown"));
    const r = await this.retry(call);
    const upid = r.value;
    // The request being accepted isn't the end: the task can still fail, and then the run must say so.
    if (typeof upid === "string" && upid.startsWith("UPID:")) await pve.waitTask(h.node, upid, { timeoutMs: TASK_TIMEOUT_MS, pollMs: 2000, sleep: this.rt.sleep });
    return { upid: typeof upid === "string" ? upid : undefined, attempts: r.attempts, detail: h.action === "snapshot" ? "Took a snapshot." : `Asked Proxmox to ${h.action === "shutdown" ? "shut down" : h.action} it, and it finished.` };
  }
}

// ---- Setting up and routes

/** Called once by the host service's entry point: configures the runtime and starts the runner. */
export function startPinRuntime(state: Parameters<typeof configurePinRuntime>[0], opts: PinRuntimeOpts, o: { run?: boolean } = {}) {
  const rt = configurePinRuntime(state, opts);
  const runner = new AutomationRunner(rt);
  rt.runner = runner;
  if (o.run !== false) runner.start();
  return { rt, runner };
}

/** When an automation is next due. A daily time counts from when it was made, so one made after today's time waits for tomorrow's. */
const dueOf = (a: Automation, now: number) => a.retryAt ?? nextDue(a.spec.trigger, a.lastRunAt ?? (a.spec.trigger.type === "schedule" && a.spec.trigger.dailyAt ? a.createdAt : null), now);

const pathsFor = (spec: AutomationSpec): string[] => {
  const s = spec.scope;
  if (s.vmids && s.vmids.length <= 50) return s.vmids.map((v) => `/vms/${v}`);
  if (s.pool) return [`/pool/${s.pool}`];
  return ["/vms"];
};

const enc = encodeURIComponent;

const view = (rt: PinRuntime, a: Automation) => {
  const runner = rt.runner as AutomationRunner | null;
  return {
    id: a.id,
    name: a.spec.name,
    owner: a.owner,
    spec: a.spec,
    readBack: describeSpec(a.spec),
    permissions: a.permissions,
    tokenExpiresAt: a.tokenExpiresAt ?? null,
    tokenName: a.tokenName,
    permissionsNote: a.permissions === "scoped" ? "Acts through its own Proxmox token that can only view, and power or snapshot machines, within its scope." : "Acts with all of its owner's Proxmox permissions, limited by its one action and scope.",
    paused: a.paused,
    running: runner?.isRunning(a.id) ?? false,
    createdAt: a.createdAt,
    lastRunAt: a.lastRunAt,
    lastStatus: a.lastStatus,
    consecutiveFailures: a.consecutiveFailures,
    nextRunAt: a.paused ? null : dueOf(a, rt.now()),
    retryAt: a.retryAt,
  };
};

export async function automationRoutes(ctx: FeatureCtx): Promise<boolean> {
  if (!ctx.path.startsWith("/api/pin/automations")) return false;
  const { HttpError, method } = ctx;
  const rt = runtimeFor(ctx.state);
  const s = ctx.session();
  const wrap = async <T,>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof PlanProblem) throw new HttpError(e.status, e.code, e.message);
      throw e;
    }
  };
  const admin = async () => ctx.asUser((pve) => ctx.isNodeAdmin(pve));
  const mine = async (id: string): Promise<Automation> => {
    const a = rt.store.automation(id);
    if (!a || (a.owner !== s.username && !(await admin()))) throw new HttpError(404, "not_found", "There is no such automation");
    return a;
  };

  if (ctx.path === "/api/pin/automations" && method === "GET") {
    const all = await admin();
    const list = Object.values(rt.store.automations()).filter((a) => all || a.owner === s.username).sort((a, b) => b.createdAt - a.createdAt);
    return ctx.json(200, { automations: list.map((a) => view(rt, a)), canSeeAll: all, runnerReady: isConfigured(rt) }), true;
  }

  if (ctx.path === "/api/pin/automations/preview" && method === "POST") {
    const b = await ctx.readJson();
    const { allowOwnerPermissions: _ignored, ...rest } = b;
    const v = validateSpec(rest);
    return ctx.json(200, v.ok ? { ok: true, readBack: describeSpec(v.spec) } : { ok: false, errors: v.errors }), true;
  }

  if (ctx.path === "/api/pin/automations/runs" && method === "GET") {
    const all = await admin();
    const id = ctx.url.searchParams.get("automation");
    const limit = Math.min(200, Math.max(1, Number(ctx.url.searchParams.get("limit")) || 50));
    const runs = rt.store.runs().filter((r) => (all || r.owner === s.username) && (!id || r.automationId === id)).reverse().slice(0, limit);
    return ctx.json(200, { runs }), true;
  }

  if (ctx.path === "/api/pin/automations" && method === "POST") {
    ctx.sameSite();
    if (s.apiToken) throw new HttpError(403, "ticket_only", "Automations are created in the console, by a signed-in person.");
    if (!isConfigured(rt)) throw new HttpError(503, "runner_unavailable", "The automation runner isn't running on this host service.");
    const b = await ctx.readJson();
    const { allowOwnerPermissions, tokenDays, ...rest } = b;
    if (tokenDays !== undefined && (typeof tokenDays !== "number" || !Number.isInteger(tokenDays) || tokenDays < 1 || tokenDays > TOKEN_MAX_DAYS)) throw new HttpError(400, "bad_request", `tokenDays is between 1 and ${TOKEN_MAX_DAYS}`);
    const tokenExpiresAt = rt.now() + (tokenDays ?? TOKEN_DEFAULT_DAYS) * DAY_MS;
    if (allowOwnerPermissions !== undefined && typeof allowOwnerPermissions !== "boolean") throw new HttpError(400, "bad_request", "allowOwnerPermissions must be true or false");
    const v = validateSpec(rest);
    if (!v.ok) throw new HttpError(400, "bad_automation", v.errors.join("; "));
    if (Object.values(rt.store.automations()).filter((a) => a.owner === s.username).length >= MAX_PER_USER) throw new HttpError(409, "too_many", `You can have up to ${MAX_PER_USER} automations.`);
    const id = newId(4);
    const tokenName = `epcauto-${id}`;
    const tokenId = `${s.username}!${tokenName}`;
    const created = await ctx.asUser(async (pve) => {
      const made = async (privsep: boolean) => {
        const r = await pve.callFull<{ value?: string }>("POST", `/access/users/${enc(s.username)}/token/${enc(tokenName)}`, { comment: `ePaperclip automation: ${v.spec.name}`.slice(0, 120), expire: Math.floor(tokenExpiresAt / 1000), privsep });
        if (!r.data?.value) throw new HttpError(502, "proxmox_error", "Proxmox didn't return a token for the automation.");
        return r.data.value;
      };
      let secret = await made(true);
      let permissions: Automation["permissions"] = "scoped";
      try {
        for (const path of pathsFor(v.spec)) await pve.call("PUT", "/access/acl", { path, roles: ROLE_FOR(v.spec.then.action), tokens: tokenId, propagate: true });
      } catch (e) {
        await pve.call("DELETE", `/access/users/${enc(s.username)}/token/${enc(tokenName)}`).catch(() => {});
        if (!(e instanceof ProxmoxError) || e.status !== 403) throw e;
        if (allowOwnerPermissions !== true) throw new HttpError(409, "needs_permissions", "You don't have the right to give an automation its own limited permissions here. You can let it act with all of your permissions instead (it is still limited to its one action and scope).");
        secret = await made(false);
        permissions = "owner";
      }
      return { secret, permissions };
    });
    const now = rt.now();
    rt.state.setSecret(automationSecret(id), created.secret);
    const a: Automation = { id, spec: v.spec, owner: s.username, paused: null, permissions: created.permissions, tokenName, tokenExpiresAt, createdAt: now, updatedAt: now, lastRunAt: null, lastStatus: null, consecutiveFailures: 0, retryAt: null };
    // A new condition automation starts looking at the next pass; a schedule waits for its time.
    rt.store.putAutomation(a);
    rt.audit(s.username, "pin.automation.create", id, `${v.spec.name} (${created.permissions} permissions)`);
    return ctx.json(201, { automation: view(rt, a) }), true;
  }

  const one = ctx.path.match(/^\/api\/pin\/automations\/([0-9a-f]{8})(?:\/(pause|resume|run|renew))?$/);
  if (!one) throw new HttpError(404, "not_found", "Not found");
  if (method === "GET" && !one[2]) {
    const a = await mine(one[1]);
    return ctx.json(200, { automation: view(rt, a), runs: rt.store.runs().filter((r) => r.automationId === a.id).reverse().slice(0, 30) }), true;
  }
  ctx.sameSite();
  const a = await mine(one[1]);
  if (method === "DELETE" && !one[2]) {
    // Remove the Proxmox token as the person (Proxmox decides if they may); the secret goes either way, so it can never be used again.
    const tokenGone = await ctx.asUser((pve) => pve.call("DELETE", `/access/users/${enc(a.owner)}/token/${enc(a.tokenName)}`).then(() => true, () => false));
    rt.state.deleteSecret(automationSecret(a.id));
    rt.store.deleteAutomation(a.id);
    rt.audit(s.username, "pin.automation.delete", a.id, a.spec.name);
    return ctx.json(200, { ok: true, tokenRemoved: tokenGone }), true;
  }
  if (method !== "POST" || !one[2]) throw new HttpError(405, "method", "Method not allowed");
  if (one[2] === "renew") {
    // A new end date for the automation's Proxmox token, made as the owner (or an administrator): Proxmox and the host agree on it.
    if (s.apiToken) throw new HttpError(403, "ticket_only", "Renewing an automation's token needs a signed-in person; API tokens can't do it.");
    const b = await ctx.readJson();
    const days = b.days === undefined ? TOKEN_DEFAULT_DAYS : b.days;
    if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > TOKEN_MAX_DAYS) throw new HttpError(400, "bad_request", `Renew for 1 to ${TOKEN_MAX_DAYS} days from now`);
    const until = rt.now() + days * DAY_MS;
    await ctx.asUser((pve) => pve.call("PUT", `/access/users/${enc(a.owner)}/token/${enc(a.tokenName)}`, { expire: Math.floor(until / 1000) }));
    const expiredPause = a.paused?.by === "runner" && /token expired/.test(a.paused.reason);
    rt.store.patchAutomation(a.id, { tokenExpiresAt: until, ...(expiredPause ? { paused: null, consecutiveFailures: 0, retryAt: null } : {}) });
    rt.audit(s.username, "pin.automation.renew", a.id, `${a.spec.name} until ${new Date(until).toISOString().slice(0, 10)}`);
    return ctx.json(200, { automation: view(rt, rt.store.automation(a.id)!) }), true;
  }
  if (one[2] === "pause") {
    rt.store.patchAutomation(a.id, { paused: { at: rt.now(), reason: "Paused by you.", by: "user" } });
    rt.audit(s.username, "pin.automation.pause", a.id, a.spec.name);
  } else if (one[2] === "resume") {
    rt.store.patchAutomation(a.id, { paused: null, consecutiveFailures: 0, retryAt: null });
    rt.audit(s.username, "pin.automation.resume", a.id, a.spec.name);
  } else {
    if (!isConfigured(rt) || !rt.runner) throw new HttpError(503, "runner_unavailable", "The automation runner isn't running on this host service.");
    if (a.paused) throw new HttpError(409, "paused", "Resume this automation to run it.");
    rt.audit(s.username, "pin.automation.run", a.id, a.spec.name);
    const run = await wrap(() => rt.runner!.runNow(a.id));
    return ctx.json(200, { run, automation: view(rt, rt.store.automation(a.id) ?? a) }), true;
  }
  return ctx.json(200, { automation: view(rt, rt.store.automation(a.id)!) }), true;
}
