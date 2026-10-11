import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Rule } from "@papercliped-engine/automations";
import { readJson, removeKey, slugify, writeJson } from "../lib/storage.ts";
import { demoData, demoHost, newOrg } from "./demo.ts";
import { RESERVED, type AppMode, type AppSession, type EngineData, type Guest, type HostMetrics, type Task, type Notice, type Org, type PinMode, type SetupState, type User } from "./types.ts";

/**
 * The console's state. Today it is backed by demo data kept in the browser; the shape matches what the host broker and
 * ePaperclip will serve, so swapping in the real API replaces this file's internals, not the pages.
 */

interface Engine {
  setup: SetupState | null;
  data: EngineData;
  host: HostMetrics;
  completeSetup: (s: Omit<SetupState, "completedAt">, firstOrg: string | null) => void;
  resetAll: () => void;
  setPinMode: (m: PinMode) => void;
  createOrg: (name: string, size?: Partial<Org["resourceGroup"]>, by?: "user" | "pin", memory?: Org["memory"]) => { ok: true; org: Org } | { ok: false; error: string };
  saveRule: (r: Rule) => void;
  toggleRule: (id: string) => void;
  deleteRule: (id: string) => void;
  notify: (n: Omit<Notice, "id" | "at" | "read">) => void;
  markRead: (id?: string) => void;
  updateUser: (id: string, patch: Partial<User>) => void;
  setConnectorAccess: (id: string, who: "pin" | string, on: boolean) => void;
  guestPower: (vmid: number, action: "start" | "shutdown" | "stop" | "reboot") => { ok: boolean; error?: string };
  snapshot: (vmid: number, name: string, description: string) => { ok: boolean; error?: string };
  deleteSnapshot: (vmid: number, name: string) => void;
  addTask: (org: string, title: string, agent: string | null) => void;
  setTaskStatus: (org: string, id: string, status: Task["status"]) => void;
  decideApproval: (org: string, id: string, approve: boolean) => void;
  toggleRoutine: (org: string, id: string) => void;
  readInbox: (org: string) => void;
  setAppMode: (m: AppMode) => void;
  updateSession: (id: string, patch: Partial<AppSession>) => void;
  revokeSession: (id: string) => void;
}

const Ctx = createContext<Engine | null>(null);

export function orgNameError(name: string, orgs: Org[]): string | null {
  const slug = slugify(name);
  if (!name.trim()) return "Give it a name.";
  if (!slug) return "Use at least one letter or number.";
  if ((RESERVED as readonly string[]).includes(slug)) return `"${slug}" is reserved for a system page. Pick another name.`;
  if (orgs.some((o) => o.slug === slug)) return "An organization with that name already exists.";
  return null;
}

