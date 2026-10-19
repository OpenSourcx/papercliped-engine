import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, CalendarClock, FileSearch, FileText, Folder, FolderOpen, Lock, Plus, RotateCcw, ShieldAlert, Trash2 } from "lucide-react";
import { dcApi, type BackupArchive, type BackupJob, type FileEntry, type PrunePlanRow } from "../../data/engine/dcApi.ts";
import type { Schema, Values } from "../../data/engine/nodeApi.ts";
import { errorText } from "../../data/engine/queries.ts";
import { formatBytes } from "../../lib/storage.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Card, Chip, EmptyState, Field, Input, Notice, PageFrame, PageHeader, SectionTitle, Segmented, Select, Status, Tabs, Textarea, Toggle } from "../../ui/primitives.tsx";
import { Async, changedValues, LiveOnly, NodeSwitcher, SchemaForm, TasksLink, TypedConfirm, useNodeName, useTaskRunner } from "./common.tsx";
import { CopyButton, DataTable, Td, when } from "./dc.tsx";

/* ── Schedule: shows the next runs of a calendar event as it is typed ───────────────── */

const PRESETS: { label: string; value: string }[] = [
  { label: "Every night at 02:00", value: "02:00" },
  { label: "Weekdays at 01:30", value: "mon..fri 01:30" },
  { label: "Sundays at 03:00", value: "sun 03:00" },
  { label: "Every 6 hours", value: "0/6:00" },
];

function ScheduleHint({ schedule }: { schedule: string }) {
  const [settled, setSettled] = useState(schedule);
  useEffect(() => {
    const t = setTimeout(() => setSettled(schedule), 400);
    return () => clearTimeout(t);
  }, [schedule]);
  const q = useQuery({ queryKey: ["node", "schedule", settled], queryFn: () => dcApi.schedule(settled.trim(), 5), enabled: settled.trim().length > 0, retry: 0, staleTime: 60_000 });
  if (!settled.trim()) return null;
  if (q.isPending) return <p className="text-xs text-ink-3">Checking the schedule…</p>;
  if (q.error) return <p role="alert" className="text-xs text-critical">Proxmox doesn't understand that schedule.</p>;
  return <p className="text-xs text-ink-3">Next runs: {q.data.runs.map((r) => when(r.at)).join(" · ") || "none"}</p>;
}

/* ── Job form ──────────────────────────────────────────────────────────────────────── */

type Sel = "all" | "list" | "pool";
const selOf = (v: Values): Sel => (v.pool ? "pool" : v.all === true ? "all" : v.vmid ? "list" : "all");
const ids = (s: unknown) => String(s ?? "").split(",").map((x) => x.trim()).filter(Boolean).map(Number).filter((n) => Number.isInteger(n));
const OPTION_KEYS = ["mode", "compress", "zstd", "bwlimit", "ionice", "notes-template", "notification-mode", "fleecing", "performance", "prune-backups", "repeat-missed", "protected", "stdexcludes", "exclude-path", "pbs-change-detection-mode", "lockwait", "stopwait", "node"];
const HINTS: Record<string, string> = { "notes-template": "Variables: {{cluster}}, {{guestname}}, {{node}}, {{vmid}}. The default is {{guestname}}.", "prune-backups": "Which backups to keep after each run. Empty uses the storage's own retention.", bwlimit: "KiB per second; 0 is unlimited.", node: "Run only on this node. Empty runs wherever the machine is." };

