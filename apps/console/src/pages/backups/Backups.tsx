import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Archive, CalendarClock, Loader2, Pencil, Play, RotateCcw, Trash2 } from "lucide-react";
import { ApiError, type BackupJob, type StorageItem } from "../../data/api.ts";
import { describeSchedule, parseBackupName } from "../../data/backend.ts";
import { useEngine } from "../../data/store.tsx";
import { formatBytes } from "../../lib/storage.ts";
import { usePinActions } from "../../pin/PinContext.tsx";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Card, EmptyState, Input, PageFrame, PageHeader, Segmented, Status, Toggle, selectClass } from "../../ui/primitives.tsx";
import { volName } from "../storage/content.ts";

const select = selectClass;
const MODES = [
  { value: "snapshot", label: "Snapshot", hint: "No downtime. The machine keeps running while it's copied." },
  { value: "suspend", label: "Suspend", hint: "Pauses the machine briefly for a more consistent copy." },
  { value: "stop", label: "Stop", hint: "Shuts it down for the most consistent copy, then starts it again." },
] as const;
const q = () => new URLSearchParams(window.location.search);

export interface BackupFile extends StorageItem {
  storage: string;
  type: "lxc" | "qemu";
  at: number | null;
}

/** Every backup on every storage that holds backups, newest first, optionally for one machine. */
export function useBackupFiles(vmid?: number) {
  const engine = useEngine();
  const stores = engine.data.host.storage.filter((s) => s.active !== false && s.content.includes("Backups"));
  const key = stores.map((s) => s.id).join(",");
  const [files, setFiles] = useState<BackupFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    Promise.all(stores.map((s) => engine.backend.content(s.id, "backup").then((items) => items.map((i) => ({ ...i, storage: s.id })), () => [] as (StorageItem & { storage: string })[]))).then(
      (lists) => {
        if (!alive) return;
        const all = lists.flat().flatMap((i): BackupFile[] => {
          const b = parseBackupName(i.volid);
          return b ? [{ ...i, type: b.type, vmid: i.vmid ?? b.vmid, at: i.ctime ?? b.at }] : [];
        });
        setFiles(all.filter((f) => vmid === undefined || f.vmid === vmid).sort((a, b) => (b.at ?? 0) - (a.at ?? 0)));
        setError(null);
      },
      (e) => alive && setError(e instanceof ApiError ? e.message : "Couldn't read backups"),
    );
    return () => {
      alive = false;
    };
  }, [key, vmid, engine.backend, engine.contentVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  return { files, error };
}

