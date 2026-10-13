import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Download, FileText, Paperclip, Plus, Tag, Trash2 } from "lucide-react";
import { MAX_ATTACHMENT_BYTES, type Issue, type IssueAttachment } from "@papercliped-engine/engine-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEngine } from "../../../data/store.tsx";
import { ago } from "../../../data/engine/map.ts";
import { ISSUE_ICON, ISSUE_LABEL } from "../../../data/engine/labels.tsx";
import { engine, useCreateIssue, useUpdateIssue } from "../../../data/engine/queries.ts";
import { useLabels, useTaskExtras } from "../../../data/engine/more.ts";
import { qk } from "../../../data/engine/keys.ts";
import { formatBytes } from "../../../lib/storage.ts";
import { Modal } from "../../../ui/Modal.tsx";
import { Button, Card, Chip, Input, SectionTitle, Status, type StatusKind } from "../../../ui/primitives.tsx";
import { ActionError, LoadError, Loading, useLiveOrg } from "./common.tsx";
import { Preview, previewKind } from "./LiveArtifacts.tsx";

/** A calm colour for a new label, worked out from its name so the same name always gets the same one. */
function labelColor(name: string): string {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  const f = (n: number) => { const k = (n + h / 30) % 12; const a = 0.45 * Math.min(0.55, 1 - 0.55); return Math.round(255 * (0.55 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
  return `#${[f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

const APPROVAL_STATUS: Record<string, [StatusKind, string]> = { pending: ["paused", "Waiting"], revision_requested: ["warning", "Changes requested"], approved: ["good", "Approved"], rejected: ["critical", "Rejected"], cancelled: ["off", "Cancelled"] };

/** Everything attached to a task besides its thread: sub-tasks, labels, files, work products, linked approvals and documents. */
export function TaskExtras({ task }: { task: Issue }) {
  const { companyId, org } = useLiveOrg();
  const { setup } = useEngine();
  const b = `/${setup?.deviceName ?? "pve"}/${org.slug}`;
  const extras = useTaskExtras(companyId, task.identifier ?? task.id, task.id);
  const labels = useLabels(companyId);
  const update = useUpdateIssue(companyId);
  const createIssue = useCreateIssue(companyId);
  const qc = useQueryClient();
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: qk.anyExtras(companyId) }), qc.invalidateQueries({ queryKey: qk.artifacts(companyId) })]);
  const upload = useMutation({ mutationFn: (file: File) => engine.artifacts.upload(companyId, task.id, file), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: string) => engine.artifacts.removeAttachment(id), onSuccess: refresh });
  const newLabel = useMutation({ mutationFn: (name: string) => engine.tasks.createLabel(companyId, { name, color: labelColor(name) }), onSuccess: () => qc.invalidateQueries({ queryKey: qk.labels(companyId) }) });
  const file = useRef<HTMLInputElement>(null);
  const [sub, setSub] = useState("");
  const [labelName, setLabelName] = useState("");
  const [tooBig, setTooBig] = useState<string | null>(null);
  const [openAtt, setOpenAtt] = useState<IssueAttachment | null>(null);
  const [openDoc, setOpenDoc] = useState<string | null>(null);
  const e = extras.data;
  const have = new Set((task as { labelIds?: string[] }).labelIds ?? []);
  const all = labels.data ?? [];
  const toggle = (id: string) => update.mutate({ id: task.id, body: { labelIds: have.has(id) ? [...have].filter((x) => x !== id) : [...have, id] } });
  const addSub = () => {
    const title = sub.trim();
    if (!title) return;
    createIssue.mutate({ title, parentId: task.id, projectId: task.projectId }, { onSuccess: () => { setSub(""); void refresh(); } });
  };
  const pick = (f: File | undefined) => {
    setTooBig(null);
    if (!f) return;
    if (f.size > MAX_ATTACHMENT_BYTES) return setTooBig(`${f.name} is ${formatBytes(f.size)}. Files can be up to ${formatBytes(MAX_ATTACHMENT_BYTES)}.`);
    upload.mutate(f);
    if (file.current) file.current.value = "";
  };
  const doc = (e?.documents ?? []).find((d) => d.key === openDoc);
  return (
    <div className="space-y-4">
      <Card className="p-5">
        <SectionTitle><span className="inline-flex items-center gap-1.5"><Tag className="h-3.5 w-3.5" aria-hidden />Labels</span></SectionTitle>
        <div className="flex flex-wrap items-center gap-2">
          {all.map((l) => <button key={l.id} onClick={() => toggle(l.id)} aria-pressed={have.has(l.id)} disabled={update.isPending}><Chip tone={have.has(l.id) ? "accent" : "neutral"}>{l.name}</Chip></button>)}
          {all.length === 0 && <span className="text-sm text-ink-3">No labels yet.</span>}
          <form className="flex items-center gap-1" onSubmit={(ev) => { ev.preventDefault(); const n = labelName.trim(); if (!n) return; const same = all.find((l) => l.name.toLowerCase() === n.toLowerCase()); if (same) { setLabelName(""); if (!have.has(same.id)) toggle(same.id); return; } newLabel.mutate(n, { onSuccess: (l) => { setLabelName(""); toggle(l.id); } }); }}>
            <Input aria-label="New label" value={labelName} onChange={(ev) => setLabelName(ev.target.value)} placeholder="New label" className="h-8 w-32 text-compact" />
            <Button size="sm" variant="ghost" type="submit" disabled={!labelName.trim()} loading={newLabel.isPending}>Add</Button>
          </form>
        </div>
        <ActionError error={update.error ?? newLabel.error} />
      </Card>

      <Card className="p-5">
        <SectionTitle>Sub-tasks</SectionTitle>
        {extras.isPending && <Loading />}
        {extras.error && <LoadError error={extras.error} retry={() => void extras.refetch()} />}
        {e && e.children.length === 0 && <p className="text-sm text-ink-3 mb-3">No sub-tasks.</p>}
        <div className="divide-y divide-line -mx-5">
          {(e?.children ?? []).map((c) => <Link key={c.id} to={`${b}/tasks/${c.identifier ?? c.id}`} className="flex items-center gap-3 px-5 py-2 text-sm hover:bg-surface-2/40"><span title={ISSUE_LABEL[c.status]}>{ISSUE_ICON[c.status]}</span><span className="font-mono text-xs text-ink-3 w-16">{c.identifier}</span><span className="flex-1">{c.title}</span><span className="text-xs text-ink-3">{ISSUE_LABEL[c.status]}</span></Link>)}
        </div>
        <form className="flex gap-2 mt-3" onSubmit={(ev) => { ev.preventDefault(); addSub(); }}>
          <Input aria-label="New sub-task" value={sub} onChange={(ev) => setSub(ev.target.value)} placeholder="Add a sub-task" />
          <Button type="submit" disabled={!sub.trim()} loading={createIssue.isPending}><Plus className="h-4 w-4" />Add</Button>
        </form>
        <ActionError error={createIssue.error} />
      </Card>

      <Card className="p-5">
        <SectionTitle action={<><input ref={file} type="file" className="sr-only" aria-label="Choose a file to attach" onChange={(ev) => pick(ev.target.files?.[0])} /><Button size="sm" variant="ghost" loading={upload.isPending} onClick={() => file.current?.click()}><Paperclip className="h-3.5 w-3.5" />Attach a file</Button></>}>Files</SectionTitle>
        {e && e.attachments.length === 0 && <p className="text-sm text-ink-3">No files attached. Files up to {formatBytes(MAX_ATTACHMENT_BYTES)} can be added.</p>}
        <div className="divide-y divide-line -mx-5">
          {(e?.attachments ?? []).map((a) => (
            <div key={a.id} className="flex items-center gap-3 px-5 py-2 text-sm">
              <FileText className="h-4 w-4 text-ink-3 shrink-0" aria-hidden />
              <button className="flex-1 min-w-0 text-left truncate hover:underline" onClick={() => setOpenAtt(a)}>{a.originalFilename ?? "Attachment"}</button>
              <span className="text-xs text-ink-3">{formatBytes(a.byteSize)} · {ago(a.createdAt)}</span>
              <Button size="sm" variant="ghost" aria-label={`Remove ${a.originalFilename ?? "attachment"}`} onClick={() => remove.mutate(a.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
            </div>
          ))}
        </div>
        {tooBig && <p role="alert" className="text-compact text-critical mt-2">{tooBig}</p>}
        <ActionError error={upload.error ?? remove.error} />
      </Card>

      {e && e.workProducts.length > 0 && (
        <Card className="p-5">
          <SectionTitle>Work products</SectionTitle>
          <div className="divide-y divide-line -mx-5">
            {e.workProducts.map((w) => (
              <div key={w.id} className="flex items-center gap-3 px-5 py-2 text-sm">
                <span className="flex-1 min-w-0 truncate">{w.url && /^https?:\/\//.test(w.url) ? <a className="hover:underline" href={w.url} target="_blank" rel="noreferrer noopener">{w.title}</a> : w.title}</span>
                <Chip>{w.type.replace(/_/g, " ")}</Chip>
                <span className="text-xs text-ink-3 w-24 text-right">{w.status.replace(/_/g, " ")}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {e && e.approvals.length > 0 && (
        <Card className="p-5">
          <SectionTitle>Approvals</SectionTitle>
          <div className="divide-y divide-line -mx-5">
            {e.approvals.map((a) => { const [k, l] = APPROVAL_STATUS[a.status] ?? ["idle", a.status]; return <div key={a.id} className="flex items-center gap-3 px-5 py-2 text-sm"><span className="flex-1">{String((a.payload as { title?: string } | null)?.title ?? a.type.replace(/_/g, " "))}</span><Status kind={k} label={l} />{a.status === "pending" && <Link to={`${b}/decisions`} className="text-compact text-accent hover:underline">Decide</Link>}</div>; })}
          </div>
        </Card>
      )}

      {e && e.documents.length > 0 && (
        <Card className="p-5">
          <SectionTitle>Documents</SectionTitle>
          <div className="divide-y divide-line -mx-5">
            {e.documents.map((d) => <button key={d.id} onClick={() => setOpenDoc(d.key)} className="w-full flex items-center gap-3 px-5 py-2 text-sm text-left hover:bg-surface-2/40"><FileText className="h-4 w-4 text-ink-3" aria-hidden /><span className="flex-1">{d.title ?? d.key}</span><span className="text-xs text-ink-3">revision {d.latestRevisionNumber} · {ago(d.updatedAt)}</span></button>)}
          </div>
        </Card>
      )}

      {openAtt && (
        <Modal title={openAtt.originalFilename ?? "Attachment"} subtitle={`${formatBytes(openAtt.byteSize)} · ${openAtt.contentType}`} size="lg" onClose={() => setOpenAtt(null)}
          footer={engine.artifacts.pathUrl(openAtt.contentPath) ? <a className="inline-flex items-center gap-2 h-10 px-4 rounded-lg bg-surface-2 border border-line text-sm hover:bg-surface-3" href={engine.artifacts.pathUrl(`${openAtt.contentPath}${openAtt.contentPath.includes("?") ? "&" : "?"}download=1`) ?? undefined} download><Download className="h-4 w-4" />Download</a> : undefined}>
          <Preview path={openAtt.contentPath} contentType={openAtt.contentType} mediaKind={previewKind(openAtt.contentType, "file") === "image" ? "image" : "file"} title={openAtt.originalFilename ?? "Attachment"} />
        </Modal>
      )}
      {doc && (
        <Modal title={doc.title ?? doc.key} subtitle={`Revision ${doc.latestRevisionNumber}`} size="lg" onClose={() => setOpenDoc(null)}>
          <pre className="font-mono text-compact text-ink-2 bg-code rounded-lg p-3 overflow-auto max-h-96 whitespace-pre-wrap break-words">{doc.body}</pre>
        </Modal>
      )}
    </div>
  );
}
