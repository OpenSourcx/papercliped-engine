import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Download, FileText, GitBranch, Package } from "lucide-react";
import type { CompanyArtifact, ExecutionWorkspace } from "@papercliped-engine/engine-client";
import { engine } from "../../../data/engine/queries.ts";
import { useEngine } from "../../../data/store.tsx";
import { ago } from "../../../data/engine/map.ts";
import { useArtifacts, useWorkspace, useWorkspaces } from "../../../data/engine/more.ts";
import { Modal } from "../../../ui/Modal.tsx";
import { Card, Chip, EmptyState, Input, Notice, PageFrame, PageHeader, SectionTitle, Segmented, Status, type StatusKind } from "../../../ui/primitives.tsx";
import { LoadError, Loading, useLiveOrg } from "./common.tsx";

/** How an artifact may be shown. Engine files are untrusted: only images go in an <img> and only text is read as text. Everything else is a download. */
export type PreviewKind = "image" | "text" | "json" | "download";
const RASTER = /^image\/(png|jpe?g|gif|webp|avif|svg\+xml)$/i;
const TEXT = /^(text\/(plain|markdown|csv|x-log)|application\/(x-ndjson|yaml|x-yaml))$/i;
export function previewKind(contentType: string | null, mediaKind: string): PreviewKind {
  const t = (contentType ?? "").split(";")[0].trim();
  if (RASTER.test(t)) return "image";
  if (/^application\/json$/i.test(t)) return "json";
  if (TEXT.test(t)) return "text";
  if (!t && mediaKind === "text") return "text";
  return "download";
}
const MAX_PREVIEW = 200_000;

export function Preview({ path, contentType, mediaKind, title }: { path: string; contentType: string | null; mediaKind: string; title: string }) {
  const kind = previewKind(contentType, mediaKind);
  const url = engine.artifacts.pathUrl(path);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (kind !== "text" && kind !== "json") return;
    let live = true;
    setText(null);
    setError(false);
    engine.artifacts.fetchPath(path).then(async (r) => {
      if (!r.ok) throw new Error(String(r.status));
      const raw = (await r.text()).slice(0, MAX_PREVIEW);
      let shown = raw;
      if (kind === "json") { try { shown = JSON.stringify(JSON.parse(raw), null, 2); } catch { shown = raw; } }
      if (live) setText(shown);
    }).catch(() => live && setError(true));
    return () => { live = false; };
  }, [path, kind]);
  if (!url) return <Notice tone="warning">This file's address isn't one the console will open.</Notice>;
  if (kind === "image") return <img src={url} alt={title} className="max-h-96 max-w-full rounded-lg border border-line bg-surface-2" />;
  if (kind === "download") return <Notice tone="info">This type of file isn't previewed here. Download it to open it.</Notice>;
  if (error) return <Notice tone="warning">The file couldn't be read.</Notice>;
  if (text === null) return <Loading label="Loading preview" />;
  return <pre className="font-mono text-compact text-ink-2 bg-code rounded-lg p-3 overflow-auto max-h-96 whitespace-pre-wrap break-words">{text}</pre>;
}

const KINDS = [{ value: "all", label: "All" }, { value: "image", label: "Images" }, { value: "text", label: "Text" }, { value: "document", label: "Documents" }, { value: "file", label: "Files" }];
const SOURCE: Record<string, string> = { document: "Document", attachment: "File", work_product: "Work product" };

