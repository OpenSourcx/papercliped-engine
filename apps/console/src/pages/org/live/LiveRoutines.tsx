import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Copy, History, Play, Plus, Repeat, RotateCw, Trash2, Webhook } from "lucide-react";
import type { RoutineDetail, RoutineListItem, RoutineRunSummary, RoutineTrigger } from "@papercliped-engine/engine-client";
import { ISSUE_PRIORITIES } from "@papercliped-engine/engine-client";
import { useEngine } from "../../../data/store.tsx";
import { ago } from "../../../data/engine/map.ts";
import { PRIORITY_LABEL } from "../../../data/engine/labels.tsx";
import { useAgents } from "../../../data/engine/queries.ts";
import { useRoutine, useRoutineRevisions, useRoutineRuns, useRoutineWrites, useRoutines } from "../../../data/engine/more.ts";
import { Modal } from "../../../ui/Modal.tsx";
import { Button, Card, Chip, EmptyState, Field, IconButton, Input, Notice, PageFrame, PageHeader, SectionTitle, Select, Status, Textarea, Toggle, type StatusKind } from "../../../ui/primitives.tsx";
import { ActionError, LoadError, Loading, useLiveOrg } from "./common.tsx";

/** A few common schedules so nobody has to remember cron; "Custom" takes any five-field expression. */
export const SCHEDULES: { id: string; label: string; cron: string }[] = [
  { id: "hourly", label: "Every hour", cron: "0 * * * *" },
  { id: "daily", label: "Every day at 9:00", cron: "0 9 * * *" },
  { id: "weekdays", label: "Weekdays at 9:00", cron: "0 9 * * 1-5" },
  { id: "weekly", label: "Mondays at 9:00", cron: "0 9 * * 1" },
  { id: "monthly", label: "The first of each month at 9:00", cron: "0 9 1 * *" },
];

export function describeCron(cron: string | null | undefined): string {
  if (!cron) return "";
  return SCHEDULES.find((s) => s.cron === cron)?.label ?? `Cron ${cron}`;
}

const RUN_STATUS: Record<string, [StatusKind, string]> = {
  received: ["working", "Received"],
  issue_created: ["working", "Task created"],
  running: ["working", "Running"],
  coalesced: ["idle", "Joined a running one"],
  skipped: ["idle", "Skipped"],
  completed: ["good", "Done"],
  succeeded: ["good", "Done"],
  failed: ["critical", "Failed"],
};
const runStatus = (s: string): [StatusKind, string] => RUN_STATUS[s] ?? ["idle", s.replace(/_/g, " ")];

function triggerSummary(r: Pick<RoutineListItem, "triggers">): string {
  const t = r.triggers.filter((x) => x.enabled);
  if (!t.length) return "No triggers, runs by hand";
  return t.map((x) => (x.kind === "schedule" ? describeCron(x.cronExpression) : x.kind === "webhook" ? "Webhook" : "API")).join(" · ");
}

