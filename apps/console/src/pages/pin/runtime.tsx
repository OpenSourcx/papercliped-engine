import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpCircle, Bell, BellOff, Check, ChevronDown, ChevronRight, ClipboardList, Pause, Play, Plus, RotateCcw, Trash2, Workflow, Zap } from "lucide-react";
import { useEngine } from "../../data/store.tsx";
import { usePin } from "../../pin/PinContext.tsx";
import { Markdown } from "./notes/Markdown.tsx";
import { RemindLater, RestartNotice, UpdateOptions } from "../updates/UpdateOptions.tsx";
import { errorMessage, pinRt, type AutomationInput, type AutomationView, type InboxNotice, type NoticeKind, type Plan, type PlanStep, type Run, type StepState, type UpdateInfo } from "../../data/engine/pinRuntimeApi.ts";
import { cn } from "../../lib/storage.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Card, Chip, EmptyState, Field, Input, Notice, Segmented, Select, Skeleton, Status, Toggle } from "../../ui/primitives.tsx";
import { TypedConfirm } from "../node/common.tsx";
import { httpUrl } from "../../lib/safeUrl";

type Inbox = Awaited<ReturnType<typeof pinRt.inbox>>;

/**
 * Pin's runtime on its page (live devices only): the inbox and what to be told about, Agent mode plans to approve step by
 * step, automations with their run history, and update awareness. Each tab reads the host service (docs/PIN.md).
 */

export const ago = (ms: number | null | undefined, now = Date.now()) => {
  if (!ms) return "never";
  const s = Math.max(0, (now - ms) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};
const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "");

function Loading({ rows = 3 }: { rows?: number }) {
  return <div className="space-y-3" aria-busy="true">{Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-16 w-full" />)}</div>;
}
function Failed({ error, retry }: { error: unknown; retry: () => void }) {
  return <Notice tone="critical" title="Couldn't read this from the device" action={<Button size="sm" onClick={retry}>Try again</Button>}>{errorMessage(error)}</Notice>;
}

/* ── Inbox ─────────────────────────────────────────────────────────────────────────── */

const KIND_LABEL: Record<NoticeKind, [string, string]> = {
  task_finished: ["Task finished", "A download, backup, clone or power change you started has finished."],
  backup_failed: ["Backup failed", "A backup on a machine you can see did not complete."],
  node_event: ["Device events", "A device goes offline or comes back."],
  approval: ["Approvals", "An organization is waiting for your decision."],
  automation: ["Automations", "An automation acted, failed, or was paused."],
  proposal: ["Pin's proposals", "Pin wrote a plan that waits for your review."],
  update: ["Updates", "A new version of ePaperclip is available."],
};
const LEVEL: Record<InboxNotice["level"], "idle" | "warning" | "critical"> = { info: "idle", warning: "warning", critical: "critical" };

export function InboxTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["pin", "inbox"], queryFn: () => pinRt.inbox(true), refetchInterval: 30_000 });
  const done = () => qc.invalidateQueries({ queryKey: ["pin", "inbox"] });
  const read = useMutation({ mutationFn: pinRt.markRead, onSuccess: done });
  const clear = useMutation({ mutationFn: pinRt.clearRead, onSuccess: done });
  const [prefsOpen, setPrefsOpen] = useState(false);
  if (q.isPending) return <Loading />;
  if (q.error) return <Failed error={q.error} retry={() => q.refetch()} />;
  const { notifications, unread } = q.data;
  return (
    <div className="space-y-4 fade-in">
      <div className="flex flex-wrap items-center gap-2 justify-between">
        <p className="text-compact text-ink-3 max-w-xl">Everything lands here. Only warnings and failures, outside your quiet hours, make Pin's island expand.</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" disabled={!unread} loading={read.isPending} onClick={() => read.mutate({ all: true })}><Check className="h-3.5 w-3.5" />Mark all read</Button>
          <Button size="sm" variant="ghost" disabled={notifications.every((n) => !n.read)} loading={clear.isPending} onClick={() => clear.mutate()}>Clear read</Button>
          <Button size="sm" onClick={() => setPrefsOpen(true)}><Bell className="h-3.5 w-3.5" />What to be told</Button>
        </div>
      </div>
      {notifications.length === 0 ? (
        <Card><EmptyState icon={<BellOff className="h-5 w-5" />} title="Nothing needs you" body="Finished tasks, failed backups, device events, approvals and Pin's proposals show up here." /></Card>
      ) : (
        <Card className="divide-y divide-line">
          {notifications.map((n) => (
            <div key={n.id} className="flex flex-wrap items-start gap-x-3 gap-y-2 p-4">
              <Status kind={LEVEL[n.level]} label={n.level === "info" ? "Info" : n.level === "warning" ? "Warning" : "Failed"} className="shrink-0 sm:w-20" />
              <div className="flex-1 min-w-0 basis-48">
                <div className={cn("text-sm text-pretty", n.read ? "text-ink-2" : "font-medium")}>{n.title}</div>
                <p className="text-compact text-ink-3 text-pretty">{n.body}</p>
                <div className="text-xs text-ink-3 mt-1" title={when(n.at)}>{KIND_LABEL[n.kind][0]} · {ago(n.at)}</div>
              </div>
              {!n.read && <Button size="sm" variant="ghost" onClick={() => read.mutate({ ids: [n.id] })}>Mark read</Button>}
            </div>
          ))}
        </Card>
      )}
      {prefsOpen && <PrefsModal prefs={q.data.prefs} kinds={q.data.kinds} onClose={() => setPrefsOpen(false)} onSaved={done} />}
    </div>
  );
}

