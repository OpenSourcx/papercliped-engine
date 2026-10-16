import { useState } from "react";
import { Download, Loader2, Terminal as TerminalIcon, Tv } from "lucide-react";
import { errorText } from "../../data/engine/guestApi.ts";
import { useMachineApi } from "../../data/engine/machineApi.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Input } from "../../ui/primitives.tsx";

/** Other ways in beside the built-in screen: a SPICE viewer file, and the QEMU monitor. */
export function ConsoleExtras({ vmid, name }: { vmid: number; name: string }) {
  const [open, setOpen] = useState<"spice" | "monitor" | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-2 mt-3">
      <Button size="sm" onClick={() => setOpen("spice")}><Tv className="h-3.5 w-3.5" />SPICE viewer file</Button>
      <Button size="sm" onClick={() => setOpen("monitor")}><TerminalIcon className="h-3.5 w-3.5" />QEMU monitor</Button>
      {open === "spice" && <SpiceModal vmid={vmid} name={name} onClose={() => setOpen(null)} />}
      {open === "monitor" && <MonitorModal vmid={vmid} onClose={() => setOpen(null)} />}
    </div>
  );
}

function SpiceModal({ vmid, name, onClose }: { vmid: number; name: string; onClose: () => void }) {
  const api = useMachineApi();
  const [addr, setAddr] = useState(typeof window !== "undefined" ? window.location.hostname : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.spice(vmid, addr.trim() || null);
      const url = URL.createObjectURL(new Blob([r.file], { type: "application/x-virt-viewer" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = r.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setDone(true);
    } catch (e) {
      setError(errorText(e, "Proxmox couldn't prepare the SPICE file"));
    }
    setBusy(false);
  };
  return (
    <Modal size="sm" icon={<Tv className="h-5 w-5" />} title="SPICE viewer file" subtitle={`Open ${name} in virt-viewer (remote-viewer) for sound, clipboard, USB redirection and multiple monitors.`} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Close</Button><Button variant="primary" onClick={go} disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}Download</Button></>}>
      <div className="space-y-3">
        <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Address of this device, as your computer reaches it</span><Input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="pve.lan or 192.168.1.10" className="font-mono" /></label>
        <p className="text-xs text-ink-3">The file carries a short-lived one-time ticket, so open it right away. The VM needs a SPICE display (Hardware, Firmware and devices, Display) for the best result; the viewer is a separate app you install.</p>
        {done && <p role="status" className="text-compact text-ink-2">Downloaded. Open it with virt-viewer.</p>}
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}

function MonitorModal({ vmid, onClose }: { vmid: number; onClose: () => void }) {
  const api = useMachineApi();
  const [cmd, setCmd] = useState("");
  const [log, setLog] = useState<{ cmd: string; out: string; bad?: boolean }[]>([]);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    const c = cmd.trim();
    if (!c) return;
    setBusy(true);
    try {
      const r = await api.monitor(vmid, c);
      setLog((l) => [...l, { cmd: c, out: r.output.trimEnd() || "(no output)" }]);
    } catch (e) {
      setLog((l) => [...l, { cmd: c, out: errorText(e, "Proxmox refused that"), bad: true }]);
    }
    setCmd("");
    setBusy(false);
  };
  return (
    <Modal size="lg" icon={<TerminalIcon className="h-5 w-5" />} title="QEMU monitor" subtitle="One command at a time, as a Proxmox administrator would type it. Try info status, info block or info version." onClose={onClose}>
      <div className="space-y-3">
        <div className="rounded-lg bg-surface-2 border border-line p-3 font-mono text-compact min-h-32 max-h-80 overflow-y-auto" aria-live="polite">
          {log.length === 0 && <span className="text-ink-3">Nothing run yet.</span>}
          {log.map((l, i) => <div key={i} className="mb-2"><div className="text-ink-3">(qemu) {l.cmd}</div><pre className={`whitespace-pre-wrap ${l.bad ? "text-critical" : ""}`}>{l.out}</pre></div>)}
        </div>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void run(); }}>
          <Input value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder="info status" className="font-mono" aria-label="Monitor command" spellCheck={false} autoFocus />
          <Button type="submit" variant="primary" disabled={busy || !cmd.trim()}>Run</Button>
        </form>
        <p className="text-xs text-ink-3">The monitor controls the VM's emulator directly. Commands like quit stop the VM at once. Proxmox needs the Sys.Audit or Sys.Modify privilege for this.</p>
      </div>
    </Modal>
  );
}
