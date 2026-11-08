import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, Check, CheckCircle2, Copy, Loader2, Network, Router, Waypoints } from "lucide-react";
import { useEngine } from "../../data/store.tsx";
import { errorText, useOrgs } from "../../data/engine/queries.ts";
import { fabricApi, fabricErrorText, type NewPairing, type Transport, type Worker, useFabric, useFabricAction } from "../../data/engine/fabric.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Chip, Field, Input, Notice, Select, Status } from "../../ui/primitives.tsx";
import { cn } from "../../lib/storage.ts";
import { CapabilityFacts } from "./Hardware.tsx";
import { countdown } from "./util.ts";

/** Providers the Fabric has room for but this build does not ship. Shown so nobody wonders, never selectable. */
const NOT_AVAILABLE = [
  { id: "headscale", label: "Headscale", detail: "Self-hosted Tailscale control server. Not available yet." },
  { id: "relay", label: "Papercliped Connect relay", detail: "For computers that can't reach this device directly. Not available yet." },
];

const ICON = { tailscale: Network, lan: Router, custom: Waypoints } as const;

export function AdoptWorkerModal({ onClose }: { onClose: () => void }) {
  const fabric = useFabric();
  const f = fabric.data;
  const orgs = useOrgs();
  const [provider, setProvider] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [scope, setScope] = useState("all");
  const [pairing, setPairing] = useState<NewPairing | null>(null);
  const baseline = useRef<Set<string> | null>(null);
  const create = useFabricAction(() => {
    baseline.current = new Set((f?.workers ?? []).map((w) => w.id));
    return fabricApi.pair({ name: name.trim() || undefined, companies: scope === "all" ? null : [scope], transport: chosen?.provider });
  });
  const transports = f?.transports ?? [];
  const recommended = transports.find((t) => t.recommended && t.available);
  const chosen = transports.find((t) => t.provider === (provider ?? recommended?.provider));
  const start = () => create.mutate(undefined, { onSuccess: (p) => setPairing(p) });

  if (pairing) return <PairStep pairing={pairing} baseline={baseline.current ?? new Set()} onClose={onClose} onAgain={() => setPairing(null)} />;
  return (
    <Modal
      size="md"
      title="Add a worker"
      subtitle="Pair a computer you own so agents can run there. You approve it; it gets its own identity and no copy of your passwords or keys."
      onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={create.isPending} disabled={!chosen?.available} onClick={start}>Create pairing code</Button></>}
    >
      <div className="grid gap-5">
        <fieldset>
          <legend className="text-compact font-medium text-ink-2 mb-2">How will the worker reach this device?</legend>
          {fabric.isPending ? <p className="text-compact text-ink-3" role="status">Checking what this device can offer</p> : (
            <div role="radiogroup" aria-label="Connection provider" className="grid gap-2">
              {transports.map((t) => <ProviderOption key={t.provider} t={t} selected={chosen?.provider === t.provider} onSelect={() => setProvider(t.provider)} />)}
              {NOT_AVAILABLE.map((n) => (
                <div key={n.id} role="radio" aria-checked={false} aria-disabled="true" tabIndex={-1} className="rounded-lg border border-line px-4 py-3 opacity-60 flex items-start gap-3">
                  <Waypoints className="h-4 w-4 mt-0.5 text-ink-3 shrink-0" aria-hidden />
                  <div className="min-w-0"><div className="text-sm font-medium">{n.label}</div><div className="text-xs text-ink-3">{n.detail}</div></div>
                </div>
              ))}
            </div>
          )}
          <p className="text-xs text-ink-3 mt-2">Tailscale, a local network or your own VPN only carry the bytes. The worker still proves who it is, and the channel is encrypted on any of them.</p>
        </fieldset>
        <Field label="Name (optional)" htmlFor="adopt-name" hint="You can change it later. The computer's own host name is used if you leave this empty.">
          <Input id="adopt-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} placeholder="For example, workshop-jetson" />
        </Field>
        <Field label="Who can use it" htmlFor="adopt-scope" hint="Limits which organizations' agents may run on this worker.">
          <Select id="adopt-scope" value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="all">All organizations</option>
            {(orgs.data ?? []).map((o) => <option key={o.id} value={o.id}>{o.name} only</option>)}
          </Select>
        </Field>
        {create.error && <Notice tone="critical" title="Couldn't create a pairing code">{fabricErrorText(create.error)}</Notice>}
      </div>
    </Modal>
  );
}

function ProviderOption({ t, selected, onSelect }: { t: Transport; selected: boolean; onSelect: () => void }) {
  const Icon = ICON[t.provider];
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={!t.available}
      onClick={onSelect}
      className={cn("transition-control text-left rounded-lg border px-4 py-3 min-h-11 flex items-start gap-3 disabled:opacity-60 disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)", selected ? "border-accent bg-accent-soft" : "border-line bg-surface hover:border-line-strong")}
    >
      <Icon className="h-4 w-4 mt-0.5 shrink-0 text-ink-2" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2 text-sm font-medium">{t.label}{t.recommended && <Chip tone="accent">Recommended</Chip>}<Status kind={t.available ? "good" : "warning"} label={t.available ? "Detected" : "Not detected"} className="text-xs" /></span>
        <span className={cn("block text-xs mt-0.5", selected ? "text-ink-2" : "text-ink-3")}>{t.detail}</span>
        {t.address && <span className="block text-xs font-mono text-ink-2 mt-0.5 break-all">{t.address}</span>}
      </span>
    </button>
  );
}

