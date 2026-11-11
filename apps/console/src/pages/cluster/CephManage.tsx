import { useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import type { CephInfo } from "../../data/engine/clusterApi.ts";
import { clusterMoreApi } from "../../data/engine/w3Api.ts";
import { call } from "../../data/engine/nodeApi.ts";
import { errorText } from "../../data/engine/queries.ts";
import { formatBytes } from "../../lib/storage.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Card, Chip, Field, Input, Notice, Select, Toggle } from "../../ui/primitives.tsx";
import { Async, TypedConfirm, useTaskRunner } from "../node/common.tsx";
import { CommandBlock, Section, numOrUndef } from "../disks/w3Common.tsx";

/** A destructive Ceph step: the name is typed, and a second box covers what Ceph or arithmetic warned about. */
function Destroy({ title, phrase, warning, action, ackLabel, run, onClose }: { title: string; phrase: string; warning: ReactNode; action: string; ackLabel: string; run: (ack: boolean) => Promise<{ task: string | null }>; onClose: () => void }) {
  const [ack, setAck] = useState(false);
  const t = useTaskRunner();
  return (
    <>
      <TypedConfirm title={title} phrase={phrase} action={action} busy={t.busy} error={t.error} onClose={onClose} onConfirm={() => void t.start(title, async () => ({ task: (await run(ack)).task ?? "" }))}>
        <Notice tone="critical">{warning}</Notice>
        <div className="flex items-center gap-3"><Toggle checked={ack} onChange={setAck} label={ackLabel} /><span className="text-compact">{ackLabel}</span></div>
      </TypedConfirm>
      {t.modal}
    </>
  );
}

function OsdCreate({ node, onClose }: { node?: string; onClose: () => void }) {
  const disks = useQuery({ queryKey: ["disks", "list-for-ceph", node ?? ""], queryFn: () => call<{ disks: { devpath: string; sizeBytes: number; model: string | null; type: string; inUseReason: string | null; usedBy: string | null }[] }>("GET", `/api/disks/list${node ? `?node=${encodeURIComponent(node)}` : ""}`), retry: 0 });
  const [dev, setDev] = useState("");
  const [db, setDb] = useState("");
  const [encrypted, setEncrypted] = useState(false);
  const [cls, setCls] = useState("");
  const [typed, setTyped] = useState("");
  const t = useTaskRunner();
  const free = (disks.data?.disks ?? []).filter((d) => !d.inUseReason && (!d.usedBy || d.usedBy === "unused"));
  const name = dev.replace(/^\/dev\//, "");
  return (
    <Modal title="Create an OSD" subtitle="Gives a whole drive to Ceph" onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" disabled={!dev || typed !== name} loading={t.busy} onClick={() => void t.start("Create OSD", () => clusterMoreApi.createOsd({ node, dev, dbDev: db || undefined, encrypted: encrypted || undefined, deviceClass: cls || undefined, confirm: typed }))}>Erase and create</Button></>}>
      <div className="space-y-4">
        <Notice tone="critical">Everything on the drive you pick is erased.</Notice>
        <Field label="Drive" htmlFor="osd-dev"><Select id="osd-dev" value={dev} onChange={(e) => { setDev(e.target.value); setTyped(""); }}><option value="">Choose a drive…</option>{free.map((d) => <option key={d.devpath} value={d.devpath}>{d.devpath} · {formatBytes(d.sizeBytes)} · {d.model ?? d.type}</option>)}</Select></Field>
        <Field label="Database drive (optional)" hint="A faster drive for the OSD's database" htmlFor="osd-db"><Select id="osd-db" value={db} onChange={(e) => setDb(e.target.value)}><option value="">On the same drive</option>{free.filter((d) => d.devpath !== dev).map((d) => <option key={d.devpath} value={d.devpath}>{d.devpath}</option>)}</Select></Field>
        <Field label="Device class (optional)" hint="ssd, hdd or nvme; Ceph works it out if empty" htmlFor="osd-class"><Input id="osd-class" value={cls} onChange={(e) => setCls(e.target.value)} className="font-mono w-40" /></Field>
        <div className="flex items-center gap-3"><Toggle checked={encrypted} onChange={setEncrypted} label="Encrypt" /><span className="text-compact">Encrypt the drive</span></div>
        {dev && <Field label={<>Type <span className="font-mono text-ink">{name}</span> to confirm</>} htmlFor="osd-typed"><Input id="osd-typed" value={typed} onChange={(e) => setTyped(e.target.value)} className="font-mono" spellCheck={false} autoComplete="off" /></Field>}
        {t.error && <p role="alert" className="text-compact text-critical">{t.error}</p>}
        {t.modal}
      </div>
    </Modal>
  );
}

function DaemonCreate({ kind, node, onClose }: { kind: "mon" | "mgr" | "mds"; node?: string; onClose: () => void }) {
  const [id, setId] = useState("");
  const [address, setAddress] = useState("");
  const [standby, setStandby] = useState(false);
  const t = useTaskRunner();
  const label = kind === "mon" ? "monitor" : kind === "mgr" ? "manager" : "metadata server";
  return (
    <Modal title={`Create a ${label}`} subtitle={`On ${node ?? "this node"}`} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={t.busy} onClick={() => void t.start(`Create ${label}`, () => clusterMoreApi.createDaemon(kind, { node, id: id || undefined, address: address || undefined, hotStandby: standby || undefined }))}>Create</Button></>}>
      <div className="space-y-4">
        <Field label="Name (optional)" hint="Defaults to the node's name" htmlFor="dm-id"><Input id="dm-id" value={id} onChange={(e) => setId(e.target.value)} className="font-mono" /></Field>
        {kind === "mon" && <Field label="Address (optional)" hint="Only to override the detected one; in Ceph's public network" htmlFor="dm-addr"><Input id="dm-addr" value={address} onChange={(e) => setAddress(e.target.value)} className="font-mono" /></Field>}
        {kind === "mds" && <div className="flex items-center gap-3"><Toggle checked={standby} onChange={setStandby} label="Hot standby" /><span className="text-compact">Follow the active server so a takeover is fast</span></div>}
        {t.error && <p role="alert" className="text-compact text-critical">{t.error}</p>}
        {t.modal}
      </div>
    </Modal>
  );
}

function FsCreate({ node, onClose }: { node?: string; onClose: () => void }) {
  const [name, setName] = useState("cephfs");
  const [pg, setPg] = useState("");
  const [storage, setStorage] = useState(true);
  const t = useTaskRunner();
  return (
    <Modal title="Create a file system" subtitle="CephFS needs a metadata server" onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={t.busy} disabled={!name} onClick={() => void t.start("Create CephFS", () => clusterMoreApi.createFs({ node, name, pgNum: numOrUndef(pg), addStorage: storage }))}>Create</Button></>}>
      <div className="space-y-4">
        <Field label="Name" htmlFor="fs-name"><Input id="fs-name" value={name} onChange={(e) => setName(e.target.value)} className="font-mono" /></Field>
        <Field label="Placement groups (optional)" hint="8 to 32768" htmlFor="fs-pg"><Input id="fs-pg" type="number" value={pg} onChange={(e) => setPg(e.target.value)} className="tabular-nums w-40" /></Field>
        <div className="flex items-center gap-3"><Toggle checked={storage} onChange={setStorage} label="Add as storage" /><span className="text-compact">Add it as a storage so machines and backups can use it</span></div>
        {t.error && <p role="alert" className="text-compact text-critical">{t.error}</p>}
        {t.modal}
      </div>
    </Modal>
  );
}

