import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Wrench } from "lucide-react";
import { call, enc } from "../../data/engine/nodeApi.ts";
import { storageToolsApi, type PruneKeep } from "../../data/engine/w3Api.ts";
import { errorText } from "../../data/engine/queries.ts";
import { formatBytes } from "../../lib/storage.ts";
import { Modal } from "../../ui/Modal.tsx";
import { BarMeter } from "../../ui/meters.tsx";
import { Button, Card, Chip, Field, Input, Notice, Select, Tabs } from "../../ui/primitives.tsx";
import { Async, TypedConfirm, useTaskRunner } from "../node/common.tsx";
import { CommandBlock, numOrUndef, Section } from "../disks/w3Common.tsx";

type Tab = "usage" | "retention" | "create" | "import" | "snippets" | "check";

function Usage({ id }: { id: string }) {
  const q = useQuery({ queryKey: ["storage-tools", "usage", id], queryFn: () => storageToolsApi.usage(id), retry: 0 });
  const [frame, setFrame] = useState("day");
  const rrd = useQuery({ queryKey: ["storage-tools", "rrd", id, frame], queryFn: () => storageToolsApi.rrd(id, frame), retry: 0 });
  return (
    <Async q={q}>
      {(u) => (
        <div className="space-y-5">
          {u.percent !== null && u.total !== null && <BarMeter label={`${formatBytes(Math.max(0, (u.total ?? 0) - (u.used ?? 0)))} free`} pct={u.percent} value={`${formatBytes(u.used ?? 0)} of ${formatBytes(u.total)}`} />}
          <Section title="What fills it" hint="Space by kind of content. “Other” is what the storage uses beyond its volumes: metadata, snapshots, reserved space.">
            <ul className="space-y-2">
              {u.byType.map((t) => <li key={t.content}><BarMeter label={`${t.label} · ${t.count}`} pct={u.total ? (t.bytes / u.total) * 100 : 0} value={formatBytes(t.bytes)} /></li>)}
              {u.other !== null && u.other > 0 && <li><BarMeter label="Other" pct={u.total ? (u.other / u.total) * 100 : 0} value={formatBytes(u.other)} /></li>}
            </ul>
          </Section>
          {u.byGuest.length > 0 && (
            <Section title="By machine">
              <Card className="overflow-x-auto edge-fade-x"><table className="w-full text-compact min-w-[360px]"><tbody>{u.byGuest.map((g) => <tr key={g.vmid} className="border-b border-line last:border-0"><td className="px-4 py-2 font-mono">{g.vmid}</td><td className="px-3 tabular-nums">{g.count} volume{g.count === 1 ? "" : "s"}</td><td className="px-3 tabular-nums">{formatBytes(g.bytes)}</td></tr>)}</tbody></table></Card>
            </Section>
          )}
          {u.largest.length > 0 && (
            <Section title="Largest files">
              <ul className="text-compact divide-y divide-line">{u.largest.map((l) => <li key={l.volid} className="py-1.5 flex justify-between gap-3"><span className="font-mono text-xs break-all">{l.volid}</span><span className="tabular-nums shrink-0">{formatBytes(l.size)}</span></li>)}</ul>
            </Section>
          )}
          <Section title="Over time" actions={<Select aria-label="Time frame" value={frame} onChange={(e) => setFrame(e.target.value)} className="w-32"><option value="hour">Hour</option><option value="day">Day</option><option value="week">Week</option><option value="month">Month</option><option value="year">Year</option></Select>}>
            {rrd.data && rrd.data.points.length > 1 ? <UsageLine points={rrd.data.points} /> : <p className="text-compact text-ink-3">{rrd.isPending ? "Loading…" : "No history for this period."}</p>}
          </Section>
        </div>
      )}
    </Async>
  );
}

