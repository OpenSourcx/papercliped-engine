import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Archive, Box, Camera, Copy, Shield, Cpu, ListChecks, Loader2, Lock, Monitor, Play, Power, RotateCw, Route, SearchX, Sparkles, Square, SquareTerminal, Trash2, Users } from "lucide-react";
import { usePin, usePinActions } from "../../pin/PinContext.tsx";
import { UsageGraphs } from "../../ui/UsageGraphs.tsx";
import { BackupTable, useBackupFiles } from "../backups/Backups.tsx";
import { Hardware } from "./Hardware.tsx";
import { MachineTasks } from "./MachineTasks.tsx";
import { MachineCluster, MigrateModal } from "../cluster/Migrate.tsx";
import { MachineFirewall } from "../firewall/Firewall.tsx";
import { AddressRows, NotesCard } from "./MachineAbout.tsx";
import { MachineNotes } from "../pin/notes/MachineNotes.tsx";
import { MachinePermissions } from "./MachinePermissions.tsx";
import { Tag } from "../../ui/Tag.tsx";
const Screen = lazy(() => import("./Screen.tsx"));
import { Snapshots } from "./Snapshots.tsx";
import { useEngine } from "../../data/store.tsx";
import type { Guest } from "../../data/types.ts";
import { cn, formatBytes } from "../../lib/storage.ts";
import { Terminal } from "../../terminal/LazyTerminal.tsx";
import { DemoTransport, LiveTransport } from "../../terminal/transport.ts";
import { BarMeter } from "../../ui/meters.tsx";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Card, Chip, EmptyState, PageFrame, SectionTitle, Segmented, Status } from "../../ui/primitives.tsx";

const TABS = [
  { id: "overview", label: "Overview", icon: <Box className="h-4 w-4" /> },
  { id: "console", label: "Console", icon: <SquareTerminal className="h-4 w-4" /> },
  { id: "snapshots", label: "Snapshots", icon: <Camera className="h-4 w-4" /> },
  { id: "backups", label: "Backups", icon: <Archive className="h-4 w-4" /> },
  { id: "hardware", label: "Hardware", icon: <Cpu className="h-4 w-4" /> },
  { id: "firewall", label: "Firewall", icon: <Shield className="h-4 w-4" /> },
  { id: "permissions", label: "Permissions", icon: <Users className="h-4 w-4" /> },
  { id: "tasks", label: "Tasks", icon: <ListChecks className="h-4 w-4" /> },
] as const;

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};

