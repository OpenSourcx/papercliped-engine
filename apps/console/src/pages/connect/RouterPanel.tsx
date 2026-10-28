import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, Trash2 } from "lucide-react";
import { connectApi, type RouterKey } from "../../data/engine/connectApi.ts";
import { ago } from "../../data/engine/map.ts";
import { errorText } from "../../data/engine/queries.ts";
import { ConfirmModal } from "../../ui/Confirm.tsx";
import { Button, Card, Input, Notice, SectionTitle } from "../../ui/primitives.tsx";
import { copyText } from "../pinview/TileView.tsx";

const KEY = ["connect", "router"] as const;

/**
 * The Router on the Connectors page (docs/ROUTER.md): one local address that speaks OpenAI's and Anthropic's formats in
 * front of every connection above, with the fallback chain. Administrators make a key per client here; a key is shown
 * once, when it is made.
 */
export function RouterPanel() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: connectApi.router, retry: 1 });
  const [name, setName] = useState("");
  const [made, setMade] = useState<{ name: string; key: string } | null>(null);
  const [revoking, setRevoking] = useState<RouterKey | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: KEY });
  const make = useMutation({ mutationFn: (n: string) => connectApi.makeRouterKey(n), onSuccess: (r) => { setMade({ name: r.view.name, key: r.key }); setName(""); refresh(); } });
  const revoke = useMutation({ mutationFn: (id: string) => connectApi.revokeRouterKey(id), onSuccess: () => { setRevoking(null); refresh(); } });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) make.mutate(name.trim());
  };
  const base = q.data?.listen ? `http://${q.data.listen}` : null;

  return (
    <section className="mt-8">
      <SectionTitle>Router</SectionTitle>
      <Card className="p-5 space-y-4">
        <p className="text-compact text-ink-2 text-pretty">
          One address on this device for agents and scripts. It speaks both OpenAI's and Anthropic's formats, sends each request to the connections above, translates when the formats differ, and follows the fallback chain when a service is busy or out of credit. Clients get a Router key; provider keys stay in the vault.
        </p>
        {q.error && <p role="alert" className="text-compact text-critical">{errorText(q.error)}</p>}
        {q.data && !base && <Notice tone="warning" title="The Router is switched off">Set EPC_ROUTER_LISTEN in /etc/default/epaperclip and restart ePaperclip to turn it on.</Notice>}
        {q.data && base && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-ink-3">Address</span>
              <span className="font-mono text-ink">{base}</span>
              <Button size="sm" variant="ghost" aria-label="Copy the Router's address" onClick={() => copyText(base)}><Copy className="h-4 w-4" /></Button>
            </div>
            <p className="text-xs text-ink-3">Reachable from this host only for now. Models a client can name: {q.data.models.map((m) => m.id).join(", ")}.</p>
            <pre className="bg-code rounded-lg p-3 font-mono text-xs text-ink-2 overflow-x-auto">{`# Claude Code
ANTHROPIC_BASE_URL=${base}
ANTHROPIC_AUTH_TOKEN=<a Router key>

# OpenAI Chat Completions clients
OPENAI_BASE_URL=${base}/v1
OPENAI_API_KEY=<a Router key>`}</pre>
          </div>
        )}
        {q.data && q.data.resting.length > 0 && (
          <Notice tone="warning" title="Resting after failures">
            {q.data.resting.map((r) => r.pid.replace(/^x:/, "")).join(", ")}: skipped until {new Date(Math.max(...q.data.resting.map((r) => r.openUntil))).toLocaleTimeString()}, unless nothing else can answer.
          </Notice>
        )}

        {made && (
          <Notice tone="good" title={`Key for ${made.name}`} action={<Button size="sm" variant="secondary" onClick={() => copyText(made.key)}><Copy className="h-4 w-4" />Copy key</Button>}>
            <span className="font-mono break-all text-ink">{made.key}</span>
            <span className="block mt-1">Copy it now. It isn't shown again; if it's lost, revoke it and make another.</span>
          </Notice>
        )}

        <div>
          <h3 className="text-compact font-semibold text-ink mb-2">Keys</h3>
          {q.data && q.data.keys.length === 0 && <p className="text-sm text-ink-3">No keys yet. Make one for each agent or script, so each can be revoked on its own.</p>}
          {q.data && q.data.keys.length > 0 && (
            <ul className="divide-y divide-line">
              {q.data.keys.map((k) => (
                <li key={k.id} className="flex items-center gap-3 py-2 text-sm">
                  <KeyRound className="h-4 w-4 text-ink-3 shrink-0" aria-hidden />
                  <span className="flex-1 min-w-0 truncate">{k.name} <span className="font-mono text-xs text-ink-3">…{k.last4}</span></span>
                  <span className="text-xs text-ink-3 hidden sm:inline">{k.lastUsedAt ? `Used ${ago(new Date(k.lastUsedAt))}` : "Never used"}</span>
                  <Button size="sm" variant="ghost" aria-label={`Revoke ${k.name}`} onClick={() => setRevoking(k)}><Trash2 className="h-4 w-4" /></Button>
                </li>
              ))}
            </ul>
          )}
          <form onSubmit={submit} className="mt-3 flex flex-col sm:flex-row gap-2">
            <Input aria-label="Name for the new key" placeholder="Who will use it, such as Acme's CEO agent" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} className="sm:max-w-sm" />
            <Button type="submit" variant="secondary" loading={make.isPending} disabled={!name.trim()}>Make a key</Button>
          </form>
          {make.error && <p role="alert" className="text-compact text-critical mt-2">{errorText(make.error)}</p>}
        </div>
      </Card>
      {revoking && (
        <ConfirmModal
          title={`Revoke ${revoking.name}?`}
          body="Anything using this key stops getting answers from the Router right away."
          label="Revoke key"
          danger
          busy={revoke.isPending}
          onConfirm={() => revoke.mutate(revoking.id)}
          onClose={() => setRevoking(null)}
        />
      )}
    </section>
  );
}
