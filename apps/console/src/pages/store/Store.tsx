import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Box, Check, Download, ExternalLink, FileUp, Loader2, Package, Puzzle, Search, Store as StoreIcon, Trash2 } from "lucide-react";
import { ApiError } from "../../data/api.ts";
import { useEngine } from "../../data/store.tsx";
import { cn, formatBytes } from "../../lib/storage.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Card, Chip, EmptyState, Input, PageFrame, PageHeader, Segmented } from "../../ui/primitives.tsx";
import { storagesWith } from "../storage/content.ts";
import { CATEGORIES, filterItems, statusLabel, tileHue, type Category, type StoreItem } from "./catalog.ts";
import { useStoreItems } from "./useStore.ts";

const select = "h-10 w-full rounded-lg bg-surface-2 border border-line px-3 text-[14px] outline-none focus:border-line-strong";

function Tile({ name, size = 44 }: { name: string; size?: number }) {
  const h = tileHue(name);
  return (
    <span className="grid place-items-center rounded-xl font-semibold shrink-0 text-white" style={{ width: size, height: size, background: `linear-gradient(135deg, hsl(${h} 62% 46%), hsl(${(h + 40) % 360} 62% 36%))`, fontSize: size * 0.42 }} aria-hidden>
      {name.replace(/[^A-Za-z0-9]/g, "").slice(0, 1).toUpperCase()}
    </span>
  );
}

function StatusChip({ it }: { it: StoreItem }) {
  if (it.status === "installed") return <Chip tone="accent"><Check className="h-3 w-3 mr-1" />Installed</Chip>;
  if (it.status === "update") return <Chip tone="warning">Update available</Chip>;
  if (it.status === "manual") return <Chip>Bring your own ISO</Chip>;
  return null;
}

