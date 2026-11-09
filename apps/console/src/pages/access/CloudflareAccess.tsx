import { useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Circle, Cloud, ExternalLink, KeyRound, Loader2, XCircle } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { host, type CloudflareDeployment, type CloudflarePermissions } from "../../data/engine/host.ts";
import { useConnectorAction, useConnectors } from "../../data/engine/queries.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Card, Input, Notice, Select } from "../../ui/primitives.tsx";

const KEY = ["publishing", "cloudflare", "deployment"];
const NEEDED: { label: string; why: string }[] = [
  { label: "Zone: Zone: Read", why: "list your domains" },
  { label: "Zone: DNS: Edit", why: "create and remove this device’s one DNS record" },
  { label: "Account: Cloudflare Tunnel: Edit", why: "create, configure and delete this device’s named tunnel" },
];
const msg = (e: unknown, fallback: string) => e instanceof Error ? e.message : fallback;

/** Access → Remote access → Self-managed Cloudflare. Publishing belongs to the device, never to one organisation or an agent. */
export function CloudflareAccess() {
  const qc = useQueryClient();
  const connectors = useConnectors();
  const cloudflare = connectors.data?.connectors.find((c) => c.id === "cloudflare");
  const ready = cloudflare?.configured === true && connectors.data?.canManage === true;
  const zones = useQuery({ queryKey: ["publishing", "cloudflare", "zones"], queryFn: host.publishing.cloudflareZones, enabled: ready, retry: 1 });
  const dep = useQuery({ queryKey: KEY, queryFn: host.publishing.cloudflareDeployment, enabled: ready, refetchInterval: (q) => q.state.data?.state === "none" || q.state.data?.state === "needs_confirmation" ? false : q.state.data?.state === "running" ? 30_000 : 4000 });
  const [zone, setZone] = useState("");
  const [subdomain, setSubdomain] = useState("app");
  const [removing, setRemoving] = useState(false);
  const [tokenOpen, setTokenOpen] = useState(false);
  const canManage = connectors.data?.canManage === true;
  // The token is entered right here, in a popup, wherever it is the problem: none yet, refused, or missing a permission.
  const tokenButton = (label: string, variant?: "primary") => canManage ? <Button variant={variant} onClick={() => setTokenOpen(true)}><KeyRound className="h-4 w-4 mr-1.5" aria-hidden />{label}</Button> : null;
  const set = (d: CloudflareDeployment) => qc.setQueryData(KEY, d);
  const create = useMutation({ mutationFn: (target: { zone: string; label: string; confirm: boolean }) => host.publishing.cloudflareCreate(target.zone, target.label, target.confirm), onSuccess: set });
  const remove = useMutation({ mutationFn: host.publishing.cloudflareRemove, onSuccess: (d) => { set(d); setRemoving(false); } });
  const check = useMutation({ mutationFn: () => host.publishing.cloudflarePermissions(zone || zones.data?.[0]?.name) });
  const availableZones = zones.data ?? [];
  const selectedZone = zone || availableZones[0]?.name || "";
  const d = dep.data;
  const has = !!d && d.state !== "none";
  // Resume and Replace continue the address that exists, not whatever domain happens to be selected now: the
  // deployment record is authoritative, and a different (or newly first) domain must not make a retry fail.
  const deployed = (confirm: boolean) => {
    if (!d?.hostname || !d.zone) return;
    create.mutate({ zone: d.zone, label: d.hostname.slice(0, -(d.zone.length + 1)), confirm });
  };

  return (
    <div className="space-y-4">
      {!connectors.data?.canManage && connectors.data && <Notice tone="warning" title="Administrator access required">Only a Proxmox administrator can connect a hosting provider or publish a device address.</Notice>}
      {!cloudflare?.configured && !connectors.isPending && <TokenGuide action={tokenButton("Add token", "primary")} />}
      {tokenOpen && <TokenDialog replacing={cloudflare?.configured === true} onClose={() => setTokenOpen(false)} onSaved={() => { check.reset(); void qc.invalidateQueries({ queryKey: ["publishing", "cloudflare"] }); }} />}
      {ready && <>
        <Card className="p-5 space-y-4">
          <div className="flex items-center gap-3"><Cloud className="h-5 w-5 text-ink-2" /><div><h2 className="font-medium">Cloudflare</h2><p className="text-compact text-ink-3">Choose a domain and one subdomain. ePaperclip creates a stable named tunnel from this device to its local HTTPS service and a DNS record that points the subdomain at it.</p></div></div>
          {zones.isPending && <p className="text-compact text-ink-3"><Loader2 className="h-3.5 w-3.5 animate-spin inline mr-1.5" />Loading domains…</p>}
          {zones.error && <Notice tone="warning" title="Could not load Cloudflare domains" action={<>{tokenButton("Replace token")}<Button onClick={() => void zones.refetch()}>Retry</Button></>}>{msg(zones.error, "Cloudflare did not answer.")}</Notice>}
          {zones.data && availableZones.length === 0 && <Notice tone="warning" title="This token can see no active domain">Add a domain to Cloudflare, make sure it is active, and include it in the token’s Zone Resources. A temporary trycloudflare.com URL is not offered: it changes at restart.</Notice>}
          {availableZones.length > 0 && !has && <>
            <div className="grid sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-3 items-end">
              <label className="block text-compact">Subdomain<Input value={subdomain} onChange={(e) => setSubdomain(e.target.value)} spellCheck={false} className="mt-1" aria-label="Subdomain" /></label>
              <label className="block text-compact">Domain<Select value={selectedZone} onChange={(e) => setZone(e.target.value)} className="mt-1" aria-label="Cloudflare domain">{availableZones.map((z) => <option key={z.id} value={z.name}>{z.name}{z.accountName ? ` (${z.accountName})` : ""}</option>)}</Select></label>
              <Button variant="primary" loading={create.isPending} disabled={!selectedZone || !subdomain.trim()} onClick={() => create.mutate({ zone: selectedZone, label: subdomain.trim(), confirm: false })}>Create address</Button>
            </div>
            <p className="text-xs text-ink-3">This will create, in your Cloudflare account: one named tunnel (<span className="font-mono">epaperclip-…</span>), its route to <span className="font-mono">https://127.0.0.1:443</span> on this device, and one proxied DNS record for <span className="font-mono">{subdomain.trim() || "…"}.{selectedZone || "…"}</span>. An existing record with that name is never changed without your confirmation.</p>
          </>}
          {create.error && <p className="text-compact text-critical" role="alert">{msg(create.error, "Could not create the address.")}</p>}
        </Card>
        {has && d && <Progress d={d} busy={create.isPending} onResume={() => deployed(false)} onReplace={() => deployed(true)} removing={removing} setRemoving={setRemoving} onRemove={() => remove.mutate()} removeBusy={remove.isPending} removeError={remove.error ? msg(remove.error, "Removal failed.") : undefined} />}
        <Card className="p-5 space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap"><h2 className="font-medium">Token permissions</h2><div className="flex gap-2 flex-wrap">{tokenButton("Replace token")}<Button loading={check.isPending} onClick={() => check.mutate()}>Check permissions</Button></div></div>
          <p className="text-compact text-ink-3">The token needs at least: {NEEDED.map((n) => n.label).join("; ")}. A token with more permissions works too; ePaperclip only uses these.</p>
          {check.error && <Notice tone="warning" title="Could not check">{msg(check.error, "Try again.")}</Notice>}
          {check.data && <PermissionList p={check.data} action={tokenButton("Replace token")} />}
        </Card>
      </>}
      <p className="text-xs text-ink-3">A Cloudflare Tunnel is an outbound connection from this machine (cloudflared); a Worker is code that runs at Cloudflare, and ePaperclip does not deploy one. A temporary <span className="font-mono">trycloudflare.com</span> Quick Tunnel is a different cloudflared feature that ePaperclip does not set up: it changes at restart, has no uptime guarantee and cannot carry Pin’s streaming. The tunnel’s run token goes from Cloudflare to this device’s privileged helper only; it is never shown or sent to a browser or an agent.</p>
    </div>
  );
}

