import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Database, Plus } from "lucide-react";
import { clusterApi, type CephInfo } from "../../data/engine/clusterApi.ts";
import { errorText } from "../../data/engine/queries.ts";
import { formatBytes } from "../../lib/storage.ts";
import { Modal } from "../../ui/Modal.tsx";
import { BarMeter } from "../../ui/meters.tsx";
import { Button, Card, Chip, EmptyState, Field, Input, Notice, PageFrame, PageHeader, Select, Status, Tabs, Toggle, type StatusKind } from "../../ui/primitives.tsx";
import { Async, LiveOnly, NodeSwitcher, TypedConfirm, useNodeName } from "../node/common.tsx";
import { CephManage, CephSetupCard } from "./CephManage.tsx";

type Tab = "overview" | "services" | "osds" | "pools" | "config" | "manage";
const HEALTH: Record<string, { kind: StatusKind; label: string }> = { HEALTH_OK: { kind: "good", label: "Healthy" }, HEALTH_WARN: { kind: "warning", label: "Warning" }, HEALTH_ERR: { kind: "critical", label: "Error" } };
const num = (n: number | null | undefined) => (n === null || n === undefined ? "–" : n.toLocaleString());
const rate = (n: number | null | undefined) => (n === null || n === undefined ? "–" : `${formatBytes(n)}/s`);

function PoolModal({ node, onClose, onDone }: { node?: string; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const [size, setSize] = useState("3");
  const [minSize, setMinSize] = useState("2");
  const [autoscale, setAutoscale] = useState("on");
  const [application, setApplication] = useState("rbd");
  const [addStorages, setAddStorages] = useState(true);
  const save = useMutation({ mutationFn: () => clusterApi.createCephPool({ node, name, size: Number(size), minSize: Number(minSize), autoscale, application, addStorages }), onSuccess: () => { onDone(); onClose(); } });
  return (
    <Modal title="Create a pool" subtitle="A pool stores machine disks in Ceph." onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(name)} loading={save.isPending} onClick={() => save.mutate()}>Create pool</Button></>}>
      <div className="space-y-5">
        <Field label="Name" htmlFor="cp-name"><Input id="cp-name" value={name} onChange={(e) => setName(e.target.value)} className="font-mono" autoFocus spellCheck={false} /></Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Copies" hint="Each object is kept this many times. At least 2." htmlFor="cp-size"><Input id="cp-size" type="number" min={2} max={7} value={size} onChange={(e) => setSize(e.target.value)} className="tabular-nums" /></Field>
          <Field label="Minimum copies" hint="Fewer than this and the pool stops taking writes." htmlFor="cp-min"><Input id="cp-min" type="number" min={1} max={7} value={minSize} onChange={(e) => setMinSize(e.target.value)} className="tabular-nums" /></Field>
        </div>
        <Field label="Placement group autoscaling" htmlFor="cp-auto"><Select id="cp-auto" value={autoscale} onChange={(e) => setAutoscale(e.target.value)}><option value="on">On</option><option value="warn">Warn only</option><option value="off">Off</option></Select></Field>
        <Field label="Used for" htmlFor="cp-app"><Select id="cp-app" value={application} onChange={(e) => setApplication(e.target.value)}><option value="rbd">Machine disks (RBD)</option><option value="cephfs">CephFS</option><option value="rgw">Object storage</option></Select></Field>
        <div className="flex items-center gap-3"><Toggle checked={addStorages} onChange={setAddStorages} label="Add as storage" /><span className="text-compact text-ink-2">Add it as a storage so machines can use it</span></div>
        {save.error && <p role="alert" className="text-compact text-critical">{errorText(save.error)}</p>}
      </div>
    </Modal>
  );
}

