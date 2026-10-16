import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Bot, Cable, ExternalLink, Plus, Server, Trash2 } from "lucide-react";
import { BRAND_ICONS } from "../../data/brandIcons.ts";
import { connectApi, type CatalogEntry, type Connection } from "../../data/engine/connectApi.ts";
import { qk } from "../../data/engine/keys.ts";
import { ago } from "../../data/engine/map.ts";
import { errorText } from "../../data/engine/queries.ts";
import { httpUrl } from "../../lib/safeUrl.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Card, Chip, EmptyState, Field, Input, Notice, PageFrame, PageHeader, SectionTitle, Select, Spinner, Status, Toggle } from "../../ui/primitives.tsx";

const KEY = ["connect", "connections"] as const;
const pidOf = (c: Connection) => (c.builtin ? c.id : `x:${c.id}`);

function Logo({ c }: { c: Connection }) {
  const b = BRAND_ICONS[c.catalog];
  return (
    <span className="h-8 w-8 rounded-lg bg-surface-2 flex items-center justify-center text-ink-2 shrink-0">
      {b ? <svg viewBox="0 0 24 24" width={18} height={18} fill="currentColor" role="img" aria-label={b.title}><path d={b.path} /></svg> : c.entry.kind === "hosted" ? <Bot className="h-4 w-4" aria-hidden /> : <Server className="h-4 w-4" aria-hidden />}
    </span>
  );
}

/** Live Connectors: every model service Pin and the agents can use (docs/CONNECTORS.md). Keys are write-only. */
export function LiveConnections() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: connectApi.connections, retry: 1 });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: KEY });
    void qc.invalidateQueries({ queryKey: qk.connectors });
  };
  const can = q.data?.canManage === true;
  const edit = q.data?.connections.find((c) => c.id === editing) ?? null;
  return (
    <PageFrame width="6xl">
      <PageHeader
        title="Connectors"
        subtitle="The AI services Pin and your agents can use: hosted providers with a key, and models you run yourself. Keys are kept in this device's vault and are never shown again."
        actions={can ? <Button variant="primary" onClick={() => setAdding(true)}><Plus className="h-4 w-4" />Add a connection</Button> : undefined}
      />
      {q.isPending && <div className="py-10 flex justify-center"><Spinner /></div>}
      {q.error && <p role="alert" className="text-compact text-critical mb-3">{errorText(q.error)}</p>}
      {q.data && (
        <>
          <Card className="divide-y divide-line">
            {q.data.connections.length === 0 && <EmptyState icon={<Cable className="h-5 w-5" />} title="No connectors" body="Add a connection to get started." />}
            {q.data.connections.map((c) => <Row key={c.id} c={c} can={can} onEdit={() => setEditing(c.id)} onChanged={refresh} />)}
          </Card>
          {!can && <p className="text-xs text-ink-3 mt-3">Only Proxmox administrators can add, test or change connections. You can see which are set up.</p>}
          <Fallbacks connections={q.data.connections} order={q.data.fallbacks} can={can} onChanged={refresh} />
          <Usage />
        </>
      )}
      {adding && <AddModal onClose={() => setAdding(false)} onDone={() => { setAdding(false); refresh(); }} />}
      {edit && <EditModal c={edit} onClose={() => setEditing(null)} onChanged={refresh} />}
    </PageFrame>
  );
}

