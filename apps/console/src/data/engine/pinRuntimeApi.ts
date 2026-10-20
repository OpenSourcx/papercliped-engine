import { NodeApiError } from "./nodeApi.ts";

/**
 * Pin's runtime on the host service (services/epaperclip/src/features/pin-*.ts, docs/PIN.md): the notification inbox and
 * its preferences, Agent mode plans, automations with their runs, the model test and update awareness. Every call is made
 * by the host service as the signed-in person.
 */

export type NoticeKind = "task_finished" | "backup_failed" | "node_event" | "approval" | "automation" | "proposal" | "update";
export type NoticeLevel = "info" | "warning" | "critical";

export interface InboxNotice {
  id: string;
  key: string;
  kind: NoticeKind;
  level: NoticeLevel;
  title: string;
  body: string;
  at: number;
  read: boolean;
  peek: boolean;
  link?: string;
}
export interface Prefs {
  muted: NoticeKind[];
  quiet: NoticeKind[];
  quietHours: { enabled: boolean; from: string; to: string };
}
export interface Inbox {
  notifications: InboxNotice[];
  unread: number;
  prefs: Prefs;
  kinds: NoticeKind[];
}

export type StepState = "pending" | "running" | "done" | "failed" | "skipped" | "rejected";
export interface PlanStep {
  id: string;
  kind: string;
  label: string;
  destructive: boolean;
  confirmPhrase: string | null;
  state: StepState;
  decidedBy?: string;
  decidedAt?: number;
  finishedAt?: number;
  result?: string;
  error?: string;
}
export interface Plan {
  id: string;
  title: string;
  summary: string;
  createdAt: number;
  createdBy: "pin" | "automation";
  status: "pending" | "running" | "done" | "failed" | "cancelled";
  steps: PlanStep[];
}

export interface RunStep {
  vmid: number;
  name: string | null;
  action: string;
  result: "done" | "proposed" | "notified" | "skipped" | "failed";
  detail?: string;
  attempts?: number;
}
export interface Run {
  id: string;
  automationId: string;
  automationName: string;
  trigger: "schedule" | "manual";
  startedAt: number;
  finishedAt: number | null;
  status: "running" | "ok" | "failed" | "skipped" | "proposed";
  steps: RunStep[];
  error?: string;
}
export interface AutomationView {
  id: string;
  name: string;
  owner: string;
  readBack: string;
  permissions: "scoped" | "owner";
  permissionsNote: string;
  /** When its Proxmox token ends; null for automations made before tokens expired. */
  tokenExpiresAt?: number | null;
  paused: { at: number; reason: string; by: "runner" | "user" } | null;
  running: boolean;
  createdAt: number;
  lastRunAt: number | null;
  lastStatus: Run["status"] | null;
  consecutiveFailures: number;
  nextRunAt: number | null;
  spec: { trigger: { type: "condition" | "schedule" } };
}
export interface AutomationInput {
  name: string;
  trigger: Record<string, unknown>;
  scope: Record<string, unknown>;
  then: { action: string };
  allowOwnerPermissions?: boolean;
}

export type UpdateChannel = "stable" | "rc";
export type UpdateWindowDay = "daily" | 0 | 1 | 2 | 3 | 4 | 5 | 6;
export interface UpdatePolicy {
  /** "remind": tell me and I install; "window": install by itself inside the maintenance window. */
  mode: "remind" | "window";
  window: { day: UpdateWindowDay; at: string; hours: number };
  pausedUntil: number | null;
  snoozedUntil: number | null;
}
export interface UpdateHistoryEntry {
  id: string;
  at: number;
  action: "update" | "rollback";
  from: string | null;
  to: string | null;
  by: string;
  result: "done" | "failed" | "rolled_back";
  message: string;
}
export interface AptRun {
  at: number | null;
  command: string;
  upgraded: number;
  installed: number;
  removed: number;
  packages: string[];
  kernel: boolean;
}
export interface UpdateInfo {
  installed: string | null;
  /** Which releases this device follows: final ones only, or release candidates too. */
  channel: UpdateChannel;
  latest: { version: string; notes: string; url: string; publishedAt: string | null } | null;
  /** A release candidate newer than this device, for one that follows final releases only. */
  preview: { version: string; publishedAt: string | null } | null;
  policy: UpdatePolicy;
  paused: boolean;
  snoozed: boolean;
  nextWindowAt: number | null;
  /** Proxmox installed a kernel that isn't running yet: a restart is needed to finish updating. */
  system: { running: string | null; newestInstalled: string | null; rebootRequired: boolean };
  source: "feed" | "github" | null;
  feedNote: string | null;
  /** Why the project pulled the release this device runs, when it did. */
  installedWithdrawn: string | null;
  state: "off" | "unchecked" | "unknown" | "available" | "current" | "no_stable" | "no_release";
  checkedAt: number | null;
  error: string | null;
  checkEnabled: boolean;
  canManage: boolean;
  canUpdate: boolean;
  previous: string | null;
  status: { phase: string; message: string; version: string | null; at: number | null } | null;
  inProgress: boolean;
  manual: string;
}
export interface ModelTest {
  ok: boolean;
  provider: string;
  model: string;
  ms?: number;
  code?: string;
  error?: string;
}

