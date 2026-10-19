import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Download, FileUp, Loader2, Package, Search } from "lucide-react";
import { ApiError, type CatalogTemplate } from "../../data/api.ts";
import { useEngine } from "../../data/store.tsx";
import { cn, formatBytes } from "../../lib/storage.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Input, Segmented, Toggle, selectClass } from "../../ui/primitives.tsx";
import { fileNameError, nameFromUrl, storagesWith, volName } from "./content.ts";

const select = selectClass;
const query = () => new URLSearchParams(window.location.search);

function StoragePicker({ kind, value, onChange }: { kind: "iso" | "vztmpl"; value: string; onChange: (v: string) => void }) {
  const { data } = useEngine();
  const list = storagesWith(data.host.storage, kind);
  return (
    <label className="block">
      <span className="block text-compact text-ink-2 mb-2">Storage</span>
      {list.length ? (
        <select value={value} onChange={(e) => onChange(e.target.value)} className={select}>
          {list.map((s) => <option key={s.id} value={s.id}>{s.id} · {formatBytes(Math.max(0, s.total - s.used))} free</option>)}
        </select>
      ) : (
        <p className="text-compact text-ink-3">No storage on this device is set up for {kind === "iso" ? "ISO images" : "container templates"}.</p>
      )}
    </label>
  );
}

function useStorageChoice(kind: "iso" | "vztmpl") {
  const { data } = useEngine();
  const list = storagesWith(data.host.storage, kind);
  const asked = query().get("storage");
  const [storage, setStorage] = useState(list.find((s) => s.id === asked)?.id ?? list[0]?.id ?? "");
  useEffect(() => {
    if (!list.some((s) => s.id === storage)) setStorage(list[0]?.id ?? "");
  }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps
  return [storage, setStorage] as const;
}

/** Upload an ISO image or container template from this computer, with progress. */
export function UploadModal({ onClose }: { onClose: () => void }) {
  const engine = useEngine();
  const [kind, setKind] = useState<"iso" | "vztmpl">(query().get("content") === "vztmpl" ? "vztmpl" : "iso");
  const [storage, setStorage] = useStorageChoice(kind);
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  const nameErr = file ? fileNameError(file.name, kind) : null;

  useEffect(() => () => abort.current?.abort(), []);

  const start = async () => {
    if (!file || nameErr || !storage) return;
    setError(null);
    setProgress(0);
    abort.current = new AbortController();
    try {
      const r = await engine.backend.upload(storage, kind, file, setProgress, abort.current.signal);
      engine.watchTask(r.task, `Upload ${file.name}`);
      abort.current = null;
      onClose();
    } catch (e) {
      setProgress(null);
      if (e instanceof ApiError && e.code === "aborted") return;
      setError(e instanceof ApiError ? e.message : "The upload failed");
    }
  };

  const pick = (f: File | undefined) => {
    if (!f) return;
    setFile(f);
    setError(null);
    if (/\.tar\.(gz|xz|zst)$/.test(f.name)) setKind("vztmpl");
    if (/\.(iso|img)$/i.test(f.name)) setKind("iso");
  };

  const uploading = progress !== null;
  return (
    <Modal
      icon={<FileUp className="h-5 w-5" />}
      title="Upload"
      subtitle="From this computer to the device. Large ISOs take a while; keep this open until it finishes."
      onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>{uploading ? "Cancel upload" : "Cancel"}</Button><Button variant="primary" onClick={start} disabled={!file || !!nameErr || !storage || uploading}>{uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileUp className="h-4 w-4" />}Upload</Button></>}
    >
      <div className="space-y-4">
        <Segmented value={kind} onChange={setKind} options={[{ value: "iso", label: "ISO image" }, { value: "vztmpl", label: "Container template" }]} />
        <StoragePicker kind={kind} value={storage} onChange={setStorage} />
        <button
          type="button"
          disabled={uploading}
          onClick={() => input.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files[0]); }}
          className={cn("w-full rounded-xl border border-dashed p-6 text-center transition", drag ? "border-accent bg-accent-soft" : "border-line-strong hover:border-accent/50")}
        >
          {file ? (
            <span className="block"><span className="block font-mono text-compact break-all">{file.name}</span><span className="block text-xs text-ink-3 mt-1">{formatBytes(file.size)}</span></span>
          ) : (
            <span className="block text-sm text-ink-2">Drop a file here or <span className="text-accent">choose one</span><span className="block text-xs text-ink-3 mt-1">{kind === "iso" ? ".iso or .img" : ".tar.gz, .tar.xz or .tar.zst"}</span></span>
          )}
        </button>
        <input ref={input} type="file" className="hidden" accept={kind === "iso" ? ".iso,.img" : ".gz,.xz,.zst"} onChange={(e) => pick(e.target.files?.[0])} />
        {nameErr && <p className="text-xs text-critical">{nameErr}</p>}
        {uploading && (
          <div>
            <div className="flex justify-between text-xs text-ink-2 mb-1.5"><span>{progress! < 1 ? "Uploading" : "Proxmox is saving it"}</span><span className="tabular-nums">{Math.round(progress! * 100)}%</span></div>
            <div className="h-2 rounded-full bg-surface-3 overflow-hidden" role="progressbar" aria-valuenow={Math.round(progress! * 100)} aria-valuemin={0} aria-valuemax={100}><div className="h-full bg-accent transition-[width] duration-(--duration-base)" style={{ width: `${progress! * 100}%` }} /></div>
          </div>
        )}
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}

