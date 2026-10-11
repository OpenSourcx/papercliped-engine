import { DEFAULT_PLUGINS, pluginById } from "./storePlugins.ts";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Rule } from "@papercliped-engine/automations";
import { useSession } from "../auth/session.tsx";
import { readJson, removeKey, slugify, writeJson } from "../lib/storage.ts";
import { api, ApiError, type HardwareChange, type MachineSpec, type RestoreSpec, type VmSpec } from "./api.ts";
import { demoBackend, liveBackend, parseBackupName, type Backend } from "./backend.ts";
import { demoData, demoHost, newOrg } from "./demo.ts";
import { liveGuests, liveHostMetrics, liveStorage } from "./live.ts";
import { defaultPinData } from "./pin.ts";
import { wouldLoop } from "./orgTree.ts";
import { RESERVED, type AppMode, type AppSession, type EngineData, type Guest, type HostMetrics, type HostStorage, type PinData, type PinLogEntry, type Task, type Notice, type Org, type PinMode, type SetupState, type User } from "./types.ts";

/**
 * The console's state. Served by the host service, the host and its machines are live: read from Proxmox as the
 * signed-in user every few seconds, and powered through the service. Everything ePaperclip will own (organizations,
 * agents, tasks, rules, users) is still demo data kept in the browser until the fork lands; the shapes match, so
 * swapping in the real API replaces this file's internals, not the pages.
 */