/** A plain line of used space over time, drawn as SVG so nothing is loaded from elsewhere. */
function UsageLine({ points }: { points: { time: number; used: number | null; total: number | null }[] }) {
  const pts = points.filter((p) => p.used !== null);
  const max = Math.max(...pts.map((p) => p.total ?? p.used ?? 0), 1);
  const t0 = pts[0].time;
  const span = Math.max(1, pts[pts.length - 1].time - t0);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${(((p.time - t0) / span) * 100).toFixed(2)},${(100 - ((p.used ?? 0) / max) * 100).toFixed(2)}`).join(" ");
  return (
    <div>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Used space over time" className="w-full h-28 rounded-lg bg-surface-2 border border-line"><path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" className="text-accent" /></svg>
      <div className="flex justify-between text-xs text-ink-3 mt-1"><span>{new Date(pts[0].time * 1000).toLocaleString()}</span><span>{formatBytes(pts[pts.length - 1].used ?? 0)} used now</span></div>
    </div>
  );
}

function Retention({ id }: { id: string }) {
  const [keep, setKeep] = useState({ keepLast: "", keepDaily: "", keepWeekly: "", keepMonthly: "", keepYearly: "" });
  const [vmid, setVmid] = useState("");
  const [armed, setArmed] = useState(false);
  const body = (): PruneKeep => ({ keepLast: numOrUndef(keep.keepLast), keepDaily: numOrUndef(keep.keepDaily), keepWeekly: numOrUndef(keep.keepWeekly), keepMonthly: numOrUndef(keep.keepMonthly), keepYearly: numOrUndef(keep.keepYearly) });
  const preview = useMutation({ mutationFn: () => storageToolsApi.prunePreview(id, body(), numOrUndef(vmid)) });
  const run = useTaskRunner(() => preview.mutate());
  const set = (k: keyof typeof keep, label: string) => <Field label={label} htmlFor={`pr-${k}`}><Input id={`pr-${k}`} type="number" min={1} value={keep[k]} onChange={(e) => { setKeep({ ...keep, [k]: e.target.value }); preview.reset(); }} className="tabular-nums" /></Field>;
  const p = preview.data;
  return (
    <div className="space-y-4">
      <p className="text-compact text-ink-2">Choose how many backups to keep, see exactly which ones would go, then prune. Leave every number empty to use the retention set on the storage itself.</p>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">{set("keepLast", "Last")}{set("keepDaily", "Daily")}{set("keepWeekly", "Weekly")}{set("keepMonthly", "Monthly")}{set("keepYearly", "Yearly")}</div>
      <Field label="Only machine (optional)" htmlFor="pr-vmid"><Input id="pr-vmid" type="number" value={vmid} onChange={(e) => { setVmid(e.target.value); preview.reset(); }} className="tabular-nums w-40" /></Field>
      <Button onClick={() => preview.mutate()} loading={preview.isPending}>Preview</Button>
      {preview.error && <p role="alert" className="text-compact text-critical">{errorText(preview.error)}</p>}
      {run.error && <p role="alert" className="text-compact text-critical">{run.error}</p>}
      {p && (
        <div className="space-y-3">
          <Notice tone={p.counts.remove ? "warning" : "info"}>
            Using {p.using}: keep {p.counts.keep}, remove {p.counts.remove}{p.counts.protected ? `, ${p.counts.protected} protected` : ""}. {p.counts.remove ? `Frees about ${formatBytes(p.bytesToFree)}.` : "Nothing would be removed."} {p.note}
          </Notice>
          <Card className="overflow-x-auto edge-fade-x max-h-72 overflow-y-auto"><table className="w-full text-compact min-w-[520px]"><tbody>
            {p.items.map((i) => <tr key={i.volid} className="border-b border-line last:border-0"><td className="px-4 py-2 font-mono text-xs break-all">{i.volid}</td><td className="px-3 tabular-nums">{i.size ? formatBytes(i.size) : "–"}</td><td className="px-3"><Chip tone={i.mark === "remove" ? "critical" : i.mark === "protected" ? "good" : "neutral"}>{i.mark === "remove" ? "Remove" : i.mark === "protected" ? "Protected" : i.mark === "renamed" ? "Renamed" : "Keep"}</Chip></td></tr>)}
          </tbody></table></Card>
          <Button variant="danger" disabled={p.counts.remove === 0} onClick={() => setArmed(true)}>Prune {p.counts.remove} backup{p.counts.remove === 1 ? "" : "s"}…</Button>
        </div>
      )}
      {armed && p && (
        <TypedConfirm title={`Delete ${p.counts.remove} backups from ${id}?`} subtitle="They are removed for good" phrase={id} action="Prune" busy={run.busy} error={run.error} onClose={() => setArmed(false)} onConfirm={() => { void run.start(`Prune ${id}`, async () => { const r = await storageToolsApi.prune(id, body(), numOrUndef(vmid)); setArmed(false); return { task: r.task ?? "" }; }); }}>
          <Notice tone="critical">Backups marked Remove are deleted from the storage. Protected backups stay. A backup made since the preview can change what goes, so look at the preview again if time has passed.</Notice>
        </TypedConfirm>
      )}
      {run.modal}
    </div>
  );
}

function Create({ id }: { id: string }) {
  const [vmid, setVmid] = useState("");
  const [name, setName] = useState("");
  const [size, setSize] = useState("1");
  const [format, setFormat] = useState("raw");
  const run = useMutation({ mutationFn: () => storageToolsApi.allocate(id, { vmid: Number(vmid), name, sizeGiB: Number(size), format }) });
  return (
    <div className="space-y-4">
      <p className="text-compact text-ink-2">Reserve an empty disk image on this storage for a machine. Attach it to the machine afterwards under its hardware.</p>
      <div className="grid sm:grid-cols-4 gap-3">
        <Field label="Machine" htmlFor="al-vmid"><Input id="al-vmid" type="number" value={vmid} onChange={(e) => { setVmid(e.target.value); setName(`vm-${e.target.value}-disk-1`); }} className="tabular-nums" /></Field>
        <Field label="Name" htmlFor="al-name"><Input id="al-name" value={name} onChange={(e) => setName(e.target.value)} className="font-mono" spellCheck={false} /></Field>
        <Field label="Size (GiB)" htmlFor="al-size"><Input id="al-size" type="number" min={1} value={size} onChange={(e) => setSize(e.target.value)} className="tabular-nums" /></Field>
        <Field label="Format" htmlFor="al-fmt"><Select id="al-fmt" value={format} onChange={(e) => setFormat(e.target.value)}><option value="raw">raw</option><option value="qcow2">qcow2</option><option value="vmdk">vmdk</option><option value="subvol">subvol</option></Select></Field>
      </div>
      <Button variant="primary" disabled={!vmid || !name || !size} loading={run.isPending} onClick={() => run.mutate()}>Create disk image</Button>
      {run.data && <Notice tone="good">Created {run.data.volid}.</Notice>}
      {run.error && <p role="alert" className="text-compact text-critical">{errorText(run.error)}</p>}
    </div>
  );
}

function ImportTab({ id }: { id: string }) {
  const [url, setUrl] = useState("");
  const [filename, setFilename] = useState("");
  const [algo, setAlgo] = useState("sha256");
  const [sum, setSum] = useState("");
  const meta = useMutation({ mutationFn: () => storageToolsApi.urlMetadata(url), onSuccess: (m) => { if (m.filename && !filename) setFilename(m.filename); } });
  const run = useTaskRunner();
  const [vmid, setVmid] = useState("");
  const [volume, setVolume] = useState("");
  const [bus, setBus] = useState("scsi");
  const [target, setTarget] = useState("");
  const attach = useMutation({ mutationFn: () => storageToolsApi.importDisk(id, { vmid: Number(vmid), volume, bus, targetStorage: target }) });
  const imports = useQuery({ queryKey: ["storage-tools", "import-files", id], queryFn: () => call<{ items: { volid: string }[] }>("GET", `/api/storage/${enc(id)}/content?content=import`), retry: 0 });
  return (
    <div className="space-y-6">
      <Section title="Get an image" hint="Appliances and disks from elsewhere: OVA, OVF, qcow2, raw and VMDK files. Proxmox checks the checksum while it downloads.">
        <div className="space-y-3">
          <Field label="Address" htmlFor="im-url"><Input id="im-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" spellCheck={false} /></Field>
          <div className="flex gap-2"><Button size="sm" onClick={() => meta.mutate()} loading={meta.isPending} disabled={!url}>Look up size and name</Button>{meta.data && <span className="text-compact text-ink-2 self-center">{meta.data.filename ?? "unknown name"}{meta.data.size ? ` · ${formatBytes(meta.data.size)}` : ""}</span>}</div>
          {meta.error && <p role="alert" className="text-compact text-critical">{errorText(meta.error)}</p>}
          <div className="grid sm:grid-cols-3 gap-3">
            <Field label="Save as" htmlFor="im-name"><Input id="im-name" value={filename} onChange={(e) => setFilename(e.target.value)} className="font-mono" spellCheck={false} /></Field>
            <Field label="Checksum type" htmlFor="im-algo"><Select id="im-algo" value={algo} onChange={(e) => setAlgo(e.target.value)}>{["sha256", "sha512", "sha384", "sha224", "sha1", "md5"].map((a) => <option key={a} value={a}>{a}</option>)}</Select></Field>
            <Field label="Checksum (optional)" htmlFor="im-sum"><Input id="im-sum" value={sum} onChange={(e) => setSum(e.target.value)} className="font-mono" spellCheck={false} /></Field>
          </div>
          <Button variant="primary" disabled={!url || !filename} loading={run.busy} onClick={() => void run.start(`Download ${filename}`, () => storageToolsApi.downloadImport(id, { url, filename, ...(sum ? { checksum: sum, algorithm: algo } : {}) }))}>Download</Button>
          {run.error && <p role="alert" className="text-compact text-critical">{run.error}</p>}
        </div>
      </Section>
      <Section title="Attach to a machine" hint="Adds an image from this storage to an existing virtual machine as a new disk, converted onto the storage you choose.">
        <div className="grid sm:grid-cols-4 gap-3">
          <Field label="Image" htmlFor="at-vol"><Select id="at-vol" value={volume} onChange={(e) => setVolume(e.target.value)}><option value="">Choose…</option>{(imports.data?.items ?? []).map((i) => <option key={i.volid} value={i.volid}>{i.volid.split("/").pop()}</option>)}</Select></Field>
          <Field label="Machine" htmlFor="at-vm"><Input id="at-vm" type="number" value={vmid} onChange={(e) => setVmid(e.target.value)} className="tabular-nums" /></Field>
          <Field label="Bus" htmlFor="at-bus"><Select id="at-bus" value={bus} onChange={(e) => setBus(e.target.value)}><option value="scsi">SCSI</option><option value="virtio">VirtIO</option><option value="sata">SATA</option><option value="ide">IDE</option></Select></Field>
          <Field label="Onto storage" htmlFor="at-st"><Input id="at-st" value={target} onChange={(e) => setTarget(e.target.value)} className="font-mono" spellCheck={false} /></Field>
        </div>
        <Button className="mt-3" disabled={!volume || !vmid || !target} loading={attach.isPending} onClick={() => attach.mutate()}>Attach as new disk</Button>
        {attach.data && <Notice tone="good" className="mt-3">Attached as {attach.data.key}.</Notice>}
        {attach.error && <p role="alert" className="mt-2 text-compact text-critical">{errorText(attach.error)}</p>}
      </Section>
      {run.modal}
    </div>
  );
}

function Snippets({ id }: { id: string }) {
  const q = useQuery({ queryKey: ["storage-tools", "snippets", id], queryFn: () => storageToolsApi.snippets(id), retry: 0 });
  return (
    <Async q={q}>
      {(s) => (
        <div className="space-y-4">
          {s.enabled === false && <Notice tone="warning">This storage isn't set to hold snippets. Turn it on under Edit, content types.</Notice>}
          <p className="text-compact text-ink-2">{s.reason}</p>
          {s.guide.map((g) => <div key={g.title} className="space-y-1"><div className="text-compact font-medium">{g.title}</div><CommandBlock command={g.command} /><p className="text-xs text-ink-3">{g.note}</p></div>)}
          <Section title="Snippets here">{s.files.length ? <ul className="text-compact divide-y divide-line">{s.files.map((f) => <li key={f.volid} className="py-1.5 font-mono text-xs">{f.name}</li>)}</ul> : <p className="text-compact text-ink-3">None yet.</p>}</Section>
        </div>
      )}
    </Async>
  );
}

function Check({ id }: { id: string }) {
  const [volid, setVolid] = useState("");
  const [sources, setSources] = useState(false);
  const info = useMutation({ mutationFn: () => storageToolsApi.volume(id, volid) });
  const iso = useQuery({ queryKey: ["storage-tools", "iso"], queryFn: storageToolsApi.isoSources, enabled: sources, retry: 0 });
  return (
    <div className="space-y-5">
      <Section title="Check a stored file" hint="Proxmox can only check a checksum while it downloads. For a file already here, run one of these on the node and compare with the publisher's value.">
        <div className="flex gap-2 items-end">
          <Field label="Volume" htmlFor="ck-vol" className="flex-1"><Input id="ck-vol" value={volid} onChange={(e) => setVolid(e.target.value)} placeholder={`${id}:iso/example.iso`} className="font-mono" spellCheck={false} /></Field>
          <Button onClick={() => info.mutate()} loading={info.isPending} disabled={!volid}>Show commands</Button>
        </div>
        {info.error && <p role="alert" className="text-compact text-critical">{errorText(info.error)}</p>}
        {info.data && <div className="space-y-2 mt-2">{info.data.verify.length ? info.data.verify.map((v) => <CommandBlock key={v.algorithm} command={v.command} label={v.algorithm} />) : <p className="text-compact text-ink-3">This kind of volume has no file to check.</p>}</div>}
      </Section>
      <Section title="Where to get an ISO" hint="The publishers' own pages. Copy a file's address and checksum into Download from URL.">
        {!sources ? <Button size="sm" onClick={() => setSources(true)}>Show sources</Button> : (
          <Async q={iso}>{(d) => <ul className="text-compact divide-y divide-line">{d.sources.map((s) => <li key={s.id} className="py-2"><a className="font-medium hover:underline" href={s.page} target="_blank" rel="noreferrer noopener">{s.name}</a><div className="text-xs text-ink-3">{s.checksums}</div></li>)}</ul>}</Async>
        )}
      </Section>
    </div>
  );
}

export function StorageToolsButton({ id, backup }: { id: string; backup?: boolean }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("usage");
  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}><Wrench className="h-3.5 w-3.5" />Space and tools</Button>
      {open && (
        <Modal title={`${id}: space and tools`} subtitle="What fills it, retention, new and imported disks, snippets" size="lg" onClose={() => setOpen(false)} footer={<Button onClick={() => setOpen(false)}>Close</Button>}>
          <div className="space-y-5">
            <Tabs<Tab> value={tab} onChange={setTab} tabs={[{ id: "usage", label: "Space" }, ...(backup === false ? [] : [{ id: "retention" as Tab, label: "Retention" }]), { id: "create", label: "New disk" }, { id: "import", label: "Import" }, { id: "snippets", label: "Snippets" }, { id: "check", label: "Check a file" }]} />
            {tab === "usage" && <Usage id={id} />}
            {tab === "retention" && <Retention id={id} />}
            {tab === "create" && <Create id={id} />}
            {tab === "import" && <ImportTab id={id} />}
            {tab === "snippets" && <Snippets id={id} />}
            {tab === "check" && <Check id={id} />}
          </div>
        </Modal>
      )}
    </>
  );
}