/** Have Proxmox download an ISO or template straight from a URL into a storage, optionally checking its checksum. */
export function DownloadUrlModal({ onClose }: { onClose: () => void }) {
  const engine = useEngine();
  const [kind, setKind] = useState<"iso" | "vztmpl">(query().get("content") === "vztmpl" ? "vztmpl" : "iso");
  const [storage, setStorage] = useStorageChoice(kind);
  const [url, setUrl] = useState("");
  const [filename, setFilename] = useState("");
  const [touchedName, setTouchedName] = useState(false);
  const [algorithm, setAlgorithm] = useState("sha256");
  const [sum, setSum] = useState("");
  const [verify, setVerify] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const n = nameFromUrl(url);
    if (!touchedName) setFilename(n);
    // The address usually says what it is.
    if (/\.(iso|img)$/i.test(n)) setKind("iso");
    else if (/\.tar\.(gz|xz|zst)$/.test(n)) setKind("vztmpl");
  }, [url, touchedName]);
  const urlErr = url && !/^https?:\/\/[^\s]+$/i.test(url) ? "Enter a full http:// or https:// address." : null;
  const nameErr = filename ? fileNameError(filename, kind) : null;
  const sumErr = sum && !/^[0-9a-fA-F]{32,128}$/.test(sum.trim()) ? "Paste the checksum as hexadecimal." : null;

  const start = async () => {
    if (!url || urlErr || !filename || nameErr || sumErr || !storage) return;
    setBusy(true);
    setError(null);
    try {
      const r = await engine.backend.downloadUrl(storage, { url: url.trim(), content: kind, filename, checksum: sum.trim() || undefined, algorithm: sum.trim() ? algorithm : undefined, verifyCertificates: verify });
      engine.watchTask(r.task, `Download ${filename}`);
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Proxmox couldn't start the download");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      icon={<Download className="h-5 w-5" />}
      title="Download from URL"
      subtitle="The device downloads it directly, so nothing passes through this computer. Pin tells you when it's done."
      onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={start} disabled={busy || !url || !!urlErr || !filename || !!nameErr || !!sumErr || !storage}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}Download</Button></>}
    >
      <div className="space-y-4">
        <Segmented value={kind} onChange={setKind} options={[{ value: "iso", label: "ISO image" }, { value: "vztmpl", label: "Container template" }]} />
        <label className="block">
          <span className="block text-compact text-ink-2 mb-2">Address</span>
          <Input autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://cdimage.debian.org/…/debian-13.1.0-amd64-netinst.iso" spellCheck={false} />
          {urlErr && <span className="block text-xs mt-1.5 text-critical">{urlErr}</span>}
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className="block">
            <span className="block text-compact text-ink-2 mb-2">Save as</span>
            <Input value={filename} onChange={(e) => { setFilename(e.target.value); setTouchedName(true); }} spellCheck={false} />
            {nameErr && <span className="block text-xs mt-1.5 text-critical">{nameErr}</span>}
          </label>
          <StoragePicker kind={kind} value={storage} onChange={setStorage} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-[140px_1fr] gap-4">
          <label className="block">
            <span className="block text-compact text-ink-2 mb-2">Checksum</span>
            <select value={algorithm} onChange={(e) => setAlgorithm(e.target.value)} className={select}>{["sha256", "sha512", "sha1", "md5", "sha224", "sha384"].map((a) => <option key={a}>{a}</option>)}</select>
          </label>
          <label className="block">
            <span className="block text-compact text-ink-2 mb-2">Value <span className="text-ink-3">(optional, recommended)</span></span>
            <Input value={sum} onChange={(e) => setSum(e.target.value)} placeholder="Paste from the download page" spellCheck={false} className="font-mono text-xs" />
            {sumErr && <span className="block text-xs mt-1.5 text-critical">{sumErr}</span>}
          </label>
        </div>
        <div className="flex items-center justify-between gap-4">
          <div><div className="text-sm">Verify the server's certificate</div><div className="text-xs text-ink-3">Leave on unless you trust a server with a self-signed certificate.</div></div>
          <Toggle checked={verify} onChange={setVerify} label="Verify the server's certificate" />
        </div>
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}

