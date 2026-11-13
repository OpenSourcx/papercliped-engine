import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Check, Sparkles, UserPlus, X } from "lucide-react";
import { type LoginAdapter } from "@papercliped-engine/engine-client";
import { useEngine } from "../../data/store.tsx";
import { orgSlug } from "../../data/engine/map.ts";
import { engine, errorText, useCanCreateOrgs, useContainersStep, useCreateOrg, useEngineStatus, useOrgs } from "../../data/engine/queries.ts";
import { qk } from "../../data/engine/keys.ts";
import { useAgentReadiness } from "../../data/engine/readiness.ts";
import { host } from "../../data/engine/host.ts";
import { startApi } from "../../data/engine/startApi.ts";
import { suggestSize } from "../../pin/brain.ts";
import { usePin } from "../../pin/PinContext.tsx";
import { useModals } from "../../modals/useModals.ts";
import { cn } from "../../lib/storage.ts";
import { Avatar, Button, Chip, Field, IconButton, Input, Notice, Spinner } from "../../ui/primitives.tsx";
import { textareaClass } from "../org/live/common.tsx";
import { ApiKeyModal, HARNESSES, InlineSignIn, type Harness } from "../AgentSignIn.tsx";
import { BrandMark } from "../../ui/BrandMark.tsx";
import { PinFieldPanel } from "../../ui/PinField.tsx";
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
  firstTask?: string;
  /** True when the person chose "Skip for now" at the model step. The limitation is shown in the task and org views. */
  modelSkipped?: boolean;
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
  useEffect(() => { heading.current?.focus(); }, [step]);

  const ctx: Ctx = { eng, device, modals, pin, gate, canCreate, create, draft, patch, name, setName, error, setError, warning, setWarning, busy, setBusy, suggested, pinDecides, setPinDecides, size, setSize, goToOrg };
  const body = step === "name" ? <NameStep c={ctx} /> : step === "ceo" ? <CeoStep c={ctx} /> : step === "model" ? <ModelStep c={ctx} /> : <TaskStep c={ctx} />;

  return createPortal(
    // Settings opened from a step shows over the wizard; the wizard steps aside, keeps its state, and comes back on close.
    <div hidden={modals.settings !== null} className="fixed inset-0 z-(--z-fullscreen) bg-bg overflow-y-auto" role="region" aria-label="Start a company">
      <PinFieldPanel />
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
  const containers = useQuery({ queryKey: qk.agentContainers, queryFn: host.agentContainers.get, retry: false });
  const dupe = name.trim() && eng.data.orgs.some((o) => o.engine?.companyId !== draft.company?.id && o.name.toLowerCase() === name.trim().toLowerCase());
  // Say what is actually being waited on instead of offering a button that can only fail.
  const blocked = (() => {
    if (gate.state === "checking") return "Checking whether the engine is ready…";
    if (gate.state !== "ready" && gate.state !== "demo") return gate.message;
    if (canCreate === undefined) return "Checking whether you can create organizations…";
    if (canCreate === false) return "Organizations on this device are created by a Proxmox administrator, who can then invite you.";
    return null;
  })();
  const next = async () => {
    if (!name.trim() || dupe || busy || blocked) return;
    if (draft.company) { patch({ step: "ceo" }); return; }
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
    <Screen title="What is the name of your organization?" next={{ label: "Continue", onClick: next, disabled: !name.trim() || !!dupe || !!blocked, reason: blocked ?? (!name.trim() ? "Enter a name for the organization to continue." : dupe ? "An organization with that name already exists. Choose another name." : undefined), loading: busy }} onBack={null}>
      {blocked && <Notice tone="warning">{blocked}</Notice>}
      {containers.data && containers.data.state !== "ready" && (
        <Notice tone="warning" title="Agent containers aren't set up yet" action={containers.data.canManage ? <Button size="sm" onClick={() => modals.selectSection("agent-containers")}>Set up</Button> : undefined}>
          Agents run in containers on this device. The organization can be created now, but its agents can't run until they are set up.
        </Notice>
      )}
      <Field label="Name" htmlFor="org-name" error={dupe ? "An organization with that name already exists." : undefined}>
        <Input id="org-name" autoFocus size="lg" disabled={!!draft.company} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void next()} placeholder="e.g. Northwind Labs" />
      </Field>
      <Field label="What is it for? (optional)" htmlFor="org-mission" hint="It becomes the organization's mission, its first goal.">
        <textarea id="org-mission" rows={3} value={draft.mission} onChange={(e) => patch({ mission: e.target.value })} className={textareaClass} placeholder="e.g. Build the best invoicing tool for small studios" />
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
      if (draft.agentId) {
        await engine.agents.update(draft.agentId, { name: draft.ceoName.trim(), title: draft.ceoTitle.trim() || null });
        patch({ step: "model" });
        return;
      }
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
    <Screen title="Create your first agent" subtitle="The CEO leads the organization: it plans the work and hires the rest of the team." onBack={() => patch({ step: "name" })} next={{ label: "Next", onClick: next, disabled: !draft.ceoName.trim(), reason: "Give the agent a name to continue. The grey text in the field is only an example.", loading: busy }}>
      <div role="radiogroup" aria-label="How to create the CEO" className="flex flex-col sm:flex-row gap-3">
        {choice("me", <UserPlus className="h-4 w-4" />, "Create it myself", "Name your first agent.")}
        {choice("pin", <Sparkles className="h-4 w-4 text-accent" />, "Let Pin create it", pinReady ? "Pin drafts a name and a role from what the organization is for. You review it." : "Pin needs a model first: choose one on the Pin page. You can name the CEO yourself now.", !pinReady)}
      </div>
      {mode === "pin" && (
        <div className="space-y-3">
          <Button onClick={() => void ask()} loading={drafting}><Sparkles className="h-4 w-4" />{draft.ceoName ? "Try again" : "Ask Pin"}</Button>
          {summary && <p className="text-compact text-ink-2">{summary}</p>}
        </div>
      )}
      {(mode === "me" || draft.ceoName) && (
        <>
          <Field label="Agent name" htmlFor="ceo-name"><Input id="ceo-name" size="lg" autoFocus={mode === "me"} value={draft.ceoName} onChange={(e) => patch({ ceoName: e.target.value })} onKeyDown={(e) => e.key === "Enter" && void next()} placeholder="e.g. Ada" /></Field>
          <Field label="Role (optional)" htmlFor="ceo-title" hint="Optional. Shown under the name in the organization chart."><Input id="ceo-title" value={draft.ceoTitle} onChange={(e) => patch({ ceoTitle: e.target.value })} placeholder="e.g. Chief of staff" /></Field>
        </>
      )}
      {warning && <Notice tone="warning">{warning}</Notice>}
      {error && <p role="alert" className="text-compact text-critical">{error}</p>}
    </Screen>
  );
}