/** The Store: one place to get operating systems, apps, driver disks and plugins, with what's installed and what has an update. */
export function Store() {
  const nav = useNavigate();
  const { items, loading, problems } = useStoreItems();
  const [cat, setCat] = useState<Category | "home">("home");
  const [q, setQ] = useState("");
  const shown = useMemo(() => filterItems(items, cat, q), [items, cat, q]);
  const open = (id: string) => nav(`?modal=store-item&item=${encodeURIComponent(id)}`);
  const updates = items.filter((i) => i.status === "update");

  const grid = (list: StoreItem[]) => (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {list.map((it) => (
        <button key={it.id} onClick={() => open(it.id)} className="text-left">
          <Card interactive className="p-4 flex gap-3 h-full">
            <Tile name={it.name} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2"><span className="font-medium truncate">{it.name}</span>{it.badge && <span className="text-[11px] text-ink-3 shrink-0">{it.badge}</span>}</div>
              <div className="text-[12px] text-ink-3 truncate">{it.vendor}{it.latestVersion ? ` · ${it.latestVersion}` : ""}</div>
              <p className="text-[13px] text-ink-2 mt-1.5 line-clamp-2">{it.summary}</p>
              <div className="mt-2 min-h-5"><StatusChip it={it} /></div>
            </div>
          </Card>
        </button>
      ))}
    </div>
  );

  return (
    <PageFrame width="6xl">
      <PageHeader title="Store" subtitle="Get operating systems, apps, drivers and plugins for this device. Installers are checked against the vendor's own checksums." />
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <Segmented value={cat} onChange={setCat} options={[{ value: "home", label: "All" }, ...CATEGORIES.map((c) => ({ value: c.id, label: c.label }))]} />
        <div className="relative ml-auto w-full sm:w-64">
          <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the Store" className="pl-9" aria-label="Search the Store" />
        </div>
      </div>
      {problems.length > 0 && <p className="text-[13px] text-warning mb-4">{problems.join(" ")} What's installed may be out of date.</p>}
      {cat === "home" && !q && updates.length > 0 && (
        <section className="mb-6"><h2 className="text-[14px] font-medium mb-2">Updates</h2>{grid(updates)}</section>
      )}
      {cat === "home" && !q ? (
        CATEGORIES.map((c) => {
          const list = items.filter((i) => i.category === c.id);
          return list.length ? <section key={c.id} className="mb-7"><h2 className="text-[14px] font-medium">{c.label}</h2><p className="text-[12px] text-ink-3 mb-2.5">{c.blurb}</p>{grid(list.slice(0, 6))}{list.length > 6 && <button className="text-[13px] text-ink-2 hover:text-ink mt-2" onClick={() => setCat(c.id)}>See all {list.length}</button>}</section> : null;
        })
      ) : shown.length ? grid(shown) : loading ? (
        <div className="py-16 grid place-items-center text-ink-3"><Loader2 className="h-5 w-5 animate-spin" /></div>
      ) : (
        <EmptyState icon={<StoreIcon className="h-5 w-5" />} title="Nothing found" body="Try another word, or pick a different section." />
      )}
    </PageFrame>
  );
}

/** One Store item: what it is, what's installed, and the install button. ?modal=store-item&item=<id> */
export function StoreItemModal({ onClose }: { onClose: () => void }) {
  const engine = useEngine();
  const nav = useNavigate();
  const { items, latest } = useStoreItems();
  const id = new URLSearchParams(window.location.search).get("item") ?? "";
  const it = items.find((x) => x.id === id);
  const kindOfStorage = it?.kind === "template" ? "vztmpl" : "iso";
  const storages = storagesWith(engine.data.host.storage, kindOfStorage).slice().sort((a, b) => b.total - b.used - (a.total - a.used));
  const [pick, setPick] = useState("");
  const storage = storages.some((s) => s.id === pick) ? pick : storages[0]?.id ?? "";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  if (!it) return null;

  const l = it.lib?.kind === "iso" ? latest[it.lib.id] : undefined;
  const run = async (fn: () => Promise<{ task: string }>, label: string) => {
    setBusy(true); setError(null);
    try {
      const r = await fn();
      engine.watchTask(r.task, label);
      setStarted(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "That didn't work. Try again.");
    }
    setBusy(false);
  };

  const install = () => {
    if (it.kind === "iso" && it.lib?.kind === "iso") {
      return run(async () => {
        const got = await engine.backend.libraryLatest(it.lib!.id);
        return engine.backend.downloadUrl(storage, { url: got.url, content: "iso", filename: got.filename, checksum: got.checksum, algorithm: got.algorithm, verifyCertificates: true });
      }, `Download ${it.name}`);
    }
    if (it.kind === "fixed" && it.lib?.kind === "fixed") return run(() => engine.backend.downloadUrl(storage, { url: it.lib!.kind === "fixed" ? it.lib!.url : "", content: "iso", filename: it.lib!.kind === "fixed" ? it.lib!.filename : "", verifyCertificates: true }), `Download ${it.name}`);
    if (it.kind === "template" && it.template) return run(() => engine.backend.downloadTemplate(storage, it.template!.template), `Download ${it.name}`);
  };
  const createMachine = () => {
    const q = new URLSearchParams({ modal: "new-machine" });
    if (it.kind === "template") { q.set("kind", "lxc"); if (it.volid) q.set("template", it.volid); }
    else { q.set("kind", "vm"); if (it.volid) q.set("iso", it.volid); if (it.lib) { q.set("ostype", it.lib.ostype); q.set("size", it.lib.size); } }
    nav(`?${q}`, { replace: true });
  };

  const needsStorage = it.kind === "iso" || it.kind === "fixed" || it.kind === "template";
  const installable = needsStorage && (it.status === "available" || it.status === "update");
  const plugin = it.plugin;
  const installed = it.status === "installed" || it.status === "update";
  const canCreate = (it.kind === "iso" || it.kind === "template" || it.kind === "fixed") && it.volid && it.kind !== "fixed";

  return (
    <Modal
      size="md"
      icon={plugin ? <Puzzle className="h-5 w-5" /> : it.kind === "template" ? <Package className="h-5 w-5" /> : <Box className="h-5 w-5" />}
      title={it.name}
      subtitle={`${it.vendor}${it.latestVersion ? ` · ${it.latestVersion}` : ""}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          {plugin && (it.status === "installed" ? <Button variant="danger" onClick={() => engine.uninstallPlugin(plugin.id)}><Trash2 className="h-4 w-4" />Remove</Button> : <Button variant="primary" onClick={() => engine.installPlugin(plugin.id)}><Download className="h-4 w-4" />Install</Button>)}
          {it.kind === "manual" && it.lib?.kind === "manual" && (
            <>
              <Button onClick={() => nav("?modal=upload&content=iso", { replace: true })}><FileUp className="h-4 w-4" />Upload ISO</Button>
              <a href={it.lib.pageUrl} target="_blank" rel="noopener noreferrer" className="inline-flex"><Button variant="primary"><ExternalLink className="h-4 w-4" />Get it from Microsoft</Button></a>
            </>
          )}
          {canCreate && <Button variant={installable ? "secondary" : "primary"} onClick={createMachine}><Box className="h-4 w-4" />Create machine</Button>}
          {installable && <Button variant="primary" onClick={install} disabled={busy || started || !storage}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}{started ? "Downloading" : it.status === "update" ? "Download newer" : "Install"}</Button>}
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex gap-3 items-start"><Tile name={it.name} size={56} /><div><p className="text-[14px] text-ink-2">{it.summary}</p><div className="mt-2 flex flex-wrap gap-2 items-center"><StatusChip it={it} />{it.badge && <Chip>{it.badge}</Chip>}</div></div></div>
        {it.status === "update" && <p className="text-[13px] text-ink-2">You have {it.haveVersion ?? "an older version"}. {it.latestVersion} is the newest the vendor lists. Your older copy stays until you remove it.</p>}
        {installed && it.volid && <p className="text-[13px] text-ink-3">On this device as <span className="font-mono text-ink-2">{it.volid}</span>.</p>}
        {it.kind === "iso" && l && <p className="text-[13px] text-ink-3">Downloads <span className="font-mono text-ink-2">{l.filename}</span> and checks its {l.algorithm.toUpperCase()} checksum against {it.vendor}'s own list.</p>}
        {it.kind === "iso" && !l && installable && <p className="text-[13px] text-ink-3">The newest version is looked up from {it.vendor}'s download list when you install.</p>}
        {it.lib?.kind === "fixed" && <p className="text-[13px] text-warning">{it.lib.note}</p>}
        {it.lib?.kind === "manual" && <p className="text-[13px] text-ink-3">{it.lib.note}</p>}
        {it.kind === "template" && it.template?.infopage && <p className="text-[13px] text-ink-3">A container system from Proxmox's template list.</p>}
        {plugin && plugin.kind === "connector" && <p className="text-[13px] text-ink-3">Installing adds it to Connectors, where you finish setting it up and choose who can use it. {it.status === "installed" ? "Remove it to take it out of Connectors." : ""}</p>}
        {plugin && plugin.kind !== "connector" && <p className="text-[13px] text-ink-3">{plugin.kind === "adapter" ? "Agents can be set to run with this once the agent runtime is on this device." : "Pin can use this once the Pin runtime is on this device."} Installing now saves your choice.</p>}
        {needsStorage && installable && (
          storages.length ? (
            <label className="block"><span className="block text-[13px] text-ink-2 mb-2">Install to</span>
              <select value={storage} onChange={(e) => setPick(e.target.value)} className={cn(select)} disabled={started}>
                {storages.map((s) => <option key={s.id} value={s.id}>{s.id} · {formatBytes(Math.max(0, s.total - s.used))} free</option>)}
              </select>
            </label>
          ) : <p className="text-[13px] text-warning">No storage on this device is set up for {kindOfStorage === "iso" ? "ISO images" : "container templates"}.</p>
        )}
        {started && <p className="text-[13px] text-good">Download started. It shows in Tasks, and Pin tells you when it's done.</p>}
        {error && <p role="alert" className="text-[13px] text-critical">{error}</p>}
      </div>
    </Modal>
  );
}