export function MachinePage() {
  const { vmid, org: orgSlug } = useParams();
  const { data, setup, host, guestPower, notify, live, ready } = useEngine();
  const pin = usePin();
  const [params, setParams] = useSearchParams();
  const device = setup?.deviceName ?? "pve";
  const g = data.guests.find((x) => String(x.vmid) === vmid && (!orgSlug || x.org === orgSlug));
  // A machine that was just created or cloned can take a few seconds to show up in Proxmox's list, so an unknown number
  // waits briefly before it is called missing. A machine that was here and is gone (deleted) is reported at once.
  const seen = useRef<string | null>(null);
  if (g) seen.current = vmid ?? null;
  const wasHere = !g && seen.current === (vmid ?? null);
  const [waited, setWaited] = useState(false);
  const [recheck, setRecheck] = useState(0);
  useEffect(() => {
    setWaited(false);
    const t = setTimeout(() => setWaited(true), 6000);
    return () => clearTimeout(t);
  }, [vmid, recheck]);
  const tablist = useRef<HTMLDivElement>(null);
  const tab = TABS.some((t) => t.id === params.get("tab")) ? params.get("tab")! : "overview";
  const [view, setView] = useState<"screen" | "serial">("screen");
  const make = useMemo(() => () => live && g ? new LiveTransport(`/api/console/guests/${g.vmid}`) : new DemoTransport({ kind: g?.type ?? "lxc", name: g?.name ?? "machine", os: g?.os ?? "Linux", ip: g?.ip ?? null, cores: g?.cores ?? 1, memUsed: g?.memUsed ?? 0, memMax: g?.memMax ?? 1, diskMax: g?.diskMax ?? 1, uptimeSec: host.uptimeSec - 3600 }), [g?.vmid, live]); // eslint-disable-line react-hooks/exhaustive-deps
  const base = useMemo(() => (g ? { cpu: Math.max(0.02, g.cpuPct / 100), maxcpu: g.cores, mem: g.memUsed, maxmem: g.memMax, net: g.status === "running" ? 40_000 + g.vmid * 30 : 0, disk: g.status === "running" ? 120_000 : 0, running: g.status === "running" } : null), [g?.vmid, g?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  const setTab = (id: string, extra?: Record<string, string>) => setParams((p) => { const n = new URLSearchParams(p); if (id === "overview") n.delete("tab"); else n.set("tab", id); for (const [k, v] of Object.entries(extra ?? {})) n.set(k, v); return n; }, { replace: true });
  const power = (a: "start" | "shutdown" | "stop" | "reboot" | "reset") => {
    if (!g) return;
    const r = guestPower(g.vmid, a);
    notify(r.ok ? { kind: "info", title: `${g.name}: ${live ? `${a === "shutdown" ? "shut down" : a} requested` : a === "start" ? "started" : a === "reboot" ? "rebooted" : a === "stop" ? "stopped" : "shut down"}`, body: live ? `Machine ${g.vmid}. Proxmox runs it as a task; the status updates in a few seconds.` : `Machine ${g.vmid}, from Pin's quick actions.` } : { kind: "info", title: `Couldn't ${a} ${g.name}`, body: r.error ?? "Failed" });
  };
  const lock = g?.protected ? `${g.name} is protected` : g?.template ? `${g.name} is a template` : undefined;
  const openAction = (action: "destroy" | "template") => g && setParams((p) => { const n = new URLSearchParams(p); n.set("modal", "machine-action"); n.set("action", action); n.set("vmid", String(g.vmid)); return n; });
  const running = g?.status === "running";
  const [acting, setActing] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const act = (a: "start" | "shutdown") => {
    setActing(true);
    power(a);
    setTimeout(() => setActing(false), 4000);
  };
  useEffect(() => {
    const el = tablist.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    el?.scrollIntoView?.({ inline: "center", block: "nearest" });
  }, [tab, g?.vmid]);
  usePinActions(g ? {
    context: `${g.name} #${g.vmid}`,
    items: [
      { id: "start", label: "Start", icon: <Play className="h-4 w-4" />, run: () => power("start"), disabled: running || !!lock, title: lock ?? (running ? "Already running" : undefined) },
      { id: "shutdown", label: "Shut down", icon: <Power className="h-4 w-4" />, run: () => power("shutdown"), disabled: !running || !!lock, title: lock },
      { id: "console", label: "Console", icon: <SquareTerminal className="h-4 w-4" />, run: () => setTab("console"), disabled: !running, title: running ? undefined : "Start it to open its console" },
      { id: "snapshot", label: "Snapshot", icon: <Camera className="h-4 w-4" />, run: () => setTab("snapshots", { new: "1" }) },
      { id: "clone", label: "Clone", icon: <Copy className="h-4 w-4" />, more: true, run: () => setParams((p) => { const n = new URLSearchParams(p); n.set("modal", "clone"); n.set("vmid", String(g.vmid)); return n; }) },
      { id: "backup", label: "Back up now", icon: <Archive className="h-4 w-4" />, more: true, run: () => setParams((p) => { const n = new URLSearchParams(p); n.set("modal", "backup-now"); n.set("vmid", String(g.vmid)); return n; }) },
      { id: "reboot", label: "Reboot", icon: <RotateCw className="h-4 w-4" />, run: () => power("reboot"), disabled: !running || !!lock, title: lock, more: true },
      { id: "stop", label: "Stop", icon: <Square className="h-4 w-4" />, run: () => power("stop"), disabled: !running || !!lock, title: lock, danger: true, more: true, confirm: { title: `Stop ${g.name}?`, body: "Stopping cuts power immediately, like pulling the plug. Unsaved work inside is lost. Shut down is the gentle option.", label: "Stop now" } },
      ...(g.type === "qemu" ? [{ id: "reset", label: "Reset", icon: <RotateCw className="h-4 w-4" />, run: () => power("reset"), disabled: !running || !!lock, title: lock, danger: true, more: true, confirm: { title: `Reset ${g.name}?`, body: "A reset restarts the VM instantly, like pressing the reset button. Unsaved work inside is lost. Reboot is the gentle option.", label: "Reset now" } }] : []),
      { id: "template", label: "Convert to template", icon: <Copy className="h-4 w-4" />, run: () => openAction("template"), disabled: !!g.template || running, title: g.template ? "Already a template" : running ? "Shut it down first" : undefined, more: true },
      { id: "delete", label: "Delete", icon: <Trash2 className="h-4 w-4" />, run: () => openAction("destroy"), disabled: running || g.protected, title: g.protected ? `${g.name} is protected` : running ? "Shut it down first" : undefined, danger: true, more: true },
      ...(live && !g.template ? [{ id: "migrate", label: "Migrate", icon: <Route className="h-4 w-4" />, run: () => setMigrating(true), more: true }] : []),
      { id: "hardware", label: "Hardware", icon: <Cpu className="h-4 w-4" />, run: () => setTab("hardware"), more: true },
      { id: "tasks", label: "Task log", icon: <ListChecks className="h-4 w-4" />, run: () => setTab("tasks"), more: true },
      { id: "ask", label: "Ask Pin about it", icon: <Sparkles className="h-4 w-4" />, run: () => pin.send(`How is ${g.name} doing?`), more: true, group: "ask" },
    ],
  } : null);
  if (!ready) return <div className="p-10 text-ink-3 text-sm" aria-busy="true">Loading machine…</div>;
  const back = orgSlug ? `/${device}/${orgSlug}/machines` : `/${device}/machines`;
  if (!g && live && !wasHere && !waited)
    return (
      <PageFrame width="3xl">
        <Card className="p-8 text-center mt-6" aria-busy="true">
          <Loader2 className="h-5 w-5 animate-spin mx-auto text-ink-3" />
          <p className="font-medium mt-3">Looking for machine #{vmid}</p>
          <p className="text-compact text-ink-3 mt-1">A new machine can take a few seconds to show up in Proxmox's list.</p>
        </Card>
      </PageFrame>
    );
  if (!g || !base)
    return (
      <PageFrame width="3xl">
        <Card className="mt-6">
          <EmptyState
            icon={<SearchX className="h-5 w-5" />}
            title={wasHere ? `Machine #${vmid} is gone` : `There is no machine #${vmid}`}
            body={wasHere ? "It was deleted, or moved to another device. Its page has nothing left to show." : orgSlug ? `${device} has no machine with that number in this organization, or your account can't see it.` : `${device} has no machine with that number, or your account can't see it. Check the number in the address.`}
            action={<div className="flex flex-wrap justify-center gap-2"><Link to={back}><Button variant="primary">Back to machines</Button></Link>{live && !wasHere && <Button variant="ghost" onClick={() => setRecheck((n) => n + 1)}>Check again</Button>}</div>}
          />
        </Card>
      </PageFrame>
    );
  const org = data.orgs.find((o) => o.slug === g.org);

  return (
    <PageFrame width="6xl">
      <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div className="flex items-start gap-3 min-w-0">
          <span className="h-12 w-12 rounded-xl bg-surface-2 border border-line flex items-center justify-center text-ink-2 shrink-0">{g.type === "qemu" ? <Monitor className="h-5 w-5" /> : <Box className="h-5 w-5" />}</span>
          <div className="min-w-0">
            <div className="text-compact text-ink-3 mb-0.5">{org ? <Link to={`/${device}/${org.slug}/machines`} className="hover:text-ink">{org.name} · machines</Link> : <Link to={`/${device}/machines`} className="hover:text-ink">{device} · machines</Link>}</div>
            <h1 className="text-heading font-semibold tracking-tight leading-tight flex items-center gap-2 flex-wrap">{g.name}<span className="text-ink-3 text-lg font-normal tabular-nums">#{g.vmid}</span></h1>
            <div className="flex flex-wrap items-center gap-2 mt-1.5">
              {g.status === "running" ? <Status kind="good" label="Running" /> : <Status kind="off" label="Stopped" />}
              {g.template && <Chip tone="accent">Template</Chip>}
              <Chip>{g.type === "qemu" ? "Virtual machine" : "Container"}</Chip>
              {g.os && g.os.trim() && <Chip>{g.os}</Chip>}
              {g.protected && <Chip><Lock className="h-3 w-3" />Protected</Chip>}
              {(g.tags ?? []).map((t) => <Tag key={t} name={t} />)}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={`Power and console for ${g.name}`}>
          {running ? (
            <Button onClick={() => act("shutdown")} disabled={!!lock || acting} title={lock} loading={acting}><Power className="h-4 w-4" />Shut down</Button>
          ) : (
            <Button variant="primary" onClick={() => act("start")} disabled={!!lock || acting} title={lock} loading={acting}><Play className="h-4 w-4" />Start</Button>
          )}
          <Button onClick={() => setTab("console")} disabled={!running} title={running ? undefined : "Start it to open its console"}><SquareTerminal className="h-4 w-4" />Console</Button>
        </div>
      </div>

      <div ref={tablist} className="flex flex-wrap sm:flex-nowrap gap-x-1 border-b border-line mb-5 sm:overflow-x-auto" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={cn("h-10 px-3 -mb-px border-b-2 text-sm inline-flex items-center gap-2 whitespace-nowrap transition-colors", tab === t.id ? "border-accent text-ink font-medium" : "border-transparent text-ink-3 hover:text-ink-2")}>
            {t.icon}{t.label}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 fade-in">
          <Card className="p-5 lg:col-span-2">
            <SectionTitle>Usage</SectionTitle>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <BarMeter label="CPU" pct={g.cpuPct} value={`${g.cpuPct.toFixed(0)}% of ${g.cores} core${g.cores === 1 ? "" : "s"}`} />
              <BarMeter label="Memory" pct={g.memMax ? (g.memUsed / g.memMax) * 100 : 0} value={`${formatBytes(g.memUsed)} of ${formatBytes(g.memMax)}`} />
              <BarMeter label="Disk" pct={31} value={`${formatBytes(g.diskMax * 0.31)} of ${formatBytes(g.diskMax)}`} />
            </div>
          </Card>
          <Card className="p-5">
            <SectionTitle>Details</SectionTitle>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <AddressRows vmid={g.vmid} status={g.status} />
              <dt className="text-ink-3">Node</dt><dd>{device}</dd>
              <dt className="text-ink-3">Owner</dt><dd>{org?.name ?? "Device"}</dd>
              <dt className="text-ink-3">Snapshots</dt><dd>{g.snapshots?.length ?? 0}</dd>
            </dl>
            <Button size="sm" className="mt-4 w-full" onClick={() => setTab("console")}><SquareTerminal className="h-3.5 w-3.5" />Open console</Button>
          </Card>
          <MachineCluster vmid={g.vmid} template={g.template} />
          <NotesCard vmid={g.vmid} />
          {live && <MachineNotes vmid={g.vmid} name={g.name} />}
          <div className="lg:col-span-3 mt-2">
            <UsageGraphs seed={g.vmid} vmid={g.vmid} base={base} kind="guest" />
          </div>
        </div>
      )}

      {tab === "console" && (
        <div className="fade-in">
          {g.status === "running" ? (
            <>
            {g.type === "qemu" && (
              <div className="mb-3"><Segmented size="sm" value={view} onChange={setView} options={[{ value: "screen", label: "Screen" }, { value: "serial", label: "Serial console" }]} /></div>
            )}
            {g.type === "qemu" && view === "screen" ? (
              live ? (
                <Suspense fallback={<Card className="p-8 text-center text-ink-3 text-sm">Loading the viewer…</Card>}><Screen vmid={g.vmid} name={g.name} /></Suspense>
              ) : (
                <Card className="p-10 text-center"><Monitor className="h-6 w-6 mx-auto text-ink-3" /><p className="text-ink-2 mt-3">{g.name}'s screen appears here on a device.</p><p className="text-compact text-ink-3 mt-1">The demo has no real VM to show. The serial console works as a demo.</p></Card>
              )
            ) : (
              <Terminal make={make} title={`root@${g.name}`} className="h-[min(560px,calc(100dvh-280px))]" />
            )}
            {live && g.type === "qemu" && view === "serial" && (
              <p className="text-xs text-ink-3 mt-2">The serial console needs a serial port on the VM (<span className="font-mono">serial0: socket</span>, then a restart).</p>
            )}
            </>
          ) : (
            <Card className="p-8 text-center"><p className="text-ink-2">{g.name} is stopped. Start it to open its console.</p><div className="mt-4 flex justify-center"><Button variant="primary" disabled={!!lock} title={lock} onClick={() => power("start")}><Play className="h-4 w-4" />Start {g.name}</Button></div></Card>
          )}
          <p className="text-xs text-ink-3 mt-2">{live ? "Opened through Proxmox as your account (it needs VM.Console)." : "Demo shell. On a device, this is the machine's real console through Proxmox."}</p>
        </div>
      )}

      {tab === "backups" && <div className="fade-in"><MachineBackups vmid={g.vmid} name={g.name} /></div>}
      {tab === "snapshots" && <div className="fade-in"><Snapshots g={g} startOpen={params.get("new") === "1"} onOpened={() => setParams((p) => { const n = new URLSearchParams(p); n.delete("new"); return n; }, { replace: true })} /></div>}

      {tab === "hardware" && <Hardware g={g} />}
      {tab === "firewall" && <MachineFirewall vmid={g.vmid} />}
      {tab === "permissions" && <MachinePermissions vmid={g.vmid} name={g.name} />}

      {tab === "tasks" && <MachineTasks g={g} />}
      {migrating && <MigrateModal vmid={g.vmid} onClose={() => setMigrating(false)} />}
    </PageFrame>
  );
}

function MachineBackups({ vmid, name }: { vmid: number; name: string }) {
  const { files, error } = useBackupFiles(vmid);
  const [, setParams] = useSearchParams();
  const backUp = () => setParams((p) => { const n = new URLSearchParams(p); n.set("modal", "backup-now"); n.set("vmid", String(vmid)); return n; });
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-compact text-ink-3">Backups of {name} on every storage that holds backups.</p>
        <Button size="sm" variant="primary" onClick={backUp}><Archive className="h-3.5 w-3.5" />Back up now</Button>
      </div>
      {error && <p role="alert" className="text-compact text-critical mb-3">{error}</p>}
      <Card className="overflow-x-auto">
        {files === null ? (
          <div className="p-8 text-center text-ink-3 text-sm"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Reading backups…</div>
        ) : files.length === 0 ? (
          <div className="p-8 text-center"><p className="text-ink-2">No backups of {name} yet.</p><p className="text-compact text-ink-3 mt-1">Back it up now, or add it to a schedule in Backups.</p></div>
        ) : (
          <BackupTable files={files} showMachine={false} />
        )}
      </Card>
    </div>
  );
}
