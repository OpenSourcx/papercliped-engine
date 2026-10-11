import { useMemo, useState } from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom";
import { Box, Camera, Cpu, HardDrive, ListChecks, Lock, MemoryStick, Monitor, Network, Play, Power, RotateCw, Square, SquareTerminal, Trash2 } from "lucide-react";
import { useEngine } from "../../data/store.tsx";
import type { Guest } from "../../data/types.ts";
import { cn, formatBytes } from "../../lib/storage.ts";
import { Terminal } from "../../terminal/LazyTerminal.tsx";
import { DemoTransport } from "../../terminal/transport.ts";
import { BarMeter } from "../../ui/meters.tsx";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Card, Chip, Input, PageFrame, SectionTitle, Status } from "../../ui/primitives.tsx";

const TABS = [
  { id: "overview", label: "Overview", icon: <Box className="h-4 w-4" /> },
  { id: "console", label: "Console", icon: <SquareTerminal className="h-4 w-4" /> },
  { id: "snapshots", label: "Snapshots", icon: <Camera className="h-4 w-4" /> },
  { id: "hardware", label: "Hardware", icon: <Cpu className="h-4 w-4" /> },
  { id: "tasks", label: "Tasks", icon: <ListChecks className="h-4 w-4" /> },
] as const;

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};

function PowerBar({ g }: { g: Guest }) {
  const { guestPower, notify } = useEngine();
  const [confirm, setConfirm] = useState<null | "stop">(null);
  const [error, setError] = useState<string | null>(null);
  const act = (a: "start" | "shutdown" | "stop" | "reboot") => {
    const r = guestPower(g.vmid, a);
    if (!r.ok) return setError(r.error ?? "Failed");
    setError(null);
    notify({ kind: "info", title: `${g.name}: ${a}`, body: `Machine ${g.vmid} ${a === "start" ? "started" : a === "reboot" ? "rebooted" : a === "stop" ? "was stopped" : "shut down"}.` });
  };
  const lock = g.protected ? "Protected machine" : undefined;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {g.status === "running" ? (
        <>
          <Button size="sm" disabled={g.protected} title={lock} onClick={() => act("shutdown")}><Power className="h-3.5 w-3.5" />Shut down</Button>
          <Button size="sm" disabled={g.protected} title={lock} onClick={() => act("reboot")}><RotateCw className="h-3.5 w-3.5" />Reboot</Button>
          <Button size="sm" variant="danger" disabled={g.protected} title={lock} onClick={() => setConfirm("stop")}><Square className="h-3.5 w-3.5" />Stop</Button>
        </>
      ) : (
        <Button size="sm" variant="primary" disabled={g.protected} title={lock} onClick={() => act("start")}><Play className="h-3.5 w-3.5" />Start</Button>
      )}
      {error && <span className="text-[13px] text-critical">{error}</span>}
      {confirm && (
        <Modal size="sm" title={`Stop ${g.name}?`} subtitle="Stopping cuts power immediately, like pulling the plug. Unsaved work inside is lost. Shut down is the gentle option." onClose={() => setConfirm(null)} footer={<><Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button><Button variant="danger" onClick={() => { act("stop"); setConfirm(null); }}>Stop now</Button></>}>
          <div />
        </Modal>
      )}
    </div>
  );
}

