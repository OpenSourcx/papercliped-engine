import { useMemo } from "react";
import { Archive, Cable, Database, ShieldAlert } from "lucide-react";
import { useEngine } from "../data/store.tsx";
import { formatBytes, formatUptime } from "../lib/storage.ts";
import { UsageGraphs } from "../ui/UsageGraphs.tsx";
import { Terminal } from "../terminal/LazyTerminal.tsx";
import { DemoTransport } from "../terminal/transport.ts";
import { BarMeter } from "../ui/meters.tsx";
import { Button, Card, Chip, PageFrame, PageHeader, Status } from "../ui/primitives.tsx";

export function HostShell() {
  const { host, setup } = useEngine();
  const make = useMemo(() => () => new DemoTransport({ kind: "host", name: setup?.deviceName ?? "pve", os: "Debian 13 (trixie)", ip: host.ip, cores: host.cpus, memUsed: host.memUsed, memMax: host.memTotal, diskMax: host.diskTotal, uptimeSec: host.uptimeSec }), []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <PageFrame width="6xl">
      <PageHeader title="Host shell" subtitle={`A root shell on ${setup?.deviceName ?? "pve"} itself.`} />
      <div className="flex items-start gap-3 rounded-xl border border-warning/30 bg-warning/5 p-3.5 mb-4 text-[13px]">
        <ShieldAlert className="h-4 w-4 text-warning shrink-0 mt-px" />
        <p className="text-ink-2">Only owners can open the host shell, and it is never available to agents or connected apps. Changes here bypass ePaperclip's checks; prefer machine consoles and Pin for everyday work.</p>
      </div>
      <Terminal make={make} title={`root@${setup?.deviceName ?? "pve"}`} className="h-[min(600px,calc(100dvh-260px))]" />
    </PageFrame>
  );
}

export function StoragePage() {
  const { data } = useEngine();
  return (
    <PageFrame width="4xl">
      <PageHeader title="Storage" subtitle="Where machine disks, templates, ISO images and backups live." />
      <div className="space-y-3">
        {data.host.storage.map((s) => (
          <Card key={s.id} className="p-5">
            <div className="flex items-center gap-3">
              <span className="h-9 w-9 rounded-lg bg-surface-2 flex items-center justify-center text-ink-2"><Database className="h-4 w-4" /></span>
              <div className="flex-1 min-w-0"><div className="font-medium">{s.id}</div><div className="text-[12px] text-ink-3 font-mono truncate">{s.type} · {s.path}</div></div>
              <Status kind="good" label="Active" />
            </div>
            <BarMeter className="mt-4" label="Used" pct={(s.used / s.total) * 100} value={`${formatBytes(s.used)} of ${formatBytes(s.total)}`} />
            <div className="flex flex-wrap gap-1.5 mt-3">{s.content.map((c) => <Chip key={c}>{c}</Chip>)}</div>
            {s.type === "dir" && <p className="text-[12px] text-ink-3 mt-3">Directory storage copies whole disks when cloning. ZFS or LVM-thin make container sessions start in seconds.</p>}
          </Card>
        ))}
      </div>
    </PageFrame>
  );
}

export function NetworkPage() {
  const { data } = useEngine();
  return (
    <PageFrame width="4xl">
      <PageHeader title="Network" subtitle="Bridges and network cards on this device." />
      <Card className="divide-y divide-line">
        {data.host.network.map((n) => (
          <div key={n.name} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
            <Cable className="h-4 w-4 text-ink-3" />
            <span className="font-mono text-[14px] w-20">{n.name}</span>
            <Chip>{n.type === "bridge" ? "Linux bridge" : n.type === "nic" ? "Network card" : "VLAN"}</Chip>
            <span className="flex-1 text-[13px] text-ink-2 font-mono">{n.cidr ?? ""}{n.gateway ? ` via ${n.gateway}` : ""}{n.ports ? ` · ports ${n.ports}` : ""}</span>
            {n.active ? <Status kind="good" label="Active" /> : <Status kind="off" label="Unused" />}
          </div>
        ))}
      </Card>
      <p className="text-[12px] text-ink-3 mt-3">Organization containers join the bridge with the firewall on. Isolating them on their own VLAN keeps them away from the host's management network.</p>
    </PageFrame>
  );
}

export function BackupsPage() {
  const { data } = useEngine();
  return (
    <PageFrame width="4xl">
      <PageHeader title="Backups" subtitle="Scheduled backups of your machines." actions={<Button disabled title="Running backups arrives with the host broker"><Archive className="h-4 w-4" />Back up now</Button>} />
      <div className="space-y-3">
        {data.host.backups.map((b) => (
          <Card key={b.id} className="p-5">
            <div className="flex items-center gap-3">
              <span className="h-9 w-9 rounded-lg bg-surface-2 flex items-center justify-center text-ink-2"><Archive className="h-4 w-4" /></span>
              <div className="flex-1"><div className="font-medium">{b.selection}</div><div className="text-[12px] text-ink-3">{b.schedule} · to {b.storage} · keeps {b.keep}</div></div>
              {b.lastOk ? <Status kind="good" label="Last run OK" /> : <Status kind="critical" label="Last run failed" />}
            </div>
            {b.keep < 3 && <p className="text-[12px] text-warning mt-3">Keeping only {b.keep} copy means one bad night loses your only backup. Pin suggests keeping 3, and leaving organization containers out.</p>}
          </Card>
        ))}
      </div>
    </PageFrame>
  );
}

export function Summary() {
  const { host, setup, data } = useEngine();
  const base = useMemo(() => ({ cpu: Math.max(0.02, host.cpuPct / 100), maxcpu: host.cpus, mem: host.memUsed, maxmem: host.memTotal, net: 180_000, disk: 400_000, running: true }), []); // eslint-disable-line react-hooks/exhaustive-deps
  const running = data.guests.filter((g) => g.status === "running").length;
  const facts: [string, string][] = [
    ["CPU", `${host.cpuPct.toFixed(1)}% of ${host.cpus} CPUs`],
    ["Load average", `${(host.cpuPct / 100 * host.cpus).toFixed(2)}, ${(host.cpuPct / 90 * host.cpus).toFixed(2)}, ${(host.cpuPct / 85 * host.cpus).toFixed(2)}`],
    ["Memory", `${formatBytes(host.memUsed)} of ${formatBytes(host.memTotal)}`],
    ["Root disk", `${formatBytes(host.diskUsed)} of ${formatBytes(host.diskTotal)}`],
    ["Uptime", formatUptime(host.uptimeSec)],
    ["Machines", `${running} running of ${data.guests.length}`],
    ["CPU model", host.cpuModel],
    ["Version", `Proxmox VE ${host.version} · ePaperclip 0.1.0`],
  ];
  return (
    <PageFrame width="6xl">
      <PageHeader title="Summary" subtitle={`Status and history for ${setup?.deviceName ?? "pve"}.`} />
      <Card className="p-5 mb-5">
        <dl className="grid sm:grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-3">
          {facts.map(([k, v]) => (
            <div key={k} className="min-w-0"><dt className="text-[12px] text-ink-3">{k}</dt><dd className="text-[14px] truncate tabular-nums" title={v}>{v}</dd></div>
          ))}
        </dl>
      </Card>
      <UsageGraphs seed={1} base={base} kind="node" />
    </PageFrame>
  );
}
