import { Link } from "react-router-dom";
import { ArrowUpRight, Bot, Boxes, Database, HardDrive, Plug, Plus, Workflow } from "lucide-react";
import { useEngine } from "../data/store.tsx";
import type { Org } from "../data/types.ts";
import { formatBytes, formatUptime } from "../lib/storage.ts";
import { PinComposer } from "../pin/PinComposer.tsx";
import { usePin } from "../pin/PinContext.tsx";
import { modalHref, settingsHref } from "../modals/useModals.ts";
import { ArcMeter, BarMeter } from "../ui/meters.tsx";
import { Avatar, Card, SectionTitle, Status } from "../ui/primitives.tsx";

function greeting(): string {
  const h = new Date().getHours();
  return h < 5 ? "Working late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

function OrgCard({ org, device }: { org: Org; device: string }) {
  const working = org.agents.filter((a) => a.status === "working");
  const rg = org.resourceGroup;
  const cpuPct = (org.usage.cpuCores / rg.cores) * 100;
  const memPct = (org.usage.memoryMb / rg.memoryMb) * 100;
  return (
    <Link to={`/${device}/${org.slug}`} className="block group">
      <Card interactive className="p-4 h-full">
        <div className="flex items-start gap-3">
          <Avatar name={org.name} hue={org.hue} size={38} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-semibold truncate">{org.name}</span>
              <ArrowUpRight className="h-4 w-4 text-ink-3 opacity-0 group-hover:opacity-100 transition" />
            </div>
            {working.length > 0 ? <Status kind="working" label={`${working.length} of ${org.agents.length} agents working`} /> : <Status kind="idle" label={org.agents.length ? "Idle" : "No agents yet"} />}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 mt-4">
          <BarMeter label="CPU" pct={cpuPct} value={`${org.usage.cpuCores.toFixed(1)} / ${rg.cores} cores`} />
          <BarMeter label="Memory" pct={memPct} value={`${(org.usage.memoryMb / 1024).toFixed(1)} / ${(rg.memoryMb / 1024).toFixed(0)} GiB`} />
        </div>
        <div className="mt-3 text-[12px] text-ink-3 truncate">{working[0]?.task ? `Now: ${working[0].task}` : `${org.usage.guests} of ${rg.maxGuests} containers in use`}</div>
      </Card>
    </Link>
  );
}

export function Home() {
  const { setup, host, data } = useEngine();
  const pin = usePin();
  const device = setup?.deviceName ?? "pve";
  const name = (setup?.ownerName || "there").split(" ")[0];
  const running = data.guests.filter((g) => g.status === "running").length;
  const working = data.orgs.flatMap((o) => o.agents).filter((a) => a.status === "working").length;
  const activeRules = data.rules.filter((r) => r.enabled).length;

  return (
    <div>
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 hero-glow pointer-events-none" aria-hidden />
        <div className="relative max-w-3xl mx-auto px-4 sm:px-6 pt-28 sm:pt-36 pb-16 sm:pb-20 text-center">
          <h1 className="text-[34px] sm:text-[48px] font-medium tracking-tight leading-[1.1] fade-in">
            {greeting()}, {name}. <span className="text-ink-2">What's on your mind?</span>
          </h1>
          <p className="text-ink-3 mt-4 text-[15px] fade-in">
            {device} is {host.cpuPct < 70 ? "running smoothly" : "busy"} · {working ? `${working} agents working` : "all agents idle"} · up {formatUptime(host.uptimeSec)}
          </p>
          <div className="mt-9 text-left">
            <PinComposer />
          </div>
          <div className="flex flex-wrap justify-center gap-2 mt-4">
            {["How is my server?", "Which agents are idle?", "If a VM uses more than 80% CPU for 5 minutes, notify me"].map((s) => (
              <button key={s} onClick={() => pin.send(s)} className="text-[13px] px-3.5 h-8 rounded-full border border-line bg-surface/60 hover:bg-surface-2 text-ink-2 transition">
                {s}
              </button>
            ))}
          </div>
        </div>
      </section>

      <div className="max-w-6xl mx-auto px-4 sm:px-6 pb-20 space-y-10">
        <section>
          <SectionTitle action={<Link to={`/${device}/machines`} className="text-[13px] text-ink-3 hover:text-ink">View machines</Link>}>This device</SectionTitle>
          <div className="grid lg:grid-cols-[1fr_280px] gap-4">
            <Card className="p-4 sm:p-6 flex flex-col">
              <div className="flex-1 grid grid-cols-3 gap-2 sm:gap-6 items-center justify-items-center">
                <ArcMeter label="CPU" pct={host.cpuPct} caption={`of ${host.cpus} CPUs`} />
                <ArcMeter label="Memory" pct={(host.memUsed / host.memTotal) * 100} caption={`${formatBytes(host.memUsed)} of ${formatBytes(host.memTotal)}`} />
                <ArcMeter label="Root disk" pct={host.diskTotal ? (host.diskUsed / host.diskTotal) * 100 : 0} caption={`${formatBytes(host.diskUsed)} of ${formatBytes(host.diskTotal)}`} />
              </div>
              <div className="mt-5 pt-4 border-t border-line flex flex-wrap gap-x-6 gap-y-1 text-[13px] text-ink-3">
                <span>{host.cpuModel}</span>
                <span>Proxmox VE {host.version}</span>
                <span>{host.ip}</span>
              </div>
            </Card>
            <div className="grid grid-cols-2 lg:grid-cols-1 gap-3">
              {[
                { icon: <Boxes className="h-4 w-4" />, value: `${running} / ${data.guests.length}`, label: "Machines running", to: `/${device}/machines` },
                { icon: <Bot className="h-4 w-4" />, value: String(working), label: "Agents working", to: `/${device}/${data.orgs[0]?.slug ?? "home"}` },
                { icon: <Workflow className="h-4 w-4" />, value: String(activeRules), label: "Automations on", to: `/${device}/automations` },
                { icon: <Plug className="h-4 w-4" />, value: String(data.apps.sessions.length), label: "Apps connected", to: settingsHref("apps") },
              ].map((s) => (
                <Link key={s.label} to={s.to}>
                  <Card interactive className="p-4 flex items-center gap-3">
                    <span className="h-9 w-9 rounded-lg bg-surface-2 flex items-center justify-center text-ink-2">{s.icon}</span>
                    <div>
                      <div className="text-[20px] font-semibold tabular-nums leading-tight">{s.value}</div>
                      <div className="text-[12px] text-ink-3">{s.label}</div>
                    </div>
                  </Card>
                </Link>
              ))}
            </div>
          </div>
        </section>

        <section>
          <SectionTitle action={<Link to={`/${device}/storage`} className="text-[13px] text-ink-3 hover:text-ink">View storage</Link>}>Drives</SectionTitle>
          <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {[
              ...(host.diskTotal ? [{ id: "/", name: "Root file system", sub: "System disk", used: host.diskUsed, total: host.diskTotal, root: true, active: true }] : []),
              ...data.host.storage.map((s) => ({ id: s.id, name: s.id, sub: [s.type, s.content.slice(0, 3).join(", ")].filter(Boolean).join(" · "), used: s.used, total: s.total, root: false, active: s.active !== false })),
            ].map((s) => (
              <Link key={s.id} to={`/${device}/storage`}>
                <Card interactive className="p-4">
                  <div className="flex items-center gap-3 mb-3">
                    <span className="h-9 w-9 rounded-lg bg-surface-2 flex items-center justify-center text-ink-2">{s.root ? <HardDrive className="h-4 w-4" /> : <Database className="h-4 w-4" />}</span>
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-[14px] truncate">{s.name}</div>
                      <div className="text-[12px] text-ink-3 truncate">{s.sub}</div>
                    </div>
                    {!s.active && <Status kind="off" label="Unavailable" />}
                  </div>
                  <BarMeter label={`${formatBytes(Math.max(0, s.total - s.used))} free`} pct={s.total ? (s.used / s.total) * 100 : 0} value={`${formatBytes(s.used)} of ${formatBytes(s.total)}`} />
                </Card>
              </Link>
            ))}
          </div>
        </section>

        <section>
          <SectionTitle action={<Link to={modalHref("new-org")} className="text-[13px] text-ink-3 hover:text-ink inline-flex items-center gap-1"><Plus className="h-3.5 w-3.5" />New organization</Link>}>Organizations</SectionTitle>
          <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-4">
            {data.orgs.map((o) => <OrgCard key={o.slug} org={o} device={device} />)}
            <Link to={modalHref("new-org")} className="block">
              <div className="h-full min-h-[168px] rounded-xl border border-dashed border-line-strong flex flex-col items-center justify-center gap-2 text-ink-3 hover:text-ink hover:border-accent/40 transition">
                <Plus className="h-5 w-5" />
                <span className="text-[14px]">New organization</span>
                <span className="text-[12px]">or ask Pin to create one</span>
              </div>
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}
