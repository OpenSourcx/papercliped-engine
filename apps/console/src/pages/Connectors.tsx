import { useState, type ReactNode } from "react";
import { Bot, Cable, Code2, Mail, MessageSquare, Network } from "lucide-react";
import { BRAND_ICONS } from "../data/brandIcons.ts";
import { useEngine } from "../data/store.tsx";
import type { Connector } from "../data/types.ts";
import { Avatar, Button, Card, EmptyState, Input, PageHeader, Status, Toggle, PageFrame } from "../ui/primitives.tsx";
import { HostError, type ConnectorState } from "../data/engine/host.ts";
import { errorText, useConnectorAction, useConnectors } from "../data/engine/queries.ts";
import { ago } from "../data/engine/map.ts";
import { PinOrb } from "../pin/PinIsland.tsx";

const ICON: Record<Connector["kind"], ReactNode> = { model: <Bot className="h-4 w-4" />, code: <Code2 className="h-4 w-4" />, chat: <MessageSquare className="h-4 w-4" />, mail: <Mail className="h-4 w-4" />, storage: <Cable className="h-4 w-4" />, network: <Network className="h-4 w-4" /> };

function DemoConnectors() {
  const { data, setConnectorAccess } = useEngine();
  return (
    <PageFrame width="6xl">
      <PageHeader title="Connectors" subtitle="System-wide connections, set up once. For each one, choose who can use it: Pin, and any of your organizations. An org's agents only see the connectors granted to it." />
      <Card className="overflow-x-auto">
        <table className="w-full text-[14px] min-w-[640px]">
          <thead>
            <tr className="text-[12px] text-ink-3 border-b border-line">
              <th className="text-left font-normal px-5 h-11">Connector</th>
              <th className="font-normal px-3"><span className="inline-flex items-center gap-1.5"><PinOrb size={14} />Pin</span></th>
              {data.orgs.map((o) => (
                <th key={o.slug} className="font-normal px-3"><span className="inline-flex items-center gap-1.5"><Avatar name={o.name} hue={o.hue} size={16} />{o.name}</span></th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.connectors.map((c) => (
              <tr key={c.id} className="border-b border-line last:border-0">
                <td className="px-5 py-3.5">
                  <div className="flex items-center gap-3">
                    <span className="h-8 w-8 rounded-lg bg-surface-2 flex items-center justify-center text-ink-2">{BRAND_ICONS[c.id] ? <svg viewBox="0 0 24 24" width={18} height={18} fill="currentColor" role="img" aria-label={BRAND_ICONS[c.id].title}><path d={BRAND_ICONS[c.id].path} /></svg> : ICON[c.kind]}</span>
                    <div>
                      <div className="font-medium">{c.name}</div>
                      {c.status === "connected" ? <Status kind="good" label="Connected" /> : <Status kind="warning" label="Needs setup" />}
                    </div>
                  </div>
                </td>
                <td className="px-3 text-center"><span className="inline-flex"><Toggle label={`Pin can use ${c.name}`} checked={c.access.pin} disabled={c.status !== "connected"} onChange={(v) => setConnectorAccess(c.id, "pin", v)} /></span></td>
                {data.orgs.map((o) => (
                  <td key={o.slug} className="px-3 text-center"><span className="inline-flex"><Toggle label={`${o.name} can use ${c.name}`} checked={c.access.orgs.includes(o.slug)} disabled={c.status !== "connected"} onChange={(v) => setConnectorAccess(c.id, o.slug, v)} /></span></td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <p className="text-[12px] text-ink-3 mt-3">Credentials stay in the Vault. Agents and Pin receive short-lived, run-scoped access, never the key itself.</p>
    </PageFrame>
  );
}

export function Connectors() {
  return useEngine().live ? <LiveConnectors /> : <DemoConnectors />;
}

const KNOWN: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI", github: "GitHub", slack: "Slack", gmail: "Gmail", google: "Google", gemini: "Gemini", openrouter: "OpenRouter", mistral: "Mistral", groq: "Groq", xai: "xAI" };
const nameOf = (c: ConnectorState) => c.label || KNOWN[c.id] || c.id.replace(/[-_]/g, " ").replace(/^./, (x) => x.toUpperCase());
const KIND_ICON = (kind: string) => ICON[kind as Connector["kind"]] ?? <Cable className="h-4 w-4" />;

/** A 403 from the host service means only an administrator may change connectors; say so in its words. */
function actionErrorText(e: unknown): string {
  if (e instanceof HostError && e.status === 403) return `${e.message || "Only an administrator can change connectors"}. Ask someone with admin rights on this device.`;
  return errorText(e);
}

function ConnectorRow({ c, canManage }: { c: ConnectorState; canManage: boolean }) {
  const act = useConnectorAction();
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const name = nameOf(c);
  const busy = act.isPending;
  const save = () => {
    if (!key.trim() || busy) return;
    act.mutate({ id: c.id, kind: "set", apiKey: key.trim() }, { onSuccess: () => { setKey(""); setEditing(false); setResult(null); }, onSettled: () => setKey("") });
  };
  const test = () =>
    act.mutate({ id: c.id, kind: "test" }, {
      onSuccess: (r) => {
        const t = r as ConnectorState | null;
        setResult({ ok: t?.ok !== false, text: t?.ok === false ? t.error ?? "The provider refused the key." : "The key works." });
      },
      onError: (e) => setResult({ ok: false, text: actionErrorText(e) }),
    });
  return (
    <div className="px-5 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="h-8 w-8 rounded-lg bg-surface-2 flex items-center justify-center text-ink-2">{BRAND_ICONS[c.id] ? <svg viewBox="0 0 24 24" width={18} height={18} fill="currentColor" role="img" aria-label={BRAND_ICONS[c.id].title}><path d={BRAND_ICONS[c.id].path} /></svg> : KIND_ICON(c.kind)}</span>
        <div className="flex-1 min-w-[160px]">
          <div className="font-medium">{name}</div>
          <div className="text-[12px] text-ink-3">
            {c.configured ? <>Key ending in <span className="font-mono">{c.last4 ?? "••••"}</span>{c.updatedBy ? ` · set by ${c.updatedBy}` : ""}{c.testedAt ? ` · tested ${ago(c.testedAt)}${c.ok === false ? ", failed" : ""}` : ""}</> : "No key yet"}
          </div>
        </div>
        {c.configured ? (c.ok === false ? <Status kind="warning" label="Needs attention" /> : <Status kind="good" label="Connected" />) : <Status kind="off" label="Not set up" />}
        {canManage && <div className="flex gap-2">
          <Button size="sm" onClick={() => { setEditing(!editing); setResult(null); act.reset(); }} disabled={busy}>{c.configured ? "Replace key" : "Set key"}</Button>
          {c.configured && <Button size="sm" variant="ghost" onClick={test} disabled={busy}>Test</Button>}
          {c.configured && <Button size="sm" variant="ghost" onClick={() => act.mutate({ id: c.id, kind: "remove" }, { onSuccess: () => setResult(null) })} disabled={busy}>Remove</Button>}
        </div>}
      </div>
      {editing && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Input type="password" autoComplete="off" spellCheck={false} aria-label={`${name} key`} value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} placeholder="Paste the key" className="h-9 text-[14px] font-mono flex-1 min-w-[220px]" autoFocus />
          <Button size="sm" variant="primary" onClick={save} disabled={!key.trim() || busy}>Save</Button>
        </div>
      )}
      {editing && <p className="text-[12px] text-ink-3 mt-1.5">Stored in the device's vault. It is never shown again; only its last four characters are.</p>}
      {!result && c.configured && c.ok === false && c.error && <p className="text-[13px] text-critical mt-2">{c.error}</p>}
      {result && <p className={`text-[13px] mt-2 ${result.ok ? "text-good" : "text-critical"}`} role="status">{result.text}</p>}
      {act.isError && act.variables?.kind !== "test" && <p className="text-[13px] text-critical mt-2" role="alert">{actionErrorText(act.error)}</p>}
    </div>
  );
}

/** Live: the host service's connectors. Keys go in once and are never read back. */
function LiveConnectors() {
  const list = useConnectors();
  return (
    <PageFrame width="6xl">
      <PageHeader title="Connectors" subtitle="System-wide connections, set up once. Keys are kept in this device's vault; agents and Pin get short-lived, run-scoped access, never the key itself." />
      <Card className="divide-y divide-line">
        {list.isPending && <p className="px-5 py-6 text-[14px] text-ink-3" aria-busy="true">Loading connectors…</p>}
        {list.error && <p className="px-5 py-4 text-[14px] text-ink-2" role="alert">{errorText(list.error)}</p>}
        {list.data?.connectors.length === 0 && <EmptyState icon={<Cable className="h-5 w-5" />} title="No connectors" body="The host service doesn't offer any connectors yet." />}
        {(list.data?.connectors ?? []).map((c) => <ConnectorRow key={c.id} c={c} canManage={list.data?.canManage === true} />)}
      </Card>
      {list.data && !list.data.canManage && <p className="text-[12px] text-ink-3 mt-3">Only Proxmox administrators can add, test or remove keys. You can see which connectors are set up.</p>}
    </PageFrame>
  );
}
