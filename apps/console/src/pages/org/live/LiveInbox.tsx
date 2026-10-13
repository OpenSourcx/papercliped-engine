import { useState } from "react";
import { Link } from "react-router-dom";
import { Check, CheckCheck, ExternalLink, Inbox as InboxIcon, X } from "lucide-react";
import type { AttentionItem, Issue, IssueInteraction } from "@papercliped-engine/engine-client";
import { useEngine } from "../../../data/store.tsx";
import { ago } from "../../../data/engine/map.ts";
import { APPROVAL_TYPE_LABEL, ISSUE_ICON, ISSUE_LABEL } from "../../../data/engine/labels.tsx";
import { useApprovals } from "../../../data/engine/queries.ts";
import { useAttention, useInboxWrites, useIssueInteractions, useMine } from "../../../data/engine/more.ts";
import { Avatar, Button, Card, Chip, EmptyState, Input, PageFrame, PageHeader, Segmented, Status, Tabs, Textarea } from "../../../ui/primitives.tsx";
import { useDecide } from "../../../data/engine/queries.ts";
import { ActionError, LoadError, Loading, useLiveOrg } from "./common.tsx";
import { useNames } from "./names.ts";

const SOURCE_LABEL: Record<string, string> = {
  approval: "Approval",
  decision: "Decision",
  issue_thread_interaction: "Question",
  join_request: "Join request",
  recovery_action: "Recovery",
  productivity_review: "Review",
  blocker_attention: "Blocked",
  review: "Review",
  failed_run: "Failed run",
  budget_alert: "Budget",
  agent_error_alert: "Agent error",
};
const SEVERITY_TONE: Record<string, "critical" | "warning" | "neutral"> = { critical: "critical", high: "warning", medium: "neutral", low: "neutral" };

/** Where an attention item points inside the console. */
function useTarget() {
  const { org } = useLiveOrg();
  const { setup } = useEngine();
  const b = `/${setup?.deviceName ?? "pve"}/${org.slug}`;
  return (item: AttentionItem): string | null => {
    const s = item.relatedIssue ?? item.subject;
    if (s.kind === "issue") return `${b}/tasks/${s.identifier ?? s.id}`;
    if (item.subject.kind === "agent") return `${b}/agents/${item.subject.id}`;
    if (item.sourceKind === "approval") return `${b}/decisions`;
    if (item.sourceKind === "budget_alert") return `${b}/costs`;
    if (item.sourceKind === "agent_error_alert" && item.subject.id) return `${b}/agents/${item.subject.id}`;
    return null;
  };
}

/** The ranked list of things that need a person, each answerable in place. */
export function AttentionList({ filter }: { filter?: string }) {
  const { companyId } = useLiveOrg();
  const feed = useAttention(companyId);
  const items = (feed.data?.items ?? []).filter((i) => !i.dismissal?.isActive && (!filter || filter === "all" || i.sourceKind === filter));
  return (
    <div className="space-y-3">
      {feed.isPending && <Card><Loading label="Loading what needs you" /></Card>}
      {feed.error && <Card><LoadError error={feed.error} retry={() => void feed.refetch()} /></Card>}
      {feed.data && items.length === 0 && <Card><EmptyState icon={<Check className="h-5 w-5" />} title="Nothing needs you" body="Approvals, questions from agents and failed runs show up here as they happen." /></Card>}
      {items.map((i) => <AttentionCard key={i.id} item={i} />)}
    </div>
  );
}

