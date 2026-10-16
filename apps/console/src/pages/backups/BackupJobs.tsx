import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Plus } from "lucide-react";
import { backupToolsApi, type BackupJobFull, type BackupJobInput } from "../../data/engine/w3Api.ts";
import { call, enc } from "../../data/engine/nodeApi.ts";
import { errorText } from "../../data/engine/queries.ts";
import { formatBytes } from "../../lib/storage.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Card, Chip, Field, Input, Notice, PageFrame, PageHeader, Select, Status, Tabs, Textarea, Toggle } from "../../ui/primitives.tsx";
import { Async, LiveOnly, TypedConfirm, useTaskRunner } from "../node/common.tsx";
import { numOrUndef, Section } from "../disks/w3Common.tsx";

type Tab = "jobs" | "uncovered" | "restore";

const SELECTION: Record<string, string> = { all: "Everything", vmids: "Chosen machines", pool: "A pool" };

function JobModal({ job, lists, onClose, onDone }: { job: BackupJobFull | null; lists: { nodes: string[]; pools: string[]; storages: string[] }; onClose: () => void; onDone: () => void }) {
  const [id, setId] = useState("");
  const [schedule, setSchedule] = useState(job?.schedule ?? "21:00");
  const [storage, setStorage] = useState(job?.storage ?? lists.storages[0] ?? "");
  const [selection, setSelection] = useState<"all" | "vmids" | "pool">(job?.selection ?? "vmids");
  const [vmids, setVmids] = useState((job?.vmids ?? []).join(","));
  const [exclude, setExclude] = useState((job?.exclude ?? []).join(","));
  const [pool, setPool] = useState(job?.pool ?? lists.pools[0] ?? "");
  const [mode, setMode] = useState(job?.mode ?? "snapshot");
  const [compress, setCompress] = useState(job?.compress ?? "zstd");
  const [enabled, setEnabled] = useState(job?.enabled ?? true);
  const [comment, setComment] = useState(job?.comment ?? "");
  const [notes, setNotes] = useState(job?.notesTemplate ?? "");
  const [notify, setNotify] = useState(job?.notificationMode ?? "");
  const [fleece, setFleece] = useState(job?.fleecing.enabled ?? false);
  const [fleeceStore, setFleeceStore] = useState(job?.fleecing.storage ?? "");
  const [bw, setBw] = useState(job?.bwlimit?.toString() ?? "");
  const [workers, setWorkers] = useState(job?.performance.maxWorkers?.toString() ?? "");
  const [zstd, setZstd] = useState(job?.zstd?.toString() ?? "");
  const [ionice, setIonice] = useState(job?.ionice?.toString() ?? "");
  const [repeat, setRepeat] = useState(job?.repeatMissed ?? false);
  const [prot, setProt] = useState(job?.protected ?? false);
  const [keepLast, setKeepLast] = useState(job?.prune?.keepLast?.toString() ?? "");
  const [keepDaily, setKeepDaily] = useState(job?.prune?.keepDaily?.toString() ?? "");
  const [keepWeekly, setKeepWeekly] = useState(job?.prune?.keepWeekly?.toString() ?? "");
  const [keepMonthly, setKeepMonthly] = useState(job?.prune?.keepMonthly?.toString() ?? "");
  const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean).map(Number);
  const save = useMutation({
    mutationFn: () => {
      const keep = { keepLast: numOrUndef(keepLast), keepDaily: numOrUndef(keepDaily), keepWeekly: numOrUndef(keepWeekly), keepMonthly: numOrUndef(keepMonthly) };
      const hasKeep = Object.values(keep).some((v) => v !== undefined);
      const body: BackupJobInput = {
        ...(job ? {} : { id: id || undefined }),
        schedule, storage, selection, mode, compress, enabled, comment, notesTemplate: notes, notificationMode: notify || null,
        ...(selection === "vmids" ? { vmids: list(vmids) } : {}),
        ...(selection === "all" ? { exclude: list(exclude) } : {}),
        ...(selection === "pool" ? { pool } : {}),
        fleecing: { enabled: fleece, storage: fleece ? fleeceStore || null : null },
        bwlimit: numOrUndef(bw) ?? null,
        performance: { maxWorkers: numOrUndef(workers) ?? null },
        zstd: numOrUndef(zstd) ?? null,
        ionice: numOrUndef(ionice) ?? null,
        repeatMissed: repeat,
        protected: prot,
        prune: hasKeep ? keep : null,
      };
      return job ? backupToolsApi.saveJob(job.id, { ...body, digest: job.digest ?? "" }) : backupToolsApi.createJob(body);
    },
    onSuccess: () => { onDone(); onClose(); },
  });
  return (
    <Modal size="lg" title={job ? `Edit ${job.id}` : "New backup job"} subtitle="Every option Proxmox offers for scheduled backups" onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={!storage || (selection === "vmids" && !vmids.trim()) || (selection === "pool" && !pool)} onClick={() => save.mutate()}>{job ? "Save" : "Create job"}</Button></>}>
      <div className="space-y-6">
        <Section title="What and when">
          <div className="grid sm:grid-cols-2 gap-4">
            {!job && <Field label="Name (optional)" hint="Letters, numbers, - and _" htmlFor="bj-id"><Input id="bj-id" value={id} onChange={(e) => setId(e.target.value)} className="font-mono" spellCheck={false} /></Field>}
            <Field label="Schedule" hint="Like 21:00, mon..fri 02:30 or sat 03:00" htmlFor="bj-sched"><Input id="bj-sched" value={schedule} onChange={(e) => setSchedule(e.target.value)} className="font-mono" /></Field>
            <Field label="Save to" htmlFor="bj-store"><Select id="bj-store" value={storage} onChange={(e) => setStorage(e.target.value)}>{lists.storages.map((s) => <option key={s} value={s}>{s}</option>)}</Select></Field>
            <Field label="Machines" htmlFor="bj-sel"><Select id="bj-sel" value={selection} onChange={(e) => setSelection(e.target.value as typeof selection)}><option value="vmids">Chosen machines</option><option value="all">Everything, except some</option><option value="pool">All machines in a pool</option></Select></Field>
            {selection === "vmids" && <Field label="Machine numbers" hint="Separated by commas" htmlFor="bj-vmids"><Input id="bj-vmids" value={vmids} onChange={(e) => setVmids(e.target.value)} className="font-mono" /></Field>}
            {selection === "all" && <Field label="Leave out" hint="Machine numbers, separated by commas" htmlFor="bj-ex"><Input id="bj-ex" value={exclude} onChange={(e) => setExclude(e.target.value)} className="font-mono" /></Field>}
            {selection === "pool" && <Field label="Pool" htmlFor="bj-pool"><Select id="bj-pool" value={pool} onChange={(e) => setPool(e.target.value)}>{lists.pools.map((p) => <option key={p} value={p}>{p}</option>)}</Select></Field>}
            <Field label="Mode" htmlFor="bj-mode"><Select id="bj-mode" value={mode} onChange={(e) => setMode(e.target.value)}><option value="snapshot">Snapshot (machine keeps running)</option><option value="suspend">Suspend (brief pause)</option><option value="stop">Stop (shut down, then start)</option></Select></Field>
            <Field label="Compression" htmlFor="bj-comp"><Select id="bj-comp" value={compress} onChange={(e) => setCompress(e.target.value)}><option value="zstd">zstd (fast, small)</option><option value="gzip">gzip</option><option value="lzo">lzo (fastest)</option><option value="0">None</option></Select></Field>
          </div>
          <div className="flex items-center gap-3"><Toggle checked={enabled} onChange={setEnabled} label="Enabled" /><span className="text-compact">Run on schedule</span></div>
          <Field label="Description" htmlFor="bj-comment"><Input id="bj-comment" value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
        </Section>
        <Section title="Keep" hint="Leave empty to use the retention of the storage.">
          <div className="grid grid-cols-4 gap-3">
            {([["Last", keepLast, setKeepLast], ["Daily", keepDaily, setKeepDaily], ["Weekly", keepWeekly, setKeepWeekly], ["Monthly", keepMonthly, setKeepMonthly]] as const).map(([l, v, set]) => <Field key={l} label={l} htmlFor={`bj-k-${l}`}><Input id={`bj-k-${l}`} type="number" min={1} value={v} onChange={(e) => set(e.target.value)} className="tabular-nums" /></Field>)}
          </div>
        </Section>
        <Section title="Notes and notifications">
          <Field label="Notes template" hint="Variables: {{guestname}}, {{node}}, {{vmid}}, {{cluster}}" htmlFor="bj-notes"><Textarea id="bj-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} className="font-mono" /></Field>
          <Field label="Notifications" htmlFor="bj-notify"><Select id="bj-notify" value={notify} onChange={(e) => setNotify(e.target.value)}><option value="">Default</option><option value="notification-system">Notification system</option><option value="legacy-sendmail">Legacy email</option><option value="auto">Automatic</option></Select></Field>
        </Section>
        <Section title="Speed and load">
          <div className="grid sm:grid-cols-4 gap-3">
            <Field label="Speed limit (KiB/s)" htmlFor="bj-bw"><Input id="bj-bw" type="number" min={0} value={bw} onChange={(e) => setBw(e.target.value)} className="tabular-nums" /></Field>
            <Field label="Workers" htmlFor="bj-workers"><Input id="bj-workers" type="number" min={1} value={workers} onChange={(e) => setWorkers(e.target.value)} className="tabular-nums" /></Field>
            <Field label="zstd threads" htmlFor="bj-zstd"><Input id="bj-zstd" type="number" min={0} value={zstd} onChange={(e) => setZstd(e.target.value)} className="tabular-nums" /></Field>
            <Field label="IO priority (0-8)" htmlFor="bj-io"><Input id="bj-io" type="number" min={0} max={8} value={ionice} onChange={(e) => setIonice(e.target.value)} className="tabular-nums" /></Field>
          </div>
          <div className="flex items-center gap-3"><Toggle checked={fleece} onChange={setFleece} label="Fleecing" /><span className="text-compact">Fleecing: spool changes to fast storage during a backup so the machine isn't slowed</span></div>
          {fleece && <Field label="Fleecing storage" htmlFor="bj-fs"><Select id="bj-fs" value={fleeceStore} onChange={(e) => setFleeceStore(e.target.value)}><option value="">Same as backup</option>{lists.storages.map((s) => <option key={s} value={s}>{s}</option>)}</Select></Field>}
          <div className="flex items-center gap-3"><Toggle checked={repeat} onChange={setRepeat} label="Repeat missed" /><span className="text-compact">Run as soon as possible if a start time was missed</span></div>
          <div className="flex items-center gap-3"><Toggle checked={prot} onChange={setProt} label="Protect" /><span className="text-compact">Mark these backups protected so retention never removes them</span></div>
        </Section>
        {save.error && <p role="alert" className="text-compact text-critical">{errorText(save.error)}</p>}
      </div>
    </Modal>
  );
}