function PrefsModal({ prefs, kinds, onClose, onSaved }: { prefs: Inbox["prefs"]; kinds: NoticeKind[]; onClose: () => void; onSaved: () => void }) {
  const [muted, setMuted] = useState(prefs.muted);
  const [quiet, setQuiet] = useState(prefs.quiet);
  const [qh, setQh] = useState(prefs.quietHours);
  const save = useMutation({ mutationFn: () => pinRt.savePrefs({ muted, quiet, quietHours: qh }), onSuccess: () => { onSaved(); onClose(); } });
  const flip = (list: NoticeKind[], k: NoticeKind, on: boolean) => (on ? [...new Set([...list, k])] : list.filter((x) => x !== k));
  return (
    <Modal size="md" title="What Pin tells you" subtitle="Saved for your account on this device." onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save preferences</Button></>}>
      <div className="space-y-5">
        <div className="divide-y divide-line">
          {kinds.map((k) => (
            <div key={k} className="py-3 flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">{KIND_LABEL[k][0]}</div>
                <div className="text-xs text-ink-3 text-pretty">{KIND_LABEL[k][1]}</div>
              </div>
              <div className="flex flex-col items-end gap-2 shrink-0">
                <label className="flex items-center gap-2 text-compact text-ink-2">Tell me<Toggle label={`Tell me about ${KIND_LABEL[k][0]}`} checked={!muted.includes(k)} onChange={(v) => setMuted(flip(muted, k, !v))} /></label>
                <label className="flex items-center gap-2 text-compact text-ink-2">Quietly<Toggle label={`Only quietly for ${KIND_LABEL[k][0]}`} checked={quiet.includes(k)} disabled={muted.includes(k)} onChange={(v) => setQuiet(flip(quiet, k, v))} /></label>
              </div>
            </div>
          ))}
        </div>
        <div className="space-y-3">
          <label className="flex items-center justify-between gap-3 text-sm font-medium">Quiet hours<Toggle label="Quiet hours" checked={qh.enabled} onChange={(v) => setQh({ ...qh, enabled: v })} /></label>
          <p className="text-xs text-ink-3">During quiet hours the island never expands. The inbox still collects everything.</p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="From" htmlFor="qh-from"><Input id="qh-from" type="time" value={qh.from} disabled={!qh.enabled} onChange={(e) => setQh({ ...qh, from: e.target.value })} /></Field>
            <Field label="Until" htmlFor="qh-to"><Input id="qh-to" type="time" value={qh.to} disabled={!qh.enabled} onChange={(e) => setQh({ ...qh, to: e.target.value })} /></Field>
          </div>
          <p className="text-xs text-ink-3">Times are the device's clock.</p>
        </div>
        {save.error && <p role="alert" className="text-compact text-critical">{errorMessage(save.error)}</p>}
      </div>
    </Modal>
  );
}

/* ── Plans (Agent mode) ────────────────────────────────────────────────────────────── */

const STEP_STATUS: Record<StepState, ["idle" | "working" | "good" | "critical" | "off", string]> = {
  pending: ["idle", "Waiting for you"],
  running: ["working", "Running"],
  done: ["good", "Done"],
  failed: ["critical", "Failed"],
  skipped: ["off", "Skipped"],
  rejected: ["off", "Rejected"],
};
const PLAN_STATUS: Record<Plan["status"], ["idle" | "working" | "good" | "critical" | "off", string]> = { pending: ["idle", "Waiting for you"], running: ["working", "Running"], done: ["good", "Done"], failed: ["critical", "Stopped by a failure"], cancelled: ["off", "Cancelled"] };