type Dialog =
  | { kind: "osd-create" }
  | { kind: "daemon-create"; daemon: "mon" | "mgr" | "mds" }
  | { kind: "fs-create" }
  | { kind: "osd-destroy"; id: number }
  | { kind: "pool-delete"; name: string; used: number | null }
  | { kind: "daemon-destroy"; daemon: "mon" | "mgr" | "mds"; id: string }
  | { kind: "fs-destroy"; name: string }
  | { kind: "service"; action: "stop" | "restart"; service: string };

export function CephManage({ c, node }: { c: CephInfo; node?: string }) {
  const [d, setD] = useState<Dialog | null>(null);
  const [removePools, setRemovePools] = useState(false);
  const crush = useQuery({ queryKey: ["cluster", "ceph-crush", node ?? ""], queryFn: () => clusterMoreApi.cephCrush(node), retry: 0 });
  const start = useMutation({ mutationFn: (service: string) => clusterMoreApi.cephService("start", service, { node }) });
  const close = () => setD(null);
  const row = (children: ReactNode) => <li className="py-2.5 flex items-center gap-3 flex-wrap justify-between">{children}</li>;
  const down = (c.osds ?? []).filter((o) => o.status !== "up" && o.in === false);
  return (
    <div className="space-y-6">
      <Notice tone="info">These steps change what the cluster stores. Each one asks Ceph whether it is safe, and wants the name typed. Watch the Overview for health while data moves.</Notice>

      <Section title="OSDs" hint="One per drive. Taking one out, then stopping it, is the way to retire it; only then can it be destroyed." actions={<Button size="sm" variant="primary" onClick={() => setD({ kind: "osd-create" })}><Plus className="h-4 w-4" />Create OSD…</Button>}>
        <Card className="px-4"><ul className="divide-y divide-line">
          {(c.osds ?? []).map((o) => row(<><span className="font-mono">{o.name}<span className="text-ink-3 text-xs ml-2">{o.host}</span></span><span className="flex gap-2 items-center"><Chip tone={o.status === "up" ? "good" : "critical"}>{o.status}</Chip>{o.in === false && <Chip tone="warning">out</Chip>}<Button size="sm" variant="ghost" disabled={o.status === "up" || o.in !== false} title={o.status === "up" || o.in !== false ? "Take it out and stop it first" : undefined} onClick={() => setD({ kind: "osd-destroy", id: o.id })}>Destroy…</Button></span></>))}
          {(c.osds ?? []).length === 0 && <li className="py-3 text-compact text-ink-3">No OSDs yet.</li>}
        </ul></Card>
        {down.length > 0 && <p className="text-xs text-ink-3">{down.map((o) => o.name).join(", ")} can be destroyed.</p>}
      </Section>

      <Section title="Monitors, managers and metadata servers" hint="Keep an odd number of monitors (3 or 5). Ceph stops if most of them are lost.">
        {([["mon", "Monitors", c.monitors ?? []], ["mgr", "Managers", c.managers ?? []], ["mds", "Metadata servers", c.metadataServers ?? []]] as const).map(([kind, title, rows]) => (
          <Card key={kind} className="px-4 py-3 mb-3">
            <div className="flex items-center justify-between mb-1"><span className="font-medium text-compact">{title}</span><Button size="sm" onClick={() => setD({ kind: "daemon-create", daemon: kind })}><Plus className="h-4 w-4" />Create…</Button></div>
            <ul className="divide-y divide-line">{(rows as { name: string; state: string | null }[]).map((r) => row(<><span className="font-mono">{r.name}<Chip className="ml-2">{r.state ?? "unknown"}</Chip></span><Button size="sm" variant="ghost" onClick={() => setD({ kind: "daemon-destroy", daemon: kind, id: r.name })}>Destroy…</Button></>))}{rows.length === 0 && <li className="py-2 text-compact text-ink-3">None.</li>}</ul>
          </Card>
        ))}
      </Section>

      <Section title="Pools" hint="Deleting a pool destroys everything stored in it." >
        <Card className="px-4"><ul className="divide-y divide-line">{(c.pools ?? []).map((p) => row(<><span className="font-mono">{p.name}<span className="text-ink-3 text-xs ml-2">{p.used !== null ? formatBytes(p.used) : ""}</span></span><Button size="sm" variant="ghost" onClick={() => setD({ kind: "pool-delete", name: p.name, used: p.used })}>Delete…</Button></>))}{(c.pools ?? []).length === 0 && <li className="py-3 text-compact text-ink-3">No pools.</li>}</ul></Card>
      </Section>

      <Section title="CephFS" actions={<Button size="sm" onClick={() => setD({ kind: "fs-create" })}><Plus className="h-4 w-4" />Create file system…</Button>}>
        <Card className="px-4"><ul className="divide-y divide-line">{(c.filesystems ?? []).map((f) => row(<><span className="font-mono">{f.name}<span className="text-ink-3 text-xs ml-2">data {f.dataPool ?? "?"}</span></span><Button size="sm" variant="ghost" onClick={() => setD({ kind: "fs-destroy", name: f.name })}>Destroy…</Button></>))}{(c.filesystems ?? []).length === 0 && <li className="py-3 text-compact text-ink-3">No file systems.</li>}</ul></Card>
      </Section>

      <Section title="Services on this node" hint="Start is safe. Stop and restart interrupt storage for a moment and ask Ceph first.">
        <Card className="px-4"><ul className="divide-y divide-line">
          {["ceph.target", ...(c.osds ?? []).filter((o) => o.host === c.node).map((o) => o.name), ...(c.monitors ?? []).filter((m) => m.host === c.node).map((m) => `mon.${m.name}`), ...(c.managers ?? []).filter((m) => m.host === c.node).map((m) => `mgr.${m.name}`), ...(c.metadataServers ?? []).filter((m) => m.host === c.node).map((m) => `mds.${m.name}`)].map((s) => row(
            <><span className="font-mono">{s}</span><span className="flex gap-1.5"><Button size="sm" variant="ghost" loading={start.isPending && start.variables === s} onClick={() => start.mutate(s)}>Start</Button><Button size="sm" variant="ghost" onClick={() => setD({ kind: "service", action: "restart", service: s })}>Restart…</Button><Button size="sm" variant="ghost" onClick={() => setD({ kind: "service", action: "stop", service: s })}>Stop…</Button></span></>,
          ))}
        </ul></Card>
        {start.error && <p role="alert" className="text-compact text-critical mt-2">{errorText(start.error)}</p>}
        {start.isSuccess && <p className="text-compact text-ink-3 mt-2">Start requested.</p>}
      </Section>

      <Section title="CRUSH map" hint="How Ceph decides where copies go. Read only here; changes are made with ceph osd crush commands.">
        <Async q={crush}>{(m) => m.denied ? <Notice tone="info">Your Proxmox account can't read the CRUSH map.</Notice> : (
          <div className="space-y-3">
            {m.summary && <Card className="p-4"><dl className="grid sm:grid-cols-3 gap-3 text-compact"><div><dt className="text-xs text-ink-3">Devices</dt><dd className="tabular-nums">{m.summary.devices}</dd></div><div><dt className="text-xs text-ink-3">Buckets</dt><dd className="tabular-nums">{m.summary.buckets}</dd></div><div><dt className="text-xs text-ink-3">Rules</dt><dd className="tabular-nums">{m.summary.rules.length}</dd></div></dl>
              {m.summary.rules.map((r) => <div key={r.name} className="mt-3"><div className="font-mono text-compact">{r.name} <span className="text-ink-3 text-xs">{r.type}</span></div><ol className="list-decimal pl-5 text-xs text-ink-2">{r.steps.map((s) => <li key={s}>{s}</li>)}</ol></div>)}</Card>}
            {m.text && <pre aria-label="CRUSH map" className="rounded-lg bg-code border border-line p-3 text-xs font-mono text-ink-2 max-h-72 overflow-auto whitespace-pre-wrap break-all">{m.text}</pre>}
          </div>
        )}</Async>
      </Section>

      {d?.kind === "osd-create" && <OsdCreate node={node} onClose={close} />}
      {d?.kind === "daemon-create" && <DaemonCreate kind={d.daemon} node={node} onClose={close} />}
      {d?.kind === "fs-create" && <FsCreate node={node} onClose={close} />}
      {d?.kind === "osd-destroy" && <Destroy title={`Destroy osd.${d.id}?`} phrase={`osd.${d.id}`} action="Destroy OSD" ackLabel="Destroy even if Ceph says it is not safe" warning="The OSD and its place in the cluster are removed. Its drive can then be reused. If Ceph hasn't finished moving its data elsewhere, copies are lost." run={(ack) => clusterMoreApi.destroyOsd(d.id, { node, acknowledgeUnsafe: ack || undefined, cleanup: true })} onClose={close} />}
      {d?.kind === "pool-delete" && <Destroy title={`Delete the pool ${d.name}?`} phrase={d.name} action="Delete pool" ackLabel={d.used ? `Yes, destroy the ${formatBytes(d.used)} stored in it` : "Yes, destroy what it holds"} warning="Every machine disk and file in the pool is destroyed for good. There is no undo." run={(ack) => clusterMoreApi.deletePool(d.name, { node, acknowledgeData: ack || undefined, removeStorages: true })} onClose={close} />}
      {d?.kind === "daemon-destroy" && <Destroy title={`Remove ${d.daemon}.${d.id}?`} phrase={`${d.daemon}.${d.id}`} action="Remove" ackLabel="Remove even if Ceph warns" warning={d.daemon === "mon" ? "Ceph needs a majority of its monitors. Removing one is refused if too few would be left." : d.daemon === "mgr" ? "Statistics and the dashboard stop until another manager exists." : "A file system loses a server for its metadata."} run={(ack) => clusterMoreApi.destroyDaemon(d.daemon, d.id, { node, acknowledgeUnsafe: ack || undefined })} onClose={close} />}
      {d?.kind === "fs-destroy" && (
        <Destroy title={`Destroy the file system ${d.name}?`} phrase={d.name} action="Destroy" ackLabel="Also delete its pools (destroys the files)" warning={<>The file system is removed.<div className="mt-2 flex items-center gap-3"><Toggle checked={removePools} onChange={setRemovePools} label="Remove pools" /><span>Also remove its pools and storage entries</span></div></>} run={(ack) => clusterMoreApi.destroyFs(d.name, { node, removePools: removePools || undefined, removeStorages: removePools || undefined, acknowledgeData: ack || undefined })} onClose={close} />
      )}
      {d?.kind === "service" && <Destroy title={`${d.action === "stop" ? "Stop" : "Restart"} ${d.service}?`} phrase={d.service} action={d.action === "stop" ? "Stop" : "Restart"} ackLabel="Go ahead even if Ceph says it is not safe" warning={d.action === "stop" ? "Storage served by this daemon is interrupted until it is started again." : "Storage served by this daemon pauses for a moment."} run={(ack) => clusterMoreApi.cephService(d.action, d.service, { node, acknowledgeUnsafe: ack || undefined })} onClose={close} />}
    </div>
  );
}