function VolumesModal({ job, onClose }: { job: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ["backup-tools", "volumes", job], queryFn: () => backupToolsApi.volumes(job), retry: 0 });
  return (
    <Modal title={`What ${job} includes`} subtitle="Each machine and its disks" onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      <Async q={q}>{(d) => d.guests.length === 0 ? <p className="text-compact text-ink-3">No machines.</p> : (
        <ul className="space-y-3">{d.guests.map((g) => (
          <li key={String(g.id)}><div className="font-medium text-compact">{g.name ?? g.id} <span className="text-ink-3 font-normal">{g.type}</span></div>
            <ul className="mt-1 space-y-1">{g.volumes.map((v) => <li key={v.id} className="flex items-center gap-2 text-compact"><Status kind={v.included ? "good" : "off"} label={v.included ? "Included" : "Skipped"} /><span className="font-mono">{v.name}</span>{v.reason && <span className="text-ink-3 text-xs">{v.reason}</span>}</li>)}</ul></li>
        ))}</ul>
      )}</Async>
    </Modal>
  );
}

function Jobs() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["backup-tools", "jobs"], queryFn: backupToolsApi.jobs, retry: 1 });
  const [edit, setEdit] = useState<BackupJobFull | "new" | null>(null);
  const [vols, setVols] = useState<string | null>(null);
  const [del, setDel] = useState<string | null>(null);
  const remove = useMutation({ mutationFn: (id: string) => backupToolsApi.deleteJob(id), onSuccess: () => { setDel(null); void qc.invalidateQueries({ queryKey: ["backup-tools"] }); } });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["backup-tools"] });
  return (
    <Async q={q}>
      {(d) => (
        <div className="space-y-4">
          <div><Button variant="primary" onClick={() => setEdit("new")}><Plus className="h-4 w-4" />New job…</Button></div>
          {d.jobs.length === 0 ? <p className="text-compact text-ink-3">No scheduled backups yet.</p> : (
            <Card className="overflow-x-auto"><table className="w-full text-compact min-w-[720px]">
              <thead><tr className="border-b border-line text-ink-3 text-left"><th className="font-normal px-4 h-10">Job</th><th className="font-normal px-3">Schedule</th><th className="font-normal px-3">Machines</th><th className="font-normal px-3">To</th><th className="font-normal px-3">Options</th><th className="px-3"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>{d.jobs.map((j) => (
                <tr key={j.id} className="border-b border-line last:border-0 align-top">
                  <td className="px-4 py-3"><div className="font-mono">{j.id}</div><div className="mt-1">{j.enabled ? <Status kind="good" label="On" /> : <Status kind="off" label="Off" />}</div></td>
                  <td className="px-3 py-3 font-mono text-xs">{j.schedule}</td>
                  <td className="px-3 py-3">{SELECTION[j.selection]}<div className="text-xs text-ink-3">{j.selection === "pool" ? j.pool : j.selection === "vmids" ? j.vmids.join(", ") : j.exclude.length ? `except ${j.exclude.join(", ")}` : ""}</div></td>
                  <td className="px-3 py-3">{j.storage}</td>
                  <td className="px-3 py-3"><div className="flex gap-1.5 flex-wrap"><Chip>{j.mode}</Chip>{j.fleecing.enabled && <Chip>fleecing</Chip>}{j.protected && <Chip>protected</Chip>}{j.bwlimit ? <Chip>{formatBytes(j.bwlimit * 1024)}/s</Chip> : null}{j.prune?.keepLast ? <Chip>keep {String(j.prune.keepLast)}</Chip> : null}</div></td>
                  <td className="px-3 py-3"><div className="flex gap-1.5 justify-end"><Button size="sm" onClick={() => setEdit(j)}>Edit</Button><Button size="sm" variant="ghost" onClick={() => setVols(j.id)}>Included disks</Button><Button size="sm" variant="ghost" onClick={() => setDel(j.id)}>Delete…</Button></div></td>
                </tr>
              ))}</tbody>
            </table></Card>
          )}
          {edit && <JobModal job={edit === "new" ? null : edit} lists={d} onClose={() => setEdit(null)} onDone={refresh} />}
          {vols && <VolumesModal job={vols} onClose={() => setVols(null)} />}
          {del && <TypedConfirm title={`Delete ${del}?`} subtitle="Stops the schedule; backups already made stay" phrase={del} action="Delete job" busy={remove.isPending} error={remove.error ? errorText(remove.error) : null} onClose={() => setDel(null)} onConfirm={() => remove.mutate(del)} />}
        </div>
      )}
    </Async>
  );
}