export function PlansTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["pin", "plans"], queryFn: pinRt.plans, refetchInterval: 15_000 });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["pin", "plans"] }); void qc.invalidateQueries({ queryKey: ["pin", "inbox"] }); };
  if (q.isPending) return <Loading />;
  if (q.error) return <Failed error={q.error} retry={() => q.refetch()} />;
  if (!q.data.plans.length) return <Card className="fade-in"><EmptyState icon={<ClipboardList className="h-5 w-5" />} title="No plans yet" body="In Agent mode, Pin writes a multi-step plan when a goal needs several changes. You review it here and approve each step; nothing runs until you do." /></Card>;
  return (
    <div className="space-y-4 fade-in">
      <p className="text-compact text-ink-3 max-w-2xl">Nothing here runs by itself. Approve a step and it runs now, as you, so Proxmox's permissions apply. Steps that interrupt a machine ask you to type a phrase first.</p>
      {q.data.plans.map((p) => <PlanCard key={p.id} plan={p} onChanged={refresh} />)}
    </div>
  );
}

export function PlanCard({ plan, onChanged }: { plan: Plan; onChanged: () => void }) {
  const [confirming, setConfirming] = useState<PlanStep | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [kind, label] = PLAN_STATUS[plan.status];
  const nextId = plan.steps.find((s) => s.state === "pending")?.id;
  const open = plan.status === "pending";
  const act = async (step: PlanStep, what: "approve" | "skip" | "reject", confirm?: string) => {
    setBusy(step.id + what);
    setError(null);
    try {
      await pinRt.decide(plan.id, step.id, what, confirm);
      setConfirming(null);
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2 justify-between">
        <div className="min-w-0">
          <h3 className="font-medium text-pretty">{plan.title}</h3>
          {plan.summary && <p className="text-compact text-ink-3 text-pretty mt-0.5">{plan.summary}</p>}
          <p className="text-xs text-ink-3 mt-1">{plan.createdBy === "automation" ? "Proposed by an automation" : "Proposed by Pin"} · {ago(plan.createdAt)}</p>
        </div>
        <Status kind={kind} label={label} />
      </div>
      <ol className="mt-4 space-y-2">
        {plan.steps.map((s, i) => {
          const [sk, sl] = STEP_STATUS[s.state];
          return (
            <li key={s.id} className={cn("rounded-lg border p-3", s.id === nextId && open ? "border-line-strong bg-surface-2/60" : "border-line")}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className="font-mono text-micro text-ink-3 tabular-nums w-5">{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-pretty">{s.label}</div>
                  {s.destructive && s.state === "pending" && <div className="text-xs text-ink-3">Interrupts a machine or can't be undone. You'll type <span className="font-mono">{s.confirmPhrase}</span> to approve.</div>}
                  {s.error && <div role="alert" className="text-xs text-critical mt-0.5">{s.error}</div>}
                  {s.result && s.state === "done" && <div className="text-xs text-ink-3 mt-0.5">{s.result}{s.decidedBy ? ` Approved by ${s.decidedBy}.` : ""}</div>}
                </div>
                <Status kind={sk} label={sl} />
                {s.id === nextId && open && (
                  <div className="flex gap-2">
                    <Button size="sm" variant={s.destructive ? "danger" : "primary"} loading={busy === s.id + "approve"} onClick={() => (s.destructive ? setConfirming(s) : act(s, "approve"))}>{s.destructive ? "Review and approve" : "Approve step"}</Button>
                    <Button size="sm" variant="ghost" loading={busy === s.id + "skip"} onClick={() => act(s, "skip")}>Skip</Button>
                    <Button size="sm" variant="ghost" loading={busy === s.id + "reject"} onClick={() => act(s, "reject")}>Reject plan</Button>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {error && <p role="alert" className="text-compact text-critical mt-3">{error}</p>}
      {confirming && (
        <TypedConfirm title="Approve this step" subtitle={plan.title} phrase={confirming.confirmPhrase ?? ""} action="Approve and run" busy={busy === confirming.id + "approve"} error={error}
          onConfirm={() => act(confirming, "approve", confirming.confirmPhrase ?? "")} onClose={() => { setConfirming(null); setError(null); }}>
          <p className="text-sm text-pretty">{confirming.label}. It runs now, as you.</p>
        </TypedConfirm>
      )}
    </Card>
  );
}

/* ── Automations ───────────────────────────────────────────────────────────────────── */

const RUN_STATUS: Record<Run["status"], ["idle" | "working" | "good" | "critical" | "warning", string]> = { running: ["working", "Running"], ok: ["good", "Done"], failed: ["critical", "Failed"], skipped: ["idle", "Nothing to do"], proposed: ["warning", "Waiting for approval"] };

export function AutomationsLive() {
  const engine = useEngine();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["pin", "automations"], queryFn: pinRt.automations, refetchInterval: 20_000 });
  const refresh = () => qc.invalidateQueries({ queryKey: ["pin", "automations"] });
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<AutomationView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<unknown>) => async () => {
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  if (q.isPending) return <Loading />;
  if (q.error) return <Failed error={q.error} retry={() => q.refetch()} />;
  const mode = engine.setup?.pinMode ?? "assistant";
  return (
    <div className="space-y-4 fade-in">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-compact text-ink-3 max-w-2xl text-pretty">Run on this device, even when no browser is open. Each acts through its own Proxmox token for its owner. {mode === "assistant" ? "In Assistant mode, an action becomes a proposal you approve." : "In Agent mode, an action runs and you're told."}</p>
        <Button variant="primary" onClick={() => setCreating(true)}><Plus className="h-4 w-4" />New automation</Button>
      </div>
      {!q.data.runnerReady && <Notice tone="warning" title="The runner isn't running">The host service started without Pin's runtime, so automations are stored but nothing runs them.</Notice>}
      {error && <Notice tone="critical" title="That didn't work">{error}</Notice>}
      {q.data.automations.length === 0 ? (
        <Card><EmptyState icon={<Workflow className="h-5 w-5" />} title="No automations yet" body='Tell Pin what you want ("snapshot every container tagged prod each night"), or build one here.' action={<Button variant="primary" onClick={() => setCreating(true)}>New automation</Button>} /></Card>
      ) : q.data.automations.map((a) => (
        <AutomationRow key={a.id} a={a} showOwner={q.data.canSeeAll}
          onPause={run(() => pinRt.automationAction(a.id, a.paused ? "resume" : "pause"))} onRun={run(() => pinRt.runNow(a.id))} onRenew={run(() => pinRt.renewAutomation(a.id))} onDelete={() => setDeleting(a)} />
      ))}
      <p className="text-xs text-ink-3">Automations can notify, shut down, stop, start or take snapshots. They can never delete anything, and machines tagged <span className="font-mono">protected</span> only ever get a notification.</p>
      {creating && <NewAutomation onClose={() => setCreating(false)} onCreated={() => { setCreating(false); void refresh(); }} />}
      {deleting && (
        <TypedConfirm title="Delete this automation" subtitle={deleting.name} phrase={deleting.name} action="Delete automation" onClose={() => setDeleting(null)}
          onConfirm={async () => { const d = deleting; setDeleting(null); await run(() => pinRt.deleteAutomation(d.id))(); }}>
          <p className="text-sm text-pretty">Its Proxmox token is removed and its run history stays until it ages out.</p>
        </TypedConfirm>
      )}
    </div>
  );
}

function AutomationRow({ a, showOwner, onPause, onRun, onRenew, onDelete }: { a: AutomationView; showOwner: boolean; onPause: () => void; onRun: () => void; onRenew: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const kind = a.paused ? "paused" : a.running ? "working" : a.lastStatus === "failed" ? "critical" : a.lastRunAt ? "good" : "idle";
  const label = a.paused ? (a.paused.by === "runner" ? "Paused after failing" : "Paused") : a.running ? "Running" : a.lastStatus === "failed" ? "Last run failed" : a.lastRunAt ? "Working" : "Waiting for its first run";
  const wrap = (id: string, fn: () => void) => async () => { setBusy(id); try { await (fn as () => unknown)(); } finally { setBusy(null); } };
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <span className="h-9 w-9 rounded-lg bg-surface-2 flex items-center justify-center text-ink-2 shrink-0"><Workflow className="h-4 w-4" /></span>
        <div className="flex-1 min-w-0 basis-60">
          <div className="font-medium text-pretty">{a.name}</div>
          <p className="text-sm text-ink-2 text-pretty">{a.readBack}</p>
          <div className="flex flex-wrap items-center gap-2 mt-2">
            <Status kind={kind} label={label} />
            <span className="text-xs text-ink-3">Last run {ago(a.lastRunAt)}{a.nextRunAt && !a.paused ? ` · next ${when(a.nextRunAt)}` : ""}</span>
            <Chip tone={a.permissions === "scoped" ? "good" : "warning"}>{a.permissions === "scoped" ? "Limited permissions" : "Acts as its owner"}</Chip>
            {showOwner && <Chip>{a.owner}</Chip>}
            <span className={`text-xs ${a.tokenExpiresAt && a.tokenExpiresAt - Date.now() < 7 * 86_400_000 ? "text-warning" : "text-ink-3"}`}>{a.tokenExpiresAt ? `Token ${a.tokenExpiresAt < Date.now() ? "expired" : "ends"} ${new Date(a.tokenExpiresAt).toLocaleDateString()}` : "Token has no end date yet"}</span>
          </div>
          {a.paused && <Notice tone={a.paused.by === "runner" ? "warning" : "info"} className="mt-3">{a.paused.reason}</Notice>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" loading={busy === "pause"} onClick={wrap("pause", onPause)}>{a.paused ? <><Play className="h-3.5 w-3.5" />Resume</> : <><Pause className="h-3.5 w-3.5" />Pause</>}</Button>
          <Button size="sm" disabled={!!a.paused || a.running} loading={busy === "run"} onClick={wrap("run", onRun)}><Zap className="h-3.5 w-3.5" />Run now</Button>
          <Button size="sm" loading={busy === "renew"} onClick={wrap("renew", onRenew)} aria-label={`Renew the token of ${a.name}`}>Renew token</Button>
          <Button size="sm" variant="ghost" aria-label={`Delete ${a.name}`} onClick={onDelete}><Trash2 className="h-3.5 w-3.5" />Delete</Button>
        </div>
      </div>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="transition-control mt-3 inline-flex items-center gap-1 text-compact text-ink-3 hover:text-ink">
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}Run history
      </button>
      {open && <RunHistory id={a.id} />}
    </Card>
  );
}

function RunHistory({ id }: { id: string }) {
  const q = useQuery({ queryKey: ["pin", "runs", id], queryFn: () => pinRt.runs(id), refetchInterval: 20_000 });
  if (q.isPending) return <Loading rows={2} />;
  if (q.error) return <Failed error={q.error} retry={() => q.refetch()} />;
  if (!q.data.runs.length) return <p className="text-compact text-ink-3 mt-2">No runs yet. A pass that finds nothing to do isn't recorded.</p>;
  return (
    <ul className="mt-2 divide-y divide-line">
      {q.data.runs.map((r) => {
        const [k, l] = RUN_STATUS[r.status];
        return (
          <li key={r.id} className="py-2.5">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <Status kind={k} label={l} />
              <span className="text-xs text-ink-3" title={when(r.startedAt)}>{ago(r.startedAt)} · {r.trigger === "manual" ? "run by hand" : "on schedule"}</span>
            </div>
            {r.error && <p role="alert" className="text-compact text-critical mt-1 text-pretty">{r.error}</p>}
            {r.steps.map((s, i) => (
              <div key={i} className="text-compact text-ink-2 mt-1 text-pretty"><span className="font-mono text-ink-3">{s.vmid || ""}</span> {s.name ?? ""} {s.action}: {s.result}{s.detail ? `. ${s.detail}` : ""}{s.attempts && s.attempts > 1 ? ` (${s.attempts} attempts)` : ""}</div>
            ))}
          </li>
        );
      })}
    </ul>
  );
}

const METRICS = [["memory_percent", "its memory use"], ["cpu_percent", "its CPU use"], ["disk_percent", "its disk use"]] as const;
const ACTIONS = [["notify", "Notify me"], ["shutdown", "Shut it down"], ["stop", "Stop it"], ["start", "Start it"], ["snapshot", "Take a snapshot"]] as const;

const EXAMPLES = [
  "If a container uses more than 50% of its memory, shut it down",
  "Snapshot every container tagged prod each night at 2:30",
  "Tell me when any machine's disk is over 90% full",
  "Stop the test containers every evening",
];

/**
 * "New automation" from anywhere (`?modal=new-automation`): say what should happen in your own words and Pin sets it up
 * and reads it back before anything is saved, or build it by hand with the form. Not to be confused with a task, which is
 * work for an organization's agents; an automation is a rule this device runs by itself.
 */
export function NewAutomationModal({ onClose }: { onClose: () => void }) {
  const engine = useEngine();
  const pin = usePin();
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [form, setForm] = useState(false);
  if (form) return <NewAutomation onClose={onClose} onCreated={() => { void qc.invalidateQueries({ queryKey: ["pin", "automations"] }); onClose(); }} />;
  const ask = () => {
    if (!text.trim()) return;
    pin.send(`Set up an automation: ${text.trim()}`);
    onClose();
  };
  return (
    <Modal size="md" icon={<Zap className="h-5 w-5" />} title="New automation" subtitle="A rule this device runs by itself. Say what should happen; Pin reads it back before anything is saved." onClose={onClose}
      footer={<>{engine.live && <Button variant="ghost" className="mr-auto" onClick={() => setForm(true)}>Build it with a form</Button>}<Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!text.trim()} onClick={ask}>Set it up with Pin</Button></>}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); ask(); }}>
        <Field label="What should happen?" htmlFor="na-text">
          <textarea id="na-text" autoFocus rows={4} value={text} maxLength={500} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) ask(); }} placeholder="When a container uses most of its memory for 5 minutes, shut it down and tell me" className="w-full resize-none rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-sm outline-none focus:border-accent" />
        </Field>
        <div>
          <div className="text-xs text-ink-3 mb-2">Or start from one of these</div>
          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map((q) => <button key={q} type="button" onClick={() => setText(q)} className="transition-control text-compact text-left px-3 py-1.5 rounded-full border border-line bg-surface-2/60 hover:bg-surface-3 text-ink-2 hover:text-ink">{q}</button>)}
          </div>
        </div>
        <p className="text-xs text-ink-3 text-pretty">Automations can notify, shut down, stop, start or take snapshots. They can never delete anything, and machines tagged <span className="font-mono">protected</span> only ever get a notification.</p>
      </form>
    </Modal>
  );
}

