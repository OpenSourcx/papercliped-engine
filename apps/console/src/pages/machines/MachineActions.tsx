import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Copy, Loader2, Lock, Trash2 } from "lucide-react";
import { type GuestHardware } from "../../data/api.ts";
import { useEngine } from "../../data/store.tsx";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Input } from "../../ui/primitives.tsx";

/** Delete or convert to template. Both are permanent, so the machine's name has to be typed. ?modal=machine-action&action=...&vmid=... */
export function MachineActionModal({ onClose }: { onClose: () => void }) {
  const engine = useEngine();
  const nav = useNavigate();
  const device = engine.setup?.deviceName ?? "pve";
  const q = new URLSearchParams(window.location.search);
  const vmid = Number(q.get("vmid"));
  const action = q.get("action") === "template" ? "template" : "destroy";
  const g = engine.data.guests.find((x) => x.vmid === vmid);
  const [hw, setHw] = useState<GuestHardware | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (g) engine.backend.hardware(g.vmid).then(setHw, () => setHw(null));
  }, [g?.vmid, engine.backend]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!g) return null;

  const protectedNow = hw?.protection ?? g.protected;
  const running = g.status === "running";
  const blocker = running ? `${g.name} is running. Shut it down first.` : action === "destroy" && protectedNow ? `${g.name} is protected. Turn protection off in Options first.` : action === "template" && g.template ? `${g.name} is already a template.` : null;
  const disks = hw?.disks.length ?? 0;

  const go = async () => {
    setBusy(true);
    setError(null);
    const r = action === "destroy" ? await engine.destroyMachine(g.vmid, typed) : await engine.convertToTemplate(g.vmid, typed);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    onClose();
    if (action === "destroy") nav(g.org ? `/${device}/${g.org}/machines` : `/${device}/machines`, { replace: true });
  };

  return (
    <Modal
      size="sm"
      icon={action === "destroy" ? <Trash2 className="h-5 w-5 text-critical" /> : <Copy className="h-5 w-5" />}
      title={action === "destroy" ? `Delete ${g.name}?` : `Turn ${g.name} into a template?`}
      subtitle={action === "destroy" ? "The machine and its disks are removed for good." : "It becomes a read-only starting point you can clone. It can't be started or turned back."}
      onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant={action === "destroy" ? "danger" : "primary"} onClick={go} disabled={busy || !!blocker || typed !== g.name}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : action === "destroy" ? <Trash2 className="h-4 w-4" /> : <Copy className="h-4 w-4" />}{action === "destroy" ? "Delete" : "Convert"}</Button></>}
    >
      <div className="space-y-3">
        {blocker ? (
          <p className="text-[13px] text-warning inline-flex items-start gap-2">{protectedNow && !running && <Lock className="h-4 w-4 shrink-0 mt-px" />}{blocker}</p>
        ) : (
          <>
            {action === "destroy" && (
              <ul className="text-[13px] text-ink-2 list-disc pl-5 space-y-1">
                <li>{disks ? `${disks} disk${disks === 1 ? " is" : "s are"} deleted` : "Its disks are deleted"}.</li>
                <li>It's taken off backup schedules. <span className="text-ink-3">Backups already taken stay on their storage.</span></li>
                <li>Snapshots go with it.</li>
              </ul>
            )}
            {action === "template" && <p className="text-[13px] text-ink-2">Use Clone on a template to make new machines quickly, as linked clones that share its disk.</p>}
            <label className="block"><span className="block text-[12px] text-ink-3 mb-1.5">Type <span className="font-mono text-ink-2">{g.name}</span> to confirm</span><Input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => e.key === "Enter" && typed === g.name && go()} spellCheck={false} className="font-mono" /></label>
          </>
        )}
        {error && <p role="alert" className="text-[13px] text-critical">{error}</p>}
      </div>
    </Modal>
  );
}