/** What a card calls each harness: the provider the person knows, not the command-line tool that runs it. */
const PROVIDER: Record<Harness, string> = { claude_local: "Claude", codex_local: "OpenAI", grok_local: "Grok", gemini_local: "Gemini" };

function ModelStep({ c }: { c: Ctx }) {
  const { draft, patch, setError, error, warning, modals } = c;
  const qc = useQueryClient();
  const [picked, setPicked] = useState<Harness | null>(null);
  const [connected, setConnected] = useState<Partial<Record<Harness, boolean>>>({});
  const [flow, setFlow] = useState<{ kind: "login" | "key"; adapter: Harness } | null>(null);
  // Paperclip's order: a subscription first, an API key as the quieter second choice.
  const [mode, setMode] = useState<"account" | "key">("account");
  // Read the host directly, under the same cache key as useAgentContainers: the wizard must still work while the
  // session probe is settling, and it needs to know whether this organization's environment exists yet.
  const containers = useQuery({
    queryKey: qk.agentContainers,
    queryFn: host.agentContainers.get,
    retry: 1,
    refetchInterval: (q) => {
      const s = q.state.data;
      if (!s || s.environments.some((e) => e.companyId === draft.company!.id && e.ok)) return false;
      return s.state === "ready" ? 3_000 : 30_000;
    },
  });
  const makeEnvironment = useContainersStep();
  const environment = containers.data?.environments.find((e) => e.companyId === draft.company!.id) ?? null;
  const environmentId = environment?.ok ? environment.environmentId : null;
  // The model step is re-entered from the task step; ask the backend what is really connected instead of trusting a
  // component-local flag that vanished on unmount.
  const agent = useQuery({ queryKey: qk.agent(draft.company!.id, draft.agentId ?? ""), queryFn: () => engine.agents.get(draft.agentId!), enabled: !!draft.agentId, retry: false });
  const readiness = useAgentReadiness(draft.company!.id, agent.data ? [agent.data] : []);
  const modelCheck = draft.agentId ? readiness.get(draft.agentId)?.checks.find((check) => check.id === "model") : undefined;
  const modelConnected = modelCheck?.state === "ok";
  const logsIn = (a: Harness) => HARNESSES.find((h) => h.adapter === a)?.login === true;
  const start = async (kind: "login" | "key", adapter: Harness) => {
    setError(null);
    try {
      // The CEO runs on whichever harness the person connects.
      if (draft.agentId) await engine.agents.update(draft.agentId, { adapterType: adapter });
      setFlow({ kind, adapter });
    } catch (e) {
      setError(errorText(e));
    }
  };
  const choose = (adapter: Harness) => {
    setFlow(null);
    setPicked(adapter);
    if (mode === "key" || !logsIn(adapter)) void start("key", adapter);
  };
  // Choosing a provider starts its sign-in at once, as soon as the container is there to run it.
  useEffect(() => {
    if (picked && mode === "account" && logsIn(picked) && environmentId && !flow && !connected[picked] && !modelConnected) void start("login", picked);
  }, [picked, mode, environmentId, modelConnected]); // eslint-disable-line react-hooks/exhaustive-deps
  const switchMode = () => {
    setFlow(null);
    setPicked(null);
    setError(null);
    setMode((m) => (m === "account" ? "key" : "account"));
  };
  // A successful sign-in or saved key is real state: refresh the readiness view and forget an earlier skip.
  const connectedNow = (adapter: Harness) => {
    setConnected((m) => ({ ...m, [adapter]: true }));
    patch({ modelSkipped: false });
    void qc.invalidateQueries({ queryKey: ["connect", "org-ai", draft.company!.id] });
    void qc.invalidateQueries({ queryKey: ["vault"] });
    void qc.invalidateQueries({ queryKey: ["agent-auth", draft.company!.id] });
    if (draft.agentId) void qc.invalidateQueries({ queryKey: qk.agent(draft.company!.id, draft.agentId) });
  };
  const shown = HARNESSES.filter((h) => mode === "key" || h.login);
  const any = modelConnected || Object.values(connected).some(Boolean);
  const environmentState = () => {
    if (containers.isPending) return <p className="text-xs text-ink-3 flex items-center gap-1.5"><Spinner />Checking this organization's container…</p>;
    if (containers.error) return <Notice tone="warning" title="Couldn't check the agent container" action={<Button size="sm" variant="ghost" onClick={() => void containers.refetch()}>Try again</Button>}>The sign-in runs inside this organization's container, and the device didn't answer whether it is ready.</Notice>;
    const s = containers.data;
    if (!s) return null;
    if (s.state !== "ready") return <Notice tone="warning" title="Agent containers aren't set up yet" action={s.canManage ? <Button size="sm" onClick={() => modals.selectSection("agent-containers")}>Set up</Button> : undefined}>A Claude, Codex or Grok sign-in runs inside this organization's container. You can connect a model later, but its agent can't execute until containers are set up.</Notice>;
    if (!environment) return <Notice tone="info" title="This organization's container is still being set up" action={s.canManage ? <Button size="sm" loading={makeEnvironment.isPending} onClick={() => makeEnvironment.mutate("environments")}>Create it now</Button> : undefined}>The account sign-in can start as soon as it exists. An API key can be saved now.</Notice>;
    if (!environment.ok) return <Notice tone="warning" title="This organization's container isn't healthy">The engine reports that its container environment isn't running. An administrator can repair it in Settings → Agent containers.</Notice>;
    return null;
  };
  return (
    <Screen title="Connect a model" subtitle="Your agents work with your subscription or an API key." onBack={() => patch({ step: "ceo" })} next={{ label: any ? "Next" : "Skip for now", onClick: () => patch({ step: "task", modelSkipped: !any }), variant: any ? "primary" : "secondary" }} avatar={draft.ceoName}>
      <div role="radiogroup" aria-label="Model" className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {shown.map((h) => (
          <button key={h.adapter} type="button" role="radio" aria-checked={picked === h.adapter} onClick={() => choose(h.adapter)} className={cn("transition-control flex flex-col items-center gap-1.5 rounded-xl border p-4 text-center", picked === h.adapter ? "border-accent/60 bg-accent-soft" : "border-line hover:border-line-strong")}>
            <BrandMark id={h.adapter} name={PROVIDER[h.adapter]} size={22} />
            <span className="font-medium text-sm">{PROVIDER[h.adapter]}</span>
            <span className="text-xs text-ink-3">{mode === "account" ? "Subscription" : "API key"}</span>
            {(connected[h.adapter] || (modelConnected && agent.data?.adapterType === h.adapter)) && <Chip tone="good"><Check className="h-3 w-3" />Connected</Chip>}
          </button>
        ))}
      </div>
      <button type="button" onClick={switchMode} className="self-start text-compact text-ink-3 underline underline-offset-2 hover:text-ink transition-control">{mode === "account" ? "Use API key instead" : "Use your subscription instead"}</button>
      {environmentState()}
      {makeEnvironment.data && <p className="text-xs text-ink-3">Environment setup was requested. This page updates on its own.</p>}
      {makeEnvironment.error && <p role="alert" className="text-compact text-critical">{errorText(makeEnvironment.error)}</p>}
      {!any && !flow && <Notice tone="info" title="You can connect a model later">Without one, {draft.ceoName || "the agent"} can't execute tasks. If you skip this step, the organization will show what is still missing.</Notice>}
      {flow?.kind === "login" && environmentId && <InlineSignIn key={flow.adapter} companyId={draft.company!.id} org={draft.company!.name} adapter={flow.adapter as LoginAdapter} environmentId={environmentId} onDone={() => connectedNow(flow.adapter)} />}
      {flow?.kind === "key" && <ApiKeyModal companyId={draft.company!.id} org={draft.company!.name} adapter={flow.adapter} onClose={() => setFlow(null)} onDone={() => connectedNow(flow.adapter)} />}
      {warning && <Notice tone="warning">{warning}</Notice>}
      {error && <p role="alert" className="text-compact text-critical">{error}</p>}
    </Screen>
  );
}



function TaskStep({ c }: { c: Ctx }) {
  const { draft, patch, setError, error, busy, setBusy, goToOrg, modals } = c;
  const agent = useQuery({ queryKey: qk.agent(draft.company!.id, draft.agentId ?? ""), queryFn: () => engine.agents.get(draft.agentId!), enabled: !!draft.agentId, retry: false });
  const readiness = useAgentReadiness(draft.company!.id, agent.data ? [agent.data] : []);
  const current = draft.agentId ? readiness.get(draft.agentId) : undefined;
  const model = current?.checks.find((check) => check.id === "model");
  const environment = current?.checks.find((check) => check.id === "environment");
  // "Skip for now" is respected, but never mistaken for readiness: the task is created and waits.
  const skipped = draft.modelSkipped === true && model?.state !== "ok";
  const text = draft.firstTask ?? "";
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
  const readinessNotice = () => {
    if (agent.isPending) return <p className="text-xs text-ink-3 flex items-center gap-1.5"><Spinner />Checking whether {draft.ceoName || "the agent"} can run…</p>;
    // The skip is something the person just chose, so it is shown even if the readiness read itself failed.
    if (skipped) return <Notice tone="warning" title="No model is connected" action={<Button size="sm" onClick={() => patch({ step: "model" })}>Connect a model</Button>}>{draft.ceoName || "This agent"} can't execute tasks yet. The task is saved and waits until a model account or API key is connected.</Notice>;
    if (agent.error) return <Notice tone="info" title="Couldn't check whether it can run">The task can still be created. {errorText(agent.error)}</Notice>;
    if (model?.state === "blocked") return <Notice tone="warning" title="No model is available to this agent" action={<Button size="sm" onClick={() => patch({ step: "model" })}>Connect a model</Button>}>{model.detail} The task is saved and waits.</Notice>;
    if (environment?.state === "blocked") return <Notice tone="warning" title="The agent can't run in a container yet" action={<Button size="sm" onClick={() => modals.selectSection("agent-containers")}>Open Agent containers</Button>}>{environment.detail} The task is saved and waits.</Notice>;
    if (current?.state === "unknown") return <Notice tone="info" title="Readiness couldn't be fully checked">{current.summary} The task can still be created.</Notice>;
    if (current?.state === "ready") return <Notice tone="good" title="Ready to run">{current.summary}</Notice>;
    return null;
  };
  return (
    <Screen title={`What should ${draft.ceoName || "your CEO"} do first?`} subtitle="The first line is the task's title; the rest is the brief. It waits for the agent until its model and container are ready." onBack={() => patch({ step: "model" })} next={{ label: "Create task", onClick: () => void launch(true), disabled: !text.trim(), reason: "Write the first task to create it, or choose Skip for now.", loading: busy }} secondary={{ label: "Skip for now", onClick: () => void launch(false) }} avatar={draft.ceoName}>
      {readinessNotice()}
      <Field label="First task" htmlFor="first-task">
        <textarea id="first-task" autoFocus rows={5} value={text} onChange={(e) => patch({ firstTask: e.target.value })} className={textareaClass} placeholder={"e.g. Plan the first week\nPropose a plan and the team we need."} />
      </Field>
      {error && <p role="alert" className="text-compact text-critical">{error}</p>}
    </Screen>
  );
}



function Screen({ title, subtitle, children, onBack, next, secondary, avatar }: { title: string; subtitle?: string; children: ReactNode; onBack: (() => void) | null; next: { label: string; onClick: () => void; disabled?: boolean; /** Shown under the buttons and as the disabled button's tooltip while it is disabled. */ reason?: string; loading?: boolean; variant?: "primary" | "secondary" }; secondary?: { label: string; onClick: () => void }; avatar?: string }) {
  return (
    <div className="mt-14 flex flex-col gap-5">
      {avatar ? <div className="flex flex-col items-center gap-2"><Avatar name={avatar} hue={hue(avatar)} size={64} /><span className="text-compact font-medium">{avatar}</span></div> : null}
      <div className="text-center">
        <h2 className="text-hero-md font-semibold text-balance">{title}</h2>
        {subtitle && <p className="text-body text-ink-3 mt-2 text-pretty">{subtitle}</p>}
      </div>
      <div className="flex flex-col gap-4">{children}</div>
      <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
        {onBack ? <Button variant="ghost" disabled={next.loading} onClick={onBack}><ArrowLeft className="h-4 w-4" />Back</Button> : <span />}
        <div className="flex items-center gap-2">
          {secondary && <Button variant="ghost" disabled={next.loading} onClick={secondary.onClick}>{secondary.label}</Button>}
          <Button variant={next.variant ?? "primary"} onClick={next.onClick} disabled={next.disabled} disabledReason={next.reason} aria-describedby={next.disabled && next.reason ? "step-reason" : undefined} loading={next.loading}>{next.label}<ArrowRight className="h-4 w-4" /></Button>
        </div>
      </div>
      {next.disabled && next.reason && !next.loading && <p id="step-reason" role="status" className="text-compact text-ink-2 text-right text-pretty -mt-3">{next.reason}</p>}
    </div>
  );
}
