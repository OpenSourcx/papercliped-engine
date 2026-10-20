import { randomBytes } from "node:crypto";
import type { Transport } from "@papercliped-engine/proxmox-client";
import type { AutomationSpec } from "@papercliped-engine/automations";
import type { HttpFetch } from "../connectors.ts";
import type { StateStore } from "../state.ts";
import { appendAudit } from "./access-tokens.ts";

/**
 * What Pin's runtime keeps and shares: automations and their run history, each person's notification inbox and
 * preferences, Agent mode plans, and the runtime's wiring (how to reach Proxmox without a signed-in person, the engine,
 * the outside world). Everything is stored in the host service's state file (docs/PIN.md); nothing secret is kept
 * here except in the vault, under names no response ever carries.
 *
 * The runtime is configured once by the host service's entry point (`configurePinRuntime`) and found again by the
 * routes through the state store they share. Tests configure it with fakes and a clock they control.
 */

export type Sleep = (ms: number) => Promise<void>;

export interface PinRuntimeOpts {
  /** How to reach Proxmox for background work (automations act with their own Proxmox API token, never a ticket). */
  pve: { baseUrl: string; node: string; caPem?: string; transport?: Transport };
  /** Outbound HTTP for the release feed. */
  fetch?: HttpFetch;
  now?: () => number;
  sleep?: Sleep;
  /** Where the installed version is written and where the release feed is; tests and unusual installs move them. */
  update?: { versionFile?: string; feedUrl?: string; signedFeedUrl?: string; pubKeyFile?: string; helperDir?: string; modulesDir?: string; aptHistory?: string; kernelRelease?: string };
}

export interface Automation {
  id: string;
  spec: AutomationSpec;
  owner: string;
  /** Set when the runner stopped it (bounded failures, the owner's account gone): resume clears it. */
  paused: { at: number; reason: string; by: "runner" | "user" } | null;
  /** "scoped": the automation's own Proxmox token holds only the privileges its action needs, on its scope. "owner": it acts with all of its owner's permissions. */
  permissions: "scoped" | "owner";
  tokenName: string;
  /** When the automation's Proxmox token ends (it always has an end; renewing moves it). Missing on automations made before tokens expired. */
  tokenExpiresAt?: number | null;
  createdAt: number;
  updatedAt: number;
  lastRunAt: number | null;
  lastStatus: RunStatus | null;
  consecutiveFailures: number;
  /** Earliest time the next run may start after a failure (backoff). */
  retryAt: number | null;
}

export type RunStatus = "running" | "ok" | "failed" | "skipped" | "proposed";

export interface RunStep {
  vmid: number;
  name: string | null;
  action: string;
  /** What happened: done, proposed (waiting for approval), notified, skipped, or failed. */
  result: "done" | "proposed" | "notified" | "skipped" | "failed";
  detail?: string;
  upid?: string;
  attempts?: number;
}

export interface Run {
  id: string;
  automationId: string;
  automationName: string;
  owner: string;
  trigger: "schedule" | "manual";
  startedAt: number;
  finishedAt: number | null;
  status: RunStatus;
  steps: RunStep[];
  error?: string;
}

export type NoticeKind = "task_finished" | "backup_failed" | "node_event" | "approval" | "automation" | "proposal" | "update";
export const NOTICE_KINDS: readonly NoticeKind[] = ["task_finished", "backup_failed", "node_event", "approval", "automation", "proposal", "update"];
export type NoticeLevel = "info" | "warning" | "critical";

export interface Notice {
  id: string;
  /** Same key, same notice: collecting twice never doubles an entry. */
  key: string;
  kind: NoticeKind;
  level: NoticeLevel;
  title: string;
  body: string;
  at: number;
  read: boolean;
  /** Whether the island may briefly expand for it. False for quiet kinds and during quiet hours. */
  peek: boolean;
  /** A console path to open, relative to the device ("tasks", "pin?tab=plans"). */
  link?: string;
}

export interface Prefs {
  /** Kinds the person switched off: never stored in their inbox. */
  muted: NoticeKind[];
  /** Kinds that sit in the inbox without ever expanding the island. */
  quiet: NoticeKind[];
  /** No island peeks between these local times ("22:00" to "07:00"); the inbox still collects. */
  quietHours: { enabled: boolean; from: string; to: string };
}

export const DEFAULT_PREFS: Prefs = { muted: [], quiet: ["task_finished", "automation", "update"], quietHours: { enabled: false, from: "22:00", to: "07:00" } };

export type StepKind = "power" | "snapshot" | "snapshot_delete" | "snapshot_rollback" | "create_task" | "act" | "note_create" | "notes_file";
export type StepState = "pending" | "running" | "done" | "failed" | "skipped" | "rejected";

export interface PlanStep {
  id: string;
  kind: StepKind;
  args: Record<string, unknown>;
  /** One line a person can read: "Shut down machine 101 (web)". */
  label: string;
  /** Interrupts a running machine or can't be undone: approving needs the typed phrase. */
  destructive: boolean;
  confirmPhrase: string | null;
  state: StepState;
  decidedBy?: string;
  decidedAt?: number;
  finishedAt?: number;
  upid?: string;
  result?: string;
  error?: string;
}

export type PlanStatus = "pending" | "running" | "done" | "failed" | "cancelled";

