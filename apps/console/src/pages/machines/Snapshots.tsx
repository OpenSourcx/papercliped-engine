import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Camera, Copy, CornerDownRight, Loader2, RotateCcw, Trash2 } from "lucide-react";
import { ApiError, type SnapshotInfo } from "../../data/api.ts";
import { useEngine } from "../../data/store.tsx";
import type { Guest } from "../../data/types.ts";
import { cn, formatBytes } from "../../lib/storage.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Card, Input, SectionTitle, Toggle } from "../../ui/primitives.tsx";

const when = (s: number | null) => (s ? new Date(s * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—");

/** Snapshots as Proxmox keeps them: a chain, where "now" sits after the newest one you're running on. */
export function Snapshots({ g, startOpen, onOpened }: { g: Guest; startOpen: boolean; onOpened: () => void }) {
  const engine = useEngine();
  const [list, setList] = useState<SnapshotInfo[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [taking, setTaking] = useState(startOpen);
  const [rollback, setRollback] = useState<SnapshotInfo | null>(null);
  const [removing, setRemoving] = useState<SnapshotInfo | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (startOpen) {
      setTaking(true);
      onOpened();
    }
  }, [startOpen]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let alive = true;
    engine.backend.snapshots(g.vmid).then(
      (r) => alive && (setList(r.snapshots), setCurrent(r.current), setError(null)),
      (e) => alive && setError(e instanceof ApiError ? e.message : "Couldn't read snapshots"),
    );
    return () => {
      alive = false;
    };
  }, [g.vmid, engine.backend, engine.contentVersion, tick]);

  const act = async (fn: () => Promise<{ task: string }>, label: string) => {
    try {
      const r = await fn();
      engine.watchTask(r.task, label);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Proxmox refused that");
    }
    setTick((n) => n + 1);
  };

  // Order as a chain from the oldest; Proxmox gives parents, not order.
  const ordered = (list ?? []).slice().sort((a, b) => (a.time ?? 0) - (b.time ?? 0));

  return (
    <Card className="p-5">
      <SectionTitle action={<Button size="sm" variant="primary" onClick={() => setTaking(true)}><Camera className="h-3.5 w-3.5" />Take snapshot</Button>}>Snapshots</SectionTitle>
      {error && <p role="alert" className="text-[13px] text-critical mb-3">{error}</p>}
      {list === null && !error ? (
        <p className="text-[14px] text-ink-3"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Reading snapshots…</p>
      ) : ordered.length === 0 ? (
        <p className="text-[14px] text-ink-3">No snapshots yet. Take one before risky changes; you can return to it in seconds. Pin does this before updates.</p>
      ) : (
        <ol className="relative">
          {ordered.map((s, i) => (
            <li key={s.name} className="flex items-center gap-3 py-3 border-b border-line">
              <span className={cn("h-7 w-7 rounded-full flex items-center justify-center shrink-0", s.name === current ? "bg-accent-soft text-accent" : "bg-surface-2 text-ink-3")}><Camera className="h-3.5 w-3.5" /></span>
              <div className="flex-1 min-w-0">
                <div className="text-[14px] font-medium font-mono">{s.name}{s.vmstate && <span className="ml-2 text-[11px] font-sans text-ink-3 border border-line rounded px-1">with memory</span>}</div>
                <div className="text-[12px] text-ink-3 truncate">{s.description || "No description"} · {when(s.time)}{i > 0 && s.parent ? ` · after ${s.parent}` : ""}</div>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setRollback(s)}><RotateCcw className="h-3.5 w-3.5" />Roll back</Button>
              <button onClick={() => setRemoving(s)} className="h-8 w-8 rounded-lg hover:bg-surface-2 flex items-center justify-center text-ink-3 hover:text-critical" aria-label={`Delete snapshot ${s.name}`}><Trash2 className="h-4 w-4" /></button>
            </li>
          ))}
          <li className="flex items-center gap-3 py-3 text-[13px] text-ink-2"><CornerDownRight className="h-4 w-4 text-accent ml-1.5" />Now{current ? `, running on top of ${current}` : ""}</li>
        </ol>
      )}

      {taking && <TakeSnapshot g={g} onClose={() => setTaking(false)} onDone={() => setTick((n) => n + 1)} />}
      {rollback && (
        <Modal size="sm" title={`Roll back ${g.name} to ${rollback.name}?`} subtitle={`Everything changed since ${when(rollback.time)} is lost. ${g.status === "running" ? "The machine restarts." : ""}`} onClose={() => setRollback(null)} footer={<><Button variant="ghost" onClick={() => setRollback(null)}>Cancel</Button><Button variant="danger" onClick={() => { const s = rollback; setRollback(null); void act(() => engine.backend.rollbackSnapshot(g.vmid, s.name), `Roll ${g.name} back to ${s.name}`); }}><RotateCcw className="h-4 w-4" />Roll back</Button></>}>
          <p className="text-[13px] text-ink-3">Tip: take a snapshot of now first if you might want to come back.</p>
        </Modal>
      )}
      {removing && (
        <Modal size="sm" title={`Delete snapshot ${removing.name}?`} subtitle="The machine keeps running as it is; you just can't return to this point anymore." onClose={() => setRemoving(null)} footer={<><Button variant="ghost" onClick={() => setRemoving(null)}>Cancel</Button><Button variant="danger" onClick={() => { const s = removing; setRemoving(null); void act(() => engine.backend.deleteSnapshot(g.vmid, s.name), `Delete snapshot ${s.name}`); }}><Trash2 className="h-4 w-4" />Delete</Button></>}>
          <div />
        </Modal>
      )}
    </Card>
  );
}