/** Proxmox's template catalog: official system templates and TurnKey appliances, downloaded with one click. */
export function TemplatesModal({ onClose }: { onClose: () => void }) {
  const engine = useEngine();
  const [storage, setStorage] = useStorageChoice("vztmpl");
  const [list, setList] = useState<CatalogTemplate[] | null>(null);
  const [have, setHave] = useState<Set<string>>(new Set());
  const [section, setSection] = useState<"system" | "turnkeylinux">("system");
  const [q, setQ] = useState("");
  const [started, setStarted] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    engine.backend.catalog().then(setList, (e) => setError(e instanceof ApiError ? e.message : "Couldn't load the catalog"));
  }, [engine.backend]);
  useEffect(() => {
    if (!storage) return;
    engine.backend.content(storage, "vztmpl").then((items) => setHave(new Set(items.map((i) => volName(i.volid)))), () => setHave(new Set()));
  }, [storage, engine.backend, engine.contentVersion]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (list ?? []).filter((t) => (needle ? true : (t.section ?? "system") === section) && (!needle || `${t.template} ${t.headline ?? ""} ${t.os ?? ""}`.toLowerCase().includes(needle))).sort((a, b) => (a.headline ?? a.template).localeCompare(b.headline ?? b.template));
  }, [list, section, q]);

  const get = async (t: CatalogTemplate) => {
    setError(null);
    try {
      const r = await engine.backend.downloadTemplate(storage, t.template);
      setStarted((s) => new Set(s).add(t.template));
      engine.watchTask(r.task, `Download ${t.headline ?? t.template}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't start the download");
    }
  };

  return (
    <Modal size="lg" icon={<Package className="h-5 w-5" />} title="Container templates" subtitle="Ready-made systems for new containers, from Proxmox's catalog." onClose={onClose} footer={<Button onClick={onClose}>Done</Button>}>
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_220px] gap-3 items-end">
          <div className="flex flex-wrap items-center gap-3">
            <Segmented value={section} onChange={setSection} options={[{ value: "system", label: "Systems" }, { value: "turnkeylinux", label: "Apps (TurnKey)" }]} />
            <div className="relative flex-1 min-w-[160px]">
              <Search className="h-4 w-4 text-ink-3 absolute left-3 top-1/2 -translate-y-1/2" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search all" className="pl-9 h-9" aria-label="Search templates" />
            </div>
          </div>
          <StoragePicker kind="vztmpl" value={storage} onChange={setStorage} />
        </div>
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
        <div className="rounded-xl border border-line max-h-[46vh] overflow-y-auto overflow-x-hidden divide-y divide-line">
          {list === null && !error && <div className="p-6 text-center text-ink-3 text-sm"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Loading the catalog…</div>}
          {list !== null && rows.length === 0 && <div className="p-6 text-center text-ink-3 text-sm">Nothing matches.</div>}
          {rows.map((t) => {
            const owned = have.has(t.template);
            const busy = started.has(t.template) && !owned;
            return (
              <div key={t.template} className="flex items-center gap-3 px-4 py-3">
                <span className="h-9 w-9 rounded-lg bg-surface-2 flex items-center justify-center text-ink-2 shrink-0"><Package className="h-4 w-4" /></span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{t.headline ?? t.template}</div>
                  <div className="text-xs text-ink-3 font-mono truncate" title={t.template}>{t.template}</div>
                </div>
                {owned ? (
                  <span className="text-xs text-good inline-flex items-center gap-1"><Check className="h-3.5 w-3.5" />On {storage}</span>
                ) : (
                  <Button size="sm" onClick={() => get(t)} disabled={busy || !storage}>{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}{busy ? "Downloading" : "Download"}</Button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