const when = (s: number | null) => (s ? new Date(s * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—");

/** The table of backup files, shared by the Backups page and a machine's Backups tab. */
export function BackupTable({ files, showMachine = true }: { files: BackupFile[]; showMachine?: boolean }) {
  const engine = useEngine();
  const nav = useNavigate();
  const device = engine.setup?.deviceName ?? "pve";
  return (
    <table className="w-full text-compact min-w-[620px]">
      <thead>
        <tr className="border-b border-line text-ink-3 text-left">
          <th className="font-normal px-4 h-10">Taken</th>
          {showMachine && <th className="font-normal px-3">Machine</th>}
          <th className="font-normal px-3">Storage</th>
          <th className="font-normal px-3 text-right">Size</th>
          <th className="font-normal px-3">Note</th>
          <th className="px-3 w-[1%]"><span className="sr-only">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        {files.map((f) => {
          const g = engine.data.guests.find((x) => x.vmid === f.vmid);
          return (
            <tr key={f.volid} className="border-b border-line last:border-0 hover:bg-surface-2/50">
              <td className="px-4 py-2.5 whitespace-nowrap tabular-nums" title={f.volid}>{when(f.at)}</td>
              {showMachine && <td className="px-3 whitespace-nowrap">{g ? <Link to={`/${device}/machines/${g.vmid}`} className="hover:underline">{g.name}</Link> : <span className="text-ink-2">Removed machine</span>} <span className="text-ink-3 tabular-nums">#{f.vmid}</span></td>}
              <td className="px-3 text-ink-2">{f.storage}</td>
              <td className="px-3 text-right tabular-nums">{f.size !== null ? formatBytes(f.size) : "—"}</td>
              <td className="px-3 text-ink-2 truncate max-w-[220px]">{f.notes ?? ""}</td>
              <td className="px-3 whitespace-nowrap text-right">
                <Button size="sm" variant="ghost" onClick={() => nav(`?${new URLSearchParams({ ...Object.fromEntries(q()), modal: "restore", storage: f.storage, volid: f.volid }).toString()}`)}><RotateCcw className="h-3.5 w-3.5" />Restore</Button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Backups, like Datacenter → Backup in Proxmox plus every backup file: schedules, back up now, restore. */
export function BackupsPage() {
  const engine = useEngine();
  const nav = useNavigate();
  const [jobs, setJobs] = useState<BackupJob[] | null>(null);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [removing, setRemoving] = useState<BackupJob | null>(null);
  const { files, error } = useBackupFiles();

  useEffect(() => {
    let alive = true;
    engine.backend.backupJobs().then(
      (j) => alive && (setJobs(j), setJobsError(null)),
      (e) => alive && (setJobs([]), setJobsError(e instanceof ApiError ? e.message : "Couldn't read backup schedules")),
    );
    return () => {
      alive = false;
    };
  }, [engine.backend, engine.contentVersion, tick, q().get("modal")]); // eslint-disable-line react-hooks/exhaustive-deps

  usePinActions({
    context: "Backups",
    items: [
      { id: "backup-now", label: "Back up now", icon: <Archive className="h-4 w-4" />, group: "do", run: () => nav("?modal=backup-now") },
      { id: "new-schedule", label: "New schedule", icon: <CalendarClock className="h-4 w-4" />, group: "do", run: () => nav("?modal=backup-job") },
    ],
  }, 10);

  const toggle = async (j: BackupJob) => {
    setJobs((l) => l?.map((x) => (x.id === j.id ? { ...x, enabled: !j.enabled } : x)) ?? null);
    try {
      await engine.backend.toggleBackupJob(j.id, !j.enabled);
    } catch (e) {
      setJobsError(e instanceof ApiError ? e.message : "Couldn't change the schedule");
      setTick((n) => n + 1);
    }
  };
  const remove = async () => {
    if (!removing) return;
    try {
      await engine.backend.deleteBackupJob(removing.id);
    } catch (e) {
      setJobsError(e instanceof ApiError ? e.message : "Couldn't delete the schedule");
    }
    setRemoving(null);
    setTick((n) => n + 1);
  };
  const selection = (j: BackupJob) => (j.all ? "All machines" : j.pool ? `Pool ${j.pool}` : j.vmids.map((v) => engine.data.guests.find((g) => g.vmid === v)?.name ?? `#${v}`).join(", "));
  const unprotected = engine.data.guests.filter((g) => !(jobs ?? []).some((j) => j.enabled && (j.all || j.vmids.includes(g.vmid))));

  return (
    <PageFrame width="6xl">
      <PageHeader title="Backups" subtitle="Scheduled backups, every backup on this device, and restoring them." actions={<Button variant="primary" onClick={() => nav("?modal=backup-now")}><Archive className="h-4 w-4" />Back up now</Button>} />

      <div className="flex items-center justify-between mb-2"><h2 className="text-compact font-semibold uppercase tracking-label text-ink-3">Schedules</h2><Button size="sm" variant="ghost" onClick={() => nav("?modal=backup-job")}><CalendarClock className="h-3.5 w-3.5" />New schedule</Button></div>
      {jobsError && <p role="alert" className="text-compact text-critical mb-3">{jobsError}</p>}
      <div className="space-y-3 mb-8">
        {jobs === null ? (
          <Card className="p-6 text-center text-ink-3 text-sm"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Reading schedules…</Card>
        ) : jobs.length === 0 ? (
          <Card><EmptyState icon={<CalendarClock className="h-5 w-5" />} title="No backup schedules" body="Nothing backs up on its own yet. A nightly schedule that keeps a few copies is a good start." action={<Button variant="primary" onClick={() => nav("?modal=backup-job")}>New schedule</Button>} /></Card>
        ) : (
          jobs.map((j) => (
            <Card key={j.id} className="p-5">
              <div className="flex flex-wrap items-center gap-3">
                <span className="h-9 w-9 rounded-lg bg-surface-2 flex items-center justify-center text-ink-2"><CalendarClock className="h-4 w-4" /></span>
                <div className="flex-1 min-w-[200px]">
                  <div className="font-medium">{describeSchedule(j.schedule)}</div>
                  <div className="text-xs text-ink-3">{selection(j)} · to {j.storage ?? "—"} · {j.mode} · keeps {j.keepLast ?? "all"}{j.nextRun && j.enabled ? ` · next ${when(j.nextRun)}` : ""}</div>
                  {j.comment && <div className="text-xs text-ink-2 mt-0.5">{j.comment}</div>}
                </div>
                <Toggle checked={j.enabled} onChange={() => toggle(j)} label={`${j.enabled ? "Disable" : "Enable"} this schedule`} />
                <Button size="sm" variant="ghost" onClick={() => nav(`?modal=backup-job&id=${encodeURIComponent(j.id)}`)} aria-label="Edit schedule"><Pencil className="h-3.5 w-3.5" />Edit</Button>
                <Button size="sm" variant="ghost" onClick={() => nav(`?modal=backup-now&${j.all ? "all=1" : `vmids=${j.vmids.join(",")}`}&storage=${j.storage ?? ""}`)}><Play className="h-3.5 w-3.5" />Run now</Button>
                <button onClick={() => setRemoving(j)} aria-label="Delete schedule" className="h-8 w-8 rounded-md inline-flex items-center justify-center text-ink-3 hover:text-critical hover:bg-critical/10"><Trash2 className="h-4 w-4" /></button>
              </div>
              {j.keepLast !== null && j.keepLast < 3 && j.enabled && <p className="text-xs text-warning mt-3">Keeping only {j.keepLast} cop{j.keepLast === 1 ? "y" : "ies"} means one bad night can leave you without a good backup. Pin suggests keeping at least 3.</p>}
            </Card>
          ))
        )}
        {jobs !== null && unprotected.length > 0 && engine.data.guests.length > 0 && (
          <p className="text-xs text-ink-3">Not covered by any schedule: {unprotected.slice(0, 6).map((g) => g.name).join(", ")}{unprotected.length > 6 ? ` and ${unprotected.length - 6} more` : ""}.</p>
        )}
      </div>

      <h2 className="text-compact font-semibold uppercase tracking-label text-ink-3 mb-2">All backups</h2>
      {error && <p role="alert" className="text-compact text-critical mb-3">{error}</p>}
      <Card className="overflow-x-auto edge-fade-x">
        {files === null ? (
          <div className="p-8 text-center text-ink-3 text-sm"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Reading backups…</div>
        ) : files.length === 0 ? (
          <EmptyState icon={<Archive className="h-5 w-5" />} title="No backups yet" body="Back up a machine now, or set a schedule. Backups land on storages set up for them." />
        ) : (
          <BackupTable files={files} />
        )}
      </Card>

      {removing && (
        <Modal size="sm" title="Delete this schedule?" subtitle={`${describeSchedule(removing.schedule)} for ${selection(removing)}. Existing backups stay; only the schedule goes.`} onClose={() => setRemoving(null)} footer={<><Button variant="ghost" onClick={() => setRemoving(null)}>Cancel</Button><Button variant="danger" onClick={remove}><Trash2 className="h-4 w-4" />Delete schedule</Button></>}>
          <div />
        </Modal>
      )}
    </PageFrame>
  );
}

function MachinePicker({ all, setAll, vmids, setVmids }: { all: boolean; setAll: (v: boolean) => void; vmids: number[]; setVmids: (v: number[]) => void }) {
  const { data } = useEngine();
  return (
    <fieldset>
      <legend className="text-compact text-ink-2 mb-2">Machines</legend>
      <Segmented value={all ? "all" : "pick"} onChange={(v) => setAll(v === "all")} options={[{ value: "all", label: "All machines" }, { value: "pick", label: "Choose" }]} />
      {!all && (
        <div className="mt-2 max-h-[180px] overflow-y-auto overflow-x-hidden rounded-lg border border-line divide-y divide-line">
          {data.guests.map((g) => (
            <label key={g.vmid} className="flex items-center gap-3 px-3 h-9 text-compact cursor-pointer hover:bg-surface-2/60">
              <input type="checkbox" checked={vmids.includes(g.vmid)} onChange={(e) => setVmids(e.target.checked ? [...vmids, g.vmid] : vmids.filter((v) => v !== g.vmid))} className="accent-[var(--accent)]" />
              <span className="flex-1">{g.name}</span>
              <span className="text-ink-3 tabular-nums">#{g.vmid}</span>
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

function useBackupStorages() {
  const { data } = useEngine();
  return data.host.storage.filter((s) => s.active !== false && s.content.includes("Backups"));
}

/** Back up one or more machines right now. Opened with ?modal=backup-now[&vmids=101,109|&all=1][&storage=...]. */
export function BackupNowModal({ onClose }: { onClose: () => void }) {
  const engine = useEngine();
  const stores = useBackupStorages();
  const p = q();
  const [all, setAll] = useState(p.get("all") === "1" || (!p.get("vmids") && !p.get("vmid")));
  const [vmids, setVmids] = useState<number[]>((p.get("vmids") ?? p.get("vmid") ?? "").split(",").filter(Boolean).map(Number));
  const [storage, setStorage] = useState(stores.find((s) => s.id === p.get("storage"))?.id ?? stores[0]?.id ?? "");
  const [mode, setMode] = useState<"snapshot" | "suspend" | "stop">("snapshot");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const single = !all && vmids.length === 1 ? engine.data.guests.find((g) => g.vmid === vmids[0]) : null;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await engine.backend.runBackup({ all, vmids, storage, mode, notes: notes.trim() || undefined });
      engine.watchTask(r.task, all ? "Back up all machines" : `Back up ${single?.name ?? `${vmids.length} machines`}`);
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't start the backup");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal icon={<Archive className="h-5 w-5" />} title={single ? `Back up ${single.name}` : "Back up now"} subtitle="A full copy, compressed, on the storage you choose. Pin tells you when it's done." onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={run} disabled={busy || !storage || (!all && vmids.length === 0)}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Archive className="h-4 w-4" />}Back up</Button></>}>
      <div className="space-y-4">
        {!single && <MachinePicker all={all} setAll={setAll} vmids={vmids} setVmids={setVmids} />}
        <label className="block">
          <span className="block text-compact text-ink-2 mb-2">Storage</span>
          {stores.length ? <select value={storage} onChange={(e) => setStorage(e.target.value)} className={select}>{stores.map((s) => <option key={s.id} value={s.id}>{s.id} · {formatBytes(Math.max(0, s.total - s.used))} free</option>)}</select> : <p className="text-compact text-ink-3">No storage here is set up for backups.</p>}
        </label>
        <fieldset>
          <legend className="text-compact text-ink-2 mb-2">Mode</legend>
          <Segmented value={mode} onChange={setMode} options={MODES.map((m) => ({ value: m.value, label: m.label }))} />
          <p className="text-xs text-ink-3 mt-1.5">{MODES.find((m) => m.value === mode)!.hint}</p>
        </fieldset>
        <label className="block">
          <span className="block text-compact text-ink-2 mb-2">Note <span className="text-ink-3">(optional)</span></span>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Before upgrading to Debian 13" maxLength={200} />
        </label>
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}

const PRESETS = [
  { value: "21:00", label: "Every night at 21:00" },
  { value: "02:00", label: "Every night at 02:00" },
  { value: "mon..fri 21:00", label: "Weekdays at 21:00" },
  { value: "sun 03:00", label: "Every Sunday at 03:00" },
  { value: "custom", label: "Custom…" },
];

/** Create or edit a backup schedule. Opened with ?modal=backup-job[&id=...]. */
export function BackupJobModal({ onClose }: { onClose: () => void }) {
  const engine = useEngine();
  const stores = useBackupStorages();
  const id = q().get("id");
  const [loaded, setLoaded] = useState(!id);
  const [preset, setPreset] = useState("21:00");
  const [custom, setCustom] = useState("");
  const [all, setAll] = useState(true);
  const [vmids, setVmids] = useState<number[]>([]);
  const [storage, setStorage] = useState(stores[0]?.id ?? "");
  const [mode, setMode] = useState<"snapshot" | "suspend" | "stop">("snapshot");
  const [keepLast, setKeepLast] = useState(3);
  const [enabled, setEnabled] = useState(true);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    engine.backend.backupJobs().then((jobs) => {
      const j = jobs.find((x) => x.id === id);
      if (j) {
        const known = PRESETS.some((p) => p.value === j.schedule);
        setPreset(known ? j.schedule! : "custom");
        if (!known) setCustom(j.schedule ?? "");
        setAll(j.all);
        setVmids(j.vmids);
        if (j.storage) setStorage(j.storage);
        if (j.mode === "snapshot" || j.mode === "suspend" || j.mode === "stop") setMode(j.mode);
        setKeepLast(j.keepLast ?? 3);
        setEnabled(j.enabled);
        setComment(j.comment ?? "");
      }
      setLoaded(true);
    }, () => setLoaded(true));
  }, [id, engine.backend]);

  const schedule = preset === "custom" ? custom.trim() : preset;
  const scheduleErr = preset === "custom" && custom && !/^[\w :.,*/~-]{1,64}$/.test(custom.trim()) ? "Use Proxmox's calendar format, like 21:00, sat 02:00 or mon..fri 22:30." : null;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await engine.backend.saveBackupJob(id, { schedule, storage, all, vmids, mode, keepLast, enabled, comment: comment.trim() || undefined });
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't save the schedule");
    } finally {
      setBusy(false);
    }
  };
  const preview = useMemo(() => describeSchedule(schedule || null), [schedule]);

  return (
    <Modal size="lg" icon={<CalendarClock className="h-5 w-5" />} title={id ? "Edit backup schedule" : "New backup schedule"} subtitle="Runs on the device on its own, and keeps the newest copies." onClose={onClose} footer={<><span className="mr-auto text-xs text-ink-3 hidden sm:block">{preview} · keeps {keepLast}</span><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} disabled={!loaded || busy || !schedule || !!scheduleErr || !storage || (!all && !vmids.length)}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}{id ? "Save" : "Create schedule"}</Button></>}>
      {!loaded ? (
        <p className="text-ink-3 text-sm"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Loading…</p>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="block">
              <span className="block text-compact text-ink-2 mb-2">When</span>
              <select value={preset} onChange={(e) => setPreset(e.target.value)} className={select}>{PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select>
              {preset === "custom" && <Input className="mt-2 font-mono text-compact" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="sat 02:00" spellCheck={false} />}
              {scheduleErr && <span className="block text-xs mt-1.5 text-critical">{scheduleErr}</span>}
            </label>
            <label className="block">
              <span className="block text-compact text-ink-2 mb-2">Storage</span>
              <select value={storage} onChange={(e) => setStorage(e.target.value)} className={select}>{stores.map((s) => <option key={s.id} value={s.id}>{s.id} · {formatBytes(Math.max(0, s.total - s.used))} free</option>)}</select>
            </label>
          </div>
          <MachinePicker all={all} setAll={setAll} vmids={vmids} setVmids={setVmids} />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <fieldset>
              <legend className="text-compact text-ink-2 mb-2">Mode</legend>
              <Segmented value={mode} onChange={setMode} options={MODES.map((m) => ({ value: m.value, label: m.label }))} />
              <p className="text-xs text-ink-3 mt-1.5">{MODES.find((m) => m.value === mode)!.hint}</p>
            </fieldset>
            <label className="block">
              <span className="block text-compact text-ink-2 mb-2">Keep the newest</span>
              <Input type="number" min={1} max={1000} value={keepLast} onChange={(e) => setKeepLast(Math.max(1, Math.min(1000, Number(e.target.value) || 1)))} />
              {keepLast < 3 && <span className="block text-xs mt-1.5 text-warning">Fewer than 3 copies leaves little room if a backup turns out bad.</span>}
            </label>
          </div>
          <label className="block">
            <span className="block text-compact text-ink-2 mb-2">Note <span className="text-ink-3">(optional)</span></span>
            <Input value={comment} onChange={(e) => setComment(e.target.value)} maxLength={200} />
          </label>
          <div className="flex items-center justify-between"><span className="text-sm">Enabled</span><Toggle checked={enabled} onChange={setEnabled} label="Enabled" /></div>
          {error && <p role="alert" className="text-compact text-critical">{error}</p>}
        </div>
      )}
    </Modal>
  );
}

/** Restore a backup, as a new machine (safe) or over the original (only when it's stopped). ?modal=restore&storage=&volid= */
export function RestoreModal({ onClose }: { onClose: () => void }) {
  const engine = useEngine();
  const nav = useNavigate();
  const device = engine.setup?.deviceName ?? "pve";
  const p = q();
  const from = p.get("storage") ?? "";
  const volid = p.get("volid") ?? "";
  const b = parseBackupName(volid);
  const orig = engine.data.guests.find((g) => g.vmid === b?.vmid);
  const [replace, setReplace] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [start, setStart] = useState(false);
  const [targets, setTargets] = useState<{ storage: string; avail: number | null }[]>([]);
  const [storage, setStorage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    engine.backend.machineOptions().then((o) => {
      const list = (b?.type === "qemu" ? o.vmStorages : o.storages).map((s) => ({ storage: s.storage, avail: s.avail }));
      setTargets(list);
      setStorage(list[0]?.storage ?? "");
    }, () => setTargets([]));
  }, [engine.backend, b?.type]);

  if (!b) return <Modal size="sm" title="Not a machine backup" onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}><p className="text-compact text-ink-3 break-all">{volid}</p></Modal>;
  const running = orig?.status === "running";
  const canReplace = !running;
  const confirmed = !replace || !orig || confirmText === orig.name;

  const go = async () => {
    setBusy(true);
    setError(null);
    const r = await engine.restoreBackup({ from, volid, storage, replace, start });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    onClose();
    nav(`/${device}/machines/${r.vmid}`);
  };

  return (
    <Modal icon={<RotateCcw className="h-5 w-5" />} title={`Restore ${orig?.name ?? `machine #${b.vmid}`}`} subtitle={`From the backup taken ${when(b.at)} on ${from}.`} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant={replace ? "danger" : "primary"} onClick={go} disabled={busy || !storage || !confirmed || (replace && !canReplace)}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}{replace ? "Replace and restore" : "Restore as new machine"}</Button></>}>
      <div className="space-y-4">
        <Segmented value={replace ? "replace" : "new"} onChange={(v) => setReplace(v === "replace")} options={[{ value: "new", label: "As a new machine" }, { value: "replace", label: "Over the original" }]} />
        {replace ? (
          !orig ? (
            <p className="text-compact text-ink-2">The original machine #{b.vmid} no longer exists, so this restores it under its old number.</p>
          ) : running ? (
            <Status kind="warning" label={`${orig.name} is running. Shut it down first; restoring over a running machine isn't allowed.`} />
          ) : (
            <div className="rounded-lg border border-critical/30 bg-critical/5 p-3 text-compact">
              <p className="text-ink-2">This erases {orig.name}'s current disks and replaces them with the backup. Anything changed since {when(b.at)} is lost.</p>
              <label className="block mt-3"><span className="block text-xs text-ink-3 mb-1.5">Type <span className="font-mono text-ink-2">{orig.name}</span> to confirm</span><Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} spellCheck={false} /></label>
            </div>
          )
        ) : (
          <p className="text-compact text-ink-2">A copy appears next to the original with a new number. Nothing existing is touched.</p>
        )}
        <label className="block">
          <span className="block text-compact text-ink-2 mb-2">Restore disks to</span>
          <select value={storage} onChange={(e) => setStorage(e.target.value)} className={select}>{targets.map((t) => <option key={t.storage} value={t.storage}>{t.storage}{t.avail !== null ? ` · ${formatBytes(t.avail)} free` : ""}</option>)}</select>
        </label>
        <div className="flex items-center justify-between"><span className="text-sm">Start it when done</span><Toggle checked={start} onChange={setStart} label="Start it when done" /></div>
        <p className="text-micro text-ink-3 font-mono break-all">{volName(volid)}</p>
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}