function AttentionCard({ item }: { item: AttentionItem }) {
  const { companyId, org } = useLiveOrg();
  const w = useInboxWrites(companyId);
  const target = useTarget()(item);
  const kindLabel = SOURCE_LABEL[item.sourceKind] ?? item.sourceKind.replace(/_/g, " ");
  // The attention feed names an approval only by its type ("hire agent"); the approval itself says who is being hired.
  const approvals = useApprovals(companyId);
  const approval = item.sourceKind === "approval" ? approvals.data?.find((a) => a.id === item.subject.id) : undefined;
  const title = approval ? payloadTitle(approval.type, approval.payload ?? {}) : item.subject.title;
  const detail = item.detail;
  const excerpt = detail && "summaryExcerpt" in detail ? detail.summaryExcerpt : detail && "promptExcerpt" in detail ? detail.promptExcerpt : detail && "failureReasonExcerpt" in detail ? detail.failureReasonExcerpt : detail && "firstQuestionText" in detail ? detail.firstQuestionText : null;
  return (
    <Card className="p-4" >
      <div className="flex flex-wrap items-start gap-3">
        <Avatar name={item.originAgentName ?? kindLabel} hue={org.hue + 40} size={32} />
        <div className="flex-1 min-w-52">
          <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">{title}</span><Chip tone={SEVERITY_TONE[item.severity] ?? "neutral"}>{kindLabel}</Chip></div>
          <div className="text-xs text-ink-3">{item.originAgentName ? `${item.originAgentName} · ` : ""}{item.whyNow} · {ago(item.createdAt)}</div>
          {excerpt && <p className="text-compact text-ink-2 mt-2 line-clamp-3 whitespace-pre-wrap">{excerpt}</p>}
        </div>
        <div className="flex items-center gap-1">
          {target && <Link to={target} className="inline-flex items-center gap-1 text-compact text-ink-3 hover:text-ink h-8 px-2"><ExternalLink className="h-3.5 w-3.5" />Open</Link>}
          <Button size="sm" variant="ghost" loading={w.dismiss.isPending && w.dismiss.variables === item.dismissalKey} onClick={() => w.dismiss.mutate(item.dismissalKey)}>Dismiss</Button>
        </div>
      </div>
      {item.sourceKind === "approval" && <ApprovalActions item={item} title={title} />}
      {item.sourceKind === "issue_thread_interaction" && item.relatedIssue && <InteractionActions item={item} issueId={item.relatedIssue.id} />}
      <ActionError error={w.dismiss.error} />
    </Card>
  );
}

function ApprovalActions({ item, title }: { item: AttentionItem; title: string }) {
  const { companyId } = useLiveOrg();
  const decide = useDecide(companyId);
  const w = useInboxWrites(companyId);
  const [note, setNote] = useState("");
  const id = item.subject.id;
  const n = note.trim() || undefined;
  const busy = decide.isPending || w.requestRevision.isPending;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <Input aria-label={`Note for ${title}`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note (optional)" className="h-8 text-compact flex-1 min-w-48" />
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => w.requestRevision.mutate({ id, note: n })}>Request revision</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => decide.mutate({ id, approve: false, note: n })}><X className="h-3.5 w-3.5" />Reject</Button>
      <Button size="sm" variant="primary" disabled={busy} onClick={() => decide.mutate({ id, approve: true, note: n })}><Check className="h-3.5 w-3.5" />Approve</Button>
      <ActionError error={decide.error ?? w.requestRevision.error} />
    </div>
  );
}

type Question = { id: string; prompt: string; helpText?: string | null; selectionMode: "single" | "multi"; allowOther?: boolean; required?: boolean; options: { id: string; label: string; description?: string | null; freeText?: boolean }[] };