async function call<T>(method: "GET" | "PUT" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: method === "GET" ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json", "X-EPC-Request": "1" },
      body: method === "GET" || method === "DELETE" ? undefined : JSON.stringify(body ?? {}),
    });
  } catch {
    throw new NodeApiError(0, "Can't reach this device", "offline");
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const d = (data ?? {}) as { error?: string; code?: string };
    throw new NodeApiError(res.status, d.error ?? `Request failed (${res.status})`, d.code ?? null);
  }
  return data as T;
}

export const pinRt = {
  inbox: (refresh = false) => call<Inbox>("GET", `/api/pin/notifications${refresh ? "?refresh=1" : ""}`),
  markRead: (b: { all: true } | { ids: string[] }) => call<{ ok: true }>("POST", "/api/pin/notifications/read", b),
  clearRead: () => call<{ ok: true }>("POST", "/api/pin/notifications/clear"),
  savePrefs: (p: Partial<Prefs>) => call<{ prefs: Prefs }>("PUT", "/api/pin/notification-prefs", p),

  plans: () => call<{ plans: Plan[]; waiting: number }>("GET", "/api/pin/plans"),
  decide: (plan: string, step: string, what: "approve" | "skip" | "reject", confirm?: string) => call<{ plan: Plan }>("POST", `/api/pin/plans/${plan}/steps/${step}/${what}`, confirm === undefined ? {} : { confirm }),
  cancelPlan: (plan: string) => call<{ plan: Plan }>("POST", `/api/pin/plans/${plan}/cancel`),

  automations: () => call<{ automations: AutomationView[]; canSeeAll: boolean; runnerReady: boolean }>("GET", "/api/pin/automations"),
  preview: (a: AutomationInput) => call<{ ok: boolean; readBack?: string; errors?: string[] }>("POST", "/api/pin/automations/preview", a),
  createAutomation: (a: AutomationInput) => call<{ automation: AutomationView }>("POST", "/api/pin/automations", a),
  automationAction: (id: string, what: "pause" | "resume") => call<{ automation: AutomationView }>("POST", `/api/pin/automations/${id}/${what}`),
  renewAutomation: (id: string, days = 90) => call<{ automation: AutomationView }>("POST", `/api/pin/automations/${id}/renew`, { days }),
  runNow: (id: string) => call<{ run: Run }>("POST", `/api/pin/automations/${id}/run`),
  deleteAutomation: (id: string) => call<{ ok: true; tokenRemoved: boolean }>("DELETE", `/api/pin/automations/${id}`),
  runs: (id?: string) => call<{ runs: Run[] }>("GET", `/api/pin/automations/runs${id ? `?automation=${id}` : ""}`),

  update: () => call<UpdateInfo>("GET", "/api/pin/update"),
  checkUpdate: () => call<UpdateInfo>("POST", "/api/pin/update/check"),
  setUpdateCheck: (check: boolean) => call<UpdateInfo>("PUT", "/api/pin/update/settings", { check }),
  setUpdateChannel: (channel: UpdateChannel) => call<UpdateInfo>("PUT", "/api/pin/update/settings", { channel }),
  /** Any of: mode, window {day, at, hours}, pauseDays (0 resumes), snoozeHours (0 stops snoozing). */
  setUpdatePolicy: (b: { mode?: UpdatePolicy["mode"]; window?: Partial<UpdatePolicy["window"]>; pauseDays?: number; snoozeHours?: number }) => call<UpdateInfo>("PUT", "/api/pin/update/settings", b),
  updateHistory: () => call<{ entries: UpdateHistoryEntry[]; system: AptRun[] }>("GET", "/api/pin/update/history"),
  startUpdate: (b: { action: "update" | "rollback"; confirm: string }) => call<{ requested: true }>("POST", "/api/pin/update", b),

  testModel: (provider?: string | null, model?: string | null) => call<ModelTest>("POST", "/api/pin/settings/test", { ...(provider ? { provider } : {}), ...(model ? { model } : {}) }),
};

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : "Something went wrong.");