/** Shown where Ceph isn't set up: the install command, then the first configuration. */
export function CephSetupCard({ node }: { node?: string }) {
  const q = useQuery({ queryKey: ["cluster", "ceph-setup", node ?? ""], queryFn: () => clusterMoreApi.cephSetup(node), retry: 0 });
  const [network, setNetwork] = useState("");
  const [cluster, setCluster] = useState("");
  const [typed, setTyped] = useState("");
  const init = useMutation({ mutationFn: () => clusterMoreApi.cephInit({ node, network: network || undefined, clusterNetwork: cluster || undefined, confirm: typed }) });
  return (
    <Async q={q}>
      {(s) => (
        <Card className="p-5 space-y-4 mt-4">
          <div className="font-medium">Set Ceph up</div>
          <p className="text-compact text-ink-2">Installing the packages is a shell step in Proxmox too. Run this on {s.node}, then come back for the first configuration.</p>
          <CommandBlock command={s.installCommand} />
          {s.releases.length > 0 && <p className="text-xs text-ink-3">Releases this node can install: {s.releases.map((r) => r.name).join(", ")}.</p>}
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Public network" hint="Like 10.0.0.0/24" htmlFor="ci-net"><Input id="ci-net" value={network} onChange={(e) => setNetwork(e.target.value)} className="font-mono" /></Field>
            <Field label="Cluster network (optional)" hint="Separate traffic for replication" htmlFor="ci-cnet"><Input id="ci-cnet" value={cluster} onChange={(e) => setCluster(e.target.value)} className="font-mono" /></Field>
          </div>
          <Field label={<>Type <span className="font-mono text-ink">ceph</span> to write the configuration</>} htmlFor="ci-typed"><Input id="ci-typed" value={typed} onChange={(e) => setTyped(e.target.value)} className="font-mono w-40" /></Field>
          <Button variant="primary" disabled={typed !== "ceph" || !network} loading={init.isPending} onClick={() => init.mutate()}>Write configuration</Button>
          {init.isSuccess && <Notice tone="good">Configuration written. Create the first monitor and manager under Manage.</Notice>}
          {init.error && <p role="alert" className="text-compact text-critical">{errorText(init.error)}</p>}
        </Card>
      )}
    </Async>
  );
}
