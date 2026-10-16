import { useState } from "react";
import { Loader2, Power } from "lucide-react";
import { errorText } from "../../data/engine/guestApi.ts";
import { useMachineApi } from "../../data/engine/machineApi.ts";
import { useEngine } from "../../data/store.tsx";
import type { Guest } from "../../data/types.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Input, Select } from "../../ui/primitives.tsx";
import { SwitchRow } from "./MachineSettingsKit.tsx";

type Action = "shutdown" | "stop" | "reboot" | "suspend" | "hibernate" | "resume" | "start" | "reset";

const LABEL: Record<Action, string> = { start: "Start", shutdown: "Shut down", stop: "Stop (pull the plug)", reboot: "Reboot", reset: "Reset", suspend: "Pause (suspend to RAM)", hibernate: "Hibernate (suspend to disk)", resume: "Resume a paused machine" };
const WORDS: Record<Action, string> = { start: "started", shutdown: "shut down", stop: "stopped", reboot: "rebooted", reset: "reset", suspend: "paused", hibernate: "hibernated", resume: "resumed" };

/** Every power action with Proxmox's options: shutdown timeout and force stop, hibernate to disk, resume, skip the lock. */
export function PowerOptionsModal({ g, onClose }: { g: Guest; onClose: () => void }) {
  const api = useMachineApi();
  const engine = useEngine();
  const vm = g.type === "qemu";
  const running = g.status === "running";
  const choices: Action[] = running ? ["shutdown", "reboot", "stop", ...(vm ? (["reset", "suspend", "hibernate", "resume"] as Action[]) : [])] : ["start"];
  const [action, setAction] = useState<Action>(choices[0]);
  const [timeout, setTimeoutS] = useState("");
  const [force, setForce] = useState(false);
  const [skip, setSkip] = useState(false);
  const [store, setStore] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const destructive = action === "stop" || action === "reset";
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { action };
      if (timeout.trim() && (action === "shutdown" || action === "reboot" || action === "stop")) body.timeout = Number(timeout);
      if (action === "shutdown" && force) body.forceStop = true;
      if (skip) body.skipLock = true;
      if (action === "hibernate" && store.trim()) body.statestorage = store.trim();
      const r = await api.status(g.vmid, body);
      engine.notify({ kind: "info", title: `${g.name}: ${WORDS[action]}`, body: engine.live ? "Proxmox runs it as a task; the status updates in a few seconds." : "Demo: nothing changes on a real machine." });
      if (r.task && r.task !== "demo") engine.watchTask(r.task, `${LABEL[action]} ${g.name}`);
      onClose();
    } catch (e) {
      setError(errorText(e, "Proxmox refused that"));
      setBusy(false);
    }
  };
  return (
    <Modal size="sm" icon={<Power className="h-5 w-5" />} title="Power options" subtitle={`${g.name} #${g.vmid} is ${running ? "running" : "stopped"}.`} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant={destructive ? "danger" : "primary"} onClick={go} disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}{LABEL[action].split(" (")[0]}</Button></>}>
      <div className="space-y-4">
        <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Action</span><Select value={action} onChange={(e) => setAction(e.target.value as Action)}>{choices.map((c) => <option key={c} value={c}>{LABEL[c]}</option>)}</Select></label>
        {action === "stop" && <p className="text-xs text-ink-3">Stopping cuts power at once, like pulling the plug. Unsaved work inside is lost.</p>}
        {action === "reset" && <p className="text-xs text-ink-3">A reset restarts the VM instantly, like the reset button. Unsaved work inside is lost.</p>}
        {action === "suspend" && <p className="text-xs text-ink-3">Freezes the VM in memory. It resumes exactly where it was. The memory stays in RAM, so this does not survive a host reboot.</p>}
        {action === "hibernate" && <p className="text-xs text-ink-3">Saves the memory to disk and stops the VM. The next start resumes where it was, even after a host reboot.</p>}
        {(action === "shutdown" || action === "reboot" || action === "stop") && <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Wait up to (seconds)</span><Input type="number" min={0} max={7200} value={timeout} onChange={(e) => setTimeoutS(e.target.value)} placeholder="Proxmox's default" /></label>}
        {action === "shutdown" && <SwitchRow label="Stop it if it doesn't shut down in time" hint="Otherwise Proxmox gives up and leaves it running." checked={force} onChange={setForce} />}
        {action === "hibernate" && <label className="block"><span className="block text-compact text-ink-2 mb-1.5">Where to keep the memory</span><Input value={store} onChange={(e) => setStore(e.target.value)} placeholder="Same storage as the disks" className="font-mono" /></label>}
        {running && action !== "reboot" && <SwitchRow label="Ignore a lock" hint="Only for a machine stuck in a backup or snapshot that is no longer running." checked={skip} onChange={setSkip} />}
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}
