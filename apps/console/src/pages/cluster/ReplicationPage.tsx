import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, RefreshCw } from "lucide-react";
import { clusterApi, type ReplJob, type ReplList } from "../../data/engine/clusterApi.ts";
import { errorText } from "../../data/engine/queries.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Card, EmptyState, Field, Input, Notice, PageFrame, PageHeader, Select, Status, Toggle, type StatusKind } from "../../ui/primitives.tsx";
import { Async, NodeSwitcher, TypedConfirm } from "../node/common.tsx";
import { ClusterOnly, ago } from "./common.tsx";

const STATE: Record<ReplJob["state"], { kind: StatusKind; label: string }> = {
  ok: { kind: "good", label: "In sync" },
  syncing: { kind: "working", label: "Copying" },
  pending: { kind: "idle", label: "Waiting for first copy" },
  error: { kind: "critical", label: "Failing" },
  disabled: { kind: "off", label: "Off" },
  removing: { kind: "paused", label: "Being removed" },
};

const PRESETS = [["*/15", "Every 15 minutes"], ["hourly", "Every hour"], ["*/2:00", "Every 2 hours"], ["daily", "Every day"], ["02:00", "Every night at 02:00"], ["mon..fri 22:00", "Weekdays at 22:00"]] as const;

function JobModal({ list, job, guest, onClose, onDone }: { list: ReplList; job: ReplJob | null; guest?: number; onClose: () => void; onDone: () => void }) {
  const [vmid, setVmid] = useState(String(job?.guest ?? guest ?? list.guests[0]?.vmid ?? ""));
  const g = list.guests.find((x) => String(x.vmid) === vmid);
  const targets = list.nodes.filter((n) => n.online && n.node !== (job?.source ?? g?.node));
  const [target, setTarget] = useState(job?.target ?? targets[0]?.node ?? "");
  const [schedule, setSchedule] = useState(job?.schedule ?? "*/15");
  const [rate, setRate] = useState(job?.rate ? String(job.rate) : "");
  const [comment, setComment] = useState(job?.comment ?? "");
  const [disabled, setDisabled] = useState(job?.disabled ?? false);
  const save = useMutation<unknown>({
    mutationFn: () => job
      ? clusterApi.saveReplication(job.id, { schedule, rate: rate ? Number(rate) : null, comment: comment || null, disable: disabled, digest: job.digest })
      : clusterApi.createReplication({ guest: Number(vmid), target, schedule, rate: rate ? Number(rate) : undefined, comment: comment || undefined, disable: disabled || undefined }),
    onSuccess: () => { onDone(); onClose(); },
  });
  return (
    <Modal title={job ? `Edit ${job.id}` : "Add a replication job"} subtitle="Copies a machine's disks to another node on a schedule." onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!vmid || !target} loading={save.isPending} onClick={() => save.mutate()}>{job ? "Save job" : "Add job"}</Button></>}>
      <div className="space-y-5">
        {!job && <Field label="Machine" htmlFor="rj-guest"><Select id="rj-guest" value={vmid} onChange={(e) => { setVmid(e.target.value); setTarget(""); }} disabled={guest !== undefined}>{list.guests.map((x) => <option key={x.vmid} value={x.vmid}>{x.name} ({x.vmid}) on {x.node}</option>)}</Select></Field>}
        {!job ? (
          <Field label="Target node" htmlFor="rj-target"><Select id="rj-target" value={target || targets[0]?.node || ""} onChange={(e) => setTarget(e.target.value)}>{targets.map((n) => <option key={n.node}>{n.node}</option>)}</Select></Field>
        ) : <p className="text-compact text-ink-2">Copies to <span className="font-mono">{job.target}</span>. The target can't be changed; remove the job and add a new one.</p>}
        <Field label="Schedule" hint="Presets, or any Proxmox calendar expression such as mon..fri 22:00." htmlFor="rj-sched">
          <div className="space-y-2">
            <Select aria-label="Schedule preset" value={PRESETS.some(([v]) => v === schedule) ? schedule : ""} onChange={(e) => e.target.value && setSchedule(e.target.value)}><option value="">Custom</option>{PRESETS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
            <Input id="rj-sched" value={schedule} onChange={(e) => setSchedule(e.target.value)} className="font-mono" spellCheck={false} />
          </div>
        </Field>
        <Field label="Speed limit (MB/s)" hint="Leave empty for no limit." htmlFor="rj-rate"><Input id="rj-rate" type="number" min={1} value={rate} onChange={(e) => setRate(e.target.value)} className="tabular-nums" /></Field>
        <Field label="Note" htmlFor="rj-comment"><Input id="rj-comment" value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
        <div className="flex items-center gap-3"><Toggle checked={disabled} onChange={setDisabled} label="Turn this job off" /><span className="text-compact text-ink-2">Turn this job off</span></div>
        <Notice tone="info">Replication needs the machine's disks on ZFS storage with the same name on both nodes. Proxmox checks this when the first copy runs and says what is wrong in the job's log.</Notice>
        {save.error && <p role="alert" className="text-compact text-critical">{errorText(save.error)}</p>}
      </div>
    </Modal>
  );
}

