import { useState, type FormEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, ArrowRight, Bot, Check, Cpu, Globe, Server, Sparkles } from "lucide-react";
import { useSession } from "../auth/session.tsx";
import { orgNameError, useEngine } from "../data/store.tsx";
import type { PinMode, SetupState } from "../data/types.ts";
import { cn, slugify } from "../lib/storage.ts";
import { PinOrb } from "../pin/PinIsland.tsx";
import { Toggle } from "../ui/primitives.tsx";

const STEPS = 5;

function Shell({ step, title, subtitle, children, onBack }: { step: number; title: ReactNode; subtitle?: ReactNode; children: ReactNode; onBack?: () => void }) {
  // On a live device there is no organization step: organizations come with the Paperclip engine, so the first screen is step 2.
  const live = useSession().session.mode === "live";
  const total = live ? STEPS - 1 : STEPS;
  const at = live ? step - 1 : step;
  return (
    <div className="min-h-dvh relative flex flex-col items-center px-5">
      <div className="absolute inset-0 hero-glow opacity-60 pointer-events-none" aria-hidden />
      <div className="relative w-full max-w-[480px] pt-[14vh] pb-16">
        <div className="flex items-center justify-center gap-1.5 mb-10" aria-label={`Step ${at + 1} of ${total}`}>
          {Array.from({ length: total }, (_, i) => (
            <span key={i} className={cn("h-1.5 rounded-full transition-all duration-(--duration-deliberate)", i === at ? "w-5 bg-ink" : i < at ? "w-1.5 bg-ink-2" : "w-1.5 bg-surface-3")} />
          ))}
        </div>
        <div key={step} className="fade-in">
          <h1 className="text-hero sm:text-hero-md font-semibold tracking-tight text-center">{title}</h1>
          {subtitle && <p className="text-center text-ink-2 mt-3 text-body">{subtitle}</p>}
          <div className="mt-10">{children}</div>
        </div>
        {onBack && (
          <button onClick={onBack} className="absolute left-0 top-[14vh] -mt-1.5 h-8 w-8 rounded-full hover:bg-surface-2 flex items-center justify-center text-ink-3" aria-label="Back">
            <ArrowLeft className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}

function Continue({ disabled, label = "Continue" }: { disabled?: boolean; label?: string }) {
  return (
    <button type="submit" disabled={disabled} className="h-11 px-6 rounded-full bg-primary text-primary-ink font-medium text-body inline-flex items-center gap-2 disabled:bg-surface-3 disabled:text-ink-3 transition active:scale-[0.98]">
      {label} <ArrowRight className="h-4 w-4" />
    </button>
  );
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium mb-2">{label}</span>
      {children}
      <span className="block text-xs mt-2 min-h-4">{hint}</span>
    </label>
  );
}

const inputCls = "h-12 w-full rounded-xl bg-surface-2/80 border border-line px-4 text-body placeholder:text-ink-3 outline-none focus:border-line-strong focus:ring-2 focus:ring-accent/25";

const PROVIDERS = [
  { id: "anthropic", name: "Anthropic", body: "Claude subscription or API key", icon: <Sparkles className="h-4 w-4" /> },
  { id: "openai", name: "OpenAI", body: "ChatGPT subscription or API key", icon: <Bot className="h-4 w-4" /> },
  { id: "google", name: "Google", body: "Gemini API key", icon: <Globe className="h-4 w-4" /> },
  { id: "custom", name: "Custom endpoint", body: "Your own gateway or model server", icon: <Cpu className="h-4 w-4" /> },
];

export function Onboarding() {
  const engine = useEngine();
  const { session } = useSession();
  const liveUser = session.mode === "live" ? session.user : null;
  const navigate = useNavigate();
  const [step, setStep] = useState(liveUser ? 1 : 0);
  const [org, setOrg] = useState("");
  const [skipOrg, setSkipOrg] = useState(false);
  const [owner, setOwner] = useState(liveUser && liveUser.name !== "root" ? liveUser.name : "");
  const [mode, setMode] = useState<PinMode>("assistant");
  const [provider, setProvider] = useState<string | null>(null);
  const [access, setAccess] = useState<SetupState["pinAccess"]>({ system: true, orgs: true, connectors: true, docs: true });
  const [device, setDevice] = useState(liveUser?.node ?? "pve");
  const [finishing, setFinishing] = useState(false);

  const next = (e?: FormEvent) => {
    e?.preventDefault();
    setStep((s) => Math.min(STEPS - 1, s + 1));
  };
  const back = step > (liveUser ? 1 : 0) ? () => setStep((s) => s - 1) : undefined;
  const orgErr = org.trim() ? orgNameError(org, []) : null;
  const deviceSlug = slugify(device);

  const finish = (e: FormEvent) => {
    e.preventDefault();
    if (!deviceSlug) return;
    setFinishing(true);
    setTimeout(() => {
      engine.completeSetup({ ownerName: owner.trim(), deviceName: deviceSlug, pinMode: mode, aiProvider: provider, pinAccess: access }, skipOrg || !org.trim() ? null : org.trim());
      navigate(`/${deviceSlug}/home`, { replace: true });
    }, 1400);
  };

  if (finishing) {
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center gap-6 relative">
        <div className="absolute inset-0 hero-glow pointer-events-none" aria-hidden />
        <div className="relative fade-in"><PinOrb size={84} thinking /></div>
        <p className="relative text-lg shimmer-text">Pin is getting to know {deviceSlug}…</p>
      </div>
    );
  }

  if (step === 0) {
    return (
      <Shell step={0} title={<>What is the name of<br />your organization?</>}>
        <form onSubmit={next}>
          <Field label="Name" hint={orgErr ? <span className="text-critical">{orgErr}</span> : null}>
            <input autoFocus value={org} onChange={(e) => { setOrg(e.target.value); setSkipOrg(false); }} placeholder="e.g. Northwind Labs" className={inputCls} />
          </Field>
          <div className="flex items-center justify-between mt-6">
            <button type="button" onClick={() => { setSkipOrg(true); setOrg(""); next(); }} className="text-sm text-ink-3 hover:text-ink-2">Skip, Pin can set one up later</button>
            <Continue disabled={!org.trim() || !!orgErr} />
          </div>
        </form>
      </Shell>
    );
  }

  if (step === 1) {
    return (
      <Shell step={1} onBack={back} title="What should Pin call you?" subtitle="Pin is your copilot for this machine. It greets you, keeps an eye on things, and does the work you hand it.">
        <form onSubmit={next}>
          <Field label="Your name"><input autoFocus value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="e.g. Jeremiah" className={inputCls} /></Field>
          <div className="flex justify-end mt-6"><Continue disabled={!owner.trim()} /></div>
        </form>
      </Shell>
    );
  }

  if (step === 2) {
    return (
      <Shell step={2} onBack={back} title="How should Pin work?" subtitle="You can switch any time from Pin's island.">
        <form onSubmit={next}>
          <div className="grid gap-3">
            {([
              ["assistant", "Assistant", "Watches your system, answers questions and handles light tasks. Asks you before doing anything bigger."],
              ["agent", "Agent", "Works on its own: runs tasks, follows your schedule and acts on triggers, then tells you what it did."],
            ] as const).map(([v, t, b]) => (
              <button key={v} type="button" onClick={() => setMode(v)} aria-pressed={mode === v} className={cn("text-left rounded-2xl border p-4 transition flex gap-3", mode === v ? "border-accent/60 bg-accent-soft" : "border-line bg-surface/60 hover:border-line-strong")}>
                <span className={cn("mt-0.5 h-5 w-5 rounded-full border flex items-center justify-center shrink-0", mode === v ? "bg-accent border-accent text-primary-ink" : "border-line-strong")}>{mode === v && <Check className="h-3.5 w-3.5" strokeWidth={3} />}</span>
                <span><span className="block font-semibold">{t}</span><span className="block text-sm text-ink-2 mt-0.5">{b}</span></span>
              </button>
            ))}
          </div>
          <div className="flex justify-end mt-6"><Continue /></div>
        </form>
      </Shell>
    );
  }

  if (step === 3) {
    return (
      <Shell step={3} onBack={back} title="Connect an AI account" subtitle="Pin and your agents think with the account you connect. The key goes into the Vault, never into an agent.">
        <form onSubmit={next}>
          <div className="grid sm:grid-cols-2 gap-3">
            {PROVIDERS.map((p) => (
              <button key={p.id} type="button" onClick={() => setProvider(p.id === provider ? null : p.id)} aria-pressed={provider === p.id} className={cn("text-left rounded-2xl border p-4 transition", provider === p.id ? "border-accent/60 bg-accent-soft" : "border-line bg-surface/60 hover:border-line-strong")}>
                <span className="flex items-center gap-2 font-semibold text-body"><span className="text-ink-2">{p.icon}</span>{p.name}</span>
                <span className="block text-compact text-ink-3 mt-1">{p.body}</span>
              </button>
            ))}
          </div>
          <p className="text-xs text-ink-3 mt-3">{provider ? "You'll finish signing in from Connectors once the console opens." : "No account yet? Pin can still run quick actions, but it can't chat until you connect one."}</p>
          <div className="flex items-center justify-between mt-6">
            <button type="button" onClick={() => { setProvider(null); next(); }} className="text-sm text-ink-3 hover:text-ink-2">Do this later</button>
            <Continue />
          </div>
        </form>
      </Shell>
    );
  }

  return (
    <Shell step={4} onBack={back} title="What can Pin do?" subtitle="Pin only gets the access you give it. Change it later in Access control.">
      <form onSubmit={finish}>
        <div className="rounded-2xl border border-line bg-surface/60 divide-y divide-line">
          {([
            ["system", "Manage this device", "Guests, storage, backups and updates"],
            ["orgs", "Manage organizations", "Create orgs and size their resources"],
            ["connectors", "Use connectors", "Only the ones you grant to Pin"],
            ["docs", "Read Proxmox and Paperclip docs", "To guide you, or do it for you"],
          ] as const).map(([k, t, b]) => (
            <div key={k} className="flex items-center gap-4 px-4 py-3.5">
              <div className="flex-1"><div className="text-body font-medium">{t}</div><div className="text-compact text-ink-3">{b}</div></div>
              <Toggle label={t} checked={access[k]} onChange={(v) => setAccess({ ...access, [k]: v })} />
            </div>
          ))}
        </div>
        <div className="mt-6">
          <Field label="This device is called" hint={deviceSlug ? <span className="text-ink-3">Your console lives at <span className="text-ink-2">/{deviceSlug}/home</span></span> : <span className="text-critical">Use at least one letter or number.</span>}>
            <div className="relative">
              <Server className="h-4 w-4 text-ink-3 absolute left-4 top-1/2 -translate-y-1/2" />
              <input value={device} onChange={(e) => setDevice(e.target.value)} className={cn(inputCls, "pl-10")} />
            </div>
          </Field>
        </div>
        <div className="flex justify-end mt-4"><Continue disabled={!deviceSlug} label="Meet Pin" /></div>
      </form>
    </Shell>
  );
}
