import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HeartPulse } from "lucide-react";
import { diskHealthApi, type DiskHealth, type ZfsPool } from "../../data/engine/w3Api.ts";
import { errorText } from "../../data/engine/queries.ts";
import { formatBytes } from "../../lib/storage.ts";
import { Modal } from "../../ui/Modal.tsx";
import { BarMeter } from "../../ui/meters.tsx";
import { Button, Card, Chip, Field, Input, Notice, PageFrame, PageHeader, Select, Status } from "../../ui/primitives.tsx";
import { Async, LiveOnly } from "../node/common.tsx";
import { Guide, LEVEL, Section } from "./w3Common.tsx";

const fmtTime = (t: number) => new Date(t * 1000).toLocaleDateString();

function HistoryModal({ disk, onClose }: { disk: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ["disk-health", "history", disk], queryFn: () => diskHealthApi.history(disk), retry: 0 });
  return (
    <Modal title={`History of ${disk}`} subtitle="Proxmox keeps no SMART history, so ePaperclip notes the figures while someone has this page open" size="lg" onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      <Async q={q}>
        {(d) => d.samples.length === 0 ? <p className="text-compact text-ink-3">No samples yet.</p> : (
          <div className="overflow-x-auto"><table className="w-full text-compact min-w-[520px]">
            <thead><tr className="text-left text-ink-3 border-b border-line"><th className="font-normal py-2 pr-3">Date</th><th className="font-normal pr-3">Life left</th><th className="font-normal pr-3">Temperature</th><th className="font-normal pr-3">Hours on</th><th className="font-normal pr-3">Remapped</th><th className="font-normal">Health</th></tr></thead>
            <tbody>{[...d.samples].reverse().map((s) => <tr key={s.t} className="border-b border-line last:border-0"><td className="py-2 pr-3">{fmtTime(s.t)}</td><td className="pr-3 tabular-nums">{s.wear === null ? "–" : `${s.wear}%`}</td><td className="pr-3 tabular-nums">{s.temperature === null ? "–" : `${s.temperature} °C`}</td><td className="pr-3 tabular-nums">{s.hours?.toLocaleString() ?? "–"}</td><td className="pr-3 tabular-nums">{s.reallocated ?? "–"}</td><td>{s.health ?? "–"}</td></tr>)}</tbody>
          </table></div>
        )}
      </Async>
    </Modal>
  );
}

const ACTIONS: { id: string; label: string; needsDevice?: boolean; needsNew?: boolean; needsImport?: boolean }[] = [
  { id: "status", label: "Detailed status" },
  { id: "scrub", label: "Scrub" },
  { id: "scrub-stop", label: "Stop a scrub" },
  { id: "trim", label: "Trim" },
  { id: "autotrim", label: "Turn on automatic trim" },
  { id: "clear", label: "Clear error counters" },
  { id: "offline", label: "Take a disk offline", needsDevice: true },
  { id: "online", label: "Bring a disk online", needsDevice: true },
  { id: "replace", label: "Replace a disk", needsDevice: true, needsNew: true },
  { id: "attach", label: "Add a mirror copy", needsDevice: true, needsNew: true },
  { id: "detach", label: "Remove a disk from a mirror", needsDevice: true },
  { id: "export", label: "Export the pool" },
  { id: "import", label: "Import a pool", needsImport: true },
];

function PoolModal({ name, freeDisks, onClose }: { name: string; freeDisks: string[]; onClose: () => void }) {
  const q = useQuery({ queryKey: ["disk-health", "zfs", name], queryFn: () => diskHealthApi.zfs(name), retry: 0 });
  return (
    <Modal title={`ZFS pool ${name}`} subtitle="State, what is stored on it, and maintenance" size="lg" onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      <Async q={q}>{(p) => <PoolBody p={p} freeDisks={freeDisks} />}</Async>
    </Modal>
  );
}

