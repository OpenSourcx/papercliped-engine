import { useState } from "react";
import { ArrowLeft, Download, FileText, Package } from "lucide-react";
import type { CompanyArtifact } from "@papercliped-engine/engine-client";
import { engine } from "../../data/engine/queries.ts";
import { ago } from "../../data/engine/map.ts";
import { useArtifacts } from "../../data/engine/more.ts";
import { Chip, EmptyState, Input, Notice, Select, Spinner } from "../../ui/primitives.tsx";
import { Preview } from "../org/live/LiveArtifacts.tsx";

const SOURCE: Record<string, string> = { document: "Document", attachment: "File", work_product: "Work product" };

/**
 * The files and documents an organization's agents produced, beside the conversation: search them, open one in place
 * (text and code in a monospace view, images as images, anything else as a download). Files are untrusted engine data, so
 * the same safe preview as the Artifacts page is used.
 */
export function FilesPanel({ orgs, companyId, onOrg }: { orgs: { name: string; companyId: string }[]; companyId: string | null; onOrg: (companyId: string) => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<CompanyArtifact | null>(null);
  const list = useArtifacts(companyId, "all", q.trim());
  const items = list.data?.artifacts ?? [];

  if (orgs.length === 0) return <EmptyState icon={<Package className="h-5 w-5" />} title="No organizations yet" body="Files your agents write show up here once an organization has some." />;
  const download = open ? open.downloadPath ?? open.contentPath : null;
  const safe = download ? engine.artifacts.pathUrl(download) : null;
  return (
    <div className="flex flex-col min-h-0 gap-3">
      {orgs.length > 1 && (
        <Select aria-label="Organization" size="sm" value={companyId ?? ""} onChange={(e) => { setOpen(null); onOrg(e.target.value); }}>
          {orgs.map((o) => <option key={o.companyId} value={o.companyId}>{o.name}</option>)}
        </Select>
      )}
      {open ? (
        <div className="flex flex-col min-h-0 gap-3">
          <button type="button" onClick={() => setOpen(null)} className="transition-control self-start inline-flex items-center gap-1 text-compact text-ink-2 hover:text-ink"><ArrowLeft className="h-4 w-4" aria-hidden />Files</button>
          <div>
            <div className="text-sm font-medium break-words">{open.title}</div>
            <div className="text-xs text-ink-3 mt-0.5">{SOURCE[open.source] ?? open.source} from <span className="font-mono">{open.issue.identifier}</span> · {ago(open.updatedAt)}</div>
          </div>
          <div className="min-h-0 overflow-auto">
            {open.contentPath ? <Preview path={open.contentPath} contentType={open.contentType} mediaKind={open.mediaKind} title={open.title} /> : open.previewText ? <p className="text-sm text-ink-2 whitespace-pre-wrap break-words">{open.previewText}</p> : <Notice tone="info">There is no preview for this one.</Notice>}
          </div>
          {download && safe && <a href={engine.artifacts.pathUrl(download) ?? undefined} download className="transition-control self-start inline-flex items-center gap-2 h-9 px-3 rounded-lg bg-surface-2 border border-line text-compact font-medium hover:bg-surface-3"><Download className="h-4 w-4" aria-hidden />Download</a>}
        </div>
      ) : (
        <>
          <Input aria-label="Search files" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search files" className="h-9" />
          {list.isPending && <div className="py-6 flex justify-center"><Spinner label="Loading files" /></div>}
          {list.error && <Notice tone="warning">The files couldn't be listed.</Notice>}
          {list.data && items.length === 0 && <p className="text-compact text-ink-3 text-pretty">{q ? "Nothing matches." : "When an agent writes a document or attaches a file to a task, it shows up here."}</p>}
          <ul className="space-y-0.5 -mx-1">
            {items.map((a) => (
              <li key={a.id}>
                <button type="button" onClick={() => setOpen(a)} className="transition-control w-full text-left rounded-lg px-2 py-2 hover:bg-surface-2 flex items-start gap-2.5">
                  <FileText className="h-4 w-4 text-ink-3 mt-0.5 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block text-compact truncate">{a.title}</span>
                    <span className="flex items-center gap-2 text-xs text-ink-3"><Chip>{SOURCE[a.source] ?? a.source}</Chip><span className="font-mono">{a.issue.identifier}</span></span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