function Snapshots({ g }: { g: Guest }) {
  const { snapshot, deleteSnapshot } = useEngine();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [error, setError] = useState<string | null>(null);
  const take = () => {
    const r = snapshot(g.vmid, name.trim(), desc.trim());
    if (!r.ok) return setError(r.error ?? "Failed");
    setOpen(false);
    setName("");
    setDesc("");
    setError(null);
  };
  return (
    <Card className="p-5">
      <SectionTitle action={<Button size="sm" variant="primary" onClick={() => setOpen(true)}><Camera className="h-3.5 w-3.5" />Take snapshot</Button>}>Snapshots</SectionTitle>
      {(g.snapshots ?? []).length === 0 ? <p className="text-[14px] text-ink-3">No snapshots yet. Take one before risky changes; Pin does this automatically before updates.</p> : (
        <div className="divide-y divide-line">
          {(g.snapshots ?? []).map((s) => (
            <div key={s.name} className="flex items-center gap-3 py-3">
              <Camera className="h-4 w-4 text-ink-3" />
              <div className="flex-1 min-w-0"><div className="text-[14px] font-medium font-mono">{s.name}</div><div className="text-[12px] text-ink-3 truncate">{s.description || "No description"} · {ago(s.at)}</div></div>
              <Button size="sm" variant="ghost" disabled title="Rollback arrives with the host broker">Roll back</Button>
              <button onClick={() => deleteSnapshot(g.vmid, s.name)} className="h-8 w-8 rounded-lg hover:bg-surface-2 flex items-center justify-center text-ink-3 hover:text-critical" aria-label={`Delete snapshot ${s.name}`}><Trash2 className="h-4 w-4" /></button>
            </div>
          ))}
        </div>
      )}
      {open && (
        <Modal size="sm" title="Take a snapshot" subtitle={`Saves ${g.name}'s current state so you can return to it.`} onClose={() => setOpen(false)} footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" onClick={take} disabled={!name.trim()}>Take snapshot</Button></>}>
          <div className="space-y-3">
            <label className="block"><span className="block text-[13px] text-ink-2 mb-1.5">Name</span><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="before-upgrade" onKeyDown={(e) => e.key === "Enter" && take()} /></label>
            <label className="block"><span className="block text-[13px] text-ink-2 mb-1.5">Description</span><Input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Optional" /></label>
            {error && <p className="text-[12px] text-critical">{error}</p>}
          </div>
        </Modal>
      )}
    </Card>
  );
}