function Row({ c, can, onEdit, onChanged }: { c: Connection; can: boolean; onEdit: () => void; onChanged: () => void }) {
  const [key, setKey] = useState("");
  const [setting, setSetting] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const test = useMutation({
    mutationFn: () => connectApi.testConnection(c.id),
    onSuccess: ({ connection: r }) => { setNote({ ok: r.ok !== false, text: r.ok === false ? r.error ?? "It didn't work." : r.modelCount !== undefined ? `Works. ${r.modelCount} model${r.modelCount === 1 ? "" : "s"} available${r.latencyMs ? ` (${r.latencyMs} ms)` : ""}.` : "Works." }); onChanged(); },
    onError: (e) => setNote({ ok: false, text: errorText(e) }),
  });
  const save = useMutation({
    mutationFn: () => connectApi.setConnectionKey(c.id, key.trim()),
    onSuccess: () => { setKey(""); setSetting(false); setNote(null); onChanged(); },
    onError: (e) => setNote({ ok: false, text: errorText(e) }),
    onSettled: () => setKey(""),
  });
  const keyed = c.entry.keyRequired || c.builtin;
  const status = !c.configured ? <Status kind="off" label="Not set up" /> : !c.enabled ? <Status kind="paused" label="Switched off" /> : c.ok === false ? <Status kind="warning" label="Needs attention" /> : <Status kind="good" label="Connected" />;
  return (
    <div className="px-5 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <Logo c={c} />
        <div className="flex-1 min-w-[180px]">
          <div className="font-medium flex items-center gap-2">{c.label}{c.pin && c.configured && c.enabled && <Chip>Pin</Chip>}{c.orgs.length > 0 && <Chip>{c.orgs.length} org{c.orgs.length === 1 ? "" : "s"}</Chip>}</div>
          <div className="text-xs text-ink-3">
            {c.baseUrl ? <><span className="font-mono">{c.baseUrl}</span> · </> : null}
            {c.last4 ? <>Key ending in <span className="font-mono">{c.last4}</span></> : keyed ? "No key yet" : "No key needed"}
            {c.model ? <> · default <span className="font-mono">{c.model}</span></> : null}
            {c.testedAt ? ` · tested ${ago(new Date(c.testedAt))}${c.ok === false ? ", failed" : ""}` : ""}
          </div>
        </div>
        {status}
        {can && (
          <div className="flex gap-2">
            {keyed && <Button size="sm" onClick={() => { setSetting(!setting); setNote(null); }}>{c.last4 ? "Replace key" : "Set key"}</Button>}
            {c.configured && <Button size="sm" variant="ghost" loading={test.isPending} onClick={() => test.mutate()}>Test</Button>}
            <Button size="sm" variant="ghost" onClick={onEdit}>Settings</Button>
          </div>
        )}
      </div>
      {setting && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Input type="password" autoComplete="off" spellCheck={false} aria-label={`${c.label} key`} value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === "Enter" && key.trim() && save.mutate()} placeholder="Paste the key" className="h-9 text-sm font-mono flex-1 min-w-[220px]" autoFocus />
          <Button size="sm" variant="primary" loading={save.isPending} disabled={!key.trim()} onClick={() => save.mutate()}>Save</Button>
        </div>
      )}
      {setting && <p className="text-xs text-ink-3 mt-1.5">Stored in the device's vault. It is never shown again; only its last four characters are.</p>}
      {!note && c.configured && c.ok === false && c.error && <p className="text-compact text-critical mt-2">{c.error}</p>}
      {note && <p className={`text-compact mt-2 ${note.ok ? "text-good" : "text-critical"}`} role="status">{note.text}</p>}
    </div>
  );
}

function AddModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const cat = useQuery({ queryKey: ["connect", "catalog"], queryFn: connectApi.catalog });
  const [pick, setPick] = useState<CatalogEntry | null>(null);
  const [label, setLabel] = useState("");
  const [base, setBase] = useState("");
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: () => connectApi.addConnection({ catalog: pick!.id, ...(label.trim() ? { label: label.trim() } : {}), ...(pick!.baseEditable ? { baseUrl: base.trim() } : {}), ...(key.trim() ? { apiKey: key.trim() } : {}) }),
    onSuccess: onDone,
    onError: (e) => setError(errorText(e)),
    onSettled: () => setKey(""),
  });
  const groups: [string, CatalogEntry[]][] = [
    ["Models you run yourself", (cat.data?.catalog ?? []).filter((c) => c.kind === "local" || c.kind === "custom")],
    ["Hosted providers", (cat.data?.catalog ?? []).filter((c) => c.kind === "hosted" && !c.builtin)],
  ];
  const keysUrl = httpUrl(pick?.keysUrl);
  return (
    <Modal size="md" icon={<Cable className="h-5 w-5" />} title={pick ? `Add ${pick.label}` : "Add a connection"} subtitle={pick ? undefined : "Pick a provider. Anthropic, OpenAI, Gemini and OpenRouter are in the list already; set their keys there."} onClose={onClose}
      footer={pick ? <><Button variant="ghost" onClick={() => { setPick(null); setError(null); }}>Back</Button><Button variant="primary" loading={add.isPending} disabled={(pick.baseEditable && !base.trim()) || (pick.keyRequired && !key.trim())} onClick={() => add.mutate()}>Add connection</Button></> : <Button variant="ghost" onClick={onClose}>Cancel</Button>}>
      {!pick && (
        <div className="space-y-5">
          {cat.isPending && <Spinner />}
          {groups.map(([title, list]) => list.length > 0 && (
            <div key={title}>
              <div className="text-compact font-medium mb-2">{title}</div>
              <div className="grid grid-cols-2 gap-2">
                {list.map((c) => (
                  <button key={c.id} type="button" onClick={() => { setPick(c); setBase(c.base); setLabel(""); setKey(""); setError(null); }} className="text-left rounded-lg border border-line hover:border-line-strong hover:bg-surface-2 px-3 py-2.5 transition-control">
                    <div className="text-sm font-medium">{c.label}</div>
                    <div className="text-xs text-ink-3">{c.kind === "hosted" ? "Needs an API key" : c.keyRequired ? "Needs a key" : "Usually no key"}</div>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {pick && (
        <div className="space-y-4">
          {pick.note && <p className="text-compact text-ink-2">{pick.note}</p>}
          <Field label="Name" hint="Shown in lists. Optional."><Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} placeholder={pick.label} /></Field>
          {pick.baseEditable && <Field label="Address" hint="Plain http is only for machines on your own network."><Input value={base} onChange={(e) => setBase(e.target.value)} className="font-mono" placeholder="http://192.168.1.20:11434/v1" autoFocus /></Field>}
          {(pick.keyRequired || pick.kind !== "hosted") && (
            <Field label={pick.keyRequired ? "API key" : "API key (only if the server asks for one)"} hint={keysUrl ? <a href={keysUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent">Get a key<ExternalLink className="h-3 w-3" aria-hidden /></a> : "Stored in the device's vault; never shown again."}>
              <Input type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} className="font-mono" />
            </Field>
          )}
          {error && <p role="alert" className="text-compact text-critical">{error}</p>}
        </div>
      )}
    </Modal>
  );
}

function EditModal({ c, onClose, onChanged }: { c: Connection; onClose: () => void; onChanged: () => void }) {
  const overview = useQuery({ queryKey: ["connect", "overview"], queryFn: connectApi.overview });
  const models = useQuery({ queryKey: ["connect", "models", c.id], queryFn: () => connectApi.connectionModels(c.id), enabled: c.configured, retry: 0 });
  const [error, setError] = useState<string | null>(null);
  const [priceIn, setPriceIn] = useState(c.price ? String(c.price.inPerM) : "");
  const [priceOut, setPriceOut] = useState(c.price ? String(c.price.outPerM) : "");
  const [label, setLabel] = useState(c.label);
  const [base, setBase] = useState(c.baseUrl ?? "");
  const [confirm, setConfirm] = useState(false);
  const patch = useMutation({ mutationFn: (p: Record<string, unknown>) => connectApi.updateConnection(c.id, p), onSuccess: onChanged, onError: (e) => setError(errorText(e)) });
  const remove = useMutation({ mutationFn: () => connectApi.removeConnection(c.id), onSuccess: () => { onChanged(); onClose(); }, onError: (e) => setError(errorText(e)) });
  const orgs = overview.data?.orgs ?? [];
  const priced = priceIn !== "" && priceOut !== "";
  const toggleOrg = (id: string) => patch.mutate({ orgs: c.orgs.includes(id) ? c.orgs.filter((x) => x !== id) : [...c.orgs, id] });
  return (
    <Modal size="md" icon={<Logo c={c} />} title={c.label} subtitle="Who may use it, its default model and what it costs." onClose={onClose}
      footer={confirm ? <><Button variant="ghost" onClick={() => setConfirm(false)}>Keep it</Button><Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}><Trash2 className="h-4 w-4" />Remove {c.label}</Button></> : <><Button variant="danger" onClick={() => setConfirm(true)}><Trash2 className="h-4 w-4" />{c.builtin ? "Remove key" : "Remove"}</Button><Button variant="primary" onClick={onClose}>Done</Button></>}>
      <div className="space-y-5">
        {confirm && <Notice tone="warning" title={`Remove ${c.label}?`}>{c.builtin ? "Its key is deleted from the vault." : "It and its key are deleted."} Pin falls back to another connection if one is set.</Notice>}
        <div className="flex items-start gap-3"><Toggle checked={c.enabled} label="Switched on" onChange={(enabled) => patch.mutate({ enabled })} /><div><div className="text-sm">Switched on</div><p className="text-xs text-ink-3">Off keeps the key but nothing uses it.</p></div></div>
        <div className="flex items-start gap-3"><Toggle checked={c.pin} label="Pin may use it" onChange={(pin) => patch.mutate({ pin })} /><div><div className="text-sm">Pin may use it</div><p className="text-xs text-ink-3">Appears in Pin's settings and can be a fallback.</p></div></div>
        {!c.builtin && (
          <Field label="Name"><div className="flex gap-2"><Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} /><Button size="sm" onClick={() => patch.mutate({ label })} disabled={!label.trim() || label === c.label}>Save</Button></div></Field>
        )}
        {c.baseUrl !== undefined && (
          <Field label="Address"><div className="flex gap-2"><Input value={base} onChange={(e) => setBase(e.target.value)} className="font-mono" /><Button size="sm" onClick={() => patch.mutate({ baseUrl: base })} disabled={!base.trim() || base === c.baseUrl}>Save</Button></div></Field>
        )}
        <Field label="Default model" hint={models.error ? errorText(models.error) : "Used when this connection is a fallback and for tests. Read from the service."}>
          <Select value={c.model ?? ""} onChange={(e) => patch.mutate({ model: e.target.value || null })} disabled={!models.data}>
            <option value="">None</option>
            {c.model && !(models.data?.models ?? []).some((m) => m.id === c.model) && <option value={c.model}>{c.model}</option>}
            {(models.data?.models ?? []).map((m) => <option key={m.id} value={m.id}>{m.label || m.id}</option>)}
          </Select>
        </Field>
        <Field label="Price per million tokens (US dollars)" hint="Optional. With a price, Usage shows an estimated cost. Look it up on the provider's pricing page.">
          <div className="flex gap-2 items-center">
            <Input inputMode="decimal" aria-label="Input price" placeholder="In" value={priceIn} onChange={(e) => setPriceIn(e.target.value)} />
            <Input inputMode="decimal" aria-label="Output price" placeholder="Out" value={priceOut} onChange={(e) => setPriceOut(e.target.value)} />
            <Button size="sm" disabled={!(priced && Number.isFinite(Number(priceIn)) && Number.isFinite(Number(priceOut))) && !(priceIn === "" && priceOut === "" && c.price)} onClick={() => patch.mutate({ price: priced ? { inPerM: Number(priceIn), outPerM: Number(priceOut) } : null })}>Save</Button>
          </div>
        </Field>
        {orgs.length > 0 && (
          <div>
            <div className="text-compact font-medium mb-1">Organizations whose agents may use it</div>
            <p className="text-xs text-ink-3 mb-2">Sharing lets an organization's owners hand this key to its agents (Organization, Connectors). The key is passed on by this device and never shown.{c.entry.engine ? "" : " The engine can only hand Anthropic, OpenAI, OpenRouter and xAI keys to agents."}</p>
            <div className="space-y-2">{orgs.map((o) => <div key={o.id} className="flex items-center gap-3"><Toggle checked={c.orgs.includes(o.id)} label={`${o.name} may use ${c.label}`} onChange={() => toggleOrg(o.id)} /><span className="text-sm">{o.name}</span></div>)}</div>
          </div>
        )}
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}

function Fallbacks({ connections, order, can, onChanged }: { connections: Connection[]; order: string[]; can: boolean; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({ mutationFn: (o: string[]) => connectApi.setFallbacks(o), onSuccess: () => { setError(null); onChanged(); }, onError: (e) => setError(errorText(e)) });
  const byPid = new Map(connections.map((c) => [pidOf(c), c]));
  const chain = order.map((p) => byPid.get(p)).filter((c): c is Connection => !!c);
  const addable = connections.filter((c) => c.configured && c.enabled && c.pin && !order.includes(pidOf(c)));
  const move = (i: number, d: number) => {
    const o = [...order];
    [o[i], o[i + d]] = [o[i + d], o[i]];
    save.mutate(o);
  };
  return (
    <section className="mt-8">
      <SectionTitle>If Pin's provider can't answer</SectionTitle>
      <Card className="p-5">
        <p className="text-compact text-ink-2 mb-3">When the provider Pin uses is busy, out of quota or unreachable, Pin tries these in order, using each one's default model. This only happens before any answer has appeared.</p>
        {chain.length === 0 ? <p className="text-sm text-ink-3">No fallbacks. Pin shows the error instead.</p> : (
          <ol className="space-y-2">
            {chain.map((c, i) => (
              <li key={c.id} className="flex items-center gap-3 text-sm">
                <span className="w-5 text-ink-3 tabular-nums">{i + 1}</span><span className="flex-1">{c.label} <span className="font-mono text-xs text-ink-3">{c.model}</span></span>
                {can && <><Button size="sm" variant="ghost" aria-label={`Move ${c.label} up`} disabled={i === 0 || save.isPending} onClick={() => move(i, -1)}><ArrowUp className="h-4 w-4" /></Button><Button size="sm" variant="ghost" aria-label={`Move ${c.label} down`} disabled={i === chain.length - 1 || save.isPending} onClick={() => move(i, 1)}><ArrowDown className="h-4 w-4" /></Button><Button size="sm" variant="ghost" aria-label={`Remove ${c.label} from fallbacks`} onClick={() => save.mutate(order.filter((p) => p !== pidOf(c)))}><Trash2 className="h-4 w-4" /></Button></>}
              </li>
            ))}
          </ol>
        )}
        {can && addable.length > 0 && (
          <div className="mt-3 flex items-center gap-2">
            <Select aria-label="Add a fallback" value="" onChange={(e) => e.target.value && save.mutate([...order, e.target.value])} className="max-w-xs">
              <option value="">Add a fallback…</option>
              {addable.map((c) => <option key={c.id} value={pidOf(c)} disabled={!c.model}>{c.label}{c.model ? "" : " (set a default model first)"}</option>)}
            </Select>
          </div>
        )}
        {error && <p role="alert" className="text-compact text-critical mt-2">{error}</p>}
      </Card>
    </section>
  );
}

const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

function Usage(): ReactNode {
  const q = useQuery({ queryKey: ["connect", "usage"], queryFn: () => connectApi.usage(30), retry: 1 });
  return (
    <section className="mt-8">
      <SectionTitle>Usage, last 30 days</SectionTitle>
      <Card className="overflow-x-auto">
        {q.isPending && <p className="px-5 py-4 text-sm text-ink-3">Loading…</p>}
        {q.data && q.data.byConnection.length === 0 && <p className="px-5 py-4 text-sm text-ink-3">Nothing yet. Pin's chats show here as tokens, and as a cost for connections with a price.</p>}
        {q.data && q.data.byConnection.length > 0 && (
          <table className="w-full text-sm min-w-[520px]">
            <thead><tr className="text-xs text-ink-3 border-b border-line"><th className="text-left font-normal px-5 h-10">Connection</th><th className="text-right font-normal px-3">Chats</th><th className="text-right font-normal px-3">Tokens in</th><th className="text-right font-normal px-3">Tokens out</th><th className="text-right font-normal px-5">Estimated cost</th></tr></thead>
            <tbody>
              {q.data.byConnection.map((b) => (
                <tr key={b.id} className="border-b border-line last:border-0 tabular-nums">
                  <td className="px-5 py-3">{b.label}</td><td className="text-right px-3">{b.calls}</td><td className="text-right px-3">{fmt(b.tokensIn)}</td><td className="text-right px-3">{fmt(b.tokensOut)}</td>
                  <td className="text-right px-5">{b.costUsd === null ? <span className="text-ink-3">No price set</span> : `$${b.costUsd.toFixed(b.costUsd < 1 ? 4 : 2)}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <p className="text-xs text-ink-3 mt-2">Counts come from what each provider reports; no text is kept. Agents' own spending is on each organization's Costs page.</p>
    </section>
  );
}
