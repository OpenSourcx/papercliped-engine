import { useEffect, useState } from "react";
import { Camera, CornerDownRight, Info, Loader2, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { useMachineApi } from "../../data/engine/machineApi.ts";
import { errorText } from "../../data/engine/guestApi.ts";
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
  const [editing, setEditing] = useState<SnapshotInfo | null>(null);
  const [details, setDetails] = useState<SnapshotInfo | null>(null);
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

  // A tree: each snapshot sits under its parent, oldest first. Rolling back and snapshotting again makes branches.
  const byTime = (list ?? []).slice().sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
  const names = new Set(byTime.map((x) => x.name));
  const ordered: { s: SnapshotInfo; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const x of byTime) if ((x.parent && names.has(x.parent) ? x.parent : null) === parent) { ordered.push({ s: x, depth }); walk(x.name, depth + (byTime.filter((y) => y.parent === x.name).length > 1 ? 1 : 0)); }
  };
  walk(null, 0);

  return (
    <Card className="p-5">
      <SectionTitle action={<Button size="sm" variant="primary" onClick={() => setTaking(true)}><Camera className="h-3.5 w-3.5" />Take snapshot</Button>}>Snapshots</SectionTitle>
      {error && <p role="alert" className="text-compact text-critical mb-3">{error}</p>}
      {list === null && !error ? (
        <p className="text-sm text-ink-3"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Reading snapshots…</p>
      ) : ordered.length === 0 ? (
        <p className="text-sm text-ink-3">No snapshots yet. Take one before risky changes; you can return to it in seconds. Pin does this before updates.</p>
      ) : (
        <ol className="relative">
          {ordered.map(({ s, depth }, i) => (
            <li key={s.name} className="flex items-center gap-3 py-3 border-b border-line" style={{ paddingLeft: `${depth * 1.5}rem` }}>
              <span className={cn("h-7 w-7 rounded-full flex items-center justify-center shrink-0", s.name === current ? "bg-accent-soft text-accent" : "bg-surface-2 text-ink-3")}><Camera className="h-3.5 w-3.5" /></span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium font-mono">{s.name}{s.vmstate && <span className="ml-2 text-micro font-sans text-ink-3 border border-line rounded px-1">with memory</span>}</div>
                <div className="text-xs text-ink-3 truncate">{s.description || "No description"} · {when(s.time)}{i > 0 && s.parent ? ` · after ${s.parent}` : ""}</div>
              </div>
              <button onClick={() => setDetails(s)} className="h-8 w-8 rounded-lg hover:bg-surface-2 flex items-center justify-center text-ink-3 hover:text-ink" aria-label={`Details of snapshot ${s.name}`}><Info className="h-4 w-4" /></button>
              <button onClick={() => setEditing(s)} className="h-8 w-8 rounded-lg hover:bg-surface-2 flex items-center justify-center text-ink-3 hover:text-ink" aria-label={`Edit description of snapshot ${s.name}`}><Pencil className="h-4 w-4" /></button>
              <Button size="sm" variant="ghost" onClick={() => setRollback(s)}><RotateCcw className="h-3.5 w-3.5" />Roll back</Button>
              <button onClick={() => setRemoving(s)} className="h-8 w-8 rounded-lg hover:bg-surface-2 flex items-center justify-center text-ink-3 hover:text-critical" aria-label={`Delete snapshot ${s.name}`}><Trash2 className="h-4 w-4" /></button>
            </li>
          ))}
          <li className="flex items-center gap-3 py-3 text-compact text-ink-2"><CornerDownRight className="h-4 w-4 text-accent ml-1.5" />Now{current ? `, running on top of ${current}` : ""}</li>
        </ol>
      )}

      {taking && <TakeSnapshot g={g} onClose={() => setTaking(false)} onDone={() => setTick((n) => n + 1)} />}
      {rollback && <RollbackModal g={g} snap={rollback} onClose={() => setRollback(null)} onDone={() => setTick((n) => n + 1)} />}
      {editing && <DescribeModal g={g} snap={editing} onClose={() => setEditing(null)} onDone={() => setTick((n) => n + 1)} />}
      {details && <DetailsModal g={g} snap={details} onClose={() => setDetails(null)} />}
      {removing && (
        <Modal size="sm" title={`Delete snapshot ${removing.name}?`} subtitle="The machine keeps running as it is; you just can't return to this point anymore." onClose={() => setRemoving(null)} footer={<><Button variant="ghost" onClick={() => setRemoving(null)}>Cancel</Button><Button variant="danger" onClick={() => { const s = removing; setRemoving(null); void act(() => engine.backend.deleteSnapshot(g.vmid, s.name), `Delete snapshot ${s.name}`); }}><Trash2 className="h-4 w-4" />Delete</Button></>}>
          <div />
        </Modal>
      )}
    </Card>
  );
}