function LogModal({ job, onClose }: { job: ReplJob; onClose: () => void }) {
  const q = useQuery({ queryKey: ["cluster", "repl-log", job.id], queryFn: () => clusterApi.replicationLog(job.id), refetchInterval: job.syncing ? 3000 : false, retry: 0 });
  const box = useRef<HTMLPreElement>(null);
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [q.data]);
  return (
    <Modal size="lg" title={`Log of ${job.id}`} subtitle={`${job.source} to ${job.target}`} onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      {q.error && <p role="alert" className="text-compact text-critical mb-2">{errorText(q.error)}</p>}
      <pre ref={box} aria-label="Replication log" className="rounded-lg bg-code border border-line p-3 text-xs leading-relaxed font-mono text-ink-2 max-h-[50vh] overflow-auto whitespace-pre-wrap break-all">{q.data ? (q.data.lines.join("\n") || "(no output yet)") : "…"}</pre>
    </Modal>
  );
}

export function ReplicationTable({ guest, list }: { guest?: number; list: ReplList }) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ["cluster", "replication"] });
  const [edit, setEdit] = useState<{ job: ReplJob | null } | null>(null);
  const [log, setLog] = useState<ReplJob | null>(null);
  const [del, setDel] = useState<ReplJob | null>(null);
  const [keep, setKeep] = useState(false);
  const run = useMutation({ mutationFn: (id: string) => clusterApi.runReplication(id), onSuccess: () => void refresh() });
  const remove = useMutation({ mutationFn: (j: ReplJob) => clusterApi.deleteReplication(j.id, { keep }), onSuccess: () => { setDel(null); void refresh(); } });
  const canAdd = list.guests.length > 0 && list.nodes.filter((n) => n.online).length > 1;
  return (
    <div className="space-y-4">
      {list.statusUnavailable.length > 0 && <Notice tone="warning">No status from {list.statusUnavailable.join(", ")}: {list.statusUnavailable.length === 1 ? "it is" : "they are"} offline or can't be read. The schedule still shows.</Notice>}
      <div><Button variant="primary" disabled={!canAdd} onClick={() => setEdit({ job: null })}><Plus className="h-4 w-4" />Add job…</Button></div>
      {run.error && <p role="alert" className="text-compact text-critical">{errorText(run.error)}</p>}
      <Card className="overflow-x-auto edge-fade-x">
        {!list.jobs.length ? <EmptyState icon={<RefreshCw className="h-5 w-5" />} title="No replication jobs" body="A job copies a machine's disks to another node every few minutes, so a failed node loses at most that much. It is what makes high availability work without shared storage." /> : (
          <table className="w-full text-compact min-w-[780px]">
            <thead><tr className="border-b border-line text-ink-3 text-left"><th className="font-normal px-4 h-10">Job</th>{guest === undefined && <th className="font-normal px-3">Machine</th>}<th className="font-normal px-3">From to</th><th className="font-normal px-3">Schedule</th><th className="font-normal px-3">Last copy</th><th className="font-normal px-3">State</th><th className="px-3"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {list.jobs.map((j) => (
                <tr key={j.id} className="border-b border-line last:border-0 align-top">
                  <td className="px-4 py-3 font-mono">{j.id}{j.comment && <span className="block text-xs text-ink-3 font-sans">{j.comment}</span>}</td>
                  {guest === undefined && <td className="px-3 py-3">{j.guestName ?? "Unknown"} <span className="text-ink-3 font-mono text-xs">{j.guest}</span></td>}
                  <td className="px-3 py-3 font-mono">{j.source || "?"} to {j.target}</td>
                  <td className="px-3 py-3 font-mono text-xs">{j.schedule}{j.rate ? ` · ${j.rate} MB/s` : ""}</td>
                  <td className="px-3 py-3"><div>{ago(j.lastSync)}</div>{j.duration !== null && <div className="text-xs text-ink-3 tabular-nums">took {Math.round(j.duration)} s</div>}{j.nextSync && !j.disabled && <div className="text-xs text-ink-3">next {new Date(j.nextSync * 1000).toLocaleTimeString()}</div>}</td>
                  <td className="px-3 py-3"><Status kind={STATE[j.state].kind} label={STATE[j.state].label} />{j.error && <span className="block text-xs text-critical mt-1 break-words max-w-56">{j.error}</span>}{j.failCount > 0 && <span className="block text-xs text-ink-3 tabular-nums">{j.failCount} failed {j.failCount === 1 ? "try" : "tries"}</span>}</td>
                  <td className="px-3 py-2"><div className="flex gap-1.5 justify-end flex-wrap">
                    <Button size="sm" loading={run.isPending && run.variables === j.id} disabled={j.disabled || j.state === "removing"} onClick={() => run.mutate(j.id)}>Run now</Button>
                    <Button size="sm" variant="ghost" onClick={() => setLog(j)}>Log</Button>
                    <Button size="sm" variant="ghost" onClick={() => setEdit({ job: j })}>Edit</Button>
                    <Button size="sm" variant="ghost" className="text-critical" onClick={() => setDel(j)}>Remove…</Button>
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {!canAdd && !list.jobs.length && <p className="text-xs text-ink-3">Replication needs at least two nodes that are online.</p>}
      {edit && <JobModal list={list} job={edit.job} guest={guest} onClose={() => setEdit(null)} onDone={() => void refresh()} />}
      {log && <LogModal job={log} onClose={() => setLog(null)} />}
      {del && (
        <TypedConfirm title={`Remove ${del.id}?`} subtitle={`Stops copying ${del.guestName ?? del.guest} to ${del.target}`} phrase={del.id} action="Remove job" busy={remove.isPending} error={remove.error ? errorText(remove.error) : null} onClose={() => setDel(null)} onConfirm={() => remove.mutate(del)}>
          <Notice tone="warning">Unless you keep them, the copies on {del.target} are deleted when the job removes itself. Without a copy, {del.guestName ?? "the machine"} can't be restarted there after a failure.</Notice>
          <div className="flex items-center gap-3"><Toggle checked={keep} onChange={setKeep} label="Keep the copies on the target" /><span className="text-compact text-ink-2">Keep the copies on the target</span></div>
        </TypedConfirm>
      )}
    </div>
  );
}

export function ReplicationPage() {
  const q = useQuery({ queryKey: ["cluster", "replication"], queryFn: () => clusterApi.replication(), refetchInterval: 15_000, retry: 1 });
  return (
    <PageFrame width="6xl">
      <PageHeader title="Replication" subtitle="Scheduled copies of machine disks to another node." actions={<NodeSwitcher />} />
      <ClusterOnly what="Replication">{() => <Async q={q}>{(list) => list.denied ? <Notice tone="info">Your Proxmox account can't see replication jobs.</Notice> : <ReplicationTable list={list} />}</Async>}</ClusterOnly>
    </PageFrame>
  );
}

/** The replication card on a machine's page. */
export function MachineReplication({ vmid }: { vmid: number }) {
  const q = useQuery({ queryKey: ["cluster", "replication", vmid], queryFn: () => clusterApi.replication(vmid), retry: 0 });
  if (q.isPending || q.error || q.data.denied || q.data.nodes.length < 2) return null;
  return (
    <section aria-label="Replication">
      <h3 className="text-compact font-semibold uppercase tracking-label text-ink-3 mb-3">Replication</h3>
      <ReplicationTable guest={vmid} list={q.data} />
    </section>
  );
}
