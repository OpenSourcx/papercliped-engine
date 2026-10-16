import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Plus, Trash2 } from "lucide-react";
import { accessAdmin, type SyncJob } from "../../data/engine/accessAdmin.ts";
import { errorText } from "../../data/engine/queries.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Chip, Input, SectionTitle, Select, Toggle } from "../../ui/primitives.tsx";
import { QueryState, Table, Td, Th, AField as Field } from "./shared.tsx";

const KEY = ["access", "sync-jobs"] as const;
const when = (s: number | null) => (s ? new Date(s * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—");
const SCHEDULES = [["daily", "Every day at midnight"], ["*-*-* 03:00", "Every day at 03:00"], ["mon..fri 02:30", "Weekdays at 02:30"], ["hourly", "Every hour"], ["sun 04:00", "Sundays at 04:00"]];

function JobModal({ job, realms, onClose }: { job: SyncJob | null; realms: string[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [id, setId] = useState(job?.id ?? "");
  const [realm, setRealm] = useState(job?.realm ?? realms[0] ?? "");
  const [schedule, setSchedule] = useState(job?.schedule ?? "daily");
  const [scope, setScope] = useState(job?.scope ?? "both");
  const [enableNew, setEnableNew] = useState(job?.enableNew ?? true);
  const [vanished, setVanished] = useState<string[]>(job?.removeVanished ?? []);
  const [enabled, setEnabled] = useState(job?.enabled ?? true);
  const [comment, setComment] = useState(job?.comment ?? "");
  const [error, setError] = useState<string | null>(null);
  const preview = useQuery({ queryKey: ["access", "sync-preview", schedule], queryFn: () => accessAdmin.syncJobs.preview(schedule), retry: 0, enabled: schedule.length > 0 });
  const save = useMutation({
    mutationFn: () => (job ? accessAdmin.syncJobs.update(job.id, { schedule, scope, enableNew, removeVanished: vanished, enabled, comment }) : accessAdmin.syncJobs.create({ id, realm, schedule, scope, enableNew, removeVanished: vanished, enabled, comment: comment || undefined })),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      onClose();
    },
    onError: (e) => setError(errorText(e)),
  });
  const flip = (v: string) => setVanished((l) => (l.includes(v) ? l.filter((x) => x !== v) : [...l, v]));
  return (
    <Modal size="md" icon={<CalendarClock className="h-5 w-5" />} title={job ? `Sync job ${job.id}` : "Schedule a sync"} subtitle="Proxmox runs it by itself and keeps its log; each run shows in the task list." onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={!schedule || (!job && (!/^[A-Za-z][A-Za-z0-9_-]{1,63}$/.test(id) || !realm))} onClick={() => save.mutate()}>{job ? "Save job" : "Schedule"}</Button></>}>
      <div className="space-y-4">
        {!job && <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Job id" hint="Letters, digits, - and _."><Input value={id} onChange={(e) => setId(e.target.value.trim())} className="font-mono" autoFocus /></Field>
          <Field label="Realm"><Select value={realm} onChange={(e) => setRealm(e.target.value)}>{realms.map((r) => <option key={r}>{r}</option>)}</Select></Field>
        </div>}
        <Field label="When" hint="A calendar event: daily, hourly, mon..fri 02:30, *-*-* 03:00.">
          <Input value={schedule} onChange={(e) => setSchedule(e.target.value)} className="font-mono" list="sync-presets" spellCheck={false} />
        </Field>
        <datalist id="sync-presets">{SCHEDULES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</datalist>
        <div className="text-compact text-ink-2" aria-live="polite">{preview.data ? <>Next runs: {preview.data.times.slice(0, 3).map((t) => when(t)).join(" · ")}</> : preview.error ? <span className="text-critical">{errorText(preview.error)}</span> : "Checking the schedule…"}</div>
        <Field label="What to sync"><Select value={scope} onChange={(e) => setScope(e.target.value)}><option value="both">Users and groups</option><option value="users">Users</option><option value="groups">Groups</option></Select></Field>
        <div className="flex items-center gap-3"><Toggle checked={enableNew} onChange={setEnableNew} label="Enable new users" /><span className="text-compact text-ink-2">Enable newly found users at once</span></div>
        <fieldset>
          <legend className="text-compact font-medium text-ink-2 mb-1.5">When something has vanished from the directory, remove</legend>
          {[["entry", "the user or group"], ["properties", "its properties"], ["acl", "its permissions"]].map(([v, l]) => <label key={v} className="flex items-center gap-2 text-compact py-0.5"><input type="checkbox" className="h-4 w-4 accent-(--accent)" checked={vanished.includes(v)} onChange={() => flip(v)} />{l}</label>)}
          <p className="text-xs text-ink-3 mt-1">Nothing is removed unless you tick it.</p>
        </fieldset>
        <Field label="Comment"><Input value={comment} onChange={(e) => setComment(e.target.value)} maxLength={512} /></Field>
        <div className="flex items-center gap-3"><Toggle checked={enabled} onChange={setEnabled} label="Job enabled" /><span className="text-compact text-ink-2">{enabled ? "Runs on schedule" : "Paused"}</span></div>
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}

/** Scheduled realm syncs (Proxmox's own jobs): list, add, edit, pause and delete. */
export function SyncJobs({ syncableRealms }: { syncableRealms: string[] }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: accessAdmin.syncJobs.list, retry: 0 });
  const [editing, setEditing] = useState<SyncJob | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const remove = useMutation({ mutationFn: (id: string) => accessAdmin.syncJobs.remove(id), onSuccess: () => qc.invalidateQueries({ queryKey: KEY }), onError: (e) => setError(errorText(e)) });
  return (
    <section aria-label="Scheduled syncs" className="mt-10">
      <SectionTitle action={syncableRealms.length ? <Button onClick={() => setEditing("new")}><Plus className="h-4 w-4" />Schedule a sync</Button> : undefined}>Scheduled syncs</SectionTitle>
      <p className="text-compact text-ink-2 mb-3 max-w-2xl">Keep users and groups in step with your directory automatically. Proxmox runs these jobs on its own schedule.</p>
      {error && <p role="alert" className="text-compact text-critical mb-2">{error}</p>}
      <QueryState query={q}>
        {q.data && (q.data.jobs.length === 0 ? <p className="text-compact text-ink-3">{syncableRealms.length ? "No scheduled syncs yet." : "Add an LDAP or Active Directory realm to schedule syncs."}</p> : (
          <Table min="min-w-[720px]">
            <thead><tr className="border-b border-line"><Th>Job</Th><Th>Realm</Th><Th>When</Th><Th>Next run</Th><Th>Last run</Th><Th /></tr></thead>
            <tbody>
              {q.data.jobs.map((j) => (
                <tr key={j.id} className="border-b border-line last:border-0 hover:bg-surface-2/50">
                  <Td><button className="text-left" onClick={() => setEditing(j)}><div className="font-medium font-mono text-compact">{j.id}</div>{j.comment && <div className="text-xs text-ink-3">{j.comment}</div>}</button></Td>
                  <Td className="font-mono text-compact">{j.realm}</Td>
                  <Td><span className="font-mono text-compact">{j.schedule}</span> {!j.enabled && <Chip>Paused</Chip>}</Td>
                  <Td className="text-ink-2">{j.enabled ? when(j.nextRun) : "—"}</Td>
                  <Td className="text-ink-2">{when(j.lastRun)}{j.status && j.status !== "OK" ? <span className="text-critical"> · {j.status}</span> : null}</Td>
                  <Td className="text-right"><Button size="sm" variant="ghost" aria-label={`Delete job ${j.id}`} onClick={() => remove.mutate(j.id)}><Trash2 className="h-4 w-4" /></Button></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ))}
      </QueryState>
      {editing && <JobModal job={editing === "new" ? null : editing} realms={syncableRealms} onClose={() => setEditing(null)} />}
    </section>
  );
}
