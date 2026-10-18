import { useState } from "react";
import { ShieldAlert } from "lucide-react";
import { useEngine } from "../data/store.tsx";
import { Button, Input, Select } from "../ui/primitives.tsx";
import { Modal } from "../ui/Modal.tsx";
import { usePin } from "./PinContext.tsx";
import type { PinPermission } from "./live.ts";

/** What each permission means, in the order a person would climb them. */
export const PERMISSION_INFO: { id: PinPermission; label: string; body: string }[] = [
  { id: "ask", label: "Ask", body: "Every change Pin wants to make waits for your approval, right in the chat." },
  { id: "accept", label: "Accept edits", body: "Creating, starting, snapshots, backups and settings run on their own. Shutting down, rebooting or deleting asks first." },
  { id: "auto", label: "Auto", body: "Everything runs on its own except what can't be undone (delete, roll back), which asks first." },
  { id: "plan", label: "Plan", body: "Pin only writes plans. Nothing runs until you approve each step on the Plans tab." },
  { id: "bypass", label: "Bypass permissions", body: "Everything runs with no questions, deletes included. It still can only do what your Proxmox account may do, and every action is logged." },
];

/** How much Agent mode may do without asking. Shown on a live device while Pin is in Agent mode. */
export function PermissionPicker() {
  const pin = usePin();
  const { live } = useEngine();
  const [asking, setAsking] = useState(false);
  const [word, setWord] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!live || !pin.settings) return null;
  const current = pin.settings.permission;
  const info = PERMISSION_INFO.find((p) => p.id === current) ?? PERMISSION_INFO[0];

  const choose = async (id: PinPermission) => {
    setError(null);
    if (id === "bypass" && current !== "bypass") {
      setWord("");
      setAsking(true);
      return;
    }
    try {
      await pin.setPermission(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't save.");
    }
  };
  const confirm = async () => {
    setBusy(true);
    try {
      await pin.setPermission("bypass", word.trim());
      setAsking(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't save.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-w-[220px] max-w-sm">
      <label htmlFor="pin-permission" className="block text-micro font-semibold uppercase tracking-label text-ink-3 mb-1">What Pin may do on its own</label>
      <Select id="pin-permission" value={current} onChange={(e) => void choose(e.target.value as PinPermission)}>
        {PERMISSION_INFO.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
      </Select>
      <p className={current === "bypass" ? "text-xs text-critical mt-1.5 text-pretty" : "text-xs text-ink-3 mt-1.5 text-pretty"}>{info.body}</p>
      {error && !asking && <p role="alert" className="text-xs text-critical mt-1">{error}</p>}
      {asking && (
        <Modal
          size="sm"
          icon={<ShieldAlert className="h-5 w-5 text-critical" />}
          title="Let Pin do everything without asking?"
          onClose={() => setAsking(false)}
          footer={<><Button variant="ghost" onClick={() => setAsking(false)}>Cancel</Button><Button variant="danger" loading={busy} disabled={word.trim() !== "bypass"} onClick={() => void confirm()}>Turn on bypass</Button></>}
        >
          <div className="space-y-3 text-compact text-ink-2 text-pretty">
            <p>Pin will create, change, shut down and <strong>delete</strong> machines without waiting for you. It acts as your Proxmox account, so it can only do what you could, and every action is written to the audit trail.</p>
            <p>You can switch back any time. Type <span className="font-mono text-ink">bypass</span> to turn it on.</p>
            <label className="sr-only" htmlFor="bypass-word">Type bypass to confirm</label>
            <Input id="bypass-word" value={word} onChange={(e) => setWord(e.target.value)} placeholder="bypass" autoFocus autoComplete="off" />
            {error && <p role="alert" className="text-critical">{error}</p>}
          </div>
        </Modal>
      )}
    </div>
  );
}