function Uncovered() {
  const q = useQuery({ queryKey: ["backup-tools", "uncovered"], queryFn: backupToolsApi.notBackedUp, retry: 1 });
  return (
    <Async q={q}>
      {(d) => d.guests.length === 0 ? <Notice tone="good">Every machine is covered by a backup job.</Notice> : (
        <div className="space-y-3">
          <Notice tone="warning">These machines are not in any scheduled backup job. If they are lost, there is nothing to restore.</Notice>
          <Card className="overflow-x-auto"><table className="w-full text-compact min-w-[400px]"><tbody>{d.guests.map((g) => <tr key={g.vmid} className="border-b border-line last:border-0"><td className="px-4 py-2.5 font-mono">{g.vmid}</td><td className="px-3">{g.name}</td><td className="px-3"><Chip>{g.type === "lxc" ? "container" : "VM"}</Chip></td><td className="px-3 text-ink-3">{g.node ?? ""}</td></tr>)}</tbody></table></Card>
        </div>
      )}
    </Async>
  );
}

interface BackupRow { volid: string; size: number | null; ctime: number | null; vmid: number | null; protected: boolean }

function RestoreModal({ from, volid, onClose }: { from: string; volid: string; onClose: () => void }) {
  const isVm = /qemu|\/vm\//.test(volid);
  const [mode, setMode] = useState<"new" | "replace">("new");
  const [vmid, setVmid] = useState("");
  const [storage, setStorage] = useState("");
  const [unique, setUnique] = useState(true);
  const [start, setStart] = useState(false);
  const [live, setLive] = useState(false);
  const [bw, setBw] = useState("");
  const [typed, setTyped] = useState("");
  const owner = volid.match(/(?:qemu|lxc)-(\d+)-/)?.[1] ?? volid.match(/\/(?:vm|ct)\/(\d+)\//)?.[1] ?? "";
  const run = useTaskRunner();
  return (
    <Modal title="Restore" subtitle={volid} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant={mode === "replace" ? "danger" : "primary"} loading={run.busy} disabled={mode === "replace" && typed !== owner} onClick={() => void run.start("Restore", () => backupToolsApi.restore({ from, volid, mode, vmid: numOrUndef(vmid), storage: storage || undefined, unique: mode === "new" ? unique : undefined, start, bwlimit: numOrUndef(bw), liveRestore: live || undefined, confirm: mode === "replace" ? typed : undefined }))}>Restore</Button></>}>
      <div className="space-y-4">
        <Field label="Restore as" htmlFor="rs-mode"><Select id="rs-mode" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}><option value="new">A new machine</option><option value="replace">Replace machine {owner}</option></Select></Field>
        {mode === "new" && <Field label="Number (optional)" hint="Leave empty for the next free one" htmlFor="rs-vmid"><Input id="rs-vmid" type="number" value={vmid} onChange={(e) => setVmid(e.target.value)} className="tabular-nums w-40" /></Field>}
        {mode === "replace" && <Notice tone="critical">Everything on machine {owner} is overwritten by this backup. Type <span className="font-mono">{owner}</span> to confirm.<Input aria-label="Machine number" className="mt-2 font-mono w-40" value={typed} onChange={(e) => setTyped(e.target.value)} /></Notice>}
        <Field label="Put disks on (optional)" htmlFor="rs-st"><Input id="rs-st" value={storage} onChange={(e) => setStorage(e.target.value)} className="font-mono" spellCheck={false} /></Field>
        <Field label="Speed limit (KiB/s, optional)" htmlFor="rs-bw"><Input id="rs-bw" type="number" min={0} value={bw} onChange={(e) => setBw(e.target.value)} className="tabular-nums w-40" /></Field>
        {mode === "new" && <div className="flex items-center gap-3"><Toggle checked={unique} onChange={setUnique} label="Unique" /><span className="text-compact">Give network cards new MAC addresses</span></div>}
        <div className="flex items-center gap-3"><Toggle checked={start} onChange={setStart} label="Start after" /><span className="text-compact">Start it when the restore finishes</span></div>
        {isVm && mode === "new" && <div className="flex items-center gap-3"><Toggle checked={live} onChange={setLive} label="Live restore" /><span className="text-compact">Start at once and bring the disks in behind it (virtual machines only)</span></div>}
        {run.error && <p role="alert" className="text-compact text-critical">{run.error}</p>}
        {run.modal}
      </div>
    </Modal>
  );
}

