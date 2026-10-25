import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Check, KeyRound, LogIn, Sparkles, UserPlus, X } from "lucide-react";
import { type LoginAdapter } from "@papercliped-engine/engine-client";
import { useEngine } from "../../data/store.tsx";
import { orgSlug } from "../../data/engine/map.ts";
import { engine, errorText, useCanCreateOrgs, useCreateOrg, useEngineStatus, useOrgs } from "../../data/engine/queries.ts";
import { host } from "../../data/engine/host.ts";
import { startApi } from "../../data/engine/startApi.ts";
import { suggestSize } from "../../pin/brain.ts";
import { usePin } from "../../pin/PinContext.tsx";
import { useModals } from "../../modals/useModals.ts";
import { cn } from "../../lib/storage.ts";
import { Avatar, Button, Chip, Field, IconButton, Input, Notice, Spinner } from "../../ui/primitives.tsx";
import { textareaClass } from "../org/live/common.tsx";
import { ApiKeyModal, HARNESSES, SignInModal, type Harness } from "../AgentSignIn.tsx";
import { SizeChoice } from "./SizeChoice.tsx";

/**
 * Start a company, the way Paperclip does it (docs/PAPERCLIP-STUDY.md): one question per screen.
 *
 *   1  the organization's name (and what it is for, and how much of this device its agents get: our addition)
 *   2  the first agent, the CEO: made by hand, or drafted by Pin for the person to review
 *   3  connect a model: an account sign-in or an API key (Gemini: key only)
 *   4  what the CEO should do first
 *
 * The company exists from the end of step 1, like Paperclip's, because signing in needs its container environment. The
 * wizard remembers where it was, so closing it and coming back resumes. What lands in the engine is built by the
 * engine's own seed route: the mission as the company goal, the CEO with the core skills, an "Onboarding" project and the first task.
 */

type Step = "name" | "ceo" | "model" | "task";
const STEPS: Step[] = ["name", "ceo", "model", "task"];
const DRAFT = "epc.start.draft";

interface Draft {
  step: Step;
  company: { id: string; issuePrefix: string; name: string } | null;
  mission: string;
  ceoName: string;
  ceoTitle: string;
  agentId: string | null;
}
const EMPTY: Draft = { step: "name", company: null, mission: "", ceoName: "", ceoTitle: "", agentId: null };

const load = (): Draft => {
  try {
    const v = JSON.parse(localStorage.getItem(DRAFT) ?? "null") as Partial<Draft> | null;
    return v && STEPS.includes(v.step as Step) ? { ...EMPTY, ...v } : EMPTY;
  } catch {
    return EMPTY;
  }
};
const save = (d: Draft | null) => {
  try {
    if (d) localStorage.setItem(DRAFT, JSON.stringify(d));
    else localStorage.removeItem(DRAFT);
  } catch {
    // storage unavailable: the wizard still works, it just can't resume
  }
};

const hue = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 17);

interface Ctx {
  eng: ReturnType<typeof useEngine>;
  device: string;
  modals: ReturnType<typeof useModals>;
  pin: ReturnType<typeof usePin>;
  gate: ReturnType<typeof useEngineStatus>;
  canCreate: boolean | undefined;
  create: ReturnType<typeof useCreateOrg>;
  draft: Draft;
  patch: (p: Partial<Draft>) => void;
  name: string;
  setName: (v: string) => void;
  error: string | null;
  setError: (v: string | null) => void;
  warning: string | null;
  setWarning: (v: string | null) => void;
  busy: boolean;
  setBusy: (v: boolean) => void;
  suggested: ReturnType<typeof suggestSize>;
  pinDecides: boolean;
  setPinDecides: (v: boolean) => void;
  size: ReturnType<typeof suggestSize>;
  setSize: (v: ReturnType<typeof suggestSize>) => void;
  goToOrg: () => void;
}

