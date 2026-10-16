import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Cloud, Copy, Loader2 } from "lucide-react";
import { errorText } from "../../data/engine/guestApi.ts";
import { useMachineApi, type CloneChoices } from "../../data/engine/machineApi.ts";
import { useEngine } from "../../data/store.tsx";
import { formatBytes } from "../../lib/storage.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Input, Notice, Select, Textarea, Toggle } from "../../ui/primitives.tsx";
import { SwitchRow } from "./MachineSettingsKit.tsx";

/**
 * Copy a machine into a new one. ?modal=clone&vmid=<id>. The simple form is a name and a storage; More options adds the
 * machine number, target node, disk format, a snapshot to copy from, a bandwidth limit, a resource group and a note.
 * For a VM, the Cloud-Init section turns a clone of a template into a ready machine: user, keys, address, bigger disk, start.
 */
export function CloneModal({ onClose }: { onClose: () => void }) {
  const engine = useEngine();
  const api = useMachineApi();
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
  useEffect(() => {
    if (!touched) setName(suggest());
  }, [g?.name, engine.data.guests.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const [ch, setCh] = useState<CloneChoices | null>(null);
  const [storage, setStorage] = useState("");
  const [linked, setLinked] = useState(true);
  const [newid, setNewid] = useState("");
  const [target, setTarget] = useState("");
  const [format, setFormat] = useState("");
  const [snap, setSnap] = useState("");
  const [bw, setBw] = useState("");
  const [pool, setPool] = useState("");
  const [note, setNote] = useState("");
  const [useCi, setUseCi] = useState(false);
  const [ci, setCi] = useState({ user: "", password: "", keys: "", ip: "dhcp", addr: "", gw: "", grow: "", start: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<{ steps: { step: string; ok: boolean; message: string }[]; note?: string; to: string } | null>(null);
  useEffect(() => {
    if (g) api.cloneChoices(g.vmid).then(setCh, () => setCh(null));
  }, [api, g?.vmid]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!g) return null;
  const vm = g.type === "qemu";
  const full = g.template ? !linked : true;
  const nameErr = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name) ? null : "Lowercase letters, digits and hyphens.";
  const idErr = newid.trim() && !/^\d{3,9}$/.test(newid.trim()) ? "A number from 100 to 999999999." : null;
  const ciBody = () => ({
    ...(ci.user.trim() ? { user: ci.user.trim() } : {}),
    ...(ci.password ? { password: ci.password } : {}),
    ...(ci.keys.trim() ? { sshKeys: ci.keys.trim() } : {}),
    ipconfig: { ipconfig0: ci.ip === "dhcp" ? { ip: "dhcp" } : { ip: ci.addr.trim(), gw: ci.gw.trim() } },
  });
  const go = async () => {
    setBusy(true);
    setError(null);
    const to = (id: number) => (g.org ? `/${device}/${g.org}/machines/${id}` : `/${device}/machines/${id}`);
    try {
      if (engine.live) {
        const body: Record<string, unknown> = { name, full, ...(full && storage ? { storage } : {}), ...(newid.trim() ? { newid: Number(newid) } : {}), ...(target ? { target } : {}), ...(full && format && vm ? { format } : {}), ...(snap ? { snapname: snap } : {}), ...(bw.trim() ? { bwlimit: Math.round(Number(bw) * 1024) } : {}), ...(pool ? { pool } : {}), ...(note.trim() ? { description: note.trim() } : {}) };
        if (vm && useCi) Object.assign(body, { cloudInit: ciBody(), ...(ci.grow.trim() ? { growGb: Number(ci.grow) } : {}), start: ci.start });
        const r = await api.clone(g.vmid, body);
        engine.watchTask(r.task, `Clone ${g.name} to ${name}`);
        if (r.steps.length || r.note) {
          setReport({ steps: r.steps, note: r.note, to: to(r.vmid) });
          setBusy(false);
          return;
        }
        onClose();
        nav(to(r.vmid));
        return;
      }
      const r = await engine.cloneMachine(g.vmid, name, g.template && linked ? null : storage || null, !!g.template && linked);
      if (!r.ok) {
        setError(r.error);
        setBusy(false);
        return;
      }
      if (vm && useCi) {
        const st = await api.cloudInit(r.vmid);
        if (!st.view.drive) await api.saveCloudInit(r.vmid, { digest: st.digest, drive: { storage: st.storages[0] } });
        const st2 = await api.cloudInit(r.vmid);
        await api.saveCloudInit(r.vmid, { digest: st2.digest, ...ciBody() });
      }
      onClose();
      nav(to(r.vmid));
    } catch (e) {
      setError(errorText(e, "Can't reach this device"));
      setBusy(false);
    }
  };
  const done = (path: string) => {
    onClose();
    nav(path);
  };
  const storages = ch?.storages ?? [];
  return (
    <Modal size="lg" icon={<Copy className="h-5 w-5" />} title={`Clone ${g.name}`} subtitle={g.template ? "A new machine made from this template. It starts stopped." : "A full, independent copy with its own disks and new network addresses. It starts stopped."} onClose={onClose}
      footer={report ? <Button variant="primary" onClick={() => done(report.to)}>Open the new machine</Button> : <><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={go} disabled={busy || !!nameErr || !!idErr}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Copy className="h-4 w-4" />}Clone</Button></>}>
      {report ? (
        <div className="space-y-3">
          <p className="text-compact text-ink-2">The copy is done.</p>
          {report.steps.map((s) => <p key={s.step} className={`text-compact ${s.ok ? "text-ink-2" : "text-critical"}`}>{s.ok ? "Done" : "Didn't work"}: {s.step}. {s.message}</p>)}
          {report.note && <Notice tone="warning">{report.note}</Notice>}
        </div>
      ) : (
        <div className="space-y-4">
          <label className="block"><span className="block text-compact text-ink-2 mb-2">Name</span><Input autoFocus value={name} onChange={(e) => { setName(e.target.value.toLowerCase()); setTouched(true); }} className="font-mono" />{nameErr && <span className="block text-xs mt-1.5 text-critical">{nameErr}</span>}</label>
          <label className="block">
            <span className="block text-compact text-ink-2 mb-2">Disks go to</span>
            <Select value={storage} onChange={(e) => setStorage(e.target.value)} disabled={!full}>
              <option value="">Same storage as {g.name}</option>
              {storages.map((s) => <option key={s.storage} value={s.storage}>{s.storage}</option>)}
            </Select>
            {!full && <span className="block text-xs text-ink-3 mt-1.5">A linked clone stays on the template's storage.</span>}
          </label>
          {g.template && (
            <div className="flex items-center justify-between gap-4"><div><div className="text-sm">Linked clone</div><div className="text-xs text-ink-3">Shares the template's disk, so it's instant and tiny. Turn off for an independent full copy.</div></div><Toggle checked={linked} onChange={setLinked} label="Linked clone" /></div>
          )}
          {g.status === "running" && <p className="text-xs text-ink-3">{g.name} keeps running; the copy is taken from its current disks.</p>}
          <details>
            <summary className="cursor-pointer text-compact text-ink-2">More options</summary>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-3">
              <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Machine number</span><Input value={newid} onChange={(e) => setNewid(e.target.value)} placeholder={ch?.nextid ? `Next free (${ch.nextid})` : "Next free"} inputMode="numeric" />{idErr && <span className="block text-xs mt-1.5 text-critical">{idErr}</span>}</label>
              <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Target node</span><Select value={target} onChange={(e) => setTarget(e.target.value)}><option value="">Same node</option>{(ch?.nodes ?? []).map((n) => <option key={n} value={n}>{n}</option>)}</Select></label>
              {vm && <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Disk format</span><Select value={format} onChange={(e) => setFormat(e.target.value)} disabled={!full}><option value="">Same as the source</option><option value="raw">Raw</option><option value="qcow2">QCOW2</option><option value="vmdk">VMDK</option></Select><span className="block text-xs text-ink-3 mt-1.5">Only file storage can use QCOW2 or VMDK.</span></label>}
              <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Copy from snapshot</span><Select value={snap} onChange={(e) => setSnap(e.target.value)} disabled={!!g.template}><option value="">The current state</option>{(ch?.snapshots ?? []).map((n) => <option key={n} value={n}>{n}</option>)}</Select></label>
              <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Speed limit (MiB/s)</span><Input type="number" min={0} value={bw} onChange={(e) => setBw(e.target.value)} placeholder="Storage's default" />{bw && <span className="block text-xs text-ink-3 mt-1.5">{formatBytes(Number(bw) * 1048576)}/s</span>}</label>
              <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Resource group</span><Select value={pool} onChange={(e) => setPool(e.target.value)}><option value="">None</option>{(ch?.pools ?? []).map((n) => <option key={n} value={n}>{n}</option>)}</Select></label>
              <label className="block sm:col-span-2"><span className="block text-compact text-ink-2 mb-1.5">Note</span><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={`Cloned from ${g.name} (#${g.vmid})`} /></label>
            </div>
          </details>
          {vm && (
            <div className="rounded-lg border border-line p-3 space-y-3">
              <SwitchRow label="Set it up with Cloud-Init" hint="Gives the copy its own user, SSH keys and address as it is made. The source needs a Cloud-Init drive or a cloud image." checked={useCi} onChange={setUseCi} />
              {useCi && (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <label className="block"><span className="block text-compact text-ink-2 mb-1.5">User</span><Input value={ci.user} onChange={(e) => setCi({ ...ci, user: e.target.value })} className="font-mono" autoComplete="off" /></label>
                    <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Password</span><Input type="password" value={ci.password} onChange={(e) => setCi({ ...ci, password: e.target.value })} autoComplete="new-password" placeholder="Optional. Write-only" /></label>
                  </div>
                  <label className="block"><span className="block text-compact text-ink-2 mb-1.5">SSH public keys</span><Textarea rows={2} value={ci.keys} onChange={(e) => setCi({ ...ci, keys: e.target.value })} className="font-mono text-compact" spellCheck={false} placeholder="ssh-ed25519 AAAA… me@laptop" /></label>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <label className="block"><span className="block text-compact text-ink-2 mb-1.5">First network address</span><Select value={ci.ip} onChange={(e) => setCi({ ...ci, ip: e.target.value })}><option value="dhcp">DHCP</option><option value="static">Static</option></Select></label>
                    {ci.ip === "static" && <><label className="block"><span className="block text-compact text-ink-2 mb-1.5">Address</span><Input value={ci.addr} onChange={(e) => setCi({ ...ci, addr: e.target.value })} placeholder="192.168.1.50/24" className="font-mono" /></label><label className="block"><span className="block text-compact text-ink-2 mb-1.5">Gateway</span><Input value={ci.gw} onChange={(e) => setCi({ ...ci, gw: e.target.value })} placeholder="192.168.1.1" className="font-mono" /></label></>}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
                    <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Grow the disk by (GiB)</span><Input type="number" min={1} value={ci.grow} onChange={(e) => setCi({ ...ci, grow: e.target.value })} placeholder="Keep the size" /></label>
                    <SwitchRow label="Start when ready" checked={ci.start} onChange={(v) => setCi({ ...ci, start: v })} />
                  </div>
                  <p className="text-xs text-ink-3 inline-flex items-center gap-1"><Cloud className="h-3 w-3" />Applied once the copy finishes. If the copy takes long, the new machine's Cloud-Init tab finishes the job.</p>
                </>
              )}
            </div>
          )}
          {error && <p role="alert" className="text-compact text-critical">{error}</p>}
        </div>
      )}
    </Modal>
  );
}