function NewAutomation({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"condition" | "schedule">("condition");
  const [metric, setMetric] = useState("memory_percent");
  const [op, setOp] = useState(">");
  const [value, setValue] = useState("80");
  const [forMin, setForMin] = useState("5");
  const [every, setEvery] = useState<"daily" | "hourly">("daily");
  const [dailyAt, setDailyAt] = useState("02:30");
  const [guestType, setGuestType] = useState("any");
  const [tag, setTag] = useState("");
  const [action, setAction] = useState("notify");
  const [owner, setOwner] = useState(false);
  const [readBack, setReadBack] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [needsOwner, setNeedsOwner] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const input = (): AutomationInput => ({
    name: name.trim(),
    trigger: mode === "condition" ? { type: "condition", when: { metric, op, value: Number(value), forSeconds: Math.round(Number(forMin) * 60) }, cooldownSeconds: 600, everySeconds: 60 } : every === "daily" ? { type: "schedule", dailyAt } : { type: "schedule", everySeconds: 3600 },
    scope: { guestType, ...(tag.trim() ? { tag: tag.trim() } : {}) },
    then: { action },
    ...(owner ? { allowOwnerPermissions: true } : {}),
  });
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      if (!name.trim()) return setReadBack(null);
      pinRt.preview(input()).then((r) => { if (alive) { setReadBack(r.ok ? (r.readBack ?? null) : null); setProblems(r.ok ? [] : (r.errors ?? [])); } }, () => undefined);
    }, 250);
    return () => { alive = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, mode, metric, op, value, forMin, every, dailyAt, guestType, tag, action]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await pinRt.createAutomation(input());
      onCreated();
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "needs_permissions") setNeedsOwner(true);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal size="lg" title="New automation" subtitle="You'll see it read back in plain words before it's saved." onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!readBack} loading={busy} onClick={create}>Save automation</Button></>}>
      <div className="space-y-4">
        <Field label="Name" htmlFor="au-name"><Input id="au-name" value={name} maxLength={160} onChange={(e) => setName(e.target.value)} placeholder="Nightly snapshot of production" /></Field>
        <Segmented label="Kind" value={mode} onChange={setMode} options={[{ value: "condition", label: "When something happens" }, { value: "schedule", label: "On a schedule" }]} />
        {mode === "condition" ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Field label="Watch" htmlFor="au-metric"><Select id="au-metric" value={metric} onChange={(e) => setMetric(e.target.value)}>{METRICS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
            <Field label="Is" htmlFor="au-op"><Select id="au-op" value={op} onChange={(e) => setOp(e.target.value)}><option value=">">more than</option><option value=">=">at least</option><option value="<">less than</option></Select></Field>
            <Field label="Percent" htmlFor="au-value"><Input id="au-value" type="number" min={0} max={100} value={value} onChange={(e) => setValue(e.target.value)} className="tabular-nums" /></Field>
            <Field label="For (minutes)" htmlFor="au-for"><Input id="au-for" type="number" min={0} max={1440} value={forMin} onChange={(e) => setForMin(e.target.value)} className="tabular-nums" /></Field>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <Field label="How often" htmlFor="au-every"><Select id="au-every" value={every} onChange={(e) => setEvery(e.target.value as "daily" | "hourly")}><option value="daily">Every day</option><option value="hourly">Every hour</option></Select></Field>
            {every === "daily" && <Field label="At" htmlFor="au-at" hint="The device's clock."><Input id="au-at" type="time" value={dailyAt} onChange={(e) => setDailyAt(e.target.value)} /></Field>}
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Applies to" htmlFor="au-type"><Select id="au-type" value={guestType} onChange={(e) => setGuestType(e.target.value)}><option value="any">Every machine</option><option value="lxc">Containers</option><option value="qemu">Virtual machines</option></Select></Field>
          <Field label="Tagged" htmlFor="au-tag" hint="Optional."><Input id="au-tag" value={tag} onChange={(e) => setTag(e.target.value)} placeholder="prod" className="font-mono" /></Field>
        </div>
        <Field label="Then" htmlFor="au-action"><Select id="au-action" value={action} onChange={(e) => setAction(e.target.value)}>{ACTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
        {problems.length > 0 && <Notice tone="warning" title="Not quite right yet">{problems.join(". ")}.</Notice>}
        {readBack && <Notice tone="info" title="Pin will read this back as">{readBack}</Notice>}
        {needsOwner && (
          <label className="flex items-start gap-3 text-sm"><Toggle label="Let it act with all my permissions" checked={owner} onChange={setOwner} /><span className="text-pretty">Let it act with all of my Proxmox permissions. It still only does this one action, on machines in this scope.</span></label>
        )}
        {error && <p role="alert" className="text-compact text-critical text-pretty">{error}</p>}
      </div>
    </Modal>
  );
}

/* ── Updates ───────────────────────────────────────────────────────────────────────── */

export function UpdatesTab() {
  const qc = useQueryClient();
  const device = useEngine().setup?.deviceName ?? "pve";
  const q = useQuery({ queryKey: ["pin", "update"], queryFn: pinRt.update, refetchInterval: (query) => (query.state.data?.inProgress ? 3000 : 600_000), retry: 1 });
  const set = (d: UpdateInfo) => qc.setQueryData(["pin", "update"], d);
  const check = useMutation({ mutationFn: pinRt.checkUpdate, onSuccess: set });
  const [confirm, setConfirm] = useState<"update" | "rollback" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const start = useMutation({ mutationFn: pinRt.startUpdate, onSuccess: () => { setConfirm(null); void q.refetch(); }, onError: (e) => setError(errorMessage(e)) });
  if (q.isPending) return <Loading rows={2} />;
  // While the host service restarts into the new version the page can't ask it anything; say so instead of failing.
  if (q.error && !q.data) return <Failed error={q.error} retry={() => q.refetch()} />;
  const u = q.data!;
  const s = u.status;
  const stateLabel = { off: "Checks are off", unchecked: "Not checked yet", unknown: "Couldn't compare versions", available: "An update is available", current: "You're up to date", no_stable: "No final release yet", no_release: "Nothing published yet" }[u.state];
  return (
    <div className="space-y-4 fade-in max-w-3xl">
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-xs font-semibold uppercase tracking-label text-ink-3">ePaperclip</div>
            <div className="mt-1 flex flex-wrap items-baseline gap-x-6 gap-y-1">
              <div><span className="text-compact text-ink-3">Installed </span><span className="font-mono text-lead">{u.installed ?? "unknown"}</span></div>
              {u.state !== "current" && <div><span className="text-compact text-ink-3">{u.channel === "rc" ? "Newest, including candidates " : "Latest "}</span><span className="font-mono text-lead">{u.latest?.version ?? "none yet"}</span></div>}
            </div>
            <div className="mt-2"><Status kind={u.state === "available" ? "warning" : u.state === "current" ? "good" : "idle"} label={stateLabel} /></div>
            {u.checkedAt && <p className="text-xs text-ink-3 mt-1">Checked {ago(u.checkedAt)}</p>}
          </div>
          {u.canManage && <Button loading={check.isPending} disabled={!u.checkEnabled} onClick={() => check.mutate()}><RotateCcw className="h-3.5 w-3.5" />Check now</Button>}
        </div>
        {(u.error || check.error) && <Notice tone="warning" className="mt-4" title="The release feed didn't answer">{u.error ?? errorMessage(check.error)} Your installed version is unaffected.</Notice>}
        {u.state === "no_stable" && !u.error && <Notice tone="info" className="mt-4" title="No final release has been published yet">Only release candidates exist so far. Final releases are what this device follows by default; turn on release candidates below to try the newer builds.</Notice>}
        {u.preview && u.channel === "stable" && u.canManage && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line px-4 py-3">
            <p className="text-compact text-ink-2 text-pretty">A release candidate, <span className="font-mono">{u.preview.version}</span>, is available for people who want to try it early.</p>
            <Button size="sm" onClick={() => void pinRt.setUpdateChannel("rc").then(set)}>Follow release candidates</Button>
          </div>
        )}
        {u.latest && u.state === "available" && (
          <div className="mt-4">
            <div className="text-sm font-medium">What's new in {u.latest.version}</div>
            <div className="mt-2 max-h-72 overflow-y-auto overflow-x-hidden rounded-lg border border-line p-4 text-compact text-ink-2">{u.latest.notes ? <Markdown text={u.latest.notes} chat /> : "No release notes were published."}</div>
            <a href={httpUrl(u.latest.url) ?? undefined} target="_blank" rel="noopener noreferrer" className="text-compact text-accent hover:underline mt-2 inline-block">Release page on GitHub</a>
          </div>
        )}
      </Card>

      {s && (s.phase !== "done" || (s.at && Date.now() - s.at < 3600_000)) && (
        <Notice tone={s.phase === "failed" ? "critical" : s.phase === "rolled_back" ? "warning" : s.phase === "done" ? "good" : "info"} title={{ queued: "Update queued", downloading: "Downloading", verifying: "Checking the download", installing: "Installing", done: "Update finished", failed: "The update didn't finish", rolled_back: "The update was rolled back" }[s.phase] ?? s.phase}>
          {s.message} {u.inProgress && "This page reconnects by itself when the host service restarts."}
        </Notice>
      )}

      {u.installedWithdrawn && <Notice tone="critical" title="The version you're running was withdrawn">{u.installedWithdrawn} Update to a newer version as soon as you can.</Notice>}
      <RestartNotice u={u} device={device} />
      {u.canManage ? (
        <Card className="p-5 space-y-4">
          <div>
            <h2 className="font-medium">Update this device</h2>
            <p className="text-compact text-ink-3 mt-1 text-pretty">The update downloads the release, checks it against its published SHA-256, test-starts it beside the running version, then swaps it in. If the new version doesn't come up healthy, the previous one is put back automatically. Proxmox's own interface is never touched.</p>
          </div>
          {u.canUpdate ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" disabled={u.state !== "available" || u.inProgress} onClick={() => { setError(null); setConfirm("update"); }}><ArrowUpCircle className="h-4 w-4" />Update to {u.latest?.version ?? "latest"}</Button>
              <RemindLater u={u} />
              <Button disabled={!u.previous || u.inProgress} onClick={() => { setError(null); setConfirm("rollback"); }}><RotateCcw className="h-4 w-4" />Go back to {u.previous ?? "the previous version"}</Button>
            </div>
          ) : (
            <Notice tone="info" title="Update from the shell on this device">This device doesn't have the update helper, so the console can't start an update. Run <span className="font-mono">{u.manual}</span>.</Notice>
          )}
        </Card>
      ) : (
        <p className="text-compact text-ink-3">Only Proxmox administrators can update ePaperclip.</p>
      )}
      <UpdateOptions u={u} device={device} />

      {confirm === "update" && u.latest && (
        <TypedConfirm title={`Update to ${u.latest.version}`} subtitle="This restarts ePaperclip for a minute or two." phrase={`update ${u.latest.version}`} action="Start the update" busy={start.isPending} error={error} onClose={() => setConfirm(null)} onConfirm={() => start.mutate({ action: "update", confirm: `update ${u.latest!.version}` })}>
          <p className="text-sm text-pretty">Machines and organizations keep running. People signed in will need to sign in again. If anything goes wrong the previous version comes back by itself.</p>
        </TypedConfirm>
      )}
      {confirm === "rollback" && (
        <TypedConfirm title="Go back to the previous version" subtitle={u.previous ?? undefined} phrase="rollback" action="Roll back" busy={start.isPending} error={error} onClose={() => setConfirm(null)} onConfirm={() => start.mutate({ action: "rollback", confirm: "rollback" })}>
          <p className="text-sm text-pretty">This puts back the version that was installed before the last update, and the engine's database from before it if the engine changed.</p>
        </TypedConfirm>
      )}
    </div>
  );
}

export function PinRuntimeLink({ to, children }: { to: string; children: ReactNode }) {
  return <Link to={to} className="text-accent hover:underline">{children}</Link>;
}