export function LiveArtifacts() {
  const { companyId, org } = useLiveOrg();
  const { setup } = useEngine();
  const b = `/${setup?.deviceName ?? "pve"}/${org.slug}`;
  const [kind, setKind] = useState("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<CompanyArtifact | null>(null);
  const list = useArtifacts(companyId, kind, q.trim());
  const items = list.data?.artifacts ?? [];
  return (
    <PageFrame width="6xl">
      <PageHeader title="Artifacts" subtitle="Files and documents your agents produced, with the task each came from." />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Segmented size="sm" value={kind} onChange={setKind} options={KINDS} />
        <Input aria-label="Search artifacts" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search artifacts" className="h-9 max-w-xs" />
      </div>
      {list.isPending && <Card><Loading label="Loading artifacts" /></Card>}
      {list.error && <Card><LoadError error={list.error} retry={() => void list.refetch()} /></Card>}
      {list.data && items.length === 0 && <Card><EmptyState icon={<Package className="h-5 w-5" />} title="No artifacts yet" body="When an agent writes a document or attaches a file to a task, it shows up here." /></Card>}
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {items.map((a) => (
          <button key={a.id} onClick={() => setOpen(a)} className="text-left">
            <Card interactive className="p-4 h-full">
              <div className="flex items-center gap-2 mb-2"><FileText className="h-4 w-4 text-ink-3 shrink-0" aria-hidden /><span className="text-sm font-medium truncate">{a.title}</span></div>
              {a.previewText && <p className="text-compact text-ink-2 line-clamp-3 mb-2 break-words">{a.previewText}</p>}
              <div className="flex flex-wrap items-center gap-2"><Chip>{SOURCE[a.source] ?? a.source}</Chip><span className="text-xs text-ink-3 font-mono">{a.issue.identifier}</span><span className="text-xs text-ink-3">{ago(a.updatedAt)}</span></div>
            </Card>
          </button>
        ))}
      </div>
      {open && (
        <Modal title={open.title} subtitle={`${SOURCE[open.source] ?? open.source} from ${open.issue.identifier}: ${open.issue.title}`} size="lg" onClose={() => setOpen(null)}
          footer={<>
            <Link to={`${b}/tasks/${open.issue.identifier}`} className="text-compact text-accent hover:underline mr-auto">Open the task</Link>
            {(open.downloadPath ?? open.contentPath) && engine.artifacts.pathUrl(open.downloadPath ?? open.contentPath ?? "") && <a className="inline-flex items-center gap-2 h-10 px-4 rounded-lg bg-surface-2 border border-line text-sm hover:bg-surface-3" href={engine.artifacts.pathUrl(open.downloadPath ?? open.contentPath ?? "") ?? undefined} download><Download className="h-4 w-4" />Download</a>}
          </>}>
          {open.contentPath ? <Preview path={open.contentPath} contentType={open.contentType} mediaKind={open.mediaKind} title={open.title} /> : open.previewText ? <p className="text-sm text-ink-2 whitespace-pre-wrap">{open.previewText}</p> : <Notice>This item has no file to preview.</Notice>}
        </Modal>
      )}
    </PageFrame>
  );
}

const WS_STATUS: Record<string, [StatusKind, string]> = { active: ["working", "Active"], idle: ["idle", "Idle"], in_review: ["paused", "In review"], archived: ["off", "Archived"], cleanup_failed: ["critical", "Cleanup failed"] };
const wsStatus = (s: string): [StatusKind, string] => WS_STATUS[s] ?? ["idle", s.replace(/_/g, " ")];

export function LiveWorkspaces() {
  const { companyId, org } = useLiveOrg();
  const { setup } = useEngine();
  const b = `/${setup?.deviceName ?? "pve"}/${org.slug}`;
  const list = useWorkspaces(companyId);
  const items = list.data ?? [];
  return (
    <PageFrame width="4xl">
      <PageHeader title="Workspaces" subtitle="Where agents do their work: a folder or a branch of a project, with the services running in it." />
      <Card className="divide-y divide-line">
        {list.isPending && <Loading label="Loading workspaces" />}
        {list.error && <LoadError error={list.error} retry={() => void list.refetch()} />}
        {list.data && items.length === 0 && <EmptyState icon={<GitBranch className="h-5 w-5" />} title="No workspaces yet" body="A workspace appears when an agent starts work on a project that uses one." />}
        {items.map((w) => {
          const [kind, label] = wsStatus(w.status);
          return (
            <Link key={w.id} to={`${b}/workspaces/${w.id}`} className="flex flex-wrap items-center gap-3 px-5 py-3 hover:bg-surface-2/40">
              <GitBranch className="h-4 w-4 text-ink-3 shrink-0" aria-hidden />
              <div className="flex-1 min-w-48"><div className="text-sm font-medium">{w.name}</div><div className="text-xs text-ink-3 font-mono truncate">{w.branchName ?? w.cwd ?? w.providerType}</div></div>
              <Status kind={kind} label={label} />
              <span className="text-xs text-ink-3 w-20 text-right">{ago(w.lastUsedAt)}</span>
            </Link>
          );
        })}
      </Card>
    </PageFrame>
  );
}

const SERVICE: Record<string, [StatusKind, string]> = { running: ["good", "Running"], starting: ["working", "Starting"], stopped: ["off", "Stopped"], failed: ["critical", "Failed"] };

export function LiveWorkspaceDetail() {
  const { workspaceId = "" } = useParams();
  const { companyId, org } = useLiveOrg();
  const { setup } = useEngine();
  const b = `/${setup?.deviceName ?? "pve"}/${org.slug}`;
  const q = useWorkspace(companyId, workspaceId);
  const w = q.data as (ExecutionWorkspace & { runtimeServices?: { id: string; serviceName: string; status: string; url: string | null; port: number | null; healthStatus?: string }[] }) | undefined;
  return (
    <PageFrame width="4xl">
      <Link to={`${b}/workspaces`} className="inline-flex items-center gap-1.5 text-compact text-ink-3 hover:text-ink mb-4"><ArrowLeft className="h-4 w-4" />Workspaces</Link>
      {q.isPending && <Loading />}
      {q.error && <Card><LoadError error={q.error} retry={() => void q.refetch()} /></Card>}
      {w && (
        <>
          <PageHeader title={w.name} subtitle={w.branchName ?? w.cwd ?? undefined} actions={<Status kind={wsStatus(w.status)[0]} label={wsStatus(w.status)[1]} />} />
          <Card className="p-5 mb-6">
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
              <dt className="text-ink-3">Kind</dt><dd>{w.mode.replace(/_/g, " ")} · {w.providerType.replace(/_/g, " ")}</dd>
              {w.cwd && <><dt className="text-ink-3">Folder</dt><dd className="font-mono break-all">{w.cwd}</dd></>}
              {w.branchName && <><dt className="text-ink-3">Branch</dt><dd className="font-mono">{w.branchName}{w.baseRef ? ` from ${w.baseRef}` : ""}</dd></>}
              <dt className="text-ink-3">Last used</dt><dd>{ago(w.lastUsedAt)}</dd>
              <dt className="text-ink-3">Opened</dt><dd>{ago(w.openedAt)}</dd>
            </dl>
          </Card>
          <SectionTitle>Running services</SectionTitle>
          <Card className="divide-y divide-line">
            {(w.runtimeServices ?? []).length === 0 && <p className="px-5 py-4 text-sm text-ink-3">Nothing is running in this workspace.</p>}
            {(w.runtimeServices ?? []).map((s) => {
              const [k, label] = SERVICE[s.status] ?? ["idle", s.status];
              return <div key={s.id} className="flex flex-wrap items-center gap-3 px-5 py-3"><span className="flex-1 text-sm font-medium">{s.serviceName}</span>{s.port && <span className="text-xs text-ink-3 font-mono">port {s.port}</span>}<Status kind={k} label={label} /></div>;
            })}
          </Card>
        </>
      )}
    </PageFrame>
  );
}
