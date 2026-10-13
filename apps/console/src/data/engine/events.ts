import { useEffect, useSyncExternalStore } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { engineEventsUrl } from "@papercliped-engine/engine-client";
import { qk } from "./keys.ts";

/**
 * The engine's live events, one WebSocket per open organization (through the host service). An event refreshes only
 * the data it touches. If the socket drops it reconnects with backoff, and while it is down the organization's data
 * polls instead, so nothing goes stale.
 */

export interface LiveEvent {
  id?: number;
  companyId: string;
  type: string;
  createdAt?: string;
  payload?: Record<string, unknown> | null;
}

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

/** Which cached data an event makes stale. */
export function keysForEvent(companyId: string, e: LiveEvent): readonly (readonly unknown[])[] {
  const p = e.payload ?? {};
  if (e.type.startsWith("heartbeat.run.")) {
    if (e.type === "heartbeat.run.log" || e.type === "heartbeat.run.event") return [];
    const agentId = str(p.agentId);
    return [qk.agents(companyId), qk.dashboard(companyId), qk.costs(companyId), qk.runs(companyId), qk.attention(companyId), qk.badges(companyId), qk.workspaces(companyId), ...(agentId ? [qk.agent(companyId, agentId)] : [])];
  }
  if (e.type === "agent.status") {
    const agentId = str(p.agentId);
    return [qk.agents(companyId), qk.dashboard(companyId), ...(agentId ? [qk.agent(companyId, agentId)] : [])];
  }
  if (e.type === "activity.logged") {
    const entityType = str(p.entityType) ?? "";
    const entityId = str(p.entityId);
    const action = str(p.action) ?? "";
    const keys: (readonly unknown[])[] = [qk.activity(companyId), qk.dashboard(companyId), qk.attention(companyId), qk.badges(companyId), qk.mine(companyId)];
    if (entityType === "issue" || action.startsWith("issue.")) {
      keys.push(qk.issues(companyId), qk.anyIssue(companyId), qk.anyComments(companyId), qk.chats(companyId), qk.artifacts(companyId), qk.anyExtras(companyId));
    }
    if (entityType.startsWith("routine") || action.startsWith("routine")) keys.push(qk.routines(companyId), qk.anyRoutine(companyId));
    if (entityType.includes("skill") || action.startsWith("skill") || action.startsWith("company_skill")) keys.push(qk.skills(companyId), qk.skillSources(companyId));
    if (entityType.includes("workspace") || action.includes("workspace")) keys.push(qk.workspaces(companyId));
    if (entityType.includes("document") || entityType.includes("attachment") || entityType.includes("work_product") || action.includes("attachment") || action.includes("document") || action.includes("work_product")) keys.push(qk.artifacts(companyId), qk.anyExtras(companyId));
    if (entityType.includes("secret") || action.startsWith("secret")) keys.push(qk.secrets(companyId));
    if (entityType.includes("budget") || action.includes("budget")) keys.push(qk.budgets(companyId), qk.costs(companyId), qk.costBreakdown(companyId));
    if (entityType.includes("instructions") || action.includes("instructions")) keys.push(qk.anyInstructions(companyId));
    if (entityType === "agent" || action.startsWith("agent.")) keys.push(qk.agents(companyId), ...(entityId ? [qk.agent(companyId, entityId)] : []));
    if (entityType === "approval" || action.startsWith("approval.")) keys.push(qk.approvals(companyId));
    if (entityType === "goal" || action.startsWith("goal.")) keys.push(qk.goals(companyId));
    if (entityType === "project" || action.startsWith("project.")) keys.push(qk.projects(companyId));
    if (entityType === "company" || action.startsWith("company.")) keys.push(qk.orgs);
    if (action.startsWith("cost") || action.startsWith("budget")) keys.push(qk.costs(companyId));
    if (action.startsWith("member") || action.startsWith("invite") || action.startsWith("join")) keys.push(qk.members(companyId));
    return keys;
  }
  return [];
}

