import { useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, Check, MessageSquare, Plus, Search } from "lucide-react";
import { ISSUE_PRIORITIES, ISSUE_STATUSES, type IssuePriority, type IssueStatus } from "@papercliped-engine/engine-client";
import { useEngine } from "../../../data/store.tsx";
import { ago } from "../../../data/engine/map.ts";
import { ISSUE_ICON, ISSUE_LABEL, PRIORITY_LABEL, isOpen } from "../../../data/engine/labels.tsx";
import { useAddComment, useAgents, useComments, useCreateIssue, useIssue, useIssues, useProjects, useUpdateIssue } from "../../../data/engine/queries.ts";
import { Modal } from "../../../ui/Modal.tsx";
import { Avatar, Button, Card, Chip, EmptyState, Input, PageFrame, PageHeader, Segmented } from "../../../ui/primitives.tsx";
import { ActionError, Field, LoadError, Loading, selectClass, textareaClass, useLiveOrg } from "./common.tsx";
import { useNames } from "./names.ts";
import { TaskExtras } from "./LiveTaskExtras.tsx";

type Filter = "open" | "done" | "all" | IssueStatus;

export function LiveTasks() {
  const { org, companyId } = useLiveOrg();
  const { setup } = useEngine();
  const b = `/${setup?.deviceName ?? "pve"}/${org.slug}`;
  const issues = useIssues(companyId);
  const names = useNames(companyId);
  const [filter, setFilter] = useState<Filter>("open");
  const [q, setQ] = useState("");
  const [params, setParams] = useSearchParams();
  const creating = params.get("new") === "1";
  const setCreating = (v: boolean) => setParams((p) => { const n = new URLSearchParams(p); if (v) n.set("new", "1"); else n.delete("new"); return n; }, { replace: !v });

  const all = issues.data ?? [];
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all
      .filter((t) => (filter === "all" ? true : filter === "open" ? isOpen(t.status) : filter === "done" ? !isOpen(t.status) : t.status === filter))
      .filter((t) => !needle || t.title.toLowerCase().includes(needle) || (t.identifier ?? "").toLowerCase().includes(needle));
  }, [all, filter, q]);
  const openCount = all.filter((t) => isOpen(t.status)).length;

  return (
    <PageFrame width="6xl">
      <PageHeader title="Tasks" subtitle={issues.data ? `${openCount} open in ${org.name}.` : undefined} actions={<Button variant="primary" onClick={() => setCreating(true)}><Plus className="h-4 w-4" />New task</Button>} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Segmented value={filter === "open" || filter === "done" || filter === "all" ? filter : "all"} onChange={(v) => setFilter(v)} options={[{ value: "open", label: "Open" }, { value: "done", label: "Closed" }, { value: "all", label: "All" }]} />
        <select aria-label="Status" value={ISSUE_STATUSES.includes(filter as IssueStatus) ? filter : ""} onChange={(e) => setFilter((e.target.value || "all") as Filter)} className="bg-surface-2 border border-line rounded-full h-9 text-compact px-3">
          <option value="">Any status</option>
          {ISSUE_STATUSES.map((s) => <option key={s} value={s}>{ISSUE_LABEL[s]}</option>)}
        </select>
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="h-4 w-4 text-ink-3 absolute left-3 top-1/2 -translate-y-1/2" />
          <Input aria-label="Search tasks" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by title or key" className="h-9 pl-9 text-sm" />
        </div>
      </div>
      <Card className="divide-y divide-line">
        {issues.isPending && <Loading label="Loading tasks" />}
        {issues.error && <LoadError error={issues.error} retry={() => void issues.refetch()} />}
        {issues.data && list.length === 0 && <EmptyState icon={<Check className="h-5 w-5" />} title={all.length ? "Nothing here" : "No tasks yet"} body={all.length ? "No tasks match this filter." : "Create a task and assign it to an agent."} />}
        {list.map((t) => (
          <Link key={t.id} to={`${b}/tasks/${t.identifier ?? t.id}`} className="flex flex-wrap items-center gap-3 px-5 py-3 hover:bg-surface-2/40">
            <span title={ISSUE_LABEL[t.status]}>{ISSUE_ICON[t.status]}</span>
            <span className="text-xs text-ink-3 font-mono w-20 truncate">{t.identifier}</span>
            <span className="flex-1 min-w-[180px] text-sm">{t.title}</span>
            {(t.priority === "high" || t.priority === "critical") && <Chip tone="warning">{PRIORITY_LABEL[t.priority]}</Chip>}
            <span className="text-compact text-ink-2 w-28 truncate">{t.assigneeAgentId ? names.agent(t.assigneeAgentId) : t.assigneeUserId ? names.user(t.assigneeUserId) : "Unassigned"}</span>
            <span className="text-xs text-ink-3 w-20 text-right">{ISSUE_LABEL[t.status]}</span>
          </Link>
        ))}
      </Card>
      {creating && <NewTaskModal onClose={() => setCreating(false)} />}
    </PageFrame>
  );
}

