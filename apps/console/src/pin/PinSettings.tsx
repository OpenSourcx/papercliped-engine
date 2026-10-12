import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Bot, Check, Cpu, Sparkles } from "lucide-react";
import { cn } from "../lib/storage.ts";
import { Button, Chip, Field, Notice, Select, Skeleton, Toggle } from "../ui/primitives.tsx";
import { isProvider, type ConnectorInfo, type ModelInfo, type PinSettings } from "./live.ts";
import type { PinSettingsSource } from "./settings.ts";

/**
 * Pin's settings: which provider it thinks with, which model, how much it may do on its own, and which connectors it
 * may use. Saved in one go with PUT /api/pin/settings (or in the browser for the demo).
 */
export function PinSettingsPanel({ source, onSaved }: { source: PinSettingsSource; onSaved?: (s: PinSettings) => void }) {
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState("");
  const [connectors, setConnectors] = useState<ConnectorInfo[]>([]);
  const [connectorsError, setConnectorsError] = useState<string | null>(null);
  const [saved, setSaved] = useState<PinSettings | null>(null);
  const [draft, setDraft] = useState<PinSettings | null>(null);
  const [models, setModels] = useState<{ provider: string; state: "loading" | "ready" | "error"; list: ModelInfo[]; error?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoadState("loading");
    source.load().then(
      (r) => {
        if (!alive) return;
        setConnectors(r.connectors);
        setConnectorsError(r.connectorsError ?? null);
        setSaved(r.settings);
        setDraft(r.settings);
        setLoadState("ready");
      },
      (e: Error) => {
        if (!alive) return;
        setLoadError(e.message);
        setLoadState("error");
      },
    );
    return () => {
      alive = false;
    };
  }, [source, attempt]);

  const providers = useMemo(() => connectors.filter(isProvider), [connectors]);
  const ready = providers.filter((p) => p.configured);
  const tools = useMemo(() => connectors.filter((c) => !isProvider(c)), [connectors]);
  const provider = draft?.provider ?? null;

  // Models follow the chosen provider; a slow answer for an earlier choice never overwrites a newer one.
  useEffect(() => {
    if (!provider) return setModels(null);
    let alive = true;
    setModels({ provider, state: "loading", list: [] });
    source.models(provider).then(
      (list) => alive && setModels({ provider, state: "ready", list }),
      (e: Error) => alive && setModels({ provider, state: "error", list: [], error: e.message }),
    );
    return () => {
      alive = false;
    };
  }, [provider, source]);

  if (loadState === "loading") {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Loading Pin's settings">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }
  if (loadState === "error" || !draft || !saved) {
    return (
      <Notice tone="critical" title="Pin's settings didn't load" action={<Button size="sm" onClick={() => setAttempt((n) => n + 1)}>Try again</Button>}>
        {loadError || "The host service didn't answer."}
      </Notice>
    );
  }

  const dirty = JSON.stringify(normalize(draft)) !== JSON.stringify(normalize(saved));
  const set = (patch: Partial<PinSettings>) => {
    setResult(null);
    setDraft((d) => (d ? { ...d, ...patch } : d));
  };
  const modelList = models?.provider === provider ? models.list : [];
  const modelMissing = !!provider && models?.state === "ready" && !!draft.model && !modelList.some((m) => m.id === draft.model);

  const save = async () => {
    setSaving(true);
    setResult(null);
    try {
      const s = await source.save(normalize(draft));
      setSaved(s);
      setDraft(s);
      setResult({ ok: true, text: "Saved. Pin uses these from its next message." });
      onSaved?.(s);
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message || "Couldn't save. Try again." });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-8">
      <Section title="Model" body="The provider Pin thinks with and the model it uses. Keys stay on this device; Pin never sees them.">
        {connectorsError ? (
          <Notice tone="warning" title="Couldn't list the model providers" action={<Button size="sm" onClick={() => setAttempt((n) => n + 1)}>Try again</Button>}>
            <span className="block">{connectorsError}</span>
            <span className="block">Pin's mode below can still be changed.</span>
          </Notice>
        ) : ready.length === 0 ? (
          <Notice tone="warning" title="Pin needs a model provider" action={<Link to="?settings=connectors" className="transition-control inline-flex h-8 items-center rounded-md bg-surface-2 border border-line px-3 text-compact font-medium hover:bg-surface-3">Add a model provider</Link>}>
            Add a provider's key in Connectors, then pick it here. Until then Pin answers from its built-in demo replies.
          </Notice>
        ) : (
          <div role="radiogroup" aria-label="Model provider" className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {providers.map((p) => (
              <Choice key={p.id} selected={provider === p.id} disabled={!p.configured} onSelect={() => set({ provider: p.id, model: provider === p.id ? draft.model : null })} icon={<Cpu className="h-4 w-4" />} title={p.name}>
                {p.configured ? (
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    {p.last4 && <span className="font-mono">Key ending {p.last4}</span>}
                    {p.ok === false ? <Chip tone="critical">Test failed</Chip> : p.ok ? <Chip tone="good">Working</Chip> : !p.last4 ? <span>Ready</span> : null}
                  </span>
                ) : (
                  "Not set up yet"
                )}
              </Choice>
            ))}
          </div>
        )}
        {provider && (
          <Field label="Model" htmlFor="pin-model" className="mt-4 max-w-md" error={models?.state === "error" ? `Couldn't list this provider's models: ${models.error}` : modelMissing ? "This model isn't available with the current key. Pick another." : undefined} hint={models?.state === "ready" && modelList.length === 0 ? "This key can't use any models yet." : undefined}>
            {models?.state === "loading" || !models ? (
              <Skeleton className="h-10 w-full" />
            ) : (
              <Select id="pin-model" value={draft.model ?? ""} onChange={(e) => set({ model: e.target.value || null })} disabled={modelList.length === 0}>
                <option value="">Choose a model</option>
                {modelList.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                {modelMissing && <option value={draft.model!}>{draft.model}</option>}
              </Select>
            )}
          </Field>
        )}
      </Section>

      <Section title="Mode" body="How much Pin does on its own. You can switch any time.">
        <div role="radiogroup" aria-label="Mode" className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <Choice selected={draft.mode === "assistant"} onSelect={() => set({ mode: "assistant" })} icon={<Sparkles className="h-4 w-4" />} title="Assistant">Watches and suggests. Asks before it changes anything.</Choice>
          <Choice selected={draft.mode === "agent"} onSelect={() => set({ mode: "agent" })} icon={<Bot className="h-4 w-4" />} title="Agent">Acts on its own within what it may do, and tells you after.</Choice>
        </div>
      </Section>

      <Section title="Connectors Pin may use" body="Only what's switched on here. Organizations choose their own connectors separately.">
        {connectorsError ? (
          <p className="text-compact text-ink-3">Connectors show here once the list loads.</p>
        ) : tools.length === 0 ? (
          <p className="text-compact text-ink-3">No connectors yet. <Link to="?settings=connectors" className="text-accent hover:underline">Add one in Connectors</Link>.</p>
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line">
            {tools.map((c) => (
              <li key={c.id} className="flex items-center gap-3 px-3.5 py-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">{c.name}</div>
                  <div className="text-xs text-ink-3">{c.configured ? (draft.connectors.includes(c.id) ? "Pin may use this" : "Off for Pin") : <>Not set up. <Link to="?settings=connectors" className="text-accent hover:underline">Set up in Connectors</Link></>}</div>
                </div>
                <Toggle checked={c.configured && draft.connectors.includes(c.id)} disabled={!c.configured} label={`Let Pin use ${c.name}`} onChange={(on) => set({ connectors: on ? [...draft.connectors, c.id] : draft.connectors.filter((x) => x !== c.id) })} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <div className="flex flex-wrap items-center justify-end gap-3 border-t border-line pt-4">
        {result && <span role="status" className={cn("mr-auto inline-flex items-center gap-1.5 text-compact", result.ok ? "text-good" : "text-critical")}>{result.ok && <Check className="h-4 w-4" />}{result.text}</span>}
        <Button variant="ghost" disabled={!dirty || saving} onClick={() => { setDraft(saved); setResult(null); }}>Discard</Button>
        <Button variant="primary" disabled={!dirty} loading={saving} onClick={save}>Save settings</Button>
      </div>
    </div>
  );
}

const normalize = (s: PinSettings): PinSettings => ({ ...s, connectors: [...new Set(s.connectors)].sort() });

function Section({ title, body, children }: { title: string; body: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="text-body font-semibold">{title}</h3>
      <p className="text-compact text-ink-3 mt-0.5 mb-3 text-pretty">{body}</p>
      {children}
    </section>
  );
}

function Choice({ selected, disabled, onSelect, icon, title, children }: { selected: boolean; disabled?: boolean; onSelect: () => void; icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn("transition-control flex items-start gap-3 rounded-xl border p-3.5 text-left disabled:opacity-50", selected ? "border-accent/50 bg-accent-soft" : "border-line hover:border-line-strong hover:bg-surface-2/60")}
    >
      <span className={cn("mt-0.5 h-8 w-8 shrink-0 rounded-lg flex items-center justify-center", selected ? "bg-accent text-primary-ink" : "bg-surface-2 text-ink-2")}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-ink-3 mt-0.5">{children}</span>
      </span>
      <span aria-hidden className={cn("mt-1 h-4 w-4 shrink-0 rounded-full border-2 flex items-center justify-center transition-control", selected ? "border-accent" : "border-line-strong")}>
        <span className={cn("h-1.5 w-1.5 rounded-full bg-accent transition-transform duration-(--duration-base) ease-spring", selected ? "scale-100" : "scale-0")} />
      </span>
    </button>
  );
}