function PoolBody({ p, freeDisks }: { p: ZfsPool; freeDisks: string[] }) {
  const [action, setAction] = useState("status");
  const [device, setDevice] = useState(p.disks[0] ?? "");
  const [newDevice, setNewDevice] = useState(freeDisks[0] ?? "");
  const [importName, setImportName] = useState("");
  const a = ACTIONS.find((x) => x.id === action)!;
  const guide = useQuery({
    queryKey: ["disk-health", "zfs-guide", p.name, action, device, newDevice, importName],
    queryFn: () => diskHealthApi.zfsGuide(p.name, action, { device: a.needsDevice ? device : undefined, newDevice: a.needsNew ? newDevice : undefined, importName: a.needsImport && importName ? importName : undefined }),
    retry: 0,
  });
  return (
    <div className="space-y-5">
      <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-2 text-compact">
        <div><dt className="text-xs text-ink-3">State</dt><dd><Status kind={p.state === "ONLINE" ? "good" : p.state === "DEGRADED" ? "warning" : "critical"} label={p.state} /></dd></div>
        <div><dt className="text-xs text-ink-3">Last scan</dt><dd>{p.scan ?? "–"}</dd></div>
        <div><dt className="text-xs text-ink-3">Errors</dt><dd>{p.errors ?? "–"}</dd></div>
        <div><dt className="text-xs text-ink-3">Disks</dt><dd className="font-mono text-xs">{p.disks.join(", ") || "–"}</dd></div>
      </dl>
      <Section title="Datasets and zvols" hint="Machine disks are zvols; container volumes are datasets. Shown for the storages that use this pool.">
        {p.volumes.length === 0 ? <p className="text-compact text-ink-3">{p.storages.length ? "Nothing stored yet." : "No Proxmox storage uses this pool."}</p> : (
          <Card className="overflow-x-auto"><table className="w-full text-compact min-w-[480px]"><tbody>
            {p.volumes.map((v) => <tr key={v.volid} className="border-b border-line last:border-0"><td className="px-4 py-2 font-mono text-xs">{v.dataset}</td><td className="px-3"><Chip>{v.kind === "zvol" ? "zvol" : "dataset"}</Chip></td><td className="px-3 tabular-nums">{v.sizeBytes ? formatBytes(v.sizeBytes) : "–"}</td><td className="px-3 text-ink-3">{v.vmid ? `machine ${v.vmid}` : ""}</td></tr>)}
          </tbody></table></Card>
        )}
      </Section>
      <Section title="Maintenance" hint="Proxmox has no calls for these. Pick what you want to do and copy the commands.">
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="What to do" htmlFor="zfs-action"><Select id="zfs-action" value={action} onChange={(e) => setAction(e.target.value)}>{ACTIONS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</Select></Field>
          {a.needsDevice && <Field label="Disk in the pool" htmlFor="zfs-dev"><Select id="zfs-dev" value={device} onChange={(e) => setDevice(e.target.value)}>{p.disks.map((d) => <option key={d} value={d}>{d}</option>)}</Select></Field>}
          {a.needsNew && <Field label="New disk (will be erased)" htmlFor="zfs-new"><Select id="zfs-new" value={newDevice} onChange={(e) => setNewDevice(e.target.value)}>{freeDisks.length === 0 && <option value="">No unused disk</option>}{freeDisks.map((d) => <option key={d} value={d}>{d}</option>)}</Select></Field>}
          {a.needsImport && <Field label="Pool to import" hint="Leave empty to see what can be imported" htmlFor="zfs-imp"><Input id="zfs-imp" value={importName} onChange={(e) => setImportName(e.target.value)} className="font-mono" spellCheck={false} /></Field>}
        </div>
        {guide.error ? <Notice tone="critical">{errorText(guide.error)}</Notice> : guide.data ? <Guide steps={guide.data.steps} cautions={guide.data.cautions} /> : null}
      </Section>
    </div>
  );
}

function SettingsModal({ t, onClose, onSaved }: { t: DiskHealth["thresholds"]; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState({ wearWarn: String(t.wearWarn), wearCrit: String(t.wearCrit), usageWarn: String(t.usageWarn), usageCrit: String(t.usageCrit) });
  const save = useMutation({ mutationFn: () => diskHealthApi.saveThresholds({ wearWarn: Number(v.wearWarn), wearCrit: Number(v.wearCrit), usageWarn: Number(v.usageWarn), usageCrit: Number(v.usageCrit) }), onSuccess: () => { onSaved(); onClose(); } });
  const f = (k: keyof typeof v, label: string, hint: string) => <Field label={label} hint={hint} htmlFor={`th-${k}`}><Input id={`th-${k}`} type="number" value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} className="tabular-nums" /></Field>;
  return (
    <Modal title="Alert thresholds" subtitle="Shared by everyone who looks at this device" onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
      <div className="grid grid-cols-2 gap-4">
        {f("wearWarn", "Wear warning (% life left)", "Warn at or below this")}
        {f("wearCrit", "Wear critical (% life left)", "Must be lower than the warning")}
        {f("usageWarn", "Usage warning (% full)", "Warn at or above this")}
        {f("usageCrit", "Usage critical (% full)", "Must be higher than the warning")}
      </div>
      {save.error && <p role="alert" className="mt-3 text-compact text-critical">{errorText(save.error)}</p>}
    </Modal>
  );
}

function Body({ d }: { d: DiskHealth }) {
  const qc = useQueryClient();
  const [pool, setPool] = useState<string | null>(null);
  const [history, setHistory] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
  const overall = LEVEL[d.level];
  const unused = d.disks.filter((x) => !x.usedBy || x.usedBy === "unused").map((x) => x.devpath);
  return (
    <div className="space-y-6">
      <Card className="p-5">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3"><Status kind={overall.kind} label={overall.label} /><span className="text-compact text-ink-2">{d.alerts.length === 0 ? "Disks, pools and storages are all fine." : `${d.alerts.length} thing${d.alerts.length === 1 ? "" : "s"} to look at`}</span></div>
          <Button size="sm" variant="ghost" onClick={() => setSettings(true)}>Alert thresholds…</Button>
        </div>
        {d.alerts.length > 0 && (
          <ul className="mt-4 divide-y divide-line">
            {d.alerts.map((a) => <li key={`${a.kind}-${a.subject}-${a.message}`} className="py-2.5 flex gap-3 items-start"><Status kind={a.level === "critical" ? "critical" : "warning"} label={a.level === "critical" ? "Act now" : "Watch"} /><span className="text-compact">{a.message}</span></li>)}
          </ul>
        )}
      </Card>

      <Section title="Disks" hint="Life left counts down from 100 for SSDs. Hard disks report health and sector counts only.">
        <Card className="overflow-x-auto"><table className="w-full text-compact min-w-[760px]">
          <thead><tr className="border-b border-line text-ink-3 text-left"><th className="font-normal px-4 h-10">Disk</th><th className="font-normal px-3">Health</th><th className="font-normal px-3">Life left</th><th className="font-normal px-3">Temperature</th><th className="font-normal px-3">Hours on</th><th className="font-normal px-3">Remapped</th><th className="px-3"><span className="sr-only">History</span></th></tr></thead>
          <tbody>{d.disks.map((x) => (
            <tr key={x.devpath} className="border-b border-line last:border-0">
              <td className="px-4 py-3"><div className="font-mono">{x.devpath}</div><div className="text-xs text-ink-3">{[x.model, formatBytes(x.sizeBytes)].filter(Boolean).join(" · ")}</div></td>
              <td className="px-3"><Status kind={x.level === "ok" ? "good" : x.level === "warning" ? "warning" : "critical"} label={x.health ?? "Unknown"} /></td>
              <td className="px-3 tabular-nums">{x.wearoutPct === null ? "–" : `${x.wearoutPct}%`}</td>
              <td className="px-3 tabular-nums">{x.facts?.temperature != null ? `${x.facts.temperature} °C` : "–"}</td>
              <td className="px-3 tabular-nums">{x.facts?.powerOnHours?.toLocaleString() ?? "–"}</td>
              <td className="px-3 tabular-nums">{x.facts?.reallocated ?? "–"}</td>
              <td className="px-3"><Button size="sm" variant="ghost" onClick={() => setHistory(x.devpath)}>History</Button></td>
            </tr>
          ))}</tbody>
        </table></Card>
      </Section>

      {d.pools.length > 0 && (
        <Section title="ZFS pools">
          <div className="grid sm:grid-cols-2 gap-3">
            {d.pools.map((p) => (
              <Card key={p.name} className="p-4 space-y-2">
                <div className="flex items-center justify-between gap-2"><span className="font-mono font-medium">{p.name}</span><Status kind={p.level === "ok" ? "good" : p.level === "warning" ? "warning" : "critical"} label={p.health} /></div>
                {p.percentUsed !== null && <BarMeter label="Used" pct={p.percentUsed} value={`${formatBytes(p.allocBytes)} of ${formatBytes(p.sizeBytes)}`} />}
                <Button size="sm" onClick={() => setPool(p.name)}>Details and maintenance</Button>
              </Card>
            ))}
          </div>
        </Section>
      )}

      {d.thin.length > 0 && (
        <Section title="Thin pools" hint="A thin pool that fills up stops every machine on it. Metadata runs out first.">
          <div className="grid sm:grid-cols-2 gap-3">{d.thin.map((t) => <Card key={t.name} className="p-4 space-y-2"><span className="font-mono">{t.name}</span>{t.percentUsed !== null && <BarMeter label="Data" pct={t.percentUsed} value={`${t.percentUsed}%`} />}{t.metadataPercent !== null && <BarMeter label="Metadata" pct={t.metadataPercent} value={`${t.metadataPercent}%`} />}</Card>)}</div>
        </Section>
      )}

      <Section title="Storages">
        <div className="grid sm:grid-cols-2 gap-3">{d.storages.map((s) => <Card key={s.storage} className="p-4"><div className="flex items-center justify-between mb-2"><span className="font-mono">{s.storage}</span><Chip>{s.type}</Chip></div><BarMeter label="Used" pct={s.percentUsed} value={`${formatBytes(s.used)} of ${formatBytes(s.total)}`} /></Card>)}</div>
        {d.inactive.length > 0 && <Notice tone="warning" className="mt-3">Not active on this node: {d.inactive.join(", ")}.</Notice>}
      </Section>

      {pool && <PoolModal name={pool} freeDisks={unused} onClose={() => setPool(null)} />}
      {history && <HistoryModal disk={history} onClose={() => setHistory(null)} />}
      {settings && <SettingsModal t={d.thresholds} onClose={() => setSettings(false)} onSaved={() => void qc.invalidateQueries({ queryKey: ["disk-health"] })} />}
    </div>
  );
}

export function StorageHealthPage() {
  const q = useQuery({ queryKey: ["disk-health", "summary"], queryFn: diskHealthApi.summary, refetchInterval: 60_000, retry: 1 });
  return (
    <PageFrame width="6xl">
      <PageHeader title="Storage health" subtitle="Every disk, ZFS pool, thin pool and storage in one place, with alerts before something fills up or wears out." eyebrow={<HeartPulse className="h-4 w-4" />} />
      <LiveOnly><Async q={q}>{(d) => <Body d={d} />}</Async></LiveOnly>
    </PageFrame>
  );
}