export function MachinePage() {
  const { vmid, org: orgSlug } = useParams();
  const { data, setup, host } = useEngine();
  const [params, setParams] = useSearchParams();
  const device = setup?.deviceName ?? "pve";
  const g = data.guests.find((x) => String(x.vmid) === vmid && (!orgSlug || x.org === orgSlug));
  const tab = TABS.some((t) => t.id === params.get("tab")) ? params.get("tab")! : "overview";
  const make = useMemo(() => () => new DemoTransport({ kind: g?.type ?? "lxc", name: g?.name ?? "machine", os: g?.os ?? "Linux", ip: g?.ip ?? null, cores: g?.cores ?? 1, memUsed: g?.memUsed ?? 0, memMax: g?.memMax ?? 1, diskMax: g?.diskMax ?? 1, uptimeSec: host.uptimeSec - 3600 }), [g?.vmid]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!g) return <Navigate to={orgSlug ? `/${device}/${orgSlug}/machines` : `/${device}/machines`} replace />;
  const org = data.orgs.find((o) => o.slug === g.org);
  const setTab = (id: string) => setParams((p) => { const n = new URLSearchParams(p); if (id === "overview") n.delete("tab"); else n.set("tab", id); return n; }, { replace: true });

  return (
    <PageFrame width="6xl">
      <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div className="flex items-start gap-3 min-w-0">
          <span className="h-12 w-12 rounded-xl bg-surface-2 border border-line flex items-center justify-center text-ink-2 shrink-0">{g.type === "qemu" ? <Monitor className="h-5 w-5" /> : <Box className="h-5 w-5" />}</span>
          <div className="min-w-0">
            <div className="text-[13px] text-ink-3 mb-0.5">{org ? <Link to={`/${device}/${org.slug}/machines`} className="hover:text-ink">{org.name} · machines</Link> : <Link to={`/${device}/machines`} className="hover:text-ink">{device} · machines</Link>}</div>
            <h1 className="text-[26px] font-semibold tracking-tight leading-tight flex items-center gap-2 flex-wrap">{g.name}<span className="text-ink-3 text-[18px] font-normal tabular-nums">#{g.vmid}</span></h1>
            <div className="flex flex-wrap items-center gap-2 mt-1.5">
              {g.status === "running" ? <Status kind="good" label="Running" /> : <Status kind="off" label="Stopped" />}
              <Chip>{g.type === "qemu" ? "Virtual machine" : "Container"}</Chip>
              <Chip>{g.os}</Chip>
              {g.protected && <Chip><Lock className="h-3 w-3" />Protected</Chip>}
            </div>
          </div>
        </div>
        <PowerBar g={g} />
      </div>

      <div className="flex gap-1 border-b border-line mb-5 overflow-x-auto" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={cn("h-10 px-3 -mb-px border-b-2 text-[14px] inline-flex items-center gap-2 whitespace-nowrap transition-colors", tab === t.id ? "border-accent text-ink font-medium" : "border-transparent text-ink-3 hover:text-ink-2")}>
            {t.icon}{t.label}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <div className="grid lg:grid-cols-3 gap-4 fade-in">
          <Card className="p-5 lg:col-span-2">
            <SectionTitle>Usage</SectionTitle>
            <div className="grid sm:grid-cols-2 gap-5">
              <BarMeter label="CPU" pct={g.cpuPct} value={`${g.cpuPct.toFixed(0)}% of ${g.cores} core${g.cores === 1 ? "" : "s"}`} />
              <BarMeter label="Memory" pct={g.memMax ? (g.memUsed / g.memMax) * 100 : 0} value={`${formatBytes(g.memUsed)} of ${formatBytes(g.memMax)}`} />
              <BarMeter label="Disk" pct={31} value={`${formatBytes(g.diskMax * 0.31)} of ${formatBytes(g.diskMax)}`} />
            </div>
          </Card>
          <Card className="p-5">
            <SectionTitle>Details</SectionTitle>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[14px]">
              <dt className="text-ink-3">Address</dt><dd className="font-mono text-[13px]">{g.ip ?? "—"}</dd>
              <dt className="text-ink-3">Node</dt><dd>{device}</dd>
              <dt className="text-ink-3">Owner</dt><dd>{org?.name ?? "Device"}</dd>
              <dt className="text-ink-3">Snapshots</dt><dd>{g.snapshots?.length ?? 0}</dd>
            </dl>
            <Button size="sm" className="mt-4 w-full" onClick={() => setTab("console")}><SquareTerminal className="h-3.5 w-3.5" />Open console</Button>
          </Card>
        </div>
      )}

      {tab === "console" && (
        <div className="fade-in">
          {g.status === "running" ? (
            <Terminal make={make} title={`root@${g.name}`} className="h-[min(560px,calc(100dvh-280px))]" />
          ) : (
            <Card className="p-8 text-center"><p className="text-ink-2">{g.name} is stopped. Start it to open its console.</p><div className="mt-4 flex justify-center"><PowerBar g={g} /></div></Card>
          )}
          <p className="text-[12px] text-ink-3 mt-2">Live consoles run through the host broker and Proxmox's terminal proxy; who can open one is set by the Open container consoles tool in Access control.</p>
        </div>
      )}

      {tab === "snapshots" && <div className="fade-in"><Snapshots g={g} /></div>}

      {tab === "hardware" && (
        <Card className="divide-y divide-line fade-in">
          {[
            [<Cpu key="c" className="h-4 w-4" />, "Processors", `${g.cores} core${g.cores === 1 ? "" : "s"}`],
            [<MemoryStick key="m" className="h-4 w-4" />, "Memory", formatBytes(g.memMax)],
            [<HardDrive key="d" className="h-4 w-4" />, "Root disk", formatBytes(g.diskMax)],
            [<Network key="n" className="h-4 w-4" />, "Network", `eth0 · bridge vmbr0 · ${g.ip ?? "DHCP"} · firewall on`],
            [<Lock key="u" className="h-4 w-4" />, "Privileges", g.type === "lxc" ? "Unprivileged container" : "KVM with host CPU"],
          ].map(([icon, k, v]) => (
            <div key={String(k)} className="flex items-center gap-3 px-5 py-3.5">
              <span className="text-ink-3">{icon}</span>
              <span className="w-32 text-[14px] text-ink-2">{k}</span>
              <span className="text-[14px]">{v}</span>
            </div>
          ))}
        </Card>
      )}

      {tab === "tasks" && (
        <Card className="divide-y divide-line fade-in">
          {(g.tasks ?? []).map((t) => (
            <div key={t.id} className="flex items-center gap-3 px-5 py-3 text-[14px]">
              {t.ok ? <Status kind="good" label="OK" /> : <Status kind="critical" label="Failed" />}
              <span className="flex-1">{t.what}</span>
              <span className="text-[12px] text-ink-3 tabular-nums">{ago(t.at)}</span>
            </div>
          ))}
        </Card>
      )}
    </PageFrame>
  );
}