export function LiveRoutines() {
  const { org, companyId } = useLiveOrg();
  const { setup } = useEngine();
  const b = `/${setup?.deviceName ?? "pve"}/${org.slug}`;
  const routines = useRoutines(companyId);
  const agents = useAgents(companyId);
  const w = useRoutineWrites(companyId);
  const [creating, setCreating] = useState(false);
  const nameOf = (id: string | null) => (agents.data ?? []).find((a) => a.id === id)?.name ?? "Unassigned";
  const list = (routines.data ?? []).filter((r) => r.status !== "archived");
  return (
    <PageFrame width="4xl">
      <PageHeader title="Routines" subtitle="Recurring work your agents do on a schedule, on a webhook or when you press Run now." actions={<Button variant="primary" onClick={() => setCreating(true)}><Plus className="h-4 w-4" />New routine</Button>} />
      <Card className="divide-y divide-line">
        {routines.isPending && <Loading label="Loading routines" />}
        {routines.error && <LoadError error={routines.error} retry={() => void routines.refetch()} />}
        {routines.data && list.length === 0 && <EmptyState icon={<Repeat className="h-5 w-5" />} title="No routines yet" body="Give an agent a recurring job, such as a daily summary or a weekly check." action={<Button variant="primary" onClick={() => setCreating(true)}><Plus className="h-4 w-4" />New routine</Button>} />}
        {list.map((r) => {
          const last = r.lastRun;
          const busy = w.update.isPending && w.update.variables?.id === r.id;
          return (
            <div key={r.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
              <Repeat className="h-4 w-4 text-ink-3 shrink-0" aria-hidden />
              <Link to={`${b}/routines/${r.id}`} className="flex-1 min-w-48">
                <div className="text-sm font-medium">{r.title}</div>
                <div className="text-xs text-ink-3">{triggerSummary(r)} · {nameOf(r.assigneeAgentId)} · {last ? `last run ${ago(last.triggeredAt)}` : "never run"}</div>
              </Link>
              {last && <Status kind={runStatus(last.status)[0]} label={runStatus(last.status)[1]} />}
              <Button size="sm" variant="ghost" loading={w.run.isPending && w.run.variables === r.id} onClick={() => w.run.mutate(r.id)}><Play className="h-3.5 w-3.5" />Run now</Button>
              <Toggle label={`${r.status === "active" ? "Pause" : "Enable"} ${r.title}`} checked={r.status === "active"} disabled={busy} onChange={(v) => w.update.mutate({ id: r.id, body: { status: v ? "active" : "paused" } })} />
            </div>
          );
        })}
      </Card>
      <ActionError error={w.run.error ?? w.update.error} />
      {creating && <RoutineForm onClose={() => setCreating(false)} />}
    </PageFrame>
  );
}

/** Create (no routine) or edit one routine's instructions, assignee and priority; creating can add a schedule too. */
function RoutineForm({ routine, onClose }: { routine?: RoutineDetail; onClose: () => void }) {
  const { companyId, org } = useLiveOrg();
  const { setup } = useEngine();
  const navigate = useNavigate();
  const agents = useAgents(companyId);
  const w = useRoutineWrites(companyId);
  const [title, setTitle] = useState(routine?.title ?? "");
  const [description, setDescription] = useState(routine?.description ?? "");
  const [assignee, setAssignee] = useState(routine?.assigneeAgentId ?? "");
  const [priority, setPriority] = useState(routine?.priority ?? "medium");
  const [schedule, setSchedule] = useState("none");
  const [cron, setCron] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const cronValue = schedule === "custom" ? cron.trim() : SCHEDULES.find((s) => s.id === schedule)?.cron ?? "";
  const save = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const body = { title: title.trim(), description: description.trim() || null, assigneeAgentId: assignee || null, priority: priority as "medium" };
      if (routine) await w.update.mutateAsync({ id: routine.id, body });
      else {
        const created = await w.create.mutateAsync(body);
        if (cronValue) await w.addTrigger.mutateAsync({ id: created.id, body: { kind: "schedule", cronExpression: cronValue, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" } });
        navigate(`/${setup?.deviceName ?? "pve"}/${org.slug}/routines/${created.id}`);
      }
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={routine ? "Edit routine" : "New routine"} subtitle={`In ${org.name}`} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!title.trim()} onClick={() => void save()}>{routine ? "Save routine" : "Create routine"}</Button></>}>
      <div className="space-y-3">
        <Field label="Name" htmlFor="rt-title"><Input id="rt-title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Morning summary" /></Field>
        <Field label="Instructions" htmlFor="rt-desc" hint="What the agent does each time. It becomes the task's description."><Textarea id="rt-desc" rows={4} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Agent" htmlFor="rt-agent"><Select id="rt-agent" value={assignee} onChange={(e) => setAssignee(e.target.value)}><option value="">Nobody yet</option>{(agents.data ?? []).filter((a) => a.status !== "terminated").map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
          <Field label="Priority" htmlFor="rt-priority"><Select id="rt-priority" value={priority} onChange={(e) => setPriority(e.target.value)}>{ISSUE_PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}</Select></Field>
        </div>
        {!routine && (
          <>
            <Field label="Schedule" htmlFor="rt-schedule" hint="You can add more triggers, including webhooks, after creating it.">
              <Select id="rt-schedule" value={schedule} onChange={(e) => setSchedule(e.target.value)}><option value="none">No schedule, run by hand</option>{SCHEDULES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}<option value="custom">Custom cron expression</option></Select>
            </Field>
            {schedule === "custom" && <Field label="Cron expression" htmlFor="rt-cron" hint="Five fields: minute, hour, day of month, month, day of week."><Input id="rt-cron" className="font-mono" value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 9 * * 1-5" /></Field>}
          </>
        )}
        <ActionError error={error} />
      </div>
    </Modal>
  );
}

export function LiveRoutineDetail() {
  const { routineId = "" } = useParams();
  const { org, companyId } = useLiveOrg();
  const { setup } = useEngine();
  const b = `/${setup?.deviceName ?? "pve"}/${org.slug}`;
  const detail = useRoutine(companyId, routineId);
  const runs = useRoutineRuns(companyId, routineId);
  const w = useRoutineWrites(companyId);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [revisions, setRevisions] = useState(false);
  const [secret, setSecret] = useState<{ url: string; secret: string } | null>(null);
  const r = detail.data;
  const rotate = async (t: RoutineTrigger) => {
    const res = await w.rotate.mutateAsync(t.id);
    if (res.secretMaterial) setSecret({ url: res.secretMaterial.webhookUrl, secret: res.secretMaterial.webhookSecret });
  };
  return (
    <PageFrame width="4xl">
      <Link to={`${b}/routines`} className="inline-flex items-center gap-1.5 text-compact text-ink-3 hover:text-ink mb-4"><ArrowLeft className="h-4 w-4" />Routines</Link>
      {detail.isPending && <Loading label="Loading routine" />}
      {detail.error && <Card><LoadError error={detail.error} retry={() => void detail.refetch()} /></Card>}
      {r && (
        <>
          <PageHeader
            title={r.title}
            subtitle={`${r.assignee ? `Runs with ${r.assignee.name}` : "No agent yet"} · ${PRIORITY_LABEL[r.priority as "medium"] ?? r.priority} priority`}
            actions={<>
              <Button variant="ghost" onClick={() => setRevisions(true)}><History className="h-4 w-4" />Revisions</Button>
              <Button onClick={() => setEditing(true)}>Edit</Button>
              <Button variant="primary" loading={w.run.isPending} onClick={() => w.run.mutate(r.id)}><Play className="h-4 w-4" />Run now</Button>
            </>}
          />
          <div className="flex items-center gap-3 mb-6">
            <Toggle label={r.status === "active" ? "Pause routine" : "Enable routine"} checked={r.status === "active"} onChange={(v) => w.update.mutate({ id: r.id, body: { status: v ? "active" : "paused" } })} />
            <span className="text-compact text-ink-2">{r.status === "active" ? "Enabled" : "Paused: triggers won't start it"}</span>
          </div>
          <ActionError error={w.run.error ?? w.update.error} />
          {r.description && <Card className="p-5 mb-6"><SectionTitle>Instructions</SectionTitle><p className="text-sm text-ink-2 whitespace-pre-wrap">{r.description}</p></Card>}

          <SectionTitle action={<Button size="sm" variant="ghost" onClick={() => setAdding(true)}><Plus className="h-3.5 w-3.5" />Add trigger</Button>}>Triggers</SectionTitle>
          <Card className="divide-y divide-line mb-6">
            {r.triggers.filter((t) => !t.archived).length === 0 && <p className="px-5 py-4 text-sm text-ink-3">No triggers. This routine only runs when you press Run now.</p>}
            {r.triggers.filter((t) => !t.archived).map((t) => (
              <div key={t.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                {t.kind === "webhook" ? <Webhook className="h-4 w-4 text-ink-3" aria-hidden /> : <Repeat className="h-4 w-4 text-ink-3" aria-hidden />}
                <div className="flex-1 min-w-48">
                  <div className="text-sm font-medium">{t.label || (t.kind === "schedule" ? describeCron(t.cronExpression) : t.kind === "webhook" ? "Webhook" : "API")}</div>
                  <div className="text-xs text-ink-3">
                    {t.kind === "schedule" ? <>{describeCron(t.cronExpression)} · {t.timezone}{t.nextRunAt ? ` · next ${new Date(t.nextRunAt).toLocaleString()}` : ""}</> : t.kind === "webhook" ? <span className="font-mono break-all">{t.webhookUrl ?? "Webhook"}</span> : "Started through the engine's API"}
                    {t.lastFiredAt ? ` · last fired ${ago(t.lastFiredAt)}` : ""}
                  </div>
                </div>
                {t.kind === "webhook" && <Button size="sm" variant="ghost" loading={w.rotate.isPending && w.rotate.variables === t.id} onClick={() => void rotate(t)}><RotateCw className="h-3.5 w-3.5" />Rotate secret</Button>}
                <Toggle label={`${t.enabled ? "Disable" : "Enable"} trigger ${t.label ?? t.kind}`} checked={t.enabled} onChange={(v) => w.updateTrigger.mutate({ id: t.id, body: { enabled: v } })} />
                <IconButton label="Remove trigger" size="sm" onClick={() => w.removeTrigger.mutate(t.id)}><Trash2 className="h-4 w-4" /></IconButton>
              </div>
            ))}
          </Card>
          <ActionError error={w.rotate.error ?? w.updateTrigger.error ?? w.removeTrigger.error} />

          <SectionTitle>Run history</SectionTitle>
          <Card className="divide-y divide-line">
            {runs.isPending && <Loading label="Loading runs" />}
            {runs.error && <LoadError error={runs.error} retry={() => void runs.refetch()} />}
            {runs.data?.length === 0 && <p className="px-5 py-4 text-sm text-ink-3">Nothing has run yet.</p>}
            {(runs.data ?? []).map((run) => <RunRow key={run.id} run={run} base={b} />)}
          </Card>
        </>
      )}
      {editing && r && <RoutineForm routine={r} onClose={() => setEditing(false)} />}
      {adding && r && <TriggerForm routineId={r.id} onClose={() => setAdding(false)} onSecret={setSecret} />}
      {revisions && r && <RevisionsModal routineId={r.id} onClose={() => setRevisions(false)} />}
      {secret && <SecretModal {...secret} onClose={() => setSecret(null)} />}
    </PageFrame>
  );
}

function RunRow({ run, base }: { run: RoutineRunSummary; base: string }) {
  const [kind, label] = runStatus(run.status);
  const t = run.linkedIssue;
  return (
    <div className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
      <Status kind={kind} label={label} />
      <div className="flex-1 min-w-48">
        {t ? <Link className="font-medium hover:underline" to={`${base}/tasks/${t.identifier ?? t.id}`}><span className="font-mono text-xs text-ink-3 mr-2">{t.identifier}</span>{t.title}</Link> : <span className="text-ink-2">No task was created</span>}
        <div className="text-xs text-ink-3">{run.source === "manual" ? "Run by hand" : run.trigger?.label || run.trigger?.kind || run.source}{t ? ` · task is ${t.status.replace(/_/g, " ")}` : ""}{run.failureReason ? ` · ${run.failureReason}` : ""}</div>
      </div>
      <span className="text-xs text-ink-3">{ago(run.triggeredAt)}</span>
    </div>
  );
}

function TriggerForm({ routineId, onClose, onSecret }: { routineId: string; onClose: () => void; onSecret: (s: { url: string; secret: string }) => void }) {
  const { companyId } = useLiveOrg();
  const w = useRoutineWrites(companyId);
  const [kind, setKind] = useState<"schedule" | "webhook">("schedule");
  const [schedule, setSchedule] = useState("weekdays");
  const [cron, setCron] = useState("");
  const [label, setLabel] = useState("");
  const [tz, setTz] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const cronValue = schedule === "custom" ? cron.trim() : SCHEDULES.find((s) => s.id === schedule)?.cron ?? "";
  const save = async () => {
    try {
      const res = await w.addTrigger.mutateAsync({ id: routineId, body: kind === "schedule" ? { kind, cronExpression: cronValue, timezone: tz.trim() || "UTC", label: label.trim() || null } : { kind, label: label.trim() || null } });
      if (res.secretMaterial) onSecret({ url: res.secretMaterial.webhookUrl, secret: res.secretMaterial.webhookSecret });
      onClose();
    } catch {
      // The error is shown under the form.
    }
  };
  return (
    <Modal title="Add trigger" size="sm" onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={w.addTrigger.isPending} disabled={kind === "schedule" && !cronValue} onClick={() => void save()}>Add trigger</Button></>}>
      <div className="space-y-3">
        <Field label="Kind" htmlFor="tg-kind"><Select id="tg-kind" value={kind} onChange={(e) => setKind(e.target.value as "schedule")}><option value="schedule">Schedule</option><option value="webhook">Webhook</option></Select></Field>
        {kind === "schedule" && (
          <>
            <Field label="Schedule" htmlFor="tg-schedule"><Select id="tg-schedule" value={schedule} onChange={(e) => setSchedule(e.target.value)}>{SCHEDULES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}<option value="custom">Custom cron expression</option></Select></Field>
            {schedule === "custom" && <Field label="Cron expression" htmlFor="tg-cron"><Input id="tg-cron" className="font-mono" value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 9 * * 1-5" /></Field>}
            <Field label="Time zone" htmlFor="tg-tz"><Input id="tg-tz" value={tz} onChange={(e) => setTz(e.target.value)} /></Field>
          </>
        )}
        <Field label="Label" htmlFor="tg-label" hint="Optional"><Input id="tg-label" value={label} onChange={(e) => setLabel(e.target.value)} /></Field>
        <ActionError error={w.addTrigger.error} />
      </div>
    </Modal>
  );
}

/** A webhook's address and secret, shown once: the engine only returns the secret when it is made or rotated. */
function SecretModal({ url, secret, onClose }: { url: string; secret: string; onClose: () => void }) {
  const copy = (v: string) => void navigator.clipboard?.writeText(v).catch(() => undefined);
  return (
    <Modal title="Webhook secret" subtitle="Copy it now" size="sm" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
      <div className="space-y-3">
        <Notice tone="warning">This secret is shown once. Store it where the sender can read it; if you lose it, rotate it to get a new one.</Notice>
        <Field label="Address"><div className="flex gap-2"><Input readOnly aria-label="Webhook address" className="font-mono" value={url} /><IconButton label="Copy address" variant="secondary" onClick={() => copy(url)}><Copy className="h-4 w-4" /></IconButton></div></Field>
        <Field label="Secret"><div className="flex gap-2"><Input readOnly aria-label="Webhook secret" className="font-mono" value={secret} /><IconButton label="Copy secret" variant="secondary" onClick={() => copy(secret)}><Copy className="h-4 w-4" /></IconButton></div></Field>
      </div>
    </Modal>
  );
}

function RevisionsModal({ routineId, onClose }: { routineId: string; onClose: () => void }) {
  const { companyId } = useLiveOrg();
  const revs = useRoutineRevisions(companyId, routineId);
  const w = useRoutineWrites(companyId);
  const [open, setOpen] = useState<string | null>(null);
  const list = [...(revs.data ?? [])].sort((a, b) => b.revisionNumber - a.revisionNumber);
  const shown = list.find((x) => x.id === open);
  return (
    <Modal title="Revisions" subtitle="Every change to this routine is kept" onClose={onClose}>
      {revs.isPending && <Loading />}
      {revs.error && <LoadError error={revs.error} retry={() => void revs.refetch()} />}
      <div className="divide-y divide-line -mx-5">
        {list.map((v) => (
          <div key={v.id} className="px-5 py-3">
            <div className="flex items-center gap-3">
              <button className="flex-1 text-left" onClick={() => setOpen(open === v.id ? null : v.id)}>
                <div className="text-sm font-medium">Revision {v.revisionNumber}{v.id === list[0]?.id && <Chip tone="accent" className="ml-2">Current</Chip>}</div>
                <div className="text-xs text-ink-3">{v.changeSummary ?? v.title} · {ago(v.createdAt)}</div>
              </button>
              {v.id !== list[0]?.id && <Button size="sm" variant="ghost" loading={w.restore.isPending && w.restore.variables?.revisionId === v.id} onClick={() => w.restore.mutate({ id: routineId, revisionId: v.id })}>Restore</Button>}
            </div>
            {shown?.id === v.id && (
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-compact">
                <dt className="text-ink-3">Name</dt><dd>{v.snapshot.routine.title}</dd>
                <dt className="text-ink-3">Status</dt><dd>{v.snapshot.routine.status}</dd>
                <dt className="text-ink-3">Priority</dt><dd>{v.snapshot.routine.priority}</dd>
                <dt className="text-ink-3">Instructions</dt><dd className="whitespace-pre-wrap">{v.snapshot.routine.description ?? "None"}</dd>
                <dt className="text-ink-3">Triggers</dt><dd>{v.snapshot.triggers.length ? v.snapshot.triggers.map((t) => `${t.kind}${t.cronExpression ? ` ${t.cronExpression}` : ""}${t.enabled ? "" : " (off)"}`).join(", ") : "None"}</dd>
              </dl>
            )}
          </div>
        ))}
      </div>
      <ActionError error={w.restore.error} />
    </Modal>
  );
}