export function StartCompany({ onClose }: { onClose: () => void }) {
  const eng = useEngine();
  const device = eng.setup?.deviceName ?? "pve";
  const navigate = useNavigate();
  const modals = useModals();
  const pin = usePin();
  const orgs = useOrgs();
  const gate = useEngineStatus();
  const canCreate = useCanCreateOrgs();
  const create = useCreateOrg();

  const [draft, setDraft] = useState<Draft>(() => load());
  const [name, setName] = useState(draft.company?.name ?? "");
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const patch = (p: Partial<Draft>) => setDraft((d) => (save({ ...d, ...p }), { ...d, ...p }));
  const suggested = useMemo(() => suggestSize(eng.host, eng.data), [eng.host, eng.data]);
  const [pinDecides, setPinDecides] = useState(true);
  const [size, setSize] = useState(suggested);

  // A remembered draft only counts while its company still exists.
  useEffect(() => {
    if (draft.company && orgs.data && !orgs.data.some((c) => c.id === draft.company!.id)) {
      save(null);
      setDraft(EMPTY);
    }
  }, [orgs.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const step = draft.step;
  const index = STEPS.indexOf(step);
  const done = () => {
    save(null);
    onClose();
  };
  const goToOrg = () => {
    const c = draft.company!;
    done();
    navigate(`/${device}/${orgSlug({ id: c.id, issuePrefix: c.issuePrefix })}`);
  };

  // Escape leaves the wizard (it resumes next time).
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && !document.querySelector("[role=dialog]") && onClose();
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);

  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), [step]);

  const ctx: Ctx = { eng, device, modals, pin, gate, canCreate, create, draft, patch, name, setName, error, setError, warning, setWarning, busy, setBusy, suggested, pinDecides, setPinDecides, size, setSize, goToOrg };
  const body = step === "name" ? <NameStep c={ctx} /> : step === "ceo" ? <CeoStep c={ctx} /> : step === "model" ? <ModelStep c={ctx} /> : <TaskStep c={ctx} />;

  return createPortal(
    <div className="fixed inset-0 z-(--z-fullscreen) bg-bg overflow-y-auto" role="region" aria-label="Start a company">
      <div className="mx-auto w-full max-w-lg px-4 pb-16 pt-6">
        <div className="flex items-center justify-between">
          <ol className="flex items-center gap-2" aria-label={`Step ${index + 1} of ${STEPS.length}`}>
            {STEPS.map((s, i) => <li key={s} aria-current={i === index ? "step" : undefined} className={cn("h-1.5 rounded-full transition-control", i === index ? "w-6 bg-ink" : i < index ? "w-1.5 bg-ink-2" : "w-1.5 bg-line-strong")} />)}
          </ol>
          <IconButton label="Close" variant="ghost" onClick={onClose}><X className="h-4 w-4" /></IconButton>
        </div>
        <h1 ref={heading} tabIndex={-1} className="sr-only">Start a company, step {index + 1} of {STEPS.length}</h1>
        {body}
      </div>
    </div>,
    document.body,
  );
}