export interface Plan {
  id: string;
  owner: string;
  title: string;
  summary: string;
  createdAt: number;
  createdBy: "pin" | "automation" | "app";
  /** The automation that proposed it, when it came from one. */
  automationId?: string;
  status: PlanStatus;
  steps: PlanStep[];
}

const SETTING = {
  automations: "pin.automations",
  runs: "pin.runs",
  plans: "pin.plans",
  nodes: "pin.nodeStates",
} as const;
export const RUNS_MAX = 300;
export const PLANS_MAX = 200;
export const INBOX_MAX = 200;
const inboxKey = (u: string) => `pin.inbox:${u}`;
const prefsKey = (u: string) => `pin.prefs:${u}`;
const cursorKey = (u: string) => `pin.cursor:${u}`;
export const automationSecret = (id: string) => `pin.automation.${id}`;

export const newId = (n = 8) => randomBytes(n).toString("hex");

export class PinStore {
  readonly state: StateStore;
  constructor(state: StateStore) {
    this.state = state;
  }
  automations = (): Record<string, Automation> => this.state.getSetting<Record<string, Automation>>(SETTING.automations) ?? {};
  saveAutomations = (v: Record<string, Automation>) => this.state.setSetting(SETTING.automations, v);
  automation = (id: string): Automation | undefined => this.automations()[id];
  putAutomation(a: Automation) {
    this.saveAutomations({ ...this.automations(), [a.id]: a });
  }
  patchAutomation(id: string, patch: Partial<Automation>): Automation | undefined {
    const cur = this.automation(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch };
    this.putAutomation(next);
    return next;
  }
  deleteAutomation(id: string) {
    const all = this.automations();
    delete all[id];
    this.saveAutomations(all);
  }

  runs = (): Run[] => this.state.getSetting<Run[]>(SETTING.runs) ?? [];
  putRun(r: Run) {
    const list = this.runs();
    const i = list.findIndex((x) => x.id === r.id);
    if (i >= 0) list[i] = r;
    else list.push(r);
    this.state.setSetting(SETTING.runs, list.slice(-RUNS_MAX));
  }

  plans = (): Record<string, Plan> => this.state.getSetting<Record<string, Plan>>(SETTING.plans) ?? {};
  plan = (id: string): Plan | undefined => this.plans()[id];
  putPlan(p: Plan) {
    const all = { ...this.plans(), [p.id]: p };
    const ids = Object.keys(all);
    if (ids.length > PLANS_MAX) {
      // Forget the oldest finished plans first; a plan still waiting for a decision is never dropped.
      const drop = ids.map((i) => all[i]).filter((x) => x.status !== "pending" && x.status !== "running").sort((a, b) => a.createdAt - b.createdAt).slice(0, ids.length - PLANS_MAX);
      for (const d of drop) delete all[d.id];
    }
    this.state.setSetting(SETTING.plans, all);
  }

  inbox = (user: string): Notice[] => this.state.getSetting<Notice[]>(inboxKey(user)) ?? [];
  saveInbox = (user: string, list: Notice[]) => this.state.setSetting(inboxKey(user), list.slice(0, INBOX_MAX));
  prefs = (user: string): Prefs => ({ ...DEFAULT_PREFS, ...(this.state.getSetting<Partial<Prefs>>(prefsKey(user)) ?? {}), quietHours: { ...DEFAULT_PREFS.quietHours, ...(this.state.getSetting<Partial<Prefs>>(prefsKey(user))?.quietHours ?? {}) } });
  savePrefs = (user: string, p: Prefs) => this.state.setSetting(prefsKey(user), p);
  cursor = (user: string): { tasksSince: number; collectedAt: number } => this.state.getSetting(cursorKey(user)) ?? { tasksSince: 0, collectedAt: 0 };
  saveCursor = (user: string, c: { tasksSince: number; collectedAt: number }) => this.state.setSetting(cursorKey(user), c);
  nodeStates = (): Record<string, string> => this.state.getSetting<Record<string, string>>(SETTING.nodes) ?? {};
  saveNodeStates = (v: Record<string, string>) => this.state.setSetting(SETTING.nodes, v);
}

export class PinRuntime {
  readonly state: StateStore;
  readonly store: PinStore;
  readonly opts: PinRuntimeOpts;
  readonly now: () => number;
  sleep: Sleep;
  /** Set by the automation runner when it exists, so routes can ask it to run something now. */
  runner: { runNow(id: string): Promise<Run> } | null = null;

  constructor(state: StateStore, opts: PinRuntimeOpts) {
    this.state = state;
    this.store = new PinStore(state);
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  audit(actor: string, action: string, target?: string, detail?: string) {
    appendAudit(this.state, this.now, { actor, action, target, detail: detail?.slice(0, 300) });
  }
}

const runtimes = new WeakMap<StateStore, PinRuntime>();

export function configurePinRuntime(state: StateStore, opts: PinRuntimeOpts): PinRuntime {
  const rt = new PinRuntime(state, opts);
  runtimes.set(state, rt);
  return rt;
}

/** The runtime for a state store. Without `configurePinRuntime` the routes that need Proxmox or the outside world say so. */
export function runtimeFor(state: StateStore): PinRuntime {
  let rt = runtimes.get(state);
  if (!rt) {
    rt = new PinRuntime(state, { pve: { baseUrl: "", node: "" } });
    runtimes.set(state, rt);
  }
  return rt;
}

export const isConfigured = (rt: PinRuntime) => rt.opts.pve.baseUrl !== "";