function JobModal({ job, preset, data, onClose }: { job: BackupJob | null; preset?: number[]; data: NonNullable<ReturnType<typeof useJobs>["data"]>; onClose: () => void }) {
  const qc = useQueryClient();
  const res = useQuery({ queryKey: ["node", "resources"], queryFn: dcApi.resources, retry: 1 });
  const initial = useMemo<Values>(() => (job ? job.values : preset ? { vmid: preset.join(","), mode: "snapshot", compress: "zstd", enabled: true } : { all: true, mode: "snapshot", compress: "zstd", enabled: true }), [job, preset]);
  const [value, setValue] = useState<Values>(initial);
  const [sel, setSel] = useState<Sel>(selOf(initial));
  const [id, setId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const guests = (res.data?.rows ?? []).filter((r) => (r.type === "qemu" || r.type === "lxc") && !r.template && r.vmid !== null).sort((a, b) => (a.vmid ?? 0) - (b.vmid ?? 0));
  const picked = ids(value.vmid);
  const excluded = ids(value.exclude);
  const set = (k: string, v: unknown) => setValue((x) => ({ ...x, [k]: v }));
  const list = (k: "vmid" | "exclude", cur: number[], n: number) => set(k, (cur.includes(n) ? cur.filter((x) => x !== n) : [...cur, n]).sort((a, b) => a - b).join(",") || undefined);

  const final: Values = { ...value };
  if (sel !== "list") final.vmid = undefined;
  if (sel !== "pool") final.pool = undefined;
  if (sel === "list") final.exclude = undefined;
  final.all = sel === "all" ? true : undefined;
  const keys = ["enabled", "comment", "storage", "schedule", "all", "vmid", "pool", "exclude", ...OPTION_KEYS];

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (job) await dcApi.updateJob(job.id, changedValues(initial, final, keys), job.digest);
      else await dcApi.createJob(id.trim() || undefined, Object.fromEntries(keys.filter((k) => final[k] !== undefined && final[k] !== "" && !(Array.isArray(final[k]) && (final[k] as unknown[]).length === 0)).map((k) => [k, final[k]])));
      await qc.invalidateQueries({ queryKey: ["node", "backup"] });
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const schema: Schema = data.schema;
  return (
    <Modal size="lg" icon={<CalendarClock className="h-5 w-5" />} title={job ? `Edit ${job.id}` : "New backup job"} subtitle="Runs on a schedule and keeps what the retention says." onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!final.storage || !final.schedule} onClick={() => void submit()}>{job ? "Save job" : "Create job"}</Button></>}>
      <div className="space-y-6">
        {!job && <Field label="Job name (optional)" hint="Letters, numbers, - and _. Proxmox picks one if you leave it empty." htmlFor="bj-id"><Input id="bj-id" value={id} onChange={(e) => setId(e.target.value)} className="font-mono" /></Field>}
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Back up to" hint={data.storages.length ? undefined : "No storage accepts backups yet. Add one under Storage."} htmlFor="bj-storage">
            <Select id="bj-storage" value={typeof value.storage === "string" ? value.storage : ""} onChange={(e) => set("storage", e.target.value || undefined)}>
              <option value="">Pick a storage</option>
              {data.storages.map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
          </Field>
          <Field label="Comment" htmlFor="bj-comment"><Input id="bj-comment" value={typeof value.comment === "string" ? value.comment : ""} onChange={(e) => set("comment", e.target.value || undefined)} /></Field>
        </div>
        <Field label="Schedule" hint="A systemd calendar event, for example mon..fri 01:30." htmlFor="bj-schedule">
          <Input id="bj-schedule" className="font-mono" value={typeof value.schedule === "string" ? value.schedule : ""} onChange={(e) => set("schedule", e.target.value)} />
          <div className="flex flex-wrap gap-1.5 mt-2">{PRESETS.map((p) => <Button key={p.value} size="sm" variant="ghost" onClick={() => set("schedule", p.value)}>{p.label}</Button>)}</div>
          <div className="mt-2"><ScheduleHint schedule={typeof value.schedule === "string" ? value.schedule : ""} /></div>
        </Field>
        <div className="space-y-3">
          <SectionTitle>What to back up</SectionTitle>
          <Segmented<Sel> label="Selection" value={sel} onChange={setSel} options={[{ value: "all", label: "Every machine" }, { value: "list", label: "Chosen machines" }, { value: "pool", label: "A pool" }]} />
          {sel === "pool" && <Select aria-label="Pool" value={typeof value.pool === "string" ? value.pool : ""} onChange={(e) => set("pool", e.target.value || undefined)}><option value="">Pick a pool</option>{data.pools.map((p) => <option key={p} value={p}>{p}</option>)}</Select>}
          <p className="text-xs text-ink-3">{sel === "list" ? "Tick the machines to back up." : "Tick any machines to leave out."}</p>
          {
            <div className="max-h-48 overflow-y-auto overflow-x-hidden rounded-lg border border-line divide-y divide-line" role="group" aria-label={sel === "list" ? "Machines to back up" : "Machines to leave out"}>
              {guests.length === 0 ? <p className="p-3 text-compact text-ink-3">No machines yet.</p> : guests.map((g) => (
                <label key={g.id} className="flex items-center gap-3 px-3 h-10 cursor-pointer text-compact">
                  <input type="checkbox" className="h-4 w-4 accent-(--accent)" checked={(sel === "list" ? picked : excluded).includes(g.vmid!)} onChange={() => (sel === "list" ? list("vmid", picked, g.vmid!) : list("exclude", excluded, g.vmid!))} />
                  <span className="font-mono text-xs text-ink-3">{g.vmid}</span><span className="truncate">{g.name}</span><span className="text-xs text-ink-3 ml-auto">{g.node}</span>
                </label>
              ))}
            </div>
          }
        </div>
        <div className="flex items-center gap-3"><Toggle checked={value.enabled !== false} onChange={(v) => set("enabled", v)} label="Job enabled" /><span className="text-compact text-ink-2">Enabled</span></div>
        <SchemaForm schema={schema} value={value} onChange={setValue} only={OPTION_KEYS} hints={HINTS} labels={{ zstd: "Zstd threads", ionice: "I/O priority (BFQ)", "pbs-change-detection-mode": "Container change detection (Proxmox Backup Server)", stdexcludes: "Skip temporary files and logs", "exclude-path": "Paths to skip (containers)", "repeat-missed": "Run as soon as possible if a run was missed", protected: "Mark the new backups as protected" }} />
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}

const useJobs = () => useQuery({ queryKey: ["node", "backup", "jobs"], queryFn: dcApi.backupJobs, retry: 1 });

function VolumesModal({ job, onClose }: { job: BackupJob; onClose: () => void }) {
  const q = useQuery({ queryKey: ["node", "backup", "volumes", job.id], queryFn: () => dcApi.jobVolumes(job.id), retry: 0 });
  return (
    <Modal size="lg" icon={<Archive className="h-5 w-5" />} title="Included volumes" subtitle={job.id} onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      {q.isPending ? <p className="text-compact text-ink-3">Asking Proxmox…</p> : q.error ? <Notice tone="warning">{errorText(q.error)}</Notice> : q.data.guests.length === 0 ? <p className="text-compact text-ink-3">This job doesn't include any machine right now.</p> : (
        <div className="space-y-4">
          {q.data.guests.map((g) => (
            <div key={g.vmid}>
              <div className="font-medium text-compact"><span className="font-mono text-xs text-ink-3 mr-2">{g.vmid}</span>{g.name}</div>
              <ul className="mt-1 space-y-1">{g.volumes.map((v) => <li key={v.id} className="text-compact flex items-center gap-2">{v.included ? <Status kind="good" label="Included" /> : <Status kind="off" label="Left out" />}<span className="font-mono text-xs">{v.name ?? v.id}</span>{v.reason && <span className="text-xs text-ink-3">{v.reason}</span>}</li>)}</ul>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

const selection = (v: Values) => (v.pool ? `Pool ${String(v.pool)}` : v.all === true ? `Every machine${v.exclude ? ` except ${String(v.exclude)}` : ""}` : v.vmid ? `Machines ${String(v.vmid)}` : "Nothing selected");
const retention = (v: Values) => {
  const r = v["prune-backups"] as Record<string, unknown> | undefined;
  if (!r) return "Storage default";
  if (r["keep-all"] === true) return "Keep all";
  return Object.entries(r).map(([k, n]) => `${k.replace("keep-", "")} ${String(n)}`).join(", ");
};

function JobsTab({ onUncovered }: { onUncovered: () => void }) {
  const qc = useQueryClient();
  const q = useJobs();
  const [edit, setEdit] = useState<BackupJob | "new" | null>(null);
  const [del, setDel] = useState<BackupJob | null>(null);
  const [vol, setVol] = useState<BackupJob | null>(null);
  const toggle = useMutation({ mutationFn: (j: BackupJob) => dcApi.updateJob(j.id, { enabled: j.values.enabled === false }, j.digest), onSuccess: () => qc.invalidateQueries({ queryKey: ["node", "backup"] }) });
  const remove = useMutation({ mutationFn: (j: BackupJob) => dcApi.deleteJob(j.id), onSuccess: () => { setDel(null); void qc.invalidateQueries({ queryKey: ["node", "backup"] }); } });
  return (
    <Async q={q}>
      {(d) => (
        <div className="space-y-4">
          {d.denied && <Notice tone="info" title="Your Proxmox account can't list backup jobs">It needs Sys.Audit on the datacenter.</Notice>}
          {d.uncovered.length > 0 && <Notice tone="warning" title={`${d.uncovered.length} ${d.uncovered.length === 1 ? "machine isn't" : "machines aren't"} in any backup job`} action={<Button size="sm" onClick={onUncovered}>See them</Button>}>If one of them is lost, there is nothing to restore it from.</Notice>}
          {toggle.error && <Notice tone="critical">{errorText(toggle.error)}</Notice>}
          <div><Button variant="primary" onClick={() => setEdit("new")}><Plus className="h-4 w-4" />New backup job…</Button></div>
          <Card>
            {d.jobs.length === 0 ? <EmptyState icon={<CalendarClock className="h-5 w-5" />} title="No backup jobs" body="A job backs machines up on a schedule. Create one so nothing depends on someone remembering." /> : (
              <DataTable label="Backup jobs" head={["Job", "Schedule", "Next run", "Back up", "To", "Mode", "Keeps", "State", ""]} min={980}>
                {d.jobs.map((j) => (
                  <tr key={j.id} className="border-b border-line last:border-0">
                    <Td mono>{j.id}{typeof j.values.comment === "string" && j.values.comment && <div className="font-sans text-xs text-ink-3">{j.values.comment}</div>}</Td>
                    <Td mono>{String(j.values.schedule ?? "")}</Td>
                    <Td>{j.values.enabled === false ? "–" : when(j.nextRun)}</Td>
                    <Td>{selection(j.values)}</Td>
                    <Td mono>{String(j.values.storage ?? "")}</Td>
                    <Td>{String(j.values.mode ?? "snapshot")}{j.values.compress ? <span className="text-ink-3"> · {String(j.values.compress)}</span> : null}</Td>
                    <Td className="text-ink-2">{retention(j.values)}</Td>
                    <Td>{j.values.enabled === false ? <Status kind="off" label="Off" /> : <Status kind="good" label="On" />}</Td>
                    <Td><div className="flex gap-1 justify-end flex-wrap">
                      <Button size="sm" variant="ghost" onClick={() => toggle.mutate(j)}>{j.values.enabled === false ? "Turn on" : "Turn off"}</Button>
                      <Button size="sm" variant="ghost" onClick={() => setVol(j)}>Volumes</Button>
                      <Button size="sm" variant="ghost" onClick={() => setEdit(j)}>Edit</Button>
                      <Button size="sm" variant="ghost" className="text-critical" aria-label={`Delete ${j.id}`} onClick={() => setDel(j)}><Trash2 className="h-4 w-4" /></Button>
                    </div></Td>
                  </tr>
                ))}
              </DataTable>
            )}
          </Card>
          {edit && <JobModal job={edit === "new" ? null : edit} data={d} onClose={() => setEdit(null)} />}
          {vol && <VolumesModal job={vol} onClose={() => setVol(null)} />}
          {del && <TypedConfirm title={`Delete ${del.id}?`} subtitle="Backups it already made stay where they are." phrase={del.id} action="Delete job" busy={remove.isPending} error={remove.error ? errorText(remove.error) : null} onConfirm={() => remove.mutate(del)} onClose={() => setDel(null)} />}
        </div>
      )}
    </Async>
  );
}

/* ── Machines no job covers ────────────────────────────────────────────────────────── */

function UncoveredTab() {
  const q = useJobs();
  const [make, setMake] = useState(false);
  return (
    <Async q={q}>
      {(d) => (
        <Card>
          <div className="p-5 pb-3 flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1 basis-60"><SectionTitle>Not in any backup job</SectionTitle><p className="text-compact text-ink-3 mt-1">Machines no enabled job includes, by number, list, pool or “every machine”.</p></div>
            {d.uncovered.length > 0 && <Button variant="primary" onClick={() => setMake(true)}><Plus className="h-4 w-4" />Back these up…</Button>}
          </div>
          {d.uncoveredDenied ? <p className="px-5 pb-5 text-compact text-ink-3">Your Proxmox account can't see this (it needs Sys.Audit on the datacenter).</p> : d.uncovered.length === 0 ? <EmptyState icon={<ShieldAlert className="h-5 w-5" />} title="Every machine is covered" body="Each machine is part of at least one backup job." /> : (
            <DataTable label="Machines without a backup job" head={["Machine", "Name", "Kind"]} min={360}>
              {d.uncovered.map((g) => <tr key={g.vmid} className="border-b border-line last:border-0"><Td mono>{g.vmid}</Td><Td>{g.name ?? "–"}</Td><Td>{g.type === "qemu" ? "Virtual machine" : "Container"}</Td></tr>)}
            </DataTable>
          )}
          {make && <JobModal job={null} preset={d.uncovered.map((g) => g.vmid)} data={d} onClose={() => setMake(false)} />}
        </Card>
      )}
    </Async>
  );
}

/* ── Backups on a storage ──────────────────────────────────────────────────────────── */

function RestoreModal({ a, storage, onClose }: { a: BackupArchive; storage: string; onClose: () => void }) {
  const { node } = useNodeName();
  const runner = useTaskRunner();
  const [target, setTarget] = useState("");
  const [vmid, setVmid] = useState("");
  const [replace, setReplace] = useState(false);
  const [unique, setUnique] = useState(true);
  const [start, setStart] = useState(false);
  const [live, setLive] = useState(false);
  const [bw, setBw] = useState("");
  const [pool, setPool] = useState("");
  const [typed, setTyped] = useState("");
  const isPbs = /:backup\/(vm|ct)\//.test(a.volid);
  const ok = !replace || typed === String(a.vmid);
  const go = () => void runner.start(`Restore ${a.vmid}`, () => dcApi.restore(node, { storage, volid: a.volid, target: target.trim() || undefined, vmid: !replace && vmid ? Number(vmid) : undefined, replace, unique: replace ? undefined : unique, start, bwlimit: bw === "" ? undefined : Number(bw), pool: pool.trim() || undefined, liveRestore: live && a.type === "qemu" ? true : undefined }));
  return (
    <>
      <Modal size="lg" icon={<RotateCcw className="h-5 w-5" />} title="Restore backup" subtitle={`${a.type === "lxc" ? "Container" : "Virtual machine"} ${a.vmid} · ${when(a.ctime)}`} onClose={onClose}
        footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant={replace ? "danger" : "primary"} disabled={!ok} loading={runner.busy} onClick={go}>{replace ? "Replace the machine" : "Restore"}</Button></>}>
        <div className="space-y-5">
          {runner.error && <Notice tone="critical">{runner.error}</Notice>}
          <Segmented<"new" | "replace"> label="Restore as" value={replace ? "replace" : "new"} onChange={(v) => setReplace(v === "replace")} options={[{ value: "new", label: "A new machine" }, { value: "replace", label: `Over machine ${a.vmid}` }]} />
          {replace ? <Notice tone="warning" title="This overwrites the machine's current disks and settings">Stop it first. Everything on it that isn't in this backup is lost.</Notice> : (
            <div className="grid sm:grid-cols-2 gap-4">
              <Field label="New machine number" hint="Empty takes the next free number." htmlFor="rs-vmid"><Input id="rs-vmid" type="number" inputMode="numeric" min={100} value={vmid} onChange={(e) => setVmid(e.target.value)} /></Field>
              <div className="flex items-start gap-3 pt-6"><Toggle checked={unique} onChange={setUnique} label="Give network cards new MAC addresses" /><span className="text-compact text-ink-2">New MAC addresses, so it doesn't clash with the original</span></div>
            </div>
          )}
          <div className="grid sm:grid-cols-3 gap-4">
            <Field label="Restore to storage" hint="Empty keeps the original storage." htmlFor="rs-target"><Input id="rs-target" value={target} onChange={(e) => setTarget(e.target.value)} className="font-mono" /></Field>
            <Field label="Bandwidth limit (KiB/s)" htmlFor="rs-bw"><Input id="rs-bw" type="number" inputMode="numeric" min={0} value={bw} onChange={(e) => setBw(e.target.value)} /></Field>
            <Field label="Resource pool" htmlFor="rs-pool"><Input id="rs-pool" value={pool} onChange={(e) => setPool(e.target.value)} /></Field>
          </div>
          <div className="flex flex-wrap gap-6">
            <div className="flex items-center gap-3"><Toggle checked={start} onChange={setStart} label="Start after restore" /><span className="text-compact text-ink-2">Start it when the restore finishes</span></div>
            {a.type === "qemu" && isPbs && <div className="flex items-center gap-3"><Toggle checked={live} onChange={setLive} label="Live restore" /><span className="text-compact text-ink-2">Start now, restore in the background (slower at first)</span></div>}
          </div>
          {replace && <Field label={<>Type <span className="font-mono text-ink">{a.vmid}</span> to confirm</>} htmlFor="rs-typed"><Input id="rs-typed" value={typed} onChange={(e) => setTyped(e.target.value)} className="font-mono" autoComplete="off" /></Field>}
        </div>
      </Modal>
      {runner.modal}
    </>
  );
}

function FilesModal({ a, storage, onClose }: { a: BackupArchive; storage: string; onClose: () => void }) {
  const { node } = useNodeName();
  const [path, setPath] = useState("/");
  const q = useQuery({ queryKey: ["node", "backup", "files", storage, a.volid, path], queryFn: () => dcApi.files(node, storage, a.volid, path), retry: 0 });
  const parts = path.split("/").filter(Boolean);
  const open = (e: FileEntry) => e.type === "directory" && setPath(e.path || `${path.replace(/\/$/, "")}/${e.name}`);
  return (
    <Modal size="lg" icon={<FileSearch className="h-5 w-5" />} title="Browse backup" subtitle={`${a.type === "lxc" ? "Container" : "Virtual machine"} ${a.vmid} · ${when(a.ctime)}`} onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      <nav aria-label="Path" className="flex flex-wrap items-center gap-1 text-compact mb-3 font-mono">
        <Button size="sm" variant="ghost" onClick={() => setPath("/")}>/</Button>
        {parts.map((p, i) => <Button key={i} size="sm" variant="ghost" onClick={() => setPath("/" + parts.slice(0, i + 1).join("/"))}>{p}</Button>)}
      </nav>
      {q.isPending ? <p className="text-compact text-ink-3">Opening the backup (this can take a few seconds)…</p> : q.error ? <Notice tone="warning" title="Can't browse this backup">{errorText(q.error)} Browsing works for backups on a Proxmox Backup Server.</Notice> : q.data.entries.length === 0 ? <p className="text-compact text-ink-3">This folder is empty.</p> : (
        <DataTable label="Files in the backup" head={["Name", "Size", "Changed"]} min={420}>
          {q.data.entries.map((e) => (
            <tr key={e.path || e.name} className="border-b border-line last:border-0">
              <Td>{e.type === "directory" ? <button type="button" onClick={() => open(e)} className="transition-control inline-flex items-center gap-2 hover:underline"><Folder className="h-4 w-4 text-ink-3" aria-hidden />{e.name}</button> : <span className="inline-flex items-center gap-2"><FileText className="h-4 w-4 text-ink-3" aria-hidden />{e.name}</span>}</Td>
              <Td mono>{e.size !== null ? formatBytes(e.size) : ""}</Td>
              <Td className="text-ink-2">{when(e.mtime)}</Td>
            </tr>
          ))}
        </DataTable>
      )}
      <p className="text-xs text-ink-3 mt-3">To get files out, restore the backup as a new machine, or download them in the Proxmox Backup Server's own browser.</p>
    </Modal>
  );
}

function NotesModal({ a, storage, onClose }: { a: BackupArchive; storage: string; onClose: () => void }) {
  const { node } = useNodeName();
  const qc = useQueryClient();
  const [notes, setNotes] = useState(a.notes ?? "");
  const save = useMutation({ mutationFn: () => dcApi.setArchive(node, storage, a.volid, { notes }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["node", "backup", "archives"] }); onClose(); } });
  return (
    <Modal size="md" title="Backup notes" subtitle={a.volid} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save notes</Button></>}>
      <Field label="Notes" htmlFor="bn-notes"><Textarea id="bn-notes" rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      {save.error && <p role="alert" className="text-compact text-critical mt-2">{errorText(save.error)}</p>}
    </Modal>
  );
}

function ConfigModal({ a, storage, onClose }: { a: BackupArchive; storage: string; onClose: () => void }) {
  const { node } = useNodeName();
  const q = useQuery({ queryKey: ["node", "backup", "config", storage, a.volid], queryFn: () => dcApi.archiveConfig(node, storage, a.volid), retry: 0 });
  return (
    <Modal size="lg" icon={<FileText className="h-5 w-5" />} title="Machine configuration in this backup" subtitle={a.volid} onClose={onClose} footer={<>{q.data && <CopyButton text={q.data.config} />}<Button onClick={onClose}>Close</Button></>}>
      {q.isPending ? <p className="text-compact text-ink-3">Reading the backup…</p> : q.error ? <Notice tone="warning">{errorText(q.error)}</Notice> : <pre aria-label="Configuration" className="rounded-lg bg-code border border-line p-3 text-xs leading-relaxed font-mono text-ink-2 max-h-[50vh] overflow-auto whitespace-pre-wrap break-all">{q.data.config}</pre>}
    </Modal>
  );
}

function PruneModal({ storage, schema, onClose }: { storage: string; schema: Schema; onClose: () => void }) {
  const { node } = useNodeName();
  const qc = useQueryClient();
  const runner = useTaskRunner(() => void qc.invalidateQueries({ queryKey: ["node", "backup", "archives"] }));
  const [value, setValue] = useState<Values>({});
  const [plan, setPlan] = useState<PrunePlanRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const retention = value["prune-backups"] as Values | undefined;
  const preview = async () => {
    setBusy(true);
    setError(null);
    try {
      setPlan((await dcApi.prunePreview(node, { storage, retention })).plan);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const removing = plan?.filter((p) => p.mark === "remove") ?? [];
  return (
    <>
      <Modal size="lg" title="Prune backups" subtitle={`Storage ${storage}`} onClose={onClose}
        footer={<><Button variant="ghost" onClick={onClose}>Close</Button><Button loading={busy} onClick={() => void preview()}>Preview</Button><Button variant="danger" disabled={removing.length === 0} onClick={() => setConfirm(true)}>Remove {removing.length} {removing.length === 1 ? "backup" : "backups"}…</Button></>}>
        <div className="space-y-4">
          <p className="text-compact text-ink-2">Choose how many backups to keep. Nothing is removed until you look at the preview and confirm. Protected backups are always kept. Leave it empty to use the storage's own retention.</p>
          <SchemaForm schema={{ "prune-backups": schema["prune-backups"] }} value={value} onChange={(v) => { setValue(v); setPlan(null); }} labels={{ "prune-backups": "Keep" }} />
          {error && <p role="alert" className="text-compact text-critical">{error}</p>}
          {plan && (plan.length === 0 ? <p className="text-compact text-ink-3">There are no backups on this storage.</p> : (
            <DataTable label="Prune preview" head={["Backup", "Date", "Result"]} min={480}>
              {plan.map((p) => <tr key={p.volid} className="border-b border-line last:border-0"><Td mono className="break-all">{p.volid}</Td><Td>{when(p.ctime)}</Td><Td>{p.mark === "remove" ? <Status kind="critical" label="Remove" /> : p.mark === "protected" ? <Status kind="idle" label="Protected" /> : <Status kind="good" label="Keep" />}</Td></tr>)}
            </DataTable>
          ))}
        </div>
      </Modal>
      {confirm && <TypedConfirm title="Remove these backups?" subtitle={`${removing.length} from ${storage}`} phrase={storage} action="Remove backups" onConfirm={() => { setConfirm(false); void runner.start("Prune backups", () => dcApi.prune(node, { storage, retention, confirm: storage })); }} onClose={() => setConfirm(false)}><p className="text-compact text-ink-2">They can't be brought back.</p></TypedConfirm>}
      {runner.error && <Notice tone="critical">{runner.error}</Notice>}
      {runner.modal}
    </>
  );
}

function ArchivesTab() {
  const { node, name } = useNodeName();
  const qc = useQueryClient();
  const jobs = useJobs();
  const [storage, setStorage] = useState("");
  const [vm, setVm] = useState("");
  const [modal, setModal] = useState<{ kind: "restore" | "files" | "notes" | "config"; a: BackupArchive } | null>(null);
  const [del, setDel] = useState<BackupArchive | null>(null);
  const [prune, setPrune] = useState(false);
  const storages = jobs.data?.storages ?? [];
  const current = storage || storages[0] || "";
  const q = useQuery({ queryKey: ["node", "backup", "archives", name, current], queryFn: () => dcApi.archives(current, node), enabled: !!current, retry: 1 });
  const refresh = () => qc.invalidateQueries({ queryKey: ["node", "backup", "archives"] });
  const protect = useMutation({ mutationFn: (a: BackupArchive) => dcApi.setArchive(node, current, a.volid, { protected: !a.protected }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (a: BackupArchive) => dcApi.deleteArchive(node, current, a.volid, a.volid.split("/").pop() ?? a.volid), onSuccess: () => { setDel(null); void refresh(); } });
  if (jobs.isPending) return <p className="text-compact text-ink-3">Loading…</p>;
  if (!storages.length) return <EmptyState icon={<Archive className="h-5 w-5" />} title="No storage takes backups" body="Add a storage that accepts backups (a directory, NFS share or Proxmox Backup Server) under Storage." />;
  const rows = (q.data?.archives ?? []).filter((a) => !vm.trim() || String(a.vmid) === vm.trim());
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Storage" htmlFor="ar-storage"><Select id="ar-storage" value={current} onChange={(e) => setStorage(e.target.value)} className="w-48">{storages.map((s) => <option key={s} value={s}>{s}</option>)}</Select></Field>
        <Field label="Machine number" htmlFor="ar-vm"><Input id="ar-vm" inputMode="numeric" value={vm} onChange={(e) => setVm(e.target.value)} className="w-36" placeholder="All" /></Field>
        <Button onClick={() => setPrune(true)}><Trash2 className="h-4 w-4" />Prune…</Button>
        <TasksLink type="vzdump" />
      </div>
      {protect.error && <Notice tone="critical">{errorText(protect.error)}</Notice>}
      <Async q={q}>
        {() => (
          <Card>
            {rows.length === 0 ? <EmptyState icon={<Archive className="h-5 w-5" />} title="No backups here" body="Nothing has been backed up to this storage yet." /> : (
              <DataTable label="Backups" head={["Machine", "Date", "Size", "Notes", "State", ""]} min={900}>
                {rows.map((a) => (
                  <tr key={a.volid} className="border-b border-line last:border-0">
                    <Td><span className="font-mono text-xs">{a.vmid}</span> <span className="text-ink-3">{a.type === "lxc" ? "container" : "VM"}</span></Td>
                    <Td>{when(a.ctime)}</Td>
                    <Td mono>{a.size !== null ? formatBytes(a.size) : "–"}</Td>
                    <Td className="max-w-64"><span className="line-clamp-2 break-words">{a.notes ?? ""}</span></Td>
                    <Td><div className="flex flex-wrap gap-1">{a.protected && <Chip><Lock className="h-3 w-3 inline mr-1" aria-hidden />Protected</Chip>}{a.verified === "ok" && <Chip tone="good">Verified</Chip>}{a.verified === "failed" && <Chip tone="critical">Verify failed</Chip>}</div></Td>
                    <Td><div className="flex gap-1 flex-wrap justify-end">
                      <Button size="sm" variant="ghost" onClick={() => setModal({ kind: "restore", a })}>Restore</Button>
                      {/:backup\/(vm|ct)\//.test(a.volid) && <Button size="sm" variant="ghost" onClick={() => setModal({ kind: "files", a })}><FolderOpen className="h-4 w-4" />Files</Button>}
                      <Button size="sm" variant="ghost" onClick={() => setModal({ kind: "config", a })}>Config</Button>
                      <Button size="sm" variant="ghost" onClick={() => setModal({ kind: "notes", a })}>Notes</Button>
                      <Button size="sm" variant="ghost" loading={protect.isPending && protect.variables?.volid === a.volid} onClick={() => protect.mutate(a)}>{a.protected ? "Unprotect" : "Protect"}</Button>
                      <Button size="sm" variant="ghost" className="text-critical" aria-label="Delete backup" disabled={a.protected} onClick={() => setDel(a)}><Trash2 className="h-4 w-4" /></Button>
                    </div></Td>
                  </tr>
                ))}
              </DataTable>
            )}
          </Card>
        )}
      </Async>
      {modal?.kind === "restore" && <RestoreModal a={modal.a} storage={current} onClose={() => setModal(null)} />}
      {modal?.kind === "files" && <FilesModal a={modal.a} storage={current} onClose={() => setModal(null)} />}
      {modal?.kind === "notes" && <NotesModal a={modal.a} storage={current} onClose={() => setModal(null)} />}
      {modal?.kind === "config" && <ConfigModal a={modal.a} storage={current} onClose={() => setModal(null)} />}
      {prune && jobs.data && <PruneModal storage={current} schema={jobs.data.schema} onClose={() => setPrune(false)} />}
      {del && <TypedConfirm title="Delete this backup?" subtitle={del.volid} phrase={del.volid.split("/").pop() ?? del.volid} action="Delete backup" busy={remove.isPending} error={remove.error ? errorText(remove.error) : null} onConfirm={() => remove.mutate(del)} onClose={() => setDel(null)}><p className="text-compact text-ink-2">It can't be brought back.</p></TypedConfirm>}
    </div>
  );
}

type Tab = "jobs" | "archives" | "uncovered";

export function BackupPage() {
  const { multi } = useNodeName();
  const [tab, setTab] = useState<Tab>("jobs");
  return (
    <PageFrame width="6xl">
      <PageHeader title="Backup" subtitle="Jobs that back machines up, the backups they made, and what to restore from." actions={multi ? <NodeSwitcher /> : undefined} />
      <LiveOnly>
        <Tabs<Tab> value={tab} onChange={setTab} className="mb-6" tabs={[{ id: "jobs", label: "Jobs" }, { id: "archives", label: "Backups" }, { id: "uncovered", label: "Not covered" }]} />
        {tab === "jobs" ? <JobsTab onUncovered={() => setTab("uncovered")} /> : tab === "archives" ? <ArchivesTab /> : <UncoveredTab />}
      </LiveOnly>
    </PageFrame>
  );
}