const TOKENS_URL = "https://dash.cloudflare.com/profile/api-tokens";

function TokenGuide({ action }: { action?: ReactNode }) {
  return <Card className="p-5">
    <div className="flex gap-3"><Cloud className="h-5 w-5 text-ink-2 shrink-0" /><div>
      <h2 className="font-medium">Connect Cloudflare first</h2>
      <p className="text-compact text-ink-3 mt-1">Create an API token in your own Cloudflare account (My Profile, API Tokens, Create Token, Custom token) with at least these permissions:</p>
      <ul className="list-disc pl-5 mt-2 text-compact text-ink-2 space-y-1">{NEEDED.map((n) => <li key={n.label}><strong>{n.label}</strong> to {n.why}.</li>)}</ul>
      <p className="text-xs text-ink-3 mt-2">A token with more permissions works too. “Account Settings: Read” only adds your account’s name. The token is stored in this device’s vault and is never available to Pin, agents, or organisations.</p>
      <div className="flex gap-4 mt-3 items-center flex-wrap">{action}<a className="inline-flex items-center min-h-11 text-compact text-accent hover:underline" href={TOKENS_URL} target="_blank" rel="noopener noreferrer">Cloudflare API tokens<ExternalLink className="h-3.5 w-3.5 ml-1" /></a></div>
    </div></div>
  </Card>;
}