function NameStep({ c }: { c: Ctx }) {
  const { eng, device, modals, pin, gate, canCreate, create, draft, patch, name, setName, error, setError, warning, setWarning, busy, setBusy, suggested, pinDecides, setPinDecides, size, setSize, goToOrg } = c;
  const containers = useQuery({ queryKey: ["start", "containers"], queryFn: host.agentContainers.get, retry: false });
  const dupe = name.trim() && eng.data.orgs.some((o) => o.name.toLowerCase() === name.trim().toLowerCase());
  const blocked = gate.state !== "ready" ? "The engine isn't ready yet." : canCreate === false ? "Organizations on this device are created by a Proxmox administrator, who can then invite you." : null;
  const next = async () => {
    if (!name.trim() || dupe || busy) return;
    setBusy(true);
    setError(null);
    try {
      const s = pinDecides ? suggested : size;
      const r = await create.mutateAsync({ name, description: draft.mission, size: s });
      setWarning(r.resourceGroupError ? `The organization exists, but its resource group couldn't be set up: ${r.resourceGroupError}. Its agents have nowhere to run until that is fixed.` : null);
      patch({ company: { id: r.companyId, issuePrefix: r.slugSource.issuePrefix ?? "", name: name.trim() }, step: "ceo" });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Screen title="What is the name of your organization?" next={{ label: "Continue", onClick: next, disabled: !name.trim() || !!dupe || !!blocked, loading: busy }} onBack={null}>
      {blocked && <Notice tone="warning">{blocked}</Notice>}
      {containers.data && containers.data.state !== "ready" && (
        <Notice tone="warning" title="Agent containers aren't set up yet" action={containers.data.canManage ? <Button size="sm" onClick={() => modals.openSettings("agent-containers")}>Set up</Button> : undefined}>
          Agents run in containers on this device. The organization can be created now, but its agents can't run until they are set up.
        </Notice>
      )}
      <Field label="Name" htmlFor="org-name" error={dupe ? "An organization with that name already exists." : undefined}>
        <Input id="org-name" autoFocus size="lg" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void next()} placeholder="e.g. Northwind Labs" />
      </Field>
      <Field label="What is it for? (optional)" htmlFor="org-mission" hint="It becomes the organization's mission, its first goal.">
        <textarea id="org-mission" rows={3} value={draft.mission} onChange={(e) => patch({ mission: e.target.value })} className={textareaClass} placeholder="Build the best invoicing tool for small studios" />
      </Field>
      <SizeChoice device={device} host={eng.host} suggested={suggested} pinDecides={pinDecides} onPinDecides={setPinDecides} size={size} onSize={setSize} />
      {error && <p role="alert" className="text-compact text-critical">{error}</p>}
    </Screen>
  );
}