function RollbackModal({ g, snap, onClose, onDone }: { g: Guest; snap: SnapshotInfo; onClose: () => void; onDone: () => void }) {
  const engine = useEngine();
  const api = useMachineApi();
  const [typed, setTyped] = useState("");
  const [start, setStart] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    try {
      const r = await api.restoreSnapshot(g.vmid, snap.name, { confirm: typed, start });
      engine.watchTask(r.task, `Roll ${g.name} back to ${snap.name}`);
      onDone();
      onClose();
    } catch (e) {
      setError(errorText(e, "Proxmox refused that"));
      setBusy(false);
    }
  };
  return (
    <Modal size="sm" icon={<RotateCcw className="h-5 w-5" />} title={`Roll back ${g.name} to ${snap.name}?`} subtitle={`Everything changed since ${when(snap.time)} is lost. ${g.status === "running" ? "A running machine is stopped first." : ""}`} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" onClick={go} disabled={busy || typed !== snap.name}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}Roll back</Button></>}>
      <div className="space-y-3">
        <p className="text-compact text-ink-3">Tip: take a snapshot of now first if you might want to come back.{snap.vmstate ? " This snapshot includes memory, so the machine resumes exactly where it was." : ""}</p>
        <div className="flex items-center justify-between gap-3"><div><div className="text-sm">Start it afterwards</div><div className="text-xs text-ink-3">Boots the machine once the rollback is done.</div></div><Toggle checked={start} onChange={setStart} label="Start it afterwards" /></div>
        <label className="block"><span className="block text-xs text-ink-3 mb-1.5">Type <span className="font-mono text-ink-2">{snap.name}</span> to confirm</span><Input value={typed} onChange={(e) => setTyped(e.target.value)} className="font-mono" /></label>
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}

function DescribeModal({ g, snap, onClose, onDone }: { g: Guest; snap: SnapshotInfo; onClose: () => void; onDone: () => void }) {
  const api = useMachineApi();
  const [text, setText] = useState(snap.description);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    try {
      await api.describeSnapshot(g.vmid, snap.name, text);
      onDone();
      onClose();
    } catch (e) {
      setError(errorText(e, "Proxmox refused that"));
      setBusy(false);
    }
  };
  return (
    <Modal size="sm" icon={<Pencil className="h-5 w-5" />} title={`Describe ${snap.name}`} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={go} disabled={busy}>Save</Button></>}>
      <div className="space-y-2">
        <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Description</span><Input autoFocus value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} /></label>
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}

function DetailsModal({ g, snap, onClose }: { g: Guest; snap: SnapshotInfo; onClose: () => void }) {
  const api = useMachineApi();
  const [d, setD] = useState<Awaited<ReturnType<typeof api.snapshotConfig>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.snapshotConfig(g.vmid, snap.name).then(setD, (e) => setError(errorText(e, "Couldn't read the snapshot")));
  }, [api, g.vmid, snap.name]);
  return (
    <Modal size="sm" icon={<Info className="h-5 w-5" />} title={snap.name} subtitle={`Taken ${when(snap.time)}`} onClose={onClose}>
      {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      {!d && !error && <p className="text-sm text-ink-3">Reading…</p>}
      {d && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-ink-3">Description</dt><dd>{d.description || <span className="text-ink-3">None</span>}</dd>
          <dt className="text-ink-3">Memory</dt><dd>{d.vmstate ? <span>Saved <span className="font-mono text-compact">{d.vmstate}</span></span> : "Not included"}</dd>
          {Object.entries(d.settings).filter(([k]) => !["description", "snaptime", "vmstate"].includes(k)).map(([k, v]) => <><dt key={`${k}-t`} className="text-ink-3 font-mono text-compact">{k}</dt><dd key={`${k}-d`} className="font-mono text-compact break-all">{v}</dd></>)}
        </dl>
      )}
    </Modal>
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
        <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Name</span><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !nameErr && take()} className="font-mono" />{nameErr && <span className="block text-xs mt-1 text-critical">{nameErr}</span>}</label>
        <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Description</span><Input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="e.g. Before upgrading nginx" /></label>
        {g.type === "qemu" && g.status === "running" && (
          <div className="flex items-center justify-between gap-3"><div><div className="text-sm">Include memory</div><div className="text-xs text-ink-3">Rolling back resumes exactly where it was, open programs and all. Takes longer and uses about {formatBytes(g.memUsed || g.memMax)} more.</div></div><Toggle checked={vmstate} onChange={setVmstate} label="Include memory" /></div>
        )}
        {error && <p role="alert" className="text-xs text-critical">{error}</p>}
      </div>
    </Modal>
  );
}