function NewTaskModal({ onClose }: { onClose: () => void }) {
  const { org, companyId } = useLiveOrg();
  const { setup } = useEngine();
  const navigate = useNavigate();
  const agents = useAgents(companyId);
  const projects = useProjects(companyId);
  const create = useCreateIssue(companyId);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assignee, setAssignee] = useState("");
  const [priority, setPriority] = useState<IssuePriority>("medium");
  const [project, setProject] = useState("");
  const save = () => {
    if (!title.trim() || create.isPending) return;
    create.mutate(
      { title: title.trim(), description: description.trim() || null, status: "todo", priority, assigneeAgentId: assignee || null, projectId: project || null },
      { onSuccess: (issue) => { onClose(); navigate(`/${setup?.deviceName ?? "pve"}/${org.slug}/tasks/${issue.identifier ?? issue.id}`); } },
    );
  };
  return (
    <Modal title="New task" subtitle={`In ${org.name}`} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} disabled={!title.trim() || create.isPending}>{create.isPending ? "Creating…" : "Create task"}</Button></>}>
      <div className="space-y-3">
        <Field label="Title"><Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} placeholder="What needs doing?" /></Field>
        <Field label="Description" hint="(optional)"><textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} className={textareaClass} placeholder="Context, links, what done looks like" /></Field>
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Assign to">
            <select value={assignee} onChange={(e) => setAssignee(e.target.value)} className={selectClass}>
              <option value="">Unassigned</option>
              {(agents.data ?? []).filter((a) => a.status !== "terminated").map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
          <Field label="Priority">
            <select value={priority} onChange={(e) => setPriority(e.target.value as IssuePriority)} className={selectClass}>
              {ISSUE_PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
            </select>
          </Field>
        </div>
        {(projects.data ?? []).length > 0 && (
          <Field label="Project" hint="(optional)">
            <select value={project} onChange={(e) => setProject(e.target.value)} className={selectClass}>
              <option value="">None</option>
              {(projects.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
        )}
        <ActionError error={create.error} />
      </div>
    </Modal>
  );
}

export function LiveTaskDetail() {
  const { org, companyId } = useLiveOrg();
  const { setup } = useEngine();
  const { taskId = "" } = useParams();
  const b = `/${setup?.deviceName ?? "pve"}/${org.slug}`;
  const issue = useIssue(companyId, taskId);
  const comments = useComments(companyId, taskId);
  const agents = useAgents(companyId);
  const names = useNames(companyId);
  const update = useUpdateIssue(companyId);
  const comment = useAddComment(companyId, taskId);
  const [text, setText] = useState("");
  const t = issue.data;
  const change = (body: Parameters<typeof update.mutate>[0]["body"]) => t && update.mutate({ id: t.id, body });
  const send = () => {
    if (!text.trim() || comment.isPending) return;
    comment.mutate(text.trim(), { onSuccess: () => setText("") });
  };

  return (
    <PageFrame width="4xl">
      <Link to={`${b}/tasks`} className="inline-flex items-center gap-1.5 text-compact text-ink-3 hover:text-ink mb-4"><ArrowLeft className="h-3.5 w-3.5" />Tasks</Link>
      {issue.isPending && <Card><Loading label="Loading task" /></Card>}
      {issue.error && <Card><LoadError error={issue.error} retry={() => void issue.refetch()} /></Card>}
      {t && (
        <>
          <PageHeader eyebrow={<span className="font-mono">{t.identifier}</span>} title={t.title} subtitle={`Opened ${ago(t.createdAt)}${t.createdByUserId ? ` by ${names.user(t.createdByUserId)}` : t.createdByAgentId ? ` by ${names.agent(t.createdByAgentId)}` : ""}`} />
          <div className="grid md:grid-cols-[1fr_240px] gap-4">
            <div className="space-y-4 min-w-0">
              <Card className="p-5">
                {t.description ? <p className="text-sm text-ink-2 whitespace-pre-wrap break-words">{t.description}</p> : <p className="text-sm text-ink-3">No description.</p>}
              </Card>
              <TaskExtras task={t} />
              <Card>
                <div className="px-5 pt-4 pb-2 flex items-center gap-2 text-compact font-semibold uppercase tracking-label text-ink-3"><MessageSquare className="h-3.5 w-3.5" />Comments</div>
                {comments.isPending && <Loading />}
                {comments.error && <LoadError error={comments.error} retry={() => void comments.refetch()} />}
                <div className="divide-y divide-line">
                  {comments.data?.length === 0 && <p className="px-5 py-3 text-sm text-ink-3">No comments yet.</p>}
                  {(comments.data ?? []).map((c) => {
                    const who = c.authorAgentId ? names.agent(c.authorAgentId) : names.user(c.authorUserId);
                    return (
                      <div key={c.id} className="px-5 py-3 flex gap-3">
                        <Avatar name={who} hue={c.authorAgentId ? org.hue + 40 : 210} size={28} />
                        <div className="min-w-0 flex-1">
                          <div className="text-compact"><span className="font-medium">{who}</span> <span className="text-ink-3">{ago(c.createdAt)}</span></div>
                          <p className="text-sm text-ink-2 whitespace-pre-wrap break-words mt-0.5">{c.body}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="p-4 border-t border-line">
                  <textarea aria-label="Add a comment" rows={3} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && send()} className={textareaClass} placeholder="Add a comment. Assigned agents see it on their next run." />
                  <div className="flex items-center justify-between gap-3 mt-2">
                    <ActionError error={comment.error} />
                    <Button className="ml-auto" variant="primary" size="sm" onClick={send} disabled={!text.trim() || comment.isPending}>{comment.isPending ? "Sending…" : "Comment"}</Button>
                  </div>
                </div>
              </Card>
            </div>
            <Card className="p-4 space-y-3 h-fit">
              <Field label="Status">
                <select aria-label="Status" value={t.status} onChange={(e) => change({ status: e.target.value as IssueStatus })} className={selectClass} disabled={update.isPending}>
                  {ISSUE_STATUSES.map((s) => <option key={s} value={s}>{ISSUE_LABEL[s]}</option>)}
                </select>
              </Field>
              <Field label="Priority">
                <select aria-label="Priority" value={t.priority} onChange={(e) => change({ priority: e.target.value as IssuePriority })} className={selectClass} disabled={update.isPending}>
                  {ISSUE_PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
                </select>
              </Field>
              <Field label="Assignee">
                <select aria-label="Assignee" value={t.assigneeAgentId ?? ""} onChange={(e) => change({ assigneeAgentId: e.target.value || null })} className={selectClass} disabled={update.isPending}>
                  <option value="">{t.assigneeUserId ? names.user(t.assigneeUserId) : "Unassigned"}</option>
                  {(agents.data ?? []).filter((a) => a.status !== "terminated").map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </Field>
              <ActionError error={update.error} />
              <p className="text-xs text-ink-3">Updated {ago(t.updatedAt)}</p>
            </Card>
          </div>
        </>
      )}
    </PageFrame>
  );
}