/** Answers an agent's pending question or confirmation without leaving the inbox. */
function InteractionActions({ item, issueId }: { item: AttentionItem; issueId: string }) {
  const { companyId } = useLiveOrg();
  const list = useIssueInteractions(companyId, issueId);
  const pending = (list.data ?? []).filter((x: IssueInteraction) => x.status === "pending");
  const w = useInboxWrites(companyId);
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  if (list.isPending) return <p className="text-xs text-ink-3 mt-3">Loading the question</p>;
  const mine = pending.find((x: IssueInteraction) => x.id === item.subject.id) ?? pending[0];
  if (!mine) return null;
  if (mine.kind === "ask_user_questions") {
    const questions = ((mine.payload as { questions?: Question[] } | undefined)?.questions ?? []);
    const answers = questions.map((q) => ({ questionId: q.id, optionIds: picked[q.id] ?? [], otherText: other[q.id]?.trim() || null }));
    const ready = questions.every((q, i) => !q.required && q.required !== undefined ? true : answers[i].optionIds.length > 0 || !!answers[i].otherText);
    return (
      <div className="mt-3 space-y-3">
        {questions.map((q) => (
          <fieldset key={q.id} className="space-y-1.5">
            <legend className="text-sm font-medium">{q.prompt}</legend>
            {q.helpText && <p className="text-xs text-ink-3">{q.helpText}</p>}
            {q.options.map((o) => (
              <label key={o.id} className="flex items-center gap-2 text-compact text-ink-2">
                <input type={q.selectionMode === "multi" ? "checkbox" : "radio"} name={`${mine.id}-${q.id}`} checked={(picked[q.id] ?? []).includes(o.id)} onChange={(e) => setPicked({ ...picked, [q.id]: q.selectionMode === "multi" ? (e.target.checked ? [...(picked[q.id] ?? []), o.id] : (picked[q.id] ?? []).filter((x) => x !== o.id)) : [o.id] })} />
                {o.label}
              </label>
            ))}
            {(q.allowOther || q.options.some((o) => o.freeText)) && <Input aria-label={`Other answer for ${q.prompt}`} value={other[q.id] ?? ""} onChange={(e) => setOther({ ...other, [q.id]: e.target.value })} placeholder="Or write your own answer" className="h-8 text-compact" />}
          </fieldset>
        ))}
        <div className="flex justify-end"><Button size="sm" variant="primary" disabled={!ready} loading={w.respond.isPending} onClick={() => w.respond.mutate({ issueId, interactionId: mine.id, body: { answers } })}>Send answers</Button></div>
        <ActionError error={w.respond.error} />
      </div>
    );
  }
  if (mine.kind === "request_confirmation") {
    const p = (mine.payload ?? {}) as { prompt?: string; acceptLabel?: string | null; rejectLabel?: string | null; allowDeclineReason?: boolean };
    return (
      <div className="mt-3 space-y-2">
        {p.prompt && <p className="text-sm text-ink-2 whitespace-pre-wrap">{p.prompt}</p>}
        {p.allowDeclineReason !== false && <Textarea aria-label="Reason (optional)" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason, if you decline (optional)" />}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" loading={w.reject.isPending} onClick={() => w.reject.mutate({ issueId, interactionId: mine.id })}>{p.rejectLabel ?? "Decline"}</Button>
          <Button size="sm" variant="primary" loading={w.accept.isPending} onClick={() => w.accept.mutate({ issueId, interactionId: mine.id })}>{p.acceptLabel ?? "Confirm"}</Button>
        </div>
        <ActionError error={w.reject.error ?? w.accept.error} />
      </div>
    );
  }
  return <p className="text-xs text-ink-3 mt-3">This request needs the full task view. Use Open.</p>;
}

type MineIssue = Issue & { isUnreadForMe?: boolean };

export function LiveInbox() {
  const { companyId, org } = useLiveOrg();
  const { setup } = useEngine();
  const b = `/${setup?.deviceName ?? "pve"}/${org.slug}`;
  const feed = useAttention(companyId);
  const mine = useMine(companyId);
  const names = useNames(companyId);
  const w = useInboxWrites(companyId);
  const [tab, setTab] = useState<"needs" | "mine">("needs");
  const needs = (feed.data?.items ?? []).filter((i) => !i.dismissal?.isActive).length;
  const issues = (mine.data ?? []) as MineIssue[];
  const unread = issues.filter((i) => i.isUnreadForMe);
  return (
    <PageFrame width="4xl">
      <PageHeader title="Inbox" subtitle="What your agents need from you, and the tasks that involve you." actions={tab === "mine" && unread.length > 0 ? <Button onClick={() => unread.forEach((i) => w.markRead.mutate(i.id))}><CheckCheck className="h-4 w-4" />Mark all read</Button> : undefined} />
      <Tabs value={tab} onChange={setTab} className="mb-4" tabs={[{ id: "needs", label: "Needs you", count: needs }, { id: "mine", label: "Assigned and mentioned", count: unread.length }]} />
      {tab === "needs" ? (
        <AttentionList />
      ) : (
        <Card className="divide-y divide-line">
          {mine.isPending && <Loading label="Loading your tasks" />}
          {mine.error && <LoadError error={mine.error} retry={() => void mine.refetch()} />}
          {mine.data && issues.length === 0 && <EmptyState icon={<InboxIcon className="h-5 w-5" />} title="Inbox zero" body="Tasks assigned to you, or that you commented on, show up here." />}
          {issues.map((i) => (
            <div key={i.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <span className={i.isUnreadForMe ? "h-2 w-2 rounded-full bg-accent shrink-0" : "h-2 w-2 shrink-0"} role={i.isUnreadForMe ? "img" : undefined} aria-label={i.isUnreadForMe ? "Unread" : undefined} />
              <span title={ISSUE_LABEL[i.status]}>{ISSUE_ICON[i.status]}</span>
              <Link to={`${b}/tasks/${i.identifier ?? i.id}`} onClick={() => i.isUnreadForMe && w.markRead.mutate(i.id)} className="flex-1 min-w-48">
                <div className={i.isUnreadForMe ? "text-sm font-medium" : "text-sm"}><span className="font-mono text-xs text-ink-3 mr-2">{i.identifier}</span>{i.title}</div>
                <div className="text-xs text-ink-3">{i.assigneeAgentId ? names.agent(i.assigneeAgentId) : i.assigneeUserId ? names.user(i.assigneeUserId) : "Unassigned"} · {ISSUE_LABEL[i.status]} · {ago(i.updatedAt)}</div>
              </Link>
              {i.isUnreadForMe && <Button size="sm" variant="ghost" onClick={() => w.markRead.mutate(i.id)}>Mark read</Button>}
              <Button size="sm" variant="ghost" onClick={() => w.archive.mutate(i.id)}>Archive</Button>
            </div>
          ))}
        </Card>
      )}
      <ActionError error={w.markRead.error ?? w.archive.error} />
    </PageFrame>
  );
}

function payloadTitle(type: string, payload: Record<string, unknown>): string {
  const name = typeof payload.name === "string" ? payload.name : null;
  const title = typeof payload.title === "string" ? payload.title : null;
  if (type === "hire_agent" && name) return `Hire ${name}${typeof payload.role === "string" ? ` (${payload.role})` : ""}`;
  return title ?? name ?? APPROVAL_TYPE_LABEL[type] ?? type.replace(/_/g, " ");
}

/** "What needs me": everything waiting on a decision, then the history of what was decided. */
export function LiveDecisions() {
  const { companyId } = useLiveOrg();
  const approvals = useApprovals(companyId);
  const feed = useAttention(companyId);
  const names = useNames(companyId);
  const [view, setView] = useState<"waiting" | "history">("waiting");
  const [filter, setFilter] = useState("all");
  const kinds = Object.entries(feed.data?.countsBySourceKind ?? {}).filter(([, n]) => n > 0);
  const history = (approvals.data ?? []).filter((a) => a.status !== "pending" && a.status !== "revision_requested");
  return (
    <PageFrame width="4xl">
      <PageHeader title="Decisions" subtitle="Approvals, questions and alerts that are waiting on you. Answer them here." />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Segmented value={view} onChange={setView} options={[{ value: "waiting", label: `Waiting${feed.data ? ` (${feed.data.totalCount})` : ""}` }, { value: "history", label: "History" }]} />
        {view === "waiting" && kinds.length > 1 && (
          <select aria-label="Kind" value={filter} onChange={(e) => setFilter(e.target.value)} className="bg-surface-2 border border-line rounded-full h-9 text-compact px-3">
            <option value="all">Everything</option>
            {kinds.map(([k, n]) => <option key={k} value={k}>{SOURCE_LABEL[k] ?? k} ({n})</option>)}
          </select>
        )}
      </div>
      {view === "waiting" ? (
        <AttentionList filter={filter} />
      ) : (
        <Card className="divide-y divide-line">
          {approvals.isPending && <Loading />}
          {approvals.error && <LoadError error={approvals.error} retry={() => void approvals.refetch()} />}
          {approvals.data && history.length === 0 && <EmptyState icon={<Check className="h-5 w-5" />} title="No history yet" body="Decisions you've made show up here." />}
          {history.map((a) => {
            const who = a.requestedByAgentId ? names.agent(a.requestedByAgentId) : names.user(a.requestedByUserId);
            return (
              <div key={a.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <div className="flex-1 min-w-48"><div className="text-sm font-medium">{payloadTitle(a.type, a.payload ?? {})}</div><div className="text-xs text-ink-3">{who} · {APPROVAL_TYPE_LABEL[a.type] ?? a.type} · {ago(a.createdAt)}{a.decisionNote ? ` · “${a.decisionNote}”` : ""}</div></div>
                {a.status === "approved" ? <Status kind="good" label="Approved" /> : a.status === "rejected" ? <Status kind="critical" label="Rejected" /> : <Status kind="off" label="Cancelled" />}
              </div>
            );
          })}
        </Card>
      )}
    </PageFrame>
  );
}