export function EngineProvider({ children }: { children: ReactNode }) {
  const [setup, setSetup] = useState<SetupState | null>(() => readJson<SetupState | null>("epc.setup", null));
  const [data, setData] = useState<EngineData>(() => {
    const saved = readJson<EngineData | null>("epc.data", null);
    if (!saved) return demoData(null);
    // Demo data saved by an older console build: fill in what it lacks rather than crash.
    if (saved.apps && saved.host && saved.orgs.every((o) => Array.isArray(o.goals))) return saved;
    return demoData(saved.orgs[0]?.name ?? null);
  });
  const [host, setHost] = useState<HostMetrics>(() => demoHost(setup?.deviceName ?? "pve"));

  useEffect(() => writeJson("epc.data", data), [data]);
  useEffect(() => (setup ? writeJson("epc.setup", setup) : removeKey("epc.setup")), [setup]);

  // Live-looking metrics: a gentle random walk, like the host's own graphs.
  useEffect(() => {
    const t = setInterval(() => {
      setHost((h) => {
        const cpuPct = Math.min(95, Math.max(1, h.cpuPct + (Math.random() - 0.5) * 3));
        const memUsed = Math.min(h.memTotal * 0.92, Math.max(h.memTotal * 0.15, h.memUsed + (Math.random() - 0.5) * 0.08 * 1024 ** 3));
        return { ...h, cpuPct, memUsed, uptimeSec: h.uptimeSec + 3 };
      });
    }, 3000);
    return () => clearInterval(t);
  }, []);

  const completeSetup = useCallback<Engine["completeSetup"]>((s, firstOrg) => {
    setSetup({ ...s, completedAt: new Date().toISOString() });
    setHost(demoHost(s.deviceName));
    const d = demoData(firstOrg);
    d.users[0] = { ...d.users[0], name: s.ownerName || "You" };
    setData(d);
  }, []);

  const updateGuest = (vmid: number, fn: (g: Guest) => Guest) => setData((d) => ({ ...d, guests: d.guests.map((x) => (x.vmid === vmid ? fn(x) : x)) }));
  const updateOrg = (slug: string, fn: (o: Org) => Org) => setData((d) => ({ ...d, orgs: d.orgs.map((o) => (o.slug === slug ? fn(o) : o)) }));

  const value = useMemo<Engine>(
    () => ({
      setup,
      data,
      host,
      completeSetup,
      resetAll: () => {
        removeKey("epc.data");
        setSetup(null);
        setData(demoData(null));
      },
      setPinMode: (m) => setSetup((s) => (s ? { ...s, pinMode: m } : s)),
      createOrg: (name, size, by = "user", memory = "postgres") => {
        const err = orgNameError(name, data.orgs);
        if (err) return { ok: false, error: err };
        const org = { ...newOrg(name.trim(), { ...size, createdBy: by }), memory };
        setData((d) => ({
          ...d,
          orgs: [...d.orgs, org],
          users: d.users.map((u) => (u.role === "owner" ? { ...u, orgs: [...u.orgs, { slug: org.slug, role: "owner" }] } : u)),
        }));
        return { ok: true, org };
      },
      saveRule: (r) => setData((d) => ({ ...d, rules: [...d.rules.filter((x) => x.id !== r.id), r] })),
      toggleRule: (id) => setData((d) => ({ ...d, rules: d.rules.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)) })),
      deleteRule: (id) => setData((d) => ({ ...d, rules: d.rules.filter((r) => r.id !== id) })),
      notify: (n) => setData((d) => ({ ...d, notices: [{ ...n, id: `n-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, at: new Date().toISOString(), read: false }, ...d.notices].slice(0, 50) })),
      markRead: (id) => setData((d) => ({ ...d, notices: d.notices.map((n) => (!id || n.id === id ? { ...n, read: true } : n)) })),
      updateUser: (id, patch) => setData((d) => ({ ...d, users: d.users.map((u) => (u.id === id ? { ...u, ...patch } : u)) })),
      setConnectorAccess: (id, who, on) =>
        setData((d) => ({
          ...d,
          connectors: d.connectors.map((c) => {
            if (c.id !== id) return c;
            if (who === "pin") return { ...c, access: { ...c.access, pin: on } };
            const orgs = on ? [...new Set([...c.access.orgs, who])] : c.access.orgs.filter((o) => o !== who);
            return { ...c, access: { ...c.access, orgs } };
          }),
        })),
      guestPower: (vmid, action) => {
        const g = data.guests.find((x) => x.vmid === vmid);
        if (!g) return { ok: false, error: "Unknown machine" };
        if (g.protected) return { ok: false, error: `${g.name} is protected` };
        const up = action === "start" || action === "reboot";
        const label = { start: "Start", shutdown: "Shutdown", stop: "Stop", reboot: "Reboot" }[action];
        updateGuest(vmid, (x) => ({ ...x, status: up ? "running" : "stopped", cpuPct: up ? 2 : 0, memUsed: up ? x.memMax * 0.2 : 0, tasks: [{ id: `${vmid}-${Date.now()}`, what: label, at: new Date().toISOString(), ok: true }, ...(x.tasks ?? [])].slice(0, 30) }));
        return { ok: true };
      },
      snapshot: (vmid, name, description) => {
        const g = data.guests.find((x) => x.vmid === vmid);
        if (!g) return { ok: false, error: "Unknown machine" };
        if (!/^[A-Za-z][A-Za-z0-9_-]{1,39}$/.test(name)) return { ok: false, error: "Use 2 to 40 letters, digits, - or _, starting with a letter." };
        if (g.snapshots?.some((s) => s.name === name)) return { ok: false, error: "A snapshot with that name exists." };
        updateGuest(vmid, (x) => ({ ...x, snapshots: [...(x.snapshots ?? []), { name, at: new Date().toISOString(), description }], tasks: [{ id: `${vmid}-${Date.now()}`, what: `Snapshot ${name}`, at: new Date().toISOString(), ok: true }, ...(x.tasks ?? [])] }));
        return { ok: true };
      },
      deleteSnapshot: (vmid, name) => updateGuest(vmid, (x) => ({ ...x, snapshots: (x.snapshots ?? []).filter((s) => s.name !== name), tasks: [{ id: `${vmid}-${Date.now()}`, what: `Delete snapshot ${name}`, at: new Date().toISOString(), ok: true }, ...(x.tasks ?? [])] })),
      addTask: (org, title, agent) =>
        updateOrg(org, (o) => {
          const prefix = o.slug.slice(0, 3).toUpperCase();
          const next = Math.max(0, ...o.tasks.map((t) => Number(t.id.split("-")[1]) || 0)) + 1;
          return { ...o, tasks: [{ id: `${prefix}-${next}`, title, status: "todo", agent, priority: "medium", project: null }, ...o.tasks], activity: [{ id: `ac-${Date.now()}`, who: "You", what: `created ${prefix}-${next}`, at: new Date().toISOString() }, ...o.activity] };
        }),
      setTaskStatus: (org, id, status) => updateOrg(org, (o) => ({ ...o, tasks: o.tasks.map((t) => (t.id === id ? { ...t, status } : t)) })),
      decideApproval: (org, id, approve) =>
        updateOrg(org, (o) => {
          const a = o.approvals.find((x) => x.id === id);
          return { ...o, approvals: o.approvals.map((x) => (x.id === id ? { ...x, status: approve ? "approved" : "rejected" } : x)), activity: a ? [{ id: `ac-${Date.now()}`, who: "You", what: `${approve ? "approved" : "rejected"} "${a.title}"`, at: new Date().toISOString() }, ...o.activity] : o.activity };
        }),
      toggleRoutine: (org, id) => updateOrg(org, (o) => ({ ...o, routines: o.routines.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)) })),
      readInbox: (org) => updateOrg(org, (o) => ({ ...o, inbox: o.inbox.map((i) => ({ ...i, read: true })) })),
      setAppMode: (m) => setData((d) => ({ ...d, apps: { ...d.apps, mode: m } })),
      updateSession: (id, patch) => setData((d) => ({ ...d, apps: { ...d.apps, sessions: d.apps.sessions.map((x) => (x.id === id ? { ...x, ...patch } : x)) } })),
      revokeSession: (id) => setData((d) => ({ ...d, apps: { ...d.apps, sessions: d.apps.sessions.filter((x) => x.id !== id) } })),
    }),
    [setup, data, host, completeSetup],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useEngine(): Engine {
  const v = useContext(Ctx);
  if (!v) throw new Error("useEngine outside EngineProvider");
  return v;
}