function CeoStep({ c }: { c: Ctx }) {
  const { eng, device, modals, pin, gate, canCreate, create, draft, patch, name, setName, error, setError, warning, setWarning, busy, setBusy, suggested, pinDecides, setPinDecides, size, setSize, goToOrg } = c;
  const [mode, setMode] = useState<"me" | "pin">("me");
  const [drafting, setDrafting] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const pinReady = !!pin.settings?.provider && !!pin.settings?.model;
  const ask = async () => {
    setDrafting(true);
    setError(null);
    try {
      const d = await startApi.draftCeo(draft.company!.name, draft.mission);
      patch({ ceoName: d.name, ceoTitle: d.title });
      setSummary(d.summary || null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setDrafting(false);
    }
  };
  const next = async () => {
    if (!draft.ceoName.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await engine.companies.seed(draft.company!.id, { revision: "1", ...(draft.mission.trim() ? { mission: draft.mission.trim() } : {}), agent: { name: draft.ceoName.trim(), ...(draft.ceoTitle.trim() ? { role: draft.ceoTitle.trim() } : {}) } });
      patch({ agentId: r.agentId, step: "model" });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const choice = (id: "me" | "pin", icon: ReactNode, title: string, text: string, disabled = false) => (
    <button type="button" role="radio" aria-checked={mode === id} disabled={disabled} onClick={() => setMode(id)} className={cn("transition-control flex-1 text-left rounded-xl border p-3.5 disabled:opacity-50", mode === id ? "border-accent/60 bg-accent-soft" : "border-line hover:border-line-strong")}>
      <div className="flex items-center gap-2 font-medium text-sm">{icon}{title}</div>
      <p className="text-xs text-ink-3 mt-1">{text}</p>
    </button>
  );
  return (
    <Screen title="Create your first agent" subtitle="The CEO leads the organization: it plans the work and hires the rest of the team." onBack={() => patch({ step: "name" })} next={{ label: "Next", onClick: next, disabled: !draft.ceoName.trim(), loading: busy }}>
      <div role="radiogroup" aria-label="How to create the CEO" className="flex flex-col sm:flex-row gap-3">
        {choice("me", <UserPlus className="h-4 w-4" />, "Create it myself", "Name your first agent.")}
        {choice("pin", <Sparkles className="h-4 w-4 text-accent" />, "Let Pin create it", pinReady ? "Pin drafts a name and a role from what the organization is for. You review it." : "Connect a model for Pin first (Settings → Connectors).", !pinReady)}
      </div>
      {mode === "pin" && (
        <div className="space-y-3">
          <Button onClick={() => void ask()} loading={drafting}><Sparkles className="h-4 w-4" />{draft.ceoName ? "Try again" : "Ask Pin"}</Button>
          {summary && <p className="text-compact text-ink-2">{summary}</p>}
        </div>
      )}
      {(mode === "me" || draft.ceoName) && (
        <>
          <Field label="Agent name" htmlFor="ceo-name"><Input id="ceo-name" size="lg" autoFocus={mode === "me"} value={draft.ceoName} onChange={(e) => patch({ ceoName: e.target.value })} onKeyDown={(e) => e.key === "Enter" && void next()} placeholder="e.g. Chief of staff" /></Field>
          <Field label="Role (optional)" htmlFor="ceo-title" hint="What it is called in the organization chart."><Input id="ceo-title" value={draft.ceoTitle} onChange={(e) => patch({ ceoTitle: e.target.value })} placeholder="Chief of staff" /></Field>
        </>
      )}
      {warning && <Notice tone="warning">{warning}</Notice>}
      {error && <p role="alert" className="text-compact text-critical">{error}</p>}
    </Screen>
  );
}



function ModelStep({ c }: { c: Ctx }) {
  const { eng, device, modals, pin, gate, canCreate, create, draft, patch, name, setName, error, setError, warning, setWarning, busy, setBusy, suggested, pinDecides, setPinDecides, size, setSize, goToOrg } = c;
  const [picked, setPicked] = useState<Harness | null>(null);
  const [connected, setConnected] = useState<Partial<Record<Harness, boolean>>>({});
  const [flow, setFlow] = useState<{ kind: "login" | "key"; adapter: Harness } | null>(null);
  const [prepping, setPrepping] = useState(false);
  // The container environment is made within a minute of the organization; wait for it before offering a sign-in.
  const env = useQuery({ queryKey: ["start", "env", draft.company!.id], queryFn: host.agentContainers.get, retry: false, refetchInterval: (q) => (q.state.data?.environments.some((e) => e.companyId === draft.company!.id && e.ok) ? false : 3000) });
  const environmentId = env.data?.environments.find((e) => e.companyId === draft.company!.id && e.ok)?.environmentId ?? null;
  const start = async (kind: "login" | "key", adapter: Harness) => {
    setPrepping(true);
    setError(null);
    try {
      // The CEO runs on whichever harness the person connects.
      if (draft.agentId) await engine.agents.update(draft.agentId, { adapterType: adapter });
      setFlow({ kind, adapter });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPrepping(false);
    }
  };
  const chosen = HARNESSES.find((h) => h.adapter === picked);
  return (
    <Screen title="Connect a model" subtitle="Your agents work with your account or an API key." onBack={() => patch({ step: "ceo" })} next={{ label: Object.values(connected).some(Boolean) ? "Next" : "Skip for now", onClick: () => patch({ step: "task" }), variant: Object.values(connected).some(Boolean) ? "primary" : "secondary" }} avatar={draft.ceoName}>
      <div role="radiogroup" aria-label="Model" className="grid grid-cols-2 gap-3">
        {HARNESSES.map((h) => (
          <button key={h.adapter} type="button" role="radio" aria-checked={picked === h.adapter} onClick={() => setPicked(h.adapter)} className={cn("transition-control rounded-xl border p-3.5 text-left", picked === h.adapter ? "border-accent/60 bg-accent-soft" : "border-line hover:border-line-strong")}>
            <div className="flex items-center justify-between gap-2 font-medium text-sm">{h.name}{connected[h.adapter] && <Chip tone="good"><Check className="h-3 w-3" />Connected</Chip>}</div>
            <p className="text-xs text-ink-3 mt-1">{h.login ? "Account or API key" : "API key"}</p>
          </button>
        ))}
      </div>
      {chosen && (
        <div className="space-y-3">
          <p className="text-compact text-ink-2">{chosen.how}</p>
          <div className="flex flex-wrap gap-2">
            {chosen.login && <Button variant="primary" disabled={!environmentId} loading={prepping} onClick={() => void start("login", chosen.adapter)}><LogIn className="h-4 w-4" />Sign in with your account</Button>}
            <Button loading={prepping && !chosen.login} onClick={() => void start("key", chosen.adapter)}><KeyRound className="h-4 w-4" />Use an API key</Button>
          </div>
          {chosen.login && !environmentId && <p className="text-xs text-ink-3 flex items-center gap-1.5"><Spinner />Setting up this organization's container so the sign-in has somewhere to run…</p>}
        </div>
      )}
      {warning && <Notice tone="warning">{warning}</Notice>}
      {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      {flow?.kind === "login" && environmentId && <SignInModal companyId={draft.company!.id} org={draft.company!.name} adapter={flow.adapter as LoginAdapter} environmentId={environmentId} onClose={() => setFlow(null)} onDone={() => setConnected((c) => ({ ...c, [flow.adapter]: true }))} />}
      {flow?.kind === "key" && <ApiKeyModal companyId={draft.company!.id} org={draft.company!.name} adapter={flow.adapter} onClose={() => setFlow(null)} onDone={() => setConnected((c) => ({ ...c, [flow.adapter]: true }))} />}
    </Screen>
  );
}



function TaskStep({ c }: { c: Ctx }) {
  const { eng, device, modals, pin, gate, canCreate, create, draft, patch, name, setName, error, setError, warning, setWarning, busy, setBusy, suggested, pinDecides, setPinDecides, size, setSize, goToOrg } = c;
  const [text, setText] = useState("");
  const launch = async (withTask: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (withTask && text.trim()) {
        const [first, ...rest] = text.trim().split(/\r?\n/);
        const details = rest.join("\n").trim();
        await engine.companies.seed(draft.company!.id, { revision: "2", ...(draft.mission.trim() ? { mission: draft.mission.trim() } : {}), agent: { name: draft.ceoName.trim(), ...(draft.ceoTitle.trim() ? { role: draft.ceoTitle.trim() } : {}) }, firstTask: { title: first.slice(0, 200), ...(details ? { details: details.slice(0, 2000) } : {}) } });
      }
      goToOrg();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  return (
    <Screen title={`What should ${draft.ceoName || "your CEO"} do first?`} subtitle="The first line is the task's title; the rest is the brief. The agent starts as soon as you launch." onBack={() => patch({ step: "model" })} next={{ label: "Launch", onClick: () => void launch(true), disabled: !text.trim(), loading: busy }} secondary={{ label: "Skip for now", onClick: () => void launch(false) }} avatar={draft.ceoName}>
      <Field label="First task" htmlFor="first-task">
        <textarea id="first-task" autoFocus rows={5} value={text} onChange={(e) => setText(e.target.value)} className={textareaClass} placeholder={"Plan the first week\nPropose a plan and the team we need."} />
      </Field>
      {error && <p role="alert" className="text-compact text-critical">{error}</p>}
    </Screen>
  );
}



function Screen({ title, subtitle, children, onBack, next, secondary, avatar }: { title: string; subtitle?: string; children: ReactNode; onBack: (() => void) | null; next: { label: string; onClick: () => void; disabled?: boolean; loading?: boolean; variant?: "primary" | "secondary" }; secondary?: { label: string; onClick: () => void }; avatar?: string }) {
  return (
    <div className="mt-14 flex flex-col gap-5">
      {avatar ? <div className="flex flex-col items-center gap-2"><Avatar name={avatar} hue={hue(avatar)} size={64} /><span className="text-compact font-medium">{avatar}</span></div> : null}
      <div className="text-center">
        <h2 className="text-hero-md font-semibold text-balance">{title}</h2>
        {subtitle && <p className="text-body text-ink-3 mt-2 text-pretty">{subtitle}</p>}
      </div>
      <div className="flex flex-col gap-4">{children}</div>
      <div className="flex items-center justify-between gap-3 pt-2">
        {onBack ? <Button variant="ghost" onClick={onBack}><ArrowLeft className="h-4 w-4" />Back</Button> : <span />}
        <div className="flex items-center gap-2">
          {secondary && <Button variant="ghost" onClick={secondary.onClick}>{secondary.label}</Button>}
          <Button variant={next.variant ?? "primary"} onClick={next.onClick} disabled={next.disabled} loading={next.loading}>{next.label}<ArrowRight className="h-4 w-4" /></Button>
        </div>
      </div>
    </div>
  );
}
