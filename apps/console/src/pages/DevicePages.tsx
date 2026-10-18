import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Archive, Cable, Database, HardDrive, ShieldAlert } from "lucide-react";
import { useEngine } from "../data/store.tsx";
import { formatBytes, formatUptime } from "../lib/storage.ts";
import { UsageGraphs } from "../ui/UsageGraphs.tsx";
import { Terminal } from "../terminal/LazyTerminal.tsx";
import { DemoTransport, LiveTransport } from "../terminal/transport.ts";
import { BarMeter } from "../ui/meters.tsx";
import { Button, Card, Chip, PageFrame, PageHeader, Status } from "../ui/primitives.tsx";

export function HostShell() {
  const { host, setup, live } = useEngine();
  const [connected, setConnected] = useState(false);
  const make = useMemo(() => () => live ? new LiveTransport("/api/console/node") : new DemoTransport({ kind: "host", name: setup?.deviceName ?? "pve", os: "Debian 13 (trixie)", ip: host.ip, cores: host.cpus, memUsed: host.memUsed, memMax: host.memTotal, diskMax: host.diskTotal, uptimeSec: host.uptimeSec }), [live]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <PageFrame width="6xl">
      <PageHeader title="Host shell" subtitle={`A root shell on ${setup?.deviceName ?? "pve"} itself.`} />
      <div className="flex items-start gap-3 rounded-xl border border-warning/30 bg-warning/5 p-3.5 mb-4 text-compact">
        <ShieldAlert className="h-4 w-4 text-warning shrink-0 mt-px" />
        <p className="text-ink-2">{live ? "A shell on the host, opened by Proxmox for your account (it needs Sys.Console). " : "Only owners can open the host shell. "}It is never available to agents or connected apps. Changes here bypass ePaperclip's checks; prefer machine consoles and Pin for everyday work.</p>
      </div>
      {connected
        ? <Terminal make={make} title={`root@${setup?.deviceName ?? "pve"}`} className="h-[min(600px,calc(100dvh-260px))]" />
        : <Card className="p-6 flex flex-col items-start gap-3">
            <p className="text-compact text-ink-2">Opening the shell starts a root session on the host and shows up in Tasks. It only starts when you press the button, never just from visiting this page.</p>
            <Button variant="primary" onClick={() => setConnected(true)}>Open host shell</Button>
          </Card>}
    </PageFrame>
  );
}

export function StoragePage() {
  const { data, host, setup } = useEngine();
  return (
    <PageFrame width="4xl">
      <PageHeader title="Storage" subtitle="Where machine disks, templates, ISO images and backups live. Open one to browse, upload or download." />
      <div className="space-y-3">
        {host.diskTotal > 0 && (
          <Card className="p-5">
            <div className="flex items-center gap-3">
              <span className="h-9 w-9 rounded-lg bg-surface-2 flex items-center justify-center text-ink-2"><HardDrive className="h-4 w-4" /></span>
              <div className="flex-1 min-w-0"><div className="font-medium">Root file system</div><div className="text-xs text-ink-3 font-mono truncate">/ on {setup?.deviceName ?? "pve"}</div></div>
              <Status kind="good" label="Mounted" />
            </div>
            <BarMeter className="mt-4" label="Used" pct={(host.diskUsed / host.diskTotal) * 100} value={`${formatBytes(host.diskUsed)} of ${formatBytes(host.diskTotal)}`} />
            <p className="text-xs text-ink-3 mt-3">The host's own system disk. Machines usually live on the storages below.</p>
          </Card>
        )}
        {data.host.storage.length === 0 && <p className="text-sm text-ink-3">Your Proxmox account can't see any storage on this device.</p>}
        {data.host.storage.map((s) => (
          <Link key={s.id} to={`/${setup?.deviceName ?? "pve"}/storage/${s.id}`} className="block">
          <Card interactive className="p-5">
            <div className="flex items-center gap-3">
              <span className="h-9 w-9 rounded-lg bg-surface-2 flex items-center justify-center text-ink-2"><Database className="h-4 w-4" /></span>
              <div className="flex-1 min-w-0"><div className="font-medium">{s.id}</div><div className="text-xs text-ink-3 font-mono truncate">{s.type}{s.path ? ` · ${s.path}` : ""}{s.shared ? " · shared" : ""}</div></div>
              {s.active === false ? <Status kind="off" label="Unavailable" /> : <Status kind="good" label="Active" />}
            </div>
            <BarMeter className="mt-4" label="Used" pct={s.total ? (s.used / s.total) * 100 : 0} value={`${formatBytes(s.used)} of ${formatBytes(s.total)}`} />
            <div className="flex flex-wrap gap-1.5 mt-3">{s.content.map((c) => <Chip key={c}>{c}</Chip>)}</div>
            {s.type === "dir" && <p className="text-xs text-ink-3 mt-3">Directory storage copies whole disks when cloning. ZFS or LVM-thin make container sessions start in seconds.</p>}
          </Card>
          </Link>
        ))}
      </div>
    </PageFrame>
  );
}

export function Summary() {
  const { host, setup, data } = useEngine();
  const base = useMemo(() => ({ cpu: Math.max(0.02, host.cpuPct / 100), maxcpu: host.cpus, mem: host.memUsed, maxmem: host.memTotal, net: 180_000, disk: 400_000, running: true }), []); // eslint-disable-line react-hooks/exhaustive-deps
  const machines = data.guests.filter((g) => !g.template);
  const running = machines.filter((g) => g.status === "running").length;
  const facts: [string, string][] = [
    ["CPU", `${host.cpuPct.toFixed(1)}% of ${host.cpus} CPUs`],
    ["Load average", `${(host.cpuPct / 100 * host.cpus).toFixed(2)}, ${(host.cpuPct / 90 * host.cpus).toFixed(2)}, ${(host.cpuPct / 85 * host.cpus).toFixed(2)}`],
    ["Memory", `${formatBytes(host.memUsed)} of ${formatBytes(host.memTotal)}`],
    ["Root disk", `${formatBytes(host.diskUsed)} of ${formatBytes(host.diskTotal)}`],
    ["Uptime", formatUptime(host.uptimeSec)],
    ["Machines", `${running} running of ${machines.length}`],
    ["CPU model", host.cpuModel],
    ["Version", `Proxmox VE ${host.version} · ePaperclip 0.1.0`],
  ];
  return (
    <PageFrame width="6xl">
      <PageHeader title="Summary" subtitle={`Status and history for ${setup?.deviceName ?? "pve"}.`} />
      <Card className="p-5 mb-5">
        <dl className="grid sm:grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-3">
          {facts.map(([k, v]) => (
            <div key={k} className="min-w-0"><dt className="text-xs text-ink-3">{k}</dt><dd className="text-sm truncate tabular-nums" title={v}>{v}</dd></div>
          ))}
        </dl>
      </Card>
      <UsageGraphs seed={1} base={base} kind="node" />
    </PageFrame>
  );
}