function Browse({ storage, volid, onClose }: { storage: string; volid: string; onClose: () => void }) {
  const [path, setPath] = useState("/");
  const q = useQuery({ queryKey: ["backup-tools", "files", storage, volid, path], queryFn: () => backupToolsApi.files(storage, volid, path), retry: 0 });
  return (
    <Modal title="Files in this backup" subtitle={path} size="lg" onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      {path !== "/" && <Button size="sm" variant="ghost" className="mb-2" onClick={() => setPath(path.replace(/\/[^/]+\/?$/, "") || "/")}>Up one folder</Button>}
      <Async q={q}>{(d) => <ul className="text-compact divide-y divide-line">{d.entries.map((e) => <li key={e.path ?? e.name} className="py-1.5 flex items-center justify-between gap-3">{e.leaf ? <span className="font-mono text-xs">{e.name}</span> : <button className="font-mono text-xs hover:underline" onClick={() => e.path && setPath(e.path)}>{e.name}/</button>}<span className="text-ink-3 tabular-nums text-xs">{e.size !== null ? formatBytes(e.size) : ""}</span></li>)}{d.entries.length === 0 && <li className="py-2 text-ink-3">Empty.</li>}</ul>}</Async>
      <p className="text-xs text-ink-3 mt-3">To get a single file out, restore the backup as a new machine, or use Proxmox Backup Server's own file restore. Downloads aren't offered here.</p>
    </Modal>
  );
}

