import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Box, Database, Disc3, Download, HardDrive, Link2, Loader2, Monitor, Package, Search, Trash2, Upload } from "lucide-react";
import { ApiError, type ContentKind, type StorageItem } from "../../data/api.ts";
import { useEngine } from "../../data/store.tsx";
import { cn, formatBytes } from "../../lib/storage.ts";
import { usePinActions } from "../../pin/PinContext.tsx";
import { BarMeter } from "../../ui/meters.tsx";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Card, EmptyState, Input, PageFrame, Segmented, Status } from "../../ui/primitives.tsx";
import { tabsFor, volName } from "./content.ts";
import { StorageAdmin } from "./StorageAdmin.tsx";
import { VolumeDetails } from "./VolumeDetails.tsx";

const ICON: Partial<Record<ContentKind, React.ReactNode>> = { iso: <Disc3 className="h-4 w-4" />, vztmpl: <Package className="h-4 w-4" />, backup: <Database className="h-4 w-4" />, images: <Monitor className="h-4 w-4" />, rootdir: <Box className="h-4 w-4" /> };

/** One storage, like Proxmox's storage panel: usage, then what it holds by content type, with upload, download and delete. */
export function StorageDetail() {
  const { id } = useParams();
  const engine = useEngine();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const device = engine.setup?.deviceName ?? "pve";
  const s = engine.data.host.storage.find((x) => x.id === id);
  const tabs = tabsFor(s);
  const [items, setItems] = useState<StorageItem[] | null>(null);
  // Open on the first tab that holds something, so a storage full of backups doesn't greet you with "No ISO images".
  const tab = tabs.find((t) => t.kind === params.get("tab")) ?? (items ? tabs.find((t) => items.some((i) => i.content === t.kind)) : undefined) ?? tabs[0];
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [confirm, setConfirm] = useState<StorageItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [details, setDetails] = useState<StorageItem | null>(null);

  useEffect(() => {
    if (!s) return;
    let alive = true;
    engine.backend.content(s.id).then(
      (list) => alive && (setItems(list), setError(null)),
      (e) => alive && setError(e instanceof ApiError ? e.message : "Couldn't read this storage"),
    );
    return () => {
      alive = false;
    };
  }, [s?.id, engine.backend, engine.contentVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = (modal: string, extra = "") => nav(`?${new URLSearchParams({ ...(tab ? { tab: tab.kind } : {}), modal, storage: s?.id ?? "" }).toString()}${extra}`);
  const has = (k: ContentKind) => tabs.some((t) => t.kind === k);
  usePinActions(
    s
      ? {
          context: s.id,
          items: [
            ...(has("iso") ? [{ id: "upload-iso", label: "Upload ISO", icon: <Upload className="h-4 w-4" />, group: "do" as const, run: () => open("upload", "&content=iso") }] : []),
            ...(has("vztmpl") ? [{ id: "templates", label: "Templates", icon: <Package className="h-4 w-4" />, group: "do" as const, run: () => open("templates") }] : []),
            ...(has("iso") || has("vztmpl") ? [{ id: "download-url", label: "Download from URL", icon: <Link2 className="h-4 w-4" />, group: "do" as const, run: () => open("download-url", `&content=${tab?.kind === "vztmpl" ? "vztmpl" : "iso"}`) }] : []),
            ...(has("vztmpl") ? [{ id: "upload-tpl", label: "Upload template", icon: <Upload className="h-4 w-4" />, group: "do" as const, more: true, run: () => open("upload", "&content=vztmpl") }] : []),
            { id: "new-vm", label: "New VM from ISO", icon: <Monitor className="h-4 w-4" />, group: "do" as const, more: true, run: () => nav(`?modal=new-machine&kind=vm`) },
          ],
        }
      : null,
    10,
  );

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (items ?? []).filter((i) => i.content === tab?.kind && (!needle || i.volid.toLowerCase().includes(needle) || String(i.vmid ?? "").includes(needle))).sort((a, b) => (b.ctime ?? 0) - (a.ctime ?? 0));
  }, [items, tab, q]);

  if (!s) return engine.ready ? <Navigate to={`/${device}/storage`} replace /> : <div className="p-10 text-ink-3 text-sm">Loading…</div>;

  const remove = async () => {
    if (!confirm) return;
    setDeleting(true);
    try {
      const r = await engine.backend.deleteVolume(s.id, confirm.volid);
      engine.watchTask(r.task, `Delete ${volName(confirm.volid)}`);
      setItems((l) => (l ?? []).filter((x) => x.volid !== confirm.volid));
      setConfirm(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't delete it");
      setConfirm(null);
    } finally {
      setDeleting(false);
    }
  };

  const counts = (k: ContentKind) => (items ?? []).filter((i) => i.content === k).length;

  return (
    <PageFrame width="6xl">
      <div className="flex items-center gap-3 mb-1 text-compact text-ink-3"><Link to={`/${device}/storage`} className="hover:text-ink">Storage</Link><span>/</span><span className="text-ink-2">{s.id}</span></div>
      <div className="flex flex-wrap items-center gap-4 mb-6">
        <span className="h-11 w-11 rounded-xl bg-surface-2 flex items-center justify-center text-ink-2"><HardDrive className="h-5 w-5" /></span>
        <div className="flex-1 min-w-0">
          <h1 className="text-heading font-semibold tracking-tight leading-tight">{s.id}</h1>
          <div className="text-compact text-ink-3">{s.type}{s.path ? ` · ${s.path}` : ""}{s.shared ? " · shared" : ""} · {device}</div>
        </div>
        {s.active === false ? <Status kind="off" label="Unavailable" /> : <Status kind="good" label="Active" />}
        <StorageAdmin id={s.id} />
      </div>
      <Card className="p-5 mb-5">
        <BarMeter label={`${formatBytes(Math.max(0, s.total - s.used))} free`} pct={s.total ? (s.used / s.total) * 100 : 0} value={`${formatBytes(s.used)} of ${formatBytes(s.total)}`} />
      </Card>

      {tabs.length === 0 ? (
        <Card><EmptyState icon={<Database className="h-5 w-5" />} title="No browsable content" body="This storage isn't set up to hold ISO images, templates, backups or disks." /></Card>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3 mb-3">
            <div className="max-w-full overflow-x-auto [scrollbar-width:none]">
              <Segmented value={tab!.kind} onChange={(k) => setParams((p) => { const n = new URLSearchParams(p); n.set("tab", k); return n; }, { replace: true })} options={tabs.map((t) => ({ value: t.kind, label: <span className="whitespace-nowrap">{t.label}{items ? <span className="text-ink-3 tabular-nums"> {counts(t.kind)}</span> : null}</span> }))} />
            </div>
            <div className="relative flex-1 min-w-[180px] max-w-xs ml-auto">
              <Search className="h-4 w-4 text-ink-3 absolute left-3 top-1/2 -translate-y-1/2" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter" className="pl-9 h-9" aria-label="Filter files" />
            </div>
          </div>
          {error && <p role="alert" className="text-compact text-critical mb-3">{error}</p>}
          <Card className="overflow-x-auto">
            {items === null && !error ? (
              <div className="p-8 text-center text-ink-3 text-sm inline-flex items-center justify-center gap-2 w-full"><Loader2 className="h-4 w-4 animate-spin" />Reading {s.id}…</div>
            ) : rows.length === 0 ? (
              <EmptyState
                icon={ICON[tab!.kind] ?? <Database className="h-5 w-5" />}
                title={q ? "Nothing matches" : `No ${tab!.label.toLowerCase()} on ${s.id}`}
                body={q ? "Try another filter." : tab!.empty}
                action={
                  q ? undefined : tab!.kind === "iso" ? (
                    <div className="flex flex-wrap justify-center gap-2"><Button variant="primary" onClick={() => open("upload", "&content=iso")}><Upload className="h-4 w-4" />Upload ISO</Button><Button onClick={() => open("download-url", "&content=iso")}><Link2 className="h-4 w-4" />Download from URL</Button></div>
                  ) : tab!.kind === "vztmpl" ? (
                    <div className="flex flex-wrap justify-center gap-2"><Button variant="primary" onClick={() => open("templates")}><Package className="h-4 w-4" />Browse templates</Button><Button onClick={() => open("download-url", "&content=vztmpl")}><Link2 className="h-4 w-4" />Download from URL</Button></div>
                  ) : undefined
                }
              />
            ) : (
              <table className="w-full text-compact min-w-[640px]">
                <thead>
                  <tr className="border-b border-line text-ink-3 text-left">
                    <th className="font-normal px-4 h-10">Name</th>
                    {(tab!.kind === "backup" || tab!.kind === "images" || tab!.kind === "rootdir") && <th className="font-normal px-3">Machine</th>}
                    <th className="font-normal px-3">Format</th>
                    <th className="font-normal px-3 text-right">Size</th>
                    <th className="font-normal px-3">Date</th>
                    <th className="px-3 w-[1%]"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((i) => (
                    <tr key={i.volid} className="border-b border-line last:border-0 hover:bg-surface-2/50">
                      <td className="px-4 py-2.5"><span className="inline-flex items-center gap-2 min-w-0"><span className="text-ink-3 shrink-0">{ICON[i.content]}</span><span className="truncate font-mono text-xs" title={i.volid}>{volName(i.volid)}</span>{i.protected && <span className="text-micro text-ink-3 border border-line rounded px-1">protected</span>}</span>{i.notes && <div className="text-xs text-ink-3 truncate pl-6">{i.notes}</div>}</td>
                      {(tab!.kind === "backup" || tab!.kind === "images" || tab!.kind === "rootdir") && <td className="px-3 tabular-nums">{i.vmid ? <Link to={`/${device}/machines/${i.vmid}`} className="hover:underline">{engine.data.guests.find((g) => g.vmid === i.vmid)?.name ?? "Machine"} #{i.vmid}</Link> : "—"}</td>}
                      <td className="px-3 text-ink-2">{i.format ?? "—"}</td>
                      <td className="px-3 text-right tabular-nums whitespace-nowrap">{i.size !== null ? formatBytes(i.size) : "—"}</td>
                      <td className="px-3 text-ink-2 whitespace-nowrap tabular-nums">{i.ctime ? new Date(i.ctime * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—"}</td>
                      <td className="px-3 whitespace-nowrap text-right">
                        <span className="inline-flex items-center gap-1">
                          {i.content === "iso" && <Button size="sm" variant="ghost" onClick={() => nav(`?modal=new-machine&kind=vm`)} title="Create a VM that boots this"><Monitor className="h-3.5 w-3.5" />New VM</Button>}
                          {i.content === "vztmpl" && <Button size="sm" variant="ghost" onClick={() => nav(`?modal=new-machine`)} title="Create a container from it"><Box className="h-3.5 w-3.5" />New container</Button>}
                          <Button size="sm" variant="ghost" onClick={() => setDetails(i)} aria-label={`Details of ${volName(i.volid)}`}>Details</Button>
                          <button onClick={() => setConfirm(i)} disabled={i.protected} title={i.protected ? "Protected; remove protection in Proxmox first" : "Delete"} aria-label={`Delete ${volName(i.volid)}`} className={cn("h-8 w-8 rounded-md inline-flex items-center justify-center text-ink-3 hover:text-critical hover:bg-critical/10 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-ink-3")}><Trash2 className="h-4 w-4" /></button>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
          {engine.running.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {engine.running.map((r) => <span key={r.upid} className="inline-flex items-center gap-2 text-xs text-ink-2 rounded-full border border-line px-3 h-7"><Loader2 className="h-3.5 w-3.5 animate-spin" />{r.label}</span>)}
              <Link to={`/${device}/tasks`} className="text-xs text-ink-3 hover:text-ink inline-flex items-center gap-1 h-7"><Download className="h-3.5 w-3.5" />Tasks</Link>
            </div>
          )}
        </>
      )}

      {details && <VolumeDetails storage={s.id} item={details} onClose={() => setDetails(null)} onDelete={() => { setConfirm(details); setDetails(null); }} onSaved={() => setItems((l) => (l ?? []).map((x) => (x.volid === details.volid ? { ...x } : x)))} />}
      {confirm && (
        <Modal
          size="sm"
          title={`Delete ${volName(confirm.volid)}?`}
          subtitle={confirm.content === "backup" ? "This backup can't be restored after it's deleted." : confirm.content === "images" || confirm.content === "rootdir" ? "This is a machine's disk. Deleting it destroys that data for good." : "It's removed from the storage. You can download it again later."}
          onClose={() => setConfirm(null)}
          footer={<><Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button><Button variant="danger" onClick={remove} disabled={deleting}>{deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}Delete</Button></>}
        >
          <p className="font-mono text-xs text-ink-3 break-all">{confirm.volid}</p>
        </Modal>
      )}
    </PageFrame>
  );
}
