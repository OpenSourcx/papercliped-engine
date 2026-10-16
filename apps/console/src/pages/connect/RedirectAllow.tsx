import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { connectApi, type RedirectAllowEntry } from "../../data/engine/connectApi.ts";
import { ago } from "../../data/engine/map.ts";
import { errorText } from "../../data/engine/queries.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Card, Chip, Input, Notice, Segmented } from "../../ui/primitives.tsx";

const schemeOf = (uri: string) => /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(uri.trim())?.[1]?.toLowerCase() ?? "";

/**
 * For Proxmox administrators: the custom-scheme return addresses (cursor://, vscode://) apps may use. Refused by default, because
 * any program on a computer can claim such an address. Adding one needs the scheme typed back; the dangerous schemes can never be added.
 */
export function RedirectAllowCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["connect", "redirect-allow"], queryFn: connectApi.redirectAllow.list, retry: 1 });
  const [adding, setAdding] = useState(false);
  const [uri, setUri] = useState("");
  const [kind, setKind] = useState<"exact" | "prefix">("exact");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const done = () => { void qc.invalidateQueries({ queryKey: ["connect", "redirect-allow"] }); };
  const close = () => { setAdding(false); setUri(""); setConfirm(""); setError(null); };
  const add = useMutation({ mutationFn: () => connectApi.redirectAllow.add({ uri: uri.trim(), kind, confirm: confirm.trim() }), onSuccess: () => { done(); close(); }, onError: (e) => setError(errorText(e)) });
  const remove = useMutation({ mutationFn: (e: RedirectAllowEntry) => connectApi.redirectAllow.remove({ uri: e.uri, kind: e.kind }), onSuccess: done, onError: (e) => setError(errorText(e)) });
  const scheme = schemeOf(uri);
  const phrase = scheme ? `allow ${scheme}` : "allow <scheme>";
  const entries = q.data?.entries ?? [];

  return (
    <Card className="mt-4 p-5">
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <div className="text-sm font-medium">App return addresses (cursor://, vscode:// ...)</div>
          <p className="text-xs text-ink-3 mt-1">Apps return to https addresses, or to this computer's own loopback address. Desktop apps that use their own address, such as <span className="font-mono">cursor://</span>, are refused until you list the exact address or a prefix of it here. Any program on a computer can claim such an address, so list only apps you trust.</p>
        </div>
        <Button size="sm" onClick={() => setAdding(true)}><Plus className="h-3.5 w-3.5" />Allow an address</Button>
      </div>
      {q.error && <p role="alert" className="text-compact text-critical mt-3">{errorText(q.error)}</p>}
      {error && !adding && <p role="alert" className="text-compact text-critical mt-3">{error}</p>}
      {q.data && entries.length === 0 && <p className="text-compact text-ink-3 mt-3">None allowed. Only https and loopback return addresses work.</p>}
      {entries.length > 0 && (
        <ul className="mt-3 divide-y divide-line">
          {entries.map((e) => (
            <li key={`${e.kind}:${e.uri}`} className="flex items-center gap-3 py-2.5">
              <code className="flex-1 min-w-0 text-compact break-all">{e.uri}</code>
              <Chip>{e.kind === "prefix" ? "Prefix" : "Exact"}</Chip>
              <span className="hidden sm:inline text-xs text-ink-3">{e.addedBy} · {ago(new Date(e.addedAt))}</span>
              <Button size="sm" variant="ghost" aria-label={`Stop allowing ${e.uri}`} loading={remove.isPending && remove.variables?.uri === e.uri} onClick={() => remove.mutate(e)}><Trash2 className="h-3.5 w-3.5" /></Button>
            </li>
          ))}
        </ul>
      )}
      {adding && (
        <Modal title="Allow an app return address" subtitle="Apps can send a person back here after they approve a connection" onClose={close}
          footer={<><Button variant="ghost" onClick={close}>Cancel</Button><Button variant="primary" loading={add.isPending} disabled={!scheme || confirm.trim() !== phrase || !uri.trim()} onClick={() => add.mutate()}>Allow this address</Button></>}>
          <div className="space-y-4">
            <Notice tone="warning" title="Only allow apps you trust">Whoever claims this address on a computer receives the sign-in code of anyone who approves the connection there. Plain web addresses and the schemes that run code or reach files or connections (javascript, data, file, blob, about, vbscript, ws and wss) can never be allowed.</Notice>
            <div>
              <label htmlFor="ra-uri" className="text-compact font-medium">Address</label>
              <Input id="ra-uri" className="mt-1.5 font-mono" value={uri} onChange={(e) => setUri(e.target.value)} placeholder={kind === "prefix" ? "cursor://anysphere.cursor-mcp/" : "cursor://anysphere.cursor-mcp/oauth/callback"} autoComplete="off" spellCheck={false} />
            </div>
            <div>
              <div className="text-compact font-medium mb-1.5">Matches</div>
              <Segmented value={kind} onChange={setKind} label="How the address matches" options={[{ value: "exact", label: "This exact address" }, { value: "prefix", label: "Anything starting with it" }]} />
              <p className="text-xs text-ink-3 mt-1.5">{kind === "prefix" ? "A prefix must name the app and end with /, so cursor://app/ never matches cursor://app-evil/." : "The safest choice: only this one address."}</p>
            </div>
            <div>
              <label htmlFor="ra-confirm" className="text-compact font-medium">Type <span className="font-mono">{phrase}</span> to confirm</label>
              <Input id="ra-confirm" className="mt-1.5 font-mono" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" spellCheck={false} />
            </div>
            {error && <p role="alert" className="text-compact text-critical">{error}</p>}
          </div>
        </Modal>
      )}
    </Card>
  );
}