type Phase = { kind: "waiting" } | { kind: "expired" } | { kind: "used" } | { kind: "cancelled" } | { kind: "arrived"; worker: Worker };

function PairStep({ pairing, baseline, onClose, onAgain }: { pairing: NewPairing; baseline: Set<string>; onClose: () => void; onAgain: () => void }) {
  const { setup } = useEngine();
  const f = useFabric().data;
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const cancel = useFabricAction(() => fabricApi.cancelPairing(pairing.id));
  const mine = f?.pairings.find((p) => p.id === pairing.id);
  const arrived = f?.workers.find((w) => w.state === "adopted" && (mine?.workerId ? w.id === mine.workerId : !baseline.has(w.id)));
  // Older hosts drop a spent code from the list; newer ones keep it with a state.
  const stillThere = !!mine || !f;
  const left = countdown(pairing.expiresAt, now);
  const phase: Phase = useMemo(() => arrived ? { kind: "arrived", worker: arrived } : mine?.state === "cancelled" ? { kind: "cancelled" } : mine?.state === "used" ? { kind: "used" } : !left || mine?.state === "expired" ? { kind: "expired" } : !stillThere && f ? { kind: "used" } : { kind: "waiting" }, [arrived, left, stillThere, f, mine]);
  const pending = f?.pending ?? [];

  if (phase.kind === "arrived") {
    const w = phase.worker;
    return (
      <Modal size="md" title={`${w.name} is connected`} subtitle="It reported this about itself. Creating the pairing code was your approval." icon={<CheckCircle2 className="h-5 w-5 text-good" aria-hidden />} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Done</Button><Link to={`/${setup?.deviceName ?? "pve"}/datacenter/workers/${encodeURIComponent(w.id)}`} onClick={onClose} className="inline-flex items-center justify-center h-10 px-4 rounded-lg text-sm font-medium bg-primary text-primary-ink min-h-11">Open {w.name}</Link></>}>
        <CapabilityFacts c={w.capabilities} />
        <p className="text-xs text-ink-3 mt-4">Not what you expected? Open the worker and revoke it. The pairing code is already used up and can't be replayed.</p>
      </Modal>
    );
  }
  const bad = phase.kind === "expired" || phase.kind === "used" || phase.kind === "cancelled";
  return (
    <Modal
      size="md"
      title="Pair the worker"
      subtitle="On the computer you are adding, install the worker, then give it this one-use code."
      onClose={onClose}
      footer={bad ? <><Button variant="ghost" onClick={onClose}>Close</Button><Button variant="primary" onClick={onAgain}>Create a new code</Button></> : <><Button variant="ghost" loading={cancel.isPending} onClick={() => cancel.mutate(undefined, { onSuccess: onClose })}>Cancel this code</Button><Button variant="secondary" onClick={onClose}>Close, keep waiting</Button></>}
    >
      <div className="grid gap-4">
        {phase.kind === "expired" && <Notice tone="warning" title="This code expired">Codes last 15 minutes and work once. Create a new one.</Notice>}
        {phase.kind === "cancelled" && <Notice tone="warning" title="This code was cancelled">It can no longer be used. Create a new one when you are ready.</Notice>}
        {phase.kind === "used" && <Notice tone="warning" title="This code is no longer valid">It was used or cancelled, and no new worker appeared. A used code can't be replayed. If a worker did not join, create a new code and check that it can reach this device.</Notice>}
        {!bad && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 text-compact">
              <span className="inline-flex items-center gap-2 text-ink-2" role="status"><Loader2 className="h-4 w-4 animate-spin" aria-hidden />Waiting for the worker to connect</span>
              <span className="text-ink-3">Expires in <span className="tabular-nums font-mono" aria-label={`Expires in ${left}`}>{left}</span></span>
            </div>
            <CopyBlock label="Pairing code" value={pairing.code} note="Shown once. It can't be shown again after you close this window." />
            <CopyBlock label="Install and pair command" value={pairing.installCommand} />
          </>
        )}
        {f && f.pending.length > 0 && (
          <Notice tone="info" title="A worker is asking to join">{pending.length} {pending.length === 1 ? "request is" : "requests are"} waiting on the Workers page, with its hardware and a check string for you to approve.</Notice>
        )}
        <p className="text-xs text-ink-3 inline-flex items-start gap-2"><AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" aria-hidden />Treat the code like a one-time key. Anyone who has it in the next few minutes can add a worker. It carries no password and no access to your account.</p>
        {cancel.error && <p role="alert" className="text-compact text-critical">{errorText(cancel.error)}</p>}
      </div>
    </Modal>
  );
}

function CopyBlock({ label, value, note }: { label: string; value: string; note?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setCopied(false); }
  };
  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-1.5"><span className="text-compact font-medium text-ink-2">{label}</span><Button size="sm" variant="secondary" className="min-h-11 sm:min-h-8" onClick={() => void copy()} aria-label={`Copy ${label.toLowerCase()}`}>{copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}{copied ? "Copied" : "Copy"}</Button></div>
      <pre tabIndex={0} aria-label={label} className="rounded-lg border border-line bg-code p-3 text-xs font-mono whitespace-pre-wrap break-all select-all">{value}</pre>
      {note && <p className="text-xs text-ink-3 mt-1">{note}</p>}
    </div>
  );
}