function Restore() {
  const jobs = useQuery({ queryKey: ["backup-tools", "jobs"], queryFn: backupToolsApi.jobs, retry: 1 });
  const [storage, setStorage] = useState("");
  const [pick, setPick] = useState<{ kind: "restore" | "config" | "browse"; volid: string } | null>(null);
  const st = storage || jobs.data?.storages[0] || "";
  const list = useQuery({ queryKey: ["backup-tools", "files-list", st], queryFn: () => call<{ items: BackupRow[] }>("GET", `/api/storage/${enc(st)}/content?content=backup`), enabled: !!st, retry: 0 });
  const cfg = useQuery({ queryKey: ["backup-tools", "config", st, pick?.volid], queryFn: () => backupToolsApi.config(st, pick!.volid), enabled: pick?.kind === "config", retry: 0 });
  return (
    <Async q={jobs}>
      {(d) => (
        <div className="space-y-4">
          <Field label="Backups on" htmlFor="rs-store"><Select id="rs-store" value={st} onChange={(e) => setStorage(e.target.value)} className="w-60">{d.storages.map((s) => <option key={s} value={s}>{s}</option>)}</Select></Field>
          {list.data && (
            <Card className="overflow-x-auto"><table className="w-full text-compact min-w-[640px]"><tbody>
              {list.data.items.length === 0 && <tr><td className="px-4 py-3 text-ink-3">No backups on this storage.</td></tr>}
              {[...list.data.items].sort((a, b) => (b.ctime ?? 0) - (a.ctime ?? 0)).map((b) => (
                <tr key={b.volid} className="border-b border-line last:border-0"><td className="px-4 py-2.5 font-mono text-xs break-all">{b.volid.split(":")[1]}</td><td className="px-3 tabular-nums">{b.size ? formatBytes(b.size) : "–"}</td><td className="px-3">{b.protected && <Chip tone="good">Protected</Chip>}</td>
                  <td className="px-3"><div className="flex gap-1.5 justify-end"><Button size="sm" onClick={() => setPick({ kind: "restore", volid: b.volid })}>Restore…</Button><Button size="sm" variant="ghost" onClick={() => setPick({ kind: "config", volid: b.volid })}>Configuration</Button>{b.volid.includes(":backup/vm/") || b.volid.includes(":backup/ct/") ? <Button size="sm" variant="ghost" onClick={() => setPick({ kind: "browse", volid: b.volid })}>Browse files</Button> : null}</div></td></tr>
              ))}
            </tbody></table></Card>
          )}
          {pick?.kind === "restore" && <RestoreModal from={st} volid={pick.volid} onClose={() => setPick(null)} />}
          {pick?.kind === "browse" && <Browse storage={st} volid={pick.volid} onClose={() => setPick(null)} />}
          {pick?.kind === "config" && (
            <Modal title="Machine configuration in this backup" subtitle={pick.volid} size="lg" onClose={() => setPick(null)} footer={<Button onClick={() => setPick(null)}>Close</Button>}>
              <Async q={cfg}>{(c) => <pre aria-label="Configuration" className="rounded-lg bg-code border border-line p-3 text-xs font-mono text-ink-2 max-h-96 overflow-auto whitespace-pre-wrap break-all">{c.config}</pre>}</Async>
              <p className="text-xs text-ink-3 mt-2">Password hashes are hidden.</p>
            </Modal>
          )}
        </div>
      )}
    </Async>
  );
}

export function BackupJobsPage() {
  const [tab, setTab] = useState<Tab>("jobs");
  return (
    <PageFrame width="6xl">
      <PageHeader title="Backup jobs" subtitle="Schedules with every option, the machines no job covers, and restoring with choices." eyebrow={<Archive className="h-4 w-4" />} />
      <LiveOnly>
        <div className="space-y-5">
          <Tabs<Tab> value={tab} onChange={setTab} tabs={[{ id: "jobs", label: "Jobs" }, { id: "uncovered", label: "Not covered" }, { id: "restore", label: "Backups and restore" }]} />
          {tab === "jobs" && <Jobs />}
          {tab === "uncovered" && <Uncovered />}
          {tab === "restore" && <Restore />}
        </div>
      </LiveOnly>
    </PageFrame>
  );
}