interface Engine {
  /** True when the host and machines come from this device's Proxmox, as the signed-in user. */
  live: boolean;
  /** Set when the last live refresh failed. */
  liveError: string | null;
  /** False until the first live answer arrives, so pages can wait instead of reporting "not found". */
  ready: boolean;
  /** Storage, templates, uploads and tasks: Proxmox live, or the in-browser stand-in for the demo. */
  backend: Backend;
  /** Follows a Proxmox task until it ends, then tells you through Pin. Bumps contentVersion so lists refresh. */
  watchTask: (upid: string | null, label: string) => void;
  /** Tasks this console started that are still running. */
  running: { upid: string; label: string }[];
  /** Changes whenever a watched task finishes; storage views refetch on it. */
  contentVersion: number;
  /** Changes CPU, memory, name or options. Proxmox checks the user's permission; the demo updates the machine. */
  changeHardware: (vmid: number, c: HardwareChange) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Clones a machine into a new one; Pin reports when the copy is done. */
  cloneMachine: (vmid: number, name: string, storage: string | null, linked?: boolean) => Promise<{ ok: true; vmid: number } | { ok: false; error: string }>;
  /** Restores a backup, as a new machine or over the original. Proxmox does the work; Pin reports when it's done. */
  restoreBackup: (spec: RestoreSpec) => Promise<{ ok: true; vmid: number } | { ok: false; error: string }>;
  createVm: (spec: VmSpec & { org: string | null }) => Promise<{ ok: true; vmid: number } | { ok: false; error: string }>;
  setup: SetupState | null;
  data: EngineData;
  host: HostMetrics;
  completeSetup: (s: Omit<SetupState, "completedAt">, firstOrg: string | null) => void;
  resetAll: () => void;
  setPinMode: (m: PinMode) => void;
  /** Pin's files and activity, with defaults for consoles set up before Pin had them. */
  pin: PinData;
  setPinAccess: (patch: Partial<SetupState["pinAccess"]>) => void;
  savePinFile: (file: "soul" | "memory", text: string) => void;
  logPin: (kind: PinLogEntry["kind"], text: string) => void;
  createOrg: (name: string, size?: Partial<Org["resourceGroup"]>, by?: "user" | "pin", memory?: Org["memory"]) => { ok: true; org: Org } | { ok: false; error: string };
  saveRule: (r: Rule) => void;
  toggleRule: (id: string) => void;
  deleteRule: (id: string) => void;
  notify: (n: Omit<Notice, "id" | "at" | "read">) => void;
  markRead: (id?: string) => void;
  updateUser: (id: string, patch: Partial<User>) => void;
  setConnectorAccess: (id: string, who: "pin" | string, on: boolean) => void;
  /** Adds a Store plugin: a connector joins the Connectors list (needing setup), adapters and skills are switched on. */
  installPlugin: (id: string) => void;
  uninstallPlugin: (id: string) => void;
  guestPower: (vmid: number, action: "start" | "shutdown" | "stop" | "reboot" | "reset") => { ok: boolean; error?: string };
  /** Deletes a machine. The name must be typed to confirm; Proxmox refuses running and protected machines. */
  destroyMachine: (vmid: number, confirm: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Turns a stopped machine into a template. This can't be undone. */
  convertToTemplate: (vmid: number, confirm: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Creates a container. Live, Proxmox creates and starts it as the signed-in user; in the demo it appears at once. */
  createMachine: (spec: MachineSpec & { org: string | null; os: string }) => Promise<{ ok: true; vmid: number } | { ok: false; error: string }>;
  addProject: (org: string, name: string, lead: string | null) => void;
  addGoal: (org: string, title: string, due: string | null) => void;
  addRoutine: (org: string, name: string, schedule: string, agent: string) => void;
  snapshot: (vmid: number, name: string, description: string) => { ok: boolean; error?: string };
  deleteSnapshot: (vmid: number, name: string) => void;
  addTask: (org: string, title: string, agent: string | null) => void;
  setTaskStatus: (org: string, id: string, status: Task["status"]) => void;
  decideApproval: (org: string, id: string, approve: boolean) => void;
  toggleRoutine: (org: string, id: string) => void;
  readInbox: (org: string) => void;
  /** Changes who an agent reports to (null = you). Refuses moves that would create a reporting loop. */
  setReportsTo: (org: string, agentId: string, managerId: string | null) => { ok: boolean; error?: string };
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
  const { session } = useSession();
  const live = session.mode === "live";
  const [setup, setSetup] = useState<SetupState | null>(() => readJson<SetupState | null>("epc.setup", null));
  const [data, setData] = useState<EngineData>(() => {
    const saved = readJson<EngineData | null>("epc.data", null);
    if (!saved) return demoData(null);
    // Demo data saved by an older console build: fill in what it lacks rather than crash.
    if (saved.apps && saved.host && saved.orgs.every((o) => Array.isArray(o.goals))) return saved;
    return demoData(saved.orgs[0]?.name ?? null);
  });
  const [host, setHost] = useState<HostMetrics>(() => demoHost(setup?.deviceName ?? "pve"));
  const [guests, setGuests] = useState<Guest[] | null>(null);
  const [storage, setStorage] = useState<HostStorage[]>([]);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [running, setRunning] = useState<{ upid: string; label: string }[]>([]);
  const [contentVersion, setContentVersion] = useState(0);
  const storageRef = useRef<HostStorage[]>([]);
  const guestsRef = useRef<Guest[]>([]);
  const backend = useMemo<Backend>(() => (live ? liveBackend : demoBackend(() => storageRef.current, () => guestsRef.current)), [live]); // eslint-disable-line react-hooks/exhaustive-deps
  const watchTask = useCallback(
    (upid: string | null, label: string) => {
      if (!upid) {
        setContentVersion((n) => n + 1);
        return;
      }
      setRunning((r) => [...r, { upid, label }]);
      let tries = 0;
      const tick = () =>
        backend.task(upid).then(
          (t) => {
            if (t.status === "running" && tries++ < 2400) return void setTimeout(tick, tries < 10 ? 700 : 1500);
            setRunning((r) => r.filter((x) => x.upid !== upid));
            setContentVersion((n) => n + 1);
            setRefreshTick((n) => n + 1);
            const ok = t.exitstatus === "OK" || (t.exitstatus ?? "").startsWith("WARNINGS");
            setData((d) => ({ ...d, notices: [{ id: `n-${Date.now()}-${upid.slice(-6)}`, kind: "info" as const, title: ok ? `${label}: done` : `${label}: failed`, body: ok ? "Finished on Proxmox." : (t.exitstatus ?? "Proxmox reported an error.") + " Open Tasks for the log.", at: new Date().toISOString(), read: false }, ...d.notices].slice(0, 50) }));
          },
          () => {
            if (tries++ < 20) setTimeout(tick, 3000);
            else setRunning((r) => r.filter((x) => x.upid !== upid));
          },
        );
      setTimeout(tick, 500);
    },
    [backend],
  );

  useEffect(() => writeJson("epc.data", data), [data]);

  // Live: read the host as the signed-in user every five seconds (and right after an action).
  const orgs = data.orgs;
  useEffect(() => {
    if (!live) return;
    let alive = true;
    const load = () =>
      api.host().then(
        (h) => {
          if (!alive) return;
          setHost((prev) => liveHostMetrics(h, prev));
          setGuests((prev) => liveGuests(h, orgs, prev ?? []));
          setStorage(liveStorage(h));
          setLiveError(null);
        },
        (e) => alive && !(e instanceof ApiError && e.code === "signed_out") && setLiveError(e instanceof ApiError ? e.message : "Can't reach this device"),
      );
    load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [live, orgs, refreshTick]);
  useEffect(() => (setup ? writeJson("epc.setup", setup) : removeKey("epc.setup")), [setup]);

  // Demo: live-looking metrics, a gentle random walk like the host's own graphs.
  useEffect(() => {
    if (live) return;
    const t = setInterval(() => {
      setHost((h) => {
        const cpuPct = Math.min(95, Math.max(1, h.cpuPct + (Math.random() - 0.5) * 3));
        const memUsed = Math.min(h.memTotal * 0.92, Math.max(h.memTotal * 0.15, h.memUsed + (Math.random() - 0.5) * 0.08 * 1024 ** 3));
        return { ...h, cpuPct, memUsed, uptimeSec: h.uptimeSec + 3 };
      });
    }, 3000);
    return () => clearInterval(t);
  }, [live]);

  const completeSetup = useCallback<Engine["completeSetup"]>((s, firstOrg) => {
    setSetup({ ...s, completedAt: new Date().toISOString() });
    if (!live) setHost(demoHost(s.deviceName));
    const d = demoData(firstOrg);
    d.users[0] = { ...d.users[0], name: s.ownerName || "You" };
    setData(d);
  }, [live]);

  const updateGuest = (vmid: number, fn: (g: Guest) => Guest) => setData((d) => ({ ...d, guests: d.guests.map((x) => (x.vmid === vmid ? fn(x) : x)) }));
  const updateOrg = (slug: string, fn: (o: Org) => Org) => setData((d) => ({ ...d, orgs: d.orgs.map((o) => (o.slug === slug ? fn(o) : o)) }));

  const logTo = (kind: PinLogEntry["kind"], text: string) =>
    setData((d) => {
      const pin = d.pin ?? defaultPinData();
      return { ...d, pin: { ...pin, log: [{ id: `pl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, at: new Date().toISOString(), kind, text }, ...pin.log].slice(0, 200) } };
    });
  storageRef.current = live ? storage : data.host.storage;
  guestsRef.current = live ? guests ?? [] : data.guests;
  const view = useMemo<EngineData>(() => (live ? { ...data, guests: guests ?? [], host: { ...data.host, storage } } : data), [live, data, guests, storage]);

  const value = useMemo<Engine>(
    () => ({
      live,
      liveError,
      ready: !live || guests !== null,
      backend,
      watchTask,
      running,
      contentVersion,
      destroyMachine: async (vmid, confirm) => {
        try {
          const g = view.guests.find((x) => x.vmid === vmid);
          const r = await backend.destroyMachine(vmid, confirm);
          watchTask(r.task, `Delete ${g?.name ?? `#${vmid}`}`);
          if (!live) setData((d) => ({ ...d, guests: d.guests.filter((x) => x.vmid !== vmid) }));
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e instanceof ApiError ? e.message : "Can't reach this device" };
        }
      },
      convertToTemplate: async (vmid, confirm) => {
        try {
          const g = view.guests.find((x) => x.vmid === vmid);
          const r = await backend.convertToTemplate(vmid, confirm);
          watchTask(r.task, `Convert ${g?.name ?? `#${vmid}`} to a template`);
          if (!live) setData((d) => ({ ...d, guests: d.guests.map((x) => (x.vmid === vmid ? { ...x, template: true } : x)) }));
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e instanceof ApiError ? e.message : "Can't reach this device" };
        }
      },
      changeHardware: async (vmid, c) => {
        try {
          await backend.setHardware(vmid, c);
          if (live) setRefreshTick((n) => n + 1);
          else setData((d) => ({ ...d, guests: d.guests.map((g) => (g.vmid === vmid ? { ...g, ...(c.cores !== undefined ? { cores: c.cores } : {}), ...(c.memoryMb !== undefined ? { memMax: c.memoryMb * 1024 ** 2 } : {}), ...(c.name !== undefined ? { name: c.name } : {}), ...(c.tags !== undefined ? { tags: c.tags } : {}), tasks: [{ id: `${vmid}-${Date.now()}`, what: "Update configuration", at: new Date().toISOString(), ok: true }, ...(g.tasks ?? [])].slice(0, 30) } : g)) }));
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e instanceof ApiError ? e.message : "Can't reach this device" };
        }
      },
      cloneMachine: async (vmid, name, storage, linked = false) => {
        try {
          const src = view.guests.find((g) => g.vmid === vmid);
          if (!live && view.guests.some((g) => g.name === name)) return { ok: false, error: "A machine with that name exists." };
          const r = await backend.clone(vmid, name, storage, linked);
          watchTask(r.task, `Clone ${src?.name ?? `#${vmid}`} to ${name}`);
          if (!live && src) {
            const at = new Date().toISOString();
            setData((d) => ({ ...d, guests: [...d.guests, { ...src, vmid: r.vmid, name, status: "stopped", cpuPct: 0, memUsed: 0, protected: false, snapshots: [], tasks: [{ id: `${r.vmid}-clone`, what: `Clone of ${src.name}`, at, ok: true }] }] }));
          }
          return { ok: true, vmid: r.vmid };
        } catch (e) {
          return { ok: false, error: e instanceof ApiError ? e.message : "Can't reach this device" };
        }
      },
      restoreBackup: async (spec) => {
        try {
          const r = await backend.restore(spec);
          const src = parseBackupName(spec.volid);
          const orig = view.guests.find((g) => g.vmid === src?.vmid);
          watchTask(r.task, spec.replace ? `Restore ${orig?.name ?? `#${src?.vmid}`}` : `Restore ${orig?.name ?? "backup"} as #${r.vmid}`);
          if (!live && src) {
            const at = new Date().toISOString();
            const copy: Guest = orig
              ? { ...orig, vmid: r.vmid, name: spec.replace ? orig.name : `${orig.name}-restored`, status: spec.start ? "running" : "stopped", cpuPct: 0, memUsed: 0, snapshots: [], tasks: [{ id: `${r.vmid}-restore`, what: "Restore", at, ok: true }] }
              : { vmid: r.vmid, name: `restored-${r.vmid}`, type: src.type, status: "stopped", cpuPct: 0, cores: 1, memUsed: 0, memMax: 1024 ** 3, diskMax: 8e9, org: null, protected: false, tasks: [{ id: `${r.vmid}-restore`, what: "Restore", at, ok: true }] };
            setData((d) => ({ ...d, guests: spec.replace ? d.guests.map((g) => (g.vmid === r.vmid ? copy : g)) : [...d.guests, copy] }));
          }
          return { ok: true, vmid: r.vmid };
        } catch (e) {
          return { ok: false, error: e instanceof ApiError ? e.message : "Can't reach this device" };
        }
      },
      createVm: async (spec) => {
        const { org, ...rest } = spec;
        if (live) {
          try {
            const r = await api.createVm(rest);
            watchTask(r.task, `Create VM ${spec.name}`);
            return { ok: true, vmid: r.vmid };
          } catch (e) {
            return { ok: false, error: e instanceof ApiError ? e.message : "Can't reach this device" };
          }
        }
        if (view.guests.some((g) => g.name === spec.name)) return { ok: false, error: "A machine with that name exists." };
        const vmid = Math.max(99, ...view.guests.map((g) => g.vmid)) + 1;
        const at = new Date().toISOString();
        const up = spec.start !== false;
        const guest: Guest = { vmid, name: spec.name, type: "qemu", status: up ? "running" : "stopped", cpuPct: up ? 4 : 0, cores: spec.cores, memUsed: up ? spec.memoryMb * 1024 ** 2 * 0.2 : 0, memMax: spec.memoryMb * 1024 ** 2, diskMax: spec.diskGb * 1e9, org, protected: false, ip: null, os: spec.ostype === "win11" ? "Windows 11" : spec.iso?.split("/").pop() ?? "No media", tags: org ? [org] : [], snapshots: [], tasks: [...(up ? [{ id: `${vmid}-start`, what: "Start", at, ok: true }] : []), { id: `${vmid}-create`, what: "Create", at, ok: true }] };
        setData((d) => ({ ...d, guests: [...d.guests, guest] }));
        return { ok: true, vmid };
      },
      setup,
      data: view,
      host,
      completeSetup,
      resetAll: () => {
        removeKey("epc.data");
        setSetup(null);
        setData(demoData(null));
      },
      setPinMode: (m) => {
        setSetup((s) => (s ? { ...s, pinMode: m } : s));
        logTo("changed", `Switched to ${m === "agent" ? "Agent" : "Assistant"} mode.`);
      },
      pin: data.pin ?? defaultPinData(),
      setPinAccess: (patch) => {
        setSetup((s) => (s ? { ...s, pinAccess: { ...s.pinAccess, ...patch } } : s));
        const names: Record<string, string> = { system: "manage this device", orgs: "manage organizations", connectors: "use connectors", docs: "read the Proxmox docs" };
        for (const [k, v] of Object.entries(patch)) logTo("changed", `${v ? "Allowed" : "Stopped"} Pin to ${names[k] ?? k}.`);
      },
      savePinFile: (file, text) => {
        setData((d) => {
          const pin = d.pin ?? defaultPinData();
          return { ...d, pin: { ...pin, [file]: text, editedAt: { ...pin.editedAt, [file]: new Date().toISOString() } } };
        });
        logTo("changed", `You edited ${file === "soul" ? "SOUL.md" : "MEMORY.md"}.`);
      },
      logPin: (kind, text) => logTo(kind, text),
      createOrg: (name, size, by = "user", memory = "postgres") => {
        const err = orgNameError(name, data.orgs);
        if (err) return { ok: false, error: err };
        const org = { ...newOrg(name.trim(), { ...size, createdBy: by }), memory };
        setData((d) => ({
          ...d,
          orgs: [...d.orgs, org],
          users: d.users.map((u) => (u.role === "owner" ? { ...u, orgs: [...u.orgs, { slug: org.slug, role: "owner" }] } : u)),
        }));
        if (by === "pin") logTo("did", `Created the organization ${org.name}.`);
        return { ok: true, org };
      },
      saveRule: (r) => {
        setData((d) => ({ ...d, rules: [...d.rules.filter((x) => x.id !== r.id), r] }));
        if (r.createdBy === "pin") logTo("did", `Saved the automation "${r.name}".`);
      },
      toggleRule: (id) => setData((d) => ({ ...d, rules: d.rules.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)) })),
      deleteRule: (id) => setData((d) => ({ ...d, rules: d.rules.filter((r) => r.id !== id) })),
      notify: (n) => setData((d) => ({ ...d, notices: [{ ...n, id: `n-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, at: new Date().toISOString(), read: false }, ...d.notices].slice(0, 50) })),
      markRead: (id) => setData((d) => ({ ...d, notices: d.notices.map((n) => (!id || n.id === id ? { ...n, read: true } : n)) })),
      updateUser: (id, patch) => setData((d) => ({ ...d, users: d.users.map((u) => (u.id === id ? { ...u, ...patch } : u)) })),
      installPlugin: (id) => {
        const p = pluginById(id);
        if (!p) return;
        setData((d) => {
          if (p.kind === "connector") return d.connectors.some((c) => c.id === id) ? d : { ...d, connectors: [...d.connectors, { id, name: p.name, kind: p.connectorKind ?? "model", status: "needs_setup", access: { pin: false, orgs: [] } }] };
          const have = d.plugins ?? DEFAULT_PLUGINS;
          return have.includes(id) ? d : { ...d, plugins: [...have, id] };
        });
      },
      uninstallPlugin: (id) => {
        const p = pluginById(id);
        if (!p) return;
        setData((d) => (p.kind === "connector" ? { ...d, connectors: d.connectors.filter((c) => c.id !== id) } : { ...d, plugins: (d.plugins ?? DEFAULT_PLUGINS).filter((x) => x !== id) }));
      },
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
        const g = view.guests.find((x) => x.vmid === vmid);
        if (!g) return { ok: false, error: "Unknown machine" };
        if (g.protected) return { ok: false, error: `${g.name} is protected` };
        if (g.template) return { ok: false, error: `${g.name} is a template; clone it to get a machine you can start.` };
        const up = action === "start" || action === "reboot" || action === "reset";
        const label = { start: "Start", shutdown: "Shutdown", stop: "Stop", reboot: "Reboot", reset: "Reset" }[action];
        if (live) {
          // Proxmox decides whether this user may do it; the result shows in the machine's task log.
          const log = (ok: boolean, what: string) => setGuests((list) => (list ?? []).map((x) => (x.vmid === vmid ? { ...x, tasks: [{ id: `${vmid}-${Date.now()}`, what, at: new Date().toISOString(), ok }, ...(x.tasks ?? [])].slice(0, 30) } : x)));
          api.power(vmid, action).then(
            () => {
              log(true, label);
              setTimeout(() => setRefreshTick((n) => n + 1), 1500);
            },
            (e) => {
              const msg = e instanceof ApiError ? e.message : "Can't reach this device";
              log(false, `${label}: ${msg}`);
              setData((d) => ({ ...d, notices: [{ id: `n-${Date.now()}`, kind: "info" as const, title: `${label} ${g.name} failed`, body: msg, at: new Date().toISOString(), read: false }, ...d.notices].slice(0, 50) }));
            },
          );
          return { ok: true };
        }
        updateGuest(vmid, (x) => ({ ...x, status: up ? "running" : "stopped", cpuPct: up ? 2 : 0, memUsed: up ? x.memMax * 0.2 : 0, tasks: [{ id: `${vmid}-${Date.now()}`, what: label, at: new Date().toISOString(), ok: true }, ...(x.tasks ?? [])].slice(0, 30) }));
        return { ok: true };
      },
      createMachine: async (spec) => {
        const { org, os, ...rest } = spec;
        if (live) {
          try {
            const r = await api.createMachine(rest);
            setTimeout(() => setRefreshTick((n) => n + 1), 1200);
            watchTask(r.task, `Create container ${spec.name}`);
            return { ok: true, vmid: r.vmid };
          } catch (e) {
            return { ok: false, error: e instanceof ApiError ? e.message : "Can't reach this device" };
          }
        }
        if (view.guests.some((g) => g.name === spec.name)) return { ok: false, error: "A machine with that name exists." };
        const vmid = Math.max(99, ...view.guests.map((g) => g.vmid)) + 1;
        const at = new Date().toISOString();
        const guest: Guest = { vmid, name: spec.name, type: "lxc", status: "running", cpuPct: 3, cores: spec.cores, memUsed: spec.memoryMb * 1024 ** 2 * 0.12, memMax: spec.memoryMb * 1024 ** 2, diskMax: spec.diskGb * 1e9, org, protected: false, ip: `192.168.1.${100 + (vmid % 150)}`, os, tags: org ? [org] : [], snapshots: [], tasks: [{ id: `${vmid}-start`, what: "Start", at, ok: true }, { id: `${vmid}-create`, what: "Create", at, ok: true }] };
        setData((d) => ({ ...d, guests: [...d.guests, guest] }));
        return { ok: true, vmid };
      },
      addProject: (org, name, lead) => updateOrg(org, (o) => ({ ...o, projects: [...o.projects, { id: `p-${Date.now()}`, name, tasks: 0, done: 0, lead }], activity: [{ id: `ac-${Date.now()}`, who: "You", what: `started the project ${name}`, at: new Date().toISOString() }, ...o.activity] })),
      addGoal: (org, title, due) => updateOrg(org, (o) => ({ ...o, goals: [...o.goals, { id: `g-${Date.now()}`, title, progress: 0, due }], activity: [{ id: `ac-${Date.now()}`, who: "You", what: `set the goal "${title}"`, at: new Date().toISOString() }, ...o.activity] })),
      addRoutine: (org, name, schedule, agent) => updateOrg(org, (o) => ({ ...o, routines: [...o.routines, { id: `r-${Date.now()}`, name, schedule, agent, lastRun: null, enabled: true }], activity: [{ id: `ac-${Date.now()}`, who: "You", what: `added the routine ${name}`, at: new Date().toISOString() }, ...o.activity] })),
      snapshot: (vmid, name, description) => {
        if (live) return { ok: false, error: "Snapshots from ePaperclip are coming next. Use the Proxmox console on port 8006 for now." };
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
      setReportsTo: (org, agentId, managerId) => {
        const o = data.orgs.find((x) => x.slug === org);
        const a = o?.agents.find((x) => x.id === agentId);
        if (!o || !a) return { ok: false, error: "Unknown agent" };
        if (managerId === agentId) return { ok: false, error: "An agent can't report to itself." };
        if (managerId && !o.agents.some((x) => x.id === managerId)) return { ok: false, error: "Unknown manager" };
        if (wouldLoop(o.agents, agentId, managerId)) return { ok: false, error: `${a.name} manages that agent, so it can't report to them.` };
        const mgr = o.agents.find((x) => x.id === managerId);
        updateOrg(org, (x) => ({ ...x, agents: x.agents.map((ag) => (ag.id === agentId ? { ...ag, reportsTo: managerId } : ag)), activity: [{ id: `ac-${Date.now()}`, who: "You", what: `moved ${a.name} to report to ${mgr?.name ?? "you"}`, at: new Date().toISOString() }, ...x.activity] }));
        return { ok: true };
      },
      readInbox: (org) => updateOrg(org, (o) => ({ ...o, inbox: o.inbox.map((i) => ({ ...i, read: true })) })),
      setAppMode: (m) => setData((d) => ({ ...d, apps: { ...d.apps, mode: m } })),
      updateSession: (id, patch) => setData((d) => ({ ...d, apps: { ...d.apps, sessions: d.apps.sessions.map((x) => (x.id === id ? { ...x, ...patch } : x)) } })),
      revokeSession: (id) => setData((d) => ({ ...d, apps: { ...d.apps, sessions: d.apps.sessions.filter((x) => x.id !== id) } })),
    }),
    [live, liveError, guests, setup, data, view, host, completeSetup, backend, watchTask, running, contentVersion],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useEngine(): Engine {
  const v = useContext(Ctx);
  if (!v) throw new Error("useEngine outside EngineProvider");
  return v;
}