type Listener = (e: LiveEvent) => void;
const taps = new Map<string, Set<Listener>>();

/** Hears every raw event of one organization, for things the cache can't hold (a run's log lines). Returns the unsubscribe. */
export function tapEvents(companyId: string, fn: Listener): () => void {
  const set = taps.get(companyId) ?? new Set<Listener>();
  set.add(fn);
  taps.set(companyId, set);
  return () => void set.delete(fn);
}

export function applyEvent(qc: QueryClient, companyId: string, e: LiveEvent) {
  if (e.companyId && e.companyId !== companyId) return;
  for (const fn of taps.get(companyId) ?? []) fn(e);
  for (const queryKey of keysForEvent(companyId, e)) void qc.invalidateQueries({ queryKey });
}

// Connection state per organization, readable from any component.
const up = new Map<string, boolean>();
const listeners = new Set<() => void>();
const setUp = (id: string, v: boolean) => {
  if (up.get(id) === v) return;
  up.set(id, v);
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** True while the organization's live socket is open. */
export function useEventsUp(companyId: string | null | undefined): boolean {
  return useSyncExternalStore(subscribe, () => (companyId ? up.get(companyId) === true : false), () => false);
}

/** How often an organization's data polls: never while its socket is open, every 15 seconds while it isn't. */
export function usePollInterval(companyId: string | null | undefined): number | false {
  return useEventsUp(companyId) ? false : 15_000;
}

type SocketLike = Pick<WebSocket, "close"> & { onopen: ((ev: Event) => unknown) | null; onmessage: ((ev: MessageEvent) => unknown) | null; onclose: ((ev: CloseEvent) => unknown) | null; onerror: ((ev: Event) => unknown) | null };
export interface EventsOptions { open?: (url: string) => SocketLike; url?: (companyId: string) => string; maxDelayMs?: number }

const conns = new Map<string, { refs: number; stop: () => void }>();

/** Opens (or shares) the organization's socket; call the returned function to let go of it. */
export function connectOrgEvents(qc: QueryClient, companyId: string, opts: EventsOptions = {}): () => void {
  const existing = conns.get(companyId);
  if (existing) {
    existing.refs++;
    return () => release(companyId);
  }
  const open = opts.open ?? ((url: string) => new WebSocket(url) as SocketLike);
  const url = (opts.url ?? engineEventsUrl)(companyId);
  const maxDelay = opts.maxDelayMs ?? 30_000;
  let stopped = false;
  let attempt = 0;
  let sock: SocketLike | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    if (stopped) return;
    try {
      sock = open(url);
    } catch {
      return retry();
    }
    sock.onopen = () => {
      attempt = 0;
      setUp(companyId, true);
      // Catch up on anything that changed while the socket was down.
      void qc.invalidateQueries({ queryKey: qk.company(companyId) });
    };
    sock.onmessage = (m) => {
      try {
        applyEvent(qc, companyId, JSON.parse(String(m.data)) as LiveEvent);
      } catch {
        // Not an event (a ping, say); ignore it.
      }
    };
    sock.onerror = () => undefined;
    sock.onclose = () => {
      setUp(companyId, false);
      sock = null;
      retry();
    };
  };
  const retry = () => {
    if (stopped) return;
    const delay = Math.min(maxDelay, 1000 * 2 ** attempt++) * (0.75 + Math.random() * 0.5);
    timer = setTimeout(connect, delay);
  };
  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (sock) {
      sock.onclose = null;
      sock.close();
    }
    setUp(companyId, false);
  };
  conns.set(companyId, { refs: 1, stop });
  connect();
  return () => release(companyId);
}

function release(companyId: string) {
  const c = conns.get(companyId);
  if (!c) return;
  if (--c.refs > 0) return;
  conns.delete(companyId);
  c.stop();
}

/** Keeps the organization's live socket open while the component is mounted. */
export function useOrgEvents(companyId: string | null | undefined) {
  const qc = useQueryClient();
  useEffect(() => (companyId ? connectOrgEvents(qc, companyId) : undefined), [qc, companyId]);
}