/** Paste a Cloudflare API token without leaving this page. The value lives only in this dialog and is cleared on close. */
function TokenDialog({ replacing, onClose, onSaved }: { replacing: boolean; onClose: () => void; onSaved: () => void }) {
  const [key, setKey] = useState("");
  const save = useConnectorAction();
  const submit = () => {
    if (!key.trim() || save.isPending) return;
    save.mutate({ id: "cloudflare", kind: "set", apiKey: key.trim() }, { onSuccess: () => { onSaved(); onClose(); }, onSettled: () => setKey("") });
  };
  return <Modal title={replacing ? "Replace Cloudflare token" : "Add Cloudflare token"} icon={<KeyRound className="h-5 w-5" />} size="sm" onClose={onClose}
    footer={<div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={!key.trim()} onClick={submit}>Save token</Button></div>}>
    <div className="space-y-3">
      <p className="text-compact text-ink-3">Needs at least: {NEEDED.map((n) => n.label).join("; ")}. A token with more permissions works too.</p>
      <Input type="password" autoComplete="off" spellCheck={false} autoFocus aria-label="Cloudflare API token" placeholder="Paste a Cloudflare API token" value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} className="font-mono" />
      {save.error && <p className="text-compact text-critical" role="alert">{msg(save.error, "The token was not saved.")}</p>}
      <p className="text-xs text-ink-3">Stored in this device’s vault, never shown again and never available to Pin, agents or organisations. <a className="text-accent hover:underline" href={TOKENS_URL} target="_blank" rel="noopener noreferrer">Create one in Cloudflare</a>.</p>
    </div>
  </Modal>;
}

function PermissionList({ p, action }: { p: CloudflarePermissions; action?: ReactNode }) {
  if (!p.tokenOk) return <Notice tone="critical" title="Cloudflare does not accept this token" action={action}>Create a new token with the permissions above and replace this one.</Notice>;
  return <div className="space-y-2">
    <Notice tone={p.ready ? "good" : "warning"} title={p.ready ? "No required permission is missing" : "A required permission is missing"} action={p.ready ? undefined : action}>{p.ready ? "Edit permissions are confirmed when the address is created." : "Add the missing permission to the token in Cloudflare, or replace it with one that has it, then check again."}</Notice>
    <ul className="space-y-1.5">{p.checks.map((c) => <li key={c.id} className="flex gap-2 text-compact items-start">
      {c.state === "ok" ? <CheckCircle2 className="h-4 w-4 text-good mt-0.5 shrink-0" aria-label="allowed" /> : c.state === "missing" ? <XCircle className="h-4 w-4 text-critical mt-0.5 shrink-0" aria-label="missing" /> : <AlertTriangle className="h-4 w-4 text-warning mt-0.5 shrink-0" aria-label="unknown" />}
      <span><strong>{c.label}</strong>{c.required ? "" : " (optional)"}: {c.detail}</span></li>)}</ul>
  </div>;
}

function Progress({ d, busy, onResume, onReplace, removing, setRemoving, onRemove, removeBusy, removeError }: { d: CloudflareDeployment; busy: boolean; onResume: () => void; onReplace: () => void; removing: boolean; setRemoving: (v: boolean) => void; onRemove: () => void; removeBusy: boolean; removeError?: string }) {
  const tone = d.state === "running" ? "good" : d.state === "failed" ? "critical" : d.state === "connecting" ? "info" : "warning";
  const resumable = d.state === "failed" || d.state === "stopped" || d.state === "connecting";
  return <Card className="p-5 space-y-4">
    <h2 className="font-medium font-mono break-all">{d.hostname}</h2>
    <ol className="space-y-1.5" aria-label="Set-up progress">{d.steps.map((s) => <li key={s.id} className="flex items-center gap-2 text-compact">
      {s.state === "done" ? <CheckCircle2 className="h-4 w-4 text-good" aria-hidden /> : s.state === "failed" ? <XCircle className="h-4 w-4 text-critical" aria-hidden /> : <Circle className="h-4 w-4 text-ink-3" aria-hidden />}
      <span className={s.state === "todo" ? "text-ink-3" : "text-ink-2"}>{s.label}<span className="sr-only">: {s.state === "done" ? "done" : s.state === "failed" ? "failed" : "not yet"}</span></span></li>)}</ol>
    <Notice tone={tone} title={d.state === "running" ? "Connected" : d.state === "needs_confirmation" ? "A DNS record already exists" : d.state === "failed" ? `Stopped at: ${d.steps.find((s) => s.id === d.failure?.step)?.label ?? "a step"}` : d.state === "stopped" ? "Not running" : "Connecting"}
      action={d.state === "needs_confirmation" ? <Button variant="danger" loading={busy} onClick={onReplace}>Replace the record</Button> : resumable ? <Button loading={busy} onClick={onResume}>Resume</Button> : undefined}>
      {d.message}{d.conflict && <span className="block mt-1 font-mono text-xs break-all">{d.conflict.type} {d.conflict.content}</span>}
    </Notice>
    {removeError && <p className="text-compact text-critical" role="alert">{removeError}</p>}
    {removing ? <Notice tone="warning" title="Remove this address?" action={<><Button onClick={() => setRemoving(false)}>Keep it</Button><Button variant="danger" loading={removeBusy} onClick={onRemove}>Remove</Button></>}>This stops the connector on this device and deletes the DNS record and the tunnel that ePaperclip created in your Cloudflare account. Records it did not create are not touched.</Notice>
      : <Button variant="ghost" onClick={() => setRemoving(true)}>Remove address</Button>}
  </Card>;
}