function TakeSnapshot({ g, onClose, onDone }: { g: Guest; onClose: () => void; onDone: () => void }) {
  const engine = useEngine();
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-T:]/g, "").replace(/^(\d{8})(\d{4})$/, "snap-$1-$2");
  const [name, setName] = useState(stamp);
  const [desc, setDesc] = useState("");
  const [vmstate, setVmstate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameErr = /^[A-Za-z][\w-]{1,39}$/.test(name) ? null : "2 to 40 letters, digits, - or _, starting with a letter.";
  const take = async () => {
    setBusy(true);
    try {
      const r = await engine.backend.takeSnapshot(g.vmid, name, desc.trim(), vmstate);
      engine.watchTask(r.task, `Snapshot ${g.name}: ${name}`);
      onDone();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't take the snapshot");
      setBusy(false);
    }
  };
  return (
    <Modal size="sm" icon={<Camera className="h-5 w-5" />} title="Take a snapshot" subtitle={`Saves ${g.name}'s disks as they are right now, so you can return to this moment.`} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={take} disabled={busy || !!nameErr}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Take snapshot</Button></>}>
      <div className="space-y-3">
        <label className="block"><span className="block text-[13px] text-ink-2 mb-1.5">Name</span><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !nameErr && take()} className="font-mono" />{nameErr && <span className="block text-[12px] mt-1 text-critical">{nameErr}</span>}</label>
        <label className="block"><span className="block text-[13px] text-ink-2 mb-1.5">Description</span><Input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="e.g. Before upgrading nginx" /></label>
        {g.type === "qemu" && g.status === "running" && (
          <div className="flex items-center justify-between gap-3"><div><div className="text-[14px]">Include memory</div><div className="text-[12px] text-ink-3">Rolling back resumes exactly where it was, open programs and all. Takes longer and uses about {formatBytes(g.memUsed || g.memMax)} more.</div></div><Toggle checked={vmstate} onChange={setVmstate} label="Include memory" /></div>
        )}
        {error && <p role="alert" className="text-[12px] text-critical">{error}</p>}
      </div>
    </Modal>
  );
}

/** Copy a machine into a new one. ?modal=clone&vmid=<id> */
export function CloneModal({ onClose }: { onClose: () => void }) {
  const engine = useEngine();
  const nav = useNavigate();
  const device = engine.setup?.deviceName ?? "pve";
  const vmid = Number(new URLSearchParams(window.location.search).get("vmid"));
  const g = engine.data.guests.find((x) => x.vmid === vmid);
  const suggest = () => {
    const base = `${g?.name ?? "machine"}-copy`;
    let n = base;
    for (let i = 2; engine.data.guests.some((x) => x.name === n); i++) n = `${base}-${i}`;
    return n.slice(0, 63);
  };
  const [name, setName] = useState(suggest);
  const [touched, setTouched] = useState(false);
  // On a direct page load the machine list arrives after the dialog opens; follow it until the user types.
  useEffect(() => {
    if (!touched) setName(suggest());
  }, [g?.name, engine.data.guests.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const [storages, setStorages] = useState<{ storage: string; avail: number | null }[]>([]);
  const [storage, setStorage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    engine.backend.machineOptions().then((o) => setStorages((g?.type === "qemu" ? o.vmStorages : o.storages).map((s) => ({ storage: s.storage, avail: s.avail }))), () => setStorages([]));
  }, [engine.backend, g?.type]);
  if (!g) return null;
  const nameErr = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name) ? null : "Lowercase letters, digits and hyphens.";
  const go = async () => {
    setBusy(true);
    const r = await engine.cloneMachine(g.vmid, name, storage || null);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    onClose();
    nav(g.org ? `/${device}/${g.org}/machines/${r.vmid}` : `/${device}/machines/${r.vmid}`);
  };
  return (
    <Modal icon={<Copy className="h-5 w-5" />} title={`Clone ${g.name}`} subtitle="A full, independent copy with its own disks and new network addresses. It starts stopped." onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={go} disabled={busy || !!nameErr}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Copy className="h-4 w-4" />}Clone</Button></>}>
      <div className="space-y-4">
        <label className="block"><span className="block text-[13px] text-ink-2 mb-2">Name</span><Input autoFocus value={name} onChange={(e) => { setName(e.target.value.toLowerCase()); setTouched(true); }} className="font-mono" />{nameErr && <span className="block text-[12px] mt-1.5 text-critical">{nameErr}</span>}</label>
        <label className="block">
          <span className="block text-[13px] text-ink-2 mb-2">Disks go to</span>
          <select value={storage} onChange={(e) => setStorage(e.target.value)} className="h-10 w-full rounded-lg bg-surface-2 border border-line px-3 text-[14px] outline-none focus:border-line-strong">
            <option value="">Same storage as {g.name}</option>
            {storages.map((s) => <option key={s.storage} value={s.storage}>{s.storage}{s.avail !== null ? ` · ${formatBytes(s.avail)} free` : ""}</option>)}
          </select>
        </label>
        {g.status === "running" && <p className="text-[12px] text-ink-3">{g.name} keeps running; the copy is taken from its current disks.</p>}
        {error && <p role="alert" className="text-[13px] text-critical">{error}</p>}
      </div>
    </Modal>
  );
}
