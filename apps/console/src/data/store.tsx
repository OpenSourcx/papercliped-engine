import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Rule } from "@papercliped-engine/automations";
import { readJson, removeKey, slugify, writeJson } from "../lib/storage.ts";
import { demoData, demoHost, newOrg } from "./demo.ts";
import { RESERVED, type AppMode, type AppSession, type EngineData, type HostMetrics, type Notice, type Org, type PinMode, type SetupState, type User } from "./types.ts";

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
  guestPower: (vmid: number, action: "start" | "shutdown") => { ok: boolean; error?: string };
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
    return saved.apps ? saved : { ...saved, apps: demoData(saved.orgs[0]?.name ?? null).apps };
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
        if (!g) return { ok: false, error: "Unknown guest" };
        if (g.protected) return { ok: false, error: `${g.name} is protected` };
        setData((d) => ({
          ...d,
          guests: d.guests.map((x) => (x.vmid === vmid ? { ...x, status: action === "start" ? "running" : "stopped", cpuPct: action === "start" ? 2 : 0, memUsed: action === "start" ? x.memMax * 0.2 : 0 } : x)),
        }));
        return { ok: true };
      },
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