function Body({ c, node }: { c: CephInfo; node?: string }) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ["cluster", "ceph"] });
  const [tab, setTab] = useState<Tab>("overview");
  const [outOsd, setOutOsd] = useState<number | null>(null);
  const [pause, setPause] = useState(false);
  const [pool, setPool] = useState(false);
  const cfg = useQuery({ queryKey: ["cluster", "ceph-config", node ?? ""], queryFn: () => clusterApi.cephConfig(node), enabled: tab === "config", retry: 0 });
  const osd = useMutation({ mutationFn: (v: { id: number; action: "in" | "out" | "scrub"; deep?: boolean; confirm?: string }) => clusterApi.cephOsd(v.id, v.action, { node, deep: v.deep, confirm: v.confirm }), onSuccess: () => { setOutOsd(null); void refresh(); } });
  const flag = useMutation({ mutationFn: (v: { flag: string; value: boolean; confirm?: string }) => clusterApi.cephFlag(v.flag, v.value, v.confirm), onSuccess: () => { setPause(false); void refresh(); } });
  const mute = useMutation({ mutationFn: (v: { code: string; value: boolean }) => clusterApi.cephMute(v.code, v.value, v.value ? "1d" : undefined), onSuccess: () => void refresh() });
  if (c.denied) return <Notice tone="info">Your Proxmox account can't read Ceph (it needs Sys.Audit or Datastore.Audit).</Notice>;
  if (!c.installed || !c.status) {
    return <><EmptyState icon={<Database className="h-5 w-5" />} title="Ceph isn't set up on this cluster" body="Ceph spreads machine disks over the drives of several nodes. Install it on a node, write its first configuration, then add monitors, managers and OSDs; this screen then shows its health and manages it. Nothing here needs it." /><CephSetupCard node={node} /></>;
  }
  const s = c.status;
  const h = HEALTH[s.health] ?? { kind: "idle" as StatusKind, label: s.health };
  const err = osd.error ?? flag.error ?? mute.error;
  return (
    <div className="space-y-5">
      {err && <Notice tone="critical" title="Proxmox didn't do that">{errorText(err)}</Notice>}
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[{ id: "overview", label: "Overview" }, { id: "services", label: "Services" }, { id: "osds", label: "OSDs", count: c.osds?.length }, { id: "pools", label: "Pools", count: c.pools?.length }, { id: "config", label: "Configuration" }, { id: "manage", label: "Manage" }]} />

      {tab === "overview" && (
        <div className="space-y-4">
          <Card className="p-5">
            <dl className="grid sm:grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-3 text-compact">
              <div><dt className="text-xs text-ink-3">Health</dt><dd><Status kind={h.kind} label={h.label} /></dd></div>
              <div><dt className="text-xs text-ink-3">Monitors in quorum</dt><dd className="tabular-nums">{s.monitors.quorum.length} of {num(s.monitors.total)}</dd></div>
              <div><dt className="text-xs text-ink-3">OSDs up and in</dt><dd className="tabular-nums">{num(s.osds.up)} up, {num(s.osds.in)} in of {num(s.osds.total)}</dd></div>
              <div><dt className="text-xs text-ink-3">Placement groups</dt><dd className="tabular-nums">{num(s.pgs.total)}{s.pgs.states.length ? ` · ${s.pgs.states.map((x) => `${x.count} ${x.state}`).join(", ")}` : ""}</dd></div>
            </dl>
            {s.usage.total ? <div className="mt-4 max-w-md"><BarMeter label="Capacity" pct={((s.usage.used ?? 0) / s.usage.total) * 100} value={`${formatBytes(s.usage.used ?? 0)} of ${formatBytes(s.usage.total)}`} /></div> : null}
            <dl className="grid sm:grid-cols-4 gap-x-6 gap-y-2 text-compact mt-4">
              <div><dt className="text-xs text-ink-3">Read</dt><dd className="tabular-nums">{rate(s.io.readBytes)} · {num(s.io.readOps)} ops/s</dd></div>
              <div><dt className="text-xs text-ink-3">Write</dt><dd className="tabular-nums">{rate(s.io.writeBytes)} · {num(s.io.writeOps)} ops/s</dd></div>
            </dl>
          </Card>
          {s.checks.length > 0 && (
            <Card className="p-5">
              <div className="font-medium mb-2">Health warnings</div>
              <ul className="divide-y divide-line">
                {s.checks.map((k) => (
                  <li key={k.code} className="py-2.5 flex items-start gap-3">
                    <Status kind={k.severity === "HEALTH_ERR" ? "critical" : "warning"} label={k.severity === "HEALTH_ERR" ? "Error" : "Warning"} />
                    <div className="min-w-0 flex-1"><div className="font-mono text-xs text-ink-3">{k.code}{k.muted && " · muted"}</div><div className="text-compact">{k.message}</div></div>
                    <Button size="sm" variant="ghost" loading={mute.isPending && mute.variables?.code === k.code} onClick={() => mute.mutate({ code: k.code, value: !k.muted })}>{k.muted ? "Unmute" : "Mute for a day"}</Button>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Card className="p-5">
            <div className="font-medium">Cluster flags</div>
            <p className="text-compact text-ink-3 mt-0.5 mb-3">Temporary switches for maintenance. A flag left on shows as a warning above. Setting one is undone by clearing it.</p>
            <ul className="grid sm:grid-cols-2 gap-x-6 gap-y-2">
              {(c.flags ?? []).map((f) => (
                <li key={f.name} className="flex items-center gap-3"><Toggle checked={f.value} label={f.name} onChange={(v) => (f.name === "pause" && v ? setPause(true) : flag.mutate({ flag: f.name, value: v }))} /><span className="font-mono text-compact">{f.name}</span></li>
              ))}
            </ul>
          </Card>
        </div>
      )}

      {tab === "services" && (
        <div className="space-y-4">
          {[["Monitors", c.monitors ?? []], ["Managers", c.managers ?? []], ["Metadata servers", c.metadataServers ?? []]].map(([title, rows]) => (
            <Card key={title as string} className="overflow-x-auto edge-fade-x">
              <div className="px-4 pt-3 font-medium">{title as string}</div>
              {(rows as { name: string; host: string | null; addr: string | null; state: string | null }[]).length === 0 ? <p className="px-4 py-3 text-compact text-ink-3">None on this cluster.</p> : (
                <table className="w-full text-compact min-w-[480px]"><tbody>
                  {(rows as { name: string; host: string | null; addr: string | null; state: string | null; version?: string | null }[]).map((r) => (
                    <tr key={r.name} className="border-t border-line first:border-0"><td className="px-4 py-2.5 font-mono">{r.name}</td><td className="px-3 font-mono text-xs text-ink-2">{r.addr ?? "–"}</td><td className="px-3"><Chip>{r.state ?? "unknown"}</Chip></td><td className="px-3 text-xs text-ink-3">{r.version ? `Ceph ${r.version}` : ""}</td></tr>
                  ))}
                </tbody></table>
              )}
            </Card>
          ))}
          {(c.filesystems ?? []).length > 0 && <Card className="p-5"><div className="font-medium mb-2">CephFS</div><ul className="text-compact">{c.filesystems!.map((f) => <li key={f.name}><span className="font-mono">{f.name}</span> <span className="text-ink-3">data {f.dataPool ?? "?"}, metadata {f.metadataPool ?? "?"}</span></li>)}</ul></Card>}
          <p className="text-xs text-ink-3">Add or remove them under Manage.</p>
        </div>
      )}

      {tab === "osds" && (
        <Card className="overflow-x-auto edge-fade-x">
          <table className="w-full text-compact min-w-[760px]">
            <thead><tr className="border-b border-line text-ink-3 text-left"><th className="font-normal px-4 h-10">OSD</th><th className="font-normal px-3">Host</th><th className="font-normal px-3">State</th><th className="font-normal px-3">Class</th><th className="font-normal px-3">Used</th><th className="font-normal px-3">PGs</th><th className="px-3"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {(c.osds ?? []).map((o) => (
                <tr key={o.id} className="border-b border-line last:border-0">
                  <td className="px-4 py-3 font-mono">{o.name}</td>
                  <td className="px-3 font-mono">{o.host ?? "–"}</td>
                  <td className="px-3"><div className="flex gap-2 flex-wrap"><Status kind={o.status === "up" ? "good" : "critical"} label={o.status === "up" ? "Up" : "Down"} />{o.in === false && <Chip tone="warning">Out</Chip>}</div></td>
                  <td className="px-3">{o.deviceClass ?? "–"}</td>
                  <td className="px-3 tabular-nums">{o.used !== null && o.total ? `${formatBytes(o.used)} of ${formatBytes(o.total)}` : "–"}</td>
                  <td className="px-3 tabular-nums">{num(o.pgs)}</td>
                  <td className="px-3"><div className="flex gap-1.5 justify-end">
                    {o.in === false ? <Button size="sm" onClick={() => osd.mutate({ id: o.id, action: "in" })}>Bring in</Button> : <Button size="sm" variant="ghost" onClick={() => setOutOsd(o.id)}>Take out…</Button>}
                    <Button size="sm" variant="ghost" onClick={() => osd.mutate({ id: o.id, action: "scrub" })}>Scrub</Button>
                    <Button size="sm" variant="ghost" onClick={() => osd.mutate({ id: o.id, action: "scrub", deep: true })}>Deep scrub</Button>
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-ink-3 px-4 py-3">Create and destroy OSDs under Manage.</p>
        </Card>
      )}

      {tab === "pools" && (
        <>
          <div><Button variant="primary" onClick={() => setPool(true)}><Plus className="h-4 w-4" />Create pool…</Button></div>
          <Card className="overflow-x-auto edge-fade-x">
            <table className="w-full text-compact min-w-[640px]">
              <thead><tr className="border-b border-line text-ink-3 text-left"><th className="font-normal px-4 h-10">Pool</th><th className="font-normal px-3">Copies</th><th className="font-normal px-3">Min</th><th className="font-normal px-3">PGs</th><th className="font-normal px-3">Autoscale</th><th className="font-normal px-3">Used for</th><th className="font-normal px-3">Used</th></tr></thead>
              <tbody>{(c.pools ?? []).map((p) => <tr key={p.name} className="border-b border-line last:border-0"><td className="px-4 py-3 font-mono">{p.name}</td><td className="px-3 tabular-nums">{num(p.size)}</td><td className="px-3 tabular-nums">{num(p.minSize)}</td><td className="px-3 tabular-nums">{num(p.pgNum)}</td><td className="px-3">{p.autoscale ?? "–"}</td><td className="px-3">{p.application ?? "–"}</td><td className="px-3 tabular-nums">{p.used !== null ? formatBytes(p.used) : "–"}</td></tr>)}</tbody>
            </table>
            {!(c.pools ?? []).length && <p className="px-4 py-3 text-compact text-ink-3">No pools yet.</p>}
          </Card>
          <p className="text-xs text-ink-3">Deleting a pool destroys its data; it is under Manage and needs the name typed.</p>
        </>
      )}

      {tab === "manage" && <CephManage c={c} node={node} />}

      {tab === "config" && (
        <Async q={cfg}>
          {(d) => (
            <div className="space-y-4">
              {d.denied && <Notice tone="info">Your Proxmox account can't read the Ceph configuration.</Notice>}
              {d.config && <Card className="p-5"><div className="font-medium mb-2">ceph.conf</div><pre aria-label="Ceph configuration" className="rounded-lg bg-code border border-line p-3 text-xs font-mono text-ink-2 max-h-72 overflow-auto whitespace-pre-wrap break-all">{d.config}</pre></Card>}
              <Card className="p-5"><div className="font-medium mb-2">Placement rules</div>{d.rules.length ? <ul className="text-compact font-mono">{d.rules.map((r) => <li key={r.name}>{r.name}</li>)}</ul> : <p className="text-compact text-ink-3">None reported.</p>}</Card>
              <Card className="p-5"><div className="font-medium mb-2">Recent log</div><pre aria-label="Ceph log" className="rounded-lg bg-code border border-line p-3 text-xs font-mono text-ink-2 max-h-64 overflow-auto whitespace-pre-wrap break-all">{d.log.length ? d.log.join("\n") : "(empty)"}</pre></Card>
            </div>
          )}
        </Async>
      )}

      {outOsd !== null && (
        <TypedConfirm title={`Take osd.${outOsd} out?`} subtitle="Its data starts moving to the other OSDs" phrase={`osd.${outOsd}`} action="Take out" busy={osd.isPending} error={osd.error ? errorText(osd.error) : null} onClose={() => setOutOsd(null)} onConfirm={() => osd.mutate({ id: outOsd, action: "out", confirm: `osd.${outOsd}` })}>
          <Notice tone="warning">Ceph copies everything on this OSD elsewhere, which loads the network and drives and can take hours. Bring it back in to stop. Make sure the rest have room.</Notice>
        </TypedConfirm>
      )}
      {pause && (
        <TypedConfirm title="Pause all reads and writes?" phrase="pause" action="Pause Ceph" busy={flag.isPending} error={flag.error ? errorText(flag.error) : null} onClose={() => setPause(false)} onConfirm={() => flag.mutate({ flag: "pause", value: true, confirm: "pause" })}>
          <Notice tone="critical">Every machine using Ceph stops being able to read or write its disk until you clear this flag.</Notice>
        </TypedConfirm>
      )}
      {pool && <PoolModal node={node} onClose={() => setPool(false)} onDone={() => void refresh()} />}
    </div>
  );
}

export function CephPage() {
  const { node, name } = useNodeName();
  const q = useQuery({ queryKey: ["cluster", "ceph", name], queryFn: () => clusterApi.ceph(node), refetchInterval: 15_000, retry: 1 });
  return (
    <PageFrame width="6xl">
      <PageHeader title="Ceph" subtitle="Storage spread over the drives of several nodes: its health, services, drives and pools." actions={<NodeSwitcher />} />
      <LiveOnly><Async q={q}>{(c) => <Body c={c} node={node} />}</Async></LiveOnly>
    </PageFrame>
  );
}
