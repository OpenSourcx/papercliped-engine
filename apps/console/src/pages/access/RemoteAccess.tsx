import { useState } from "react";
import { Cloud, ExternalLink, Globe, Home } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { host, type ConnectStatusView, type RemoteMode } from "../../data/engine/host.ts";
import { nativeAppApi } from "../../data/engine/connectApi.ts";
import { httpUrl } from "../../lib/safeUrl.ts";
import { Button, Card, Input, Notice } from "../../ui/primitives.tsx";
import { CloudflareAccess } from "./CloudflareAccess.tsx";

const KEY = ["papercliped", "connect", "status"];

const MODES: { id: RemoteMode; title: string; icon: typeof Home; text: string }[] = [
  { id: "local", title: "Local only", icon: Home, text: "Reach ePaperclip on your own network. No subscription, no hosted service and nothing leaves this machine." },
  { id: "cloudflare-self", title: "Self-managed Cloudflare", icon: Cloud, text: "Use your own Cloudflare account. ePaperclip runs a named Cloudflare Tunnel (cloudflared): an outbound-only connection from this machine to your domain. It does not deploy a Cloudflare Worker, which is a separate service that runs code at Cloudflare." },
  { id: "connect", title: "Papercliped Connect", icon: Globe, text: "Papercliped provides the address and the tunnel, billed to your Papercliped account. No Cloudflare account needed. Connect manages the address only; sign-in, permissions and every action stay on this machine." },
];

/** Access → Remote access. Exactly one mode is active; switching between the two remote modes goes through Local only. */
export function RemoteAccess() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: KEY, queryFn: host.connect.status, refetchInterval: (q) => q.state.data?.pairing?.state === "pending" || q.state.data?.pairing?.state === "approved" ? 3000 : 20_000 });
  const set = (v: ConnectStatusView) => qc.setQueryData(KEY, v);
  const mode = useMutation({ mutationFn: async (to: RemoteMode) => { const now = status.data?.mode; if (now && now !== "local" && to !== "local") await host.connect.mode("local"); return host.connect.mode(to); }, onSuccess: set });
  const current = status.data?.mode;
  return (
    <div className="space-y-4">
      <p className="text-compact text-ink-3">Choose how people reach this device from outside your network. Local access works in every mode, including when Papercliped Connect is offline. A public address never bypasses sign-in: everyone still signs in with their Proxmox account and gets only the permissions it has.</p>
      {status.error && <Notice tone="critical" title="Could not load remote access" action={<Button size="sm" onClick={() => void status.refetch()}>Retry</Button>}>{status.error instanceof Error ? status.error.message : "The device did not answer."}</Notice>}
      {mode.error && <Notice tone="warning" title="Mode not changed">{mode.error instanceof Error ? mode.error.message : "The change was refused."}</Notice>}
      <div role="radiogroup" aria-label="Remote access mode" className="grid gap-3 md:grid-cols-3">
        {MODES.map((m) => {
          const on = current === m.id;
          return <button key={m.id} type="button" role="radio" aria-checked={on} disabled={!status.data || mode.isPending} onClick={() => !on && mode.mutate(m.id)} className={`text-left rounded-xl border p-4 transition min-h-11 disabled:opacity-60 ${on ? "border-accent bg-accent-soft" : "border-line hover:border-ink-3"}`}>
            <span className="flex items-center gap-2 font-medium"><m.icon className="h-4 w-4 text-ink-2" />{m.title}{on && <span className="ml-auto text-xs text-accent">Active</span>}</span>
            <span className="mt-2 block text-compact text-ink-3">{m.text}</span>
          </button>;
        })}
      </div>
      {current === "cloudflare-self" && <CloudflareAccess />}
      {current === "connect" && status.data && <ConnectPanel status={status.data} onChange={set} />}
      <ProviderAddress />
      {current === "local" && <Card className="p-5"><p className="text-compact text-ink-3">Remote access is off. People on your network sign in at this device’s own address.</p></Card>}
    </div>
  );
}

function ConnectPanel({ status, onChange }: { status: ConnectStatusView; onChange: (v: ConnectStatusView) => void }) {
  const [name, setName] = useState("");
  const run = (fn: () => Promise<ConnectStatusView>) => ({ mutationFn: fn, onSuccess: onChange });
  const start = useMutation(run(host.connect.pairingStart));
  const poll = useMutation(run(host.connect.pairingPoll));
  const confirm = useMutation(run(() => host.connect.pairingConfirm(status.pairing!.selectedOwner!, name.trim() || "ePaperclip")));
  const cancel = useMutation(run(host.connect.pairingCancel));
  const [removing, setRemoving] = useState(false);
  const unpair = useMutation({ ...run(host.connect.unpair), onSuccess: (v) => { setRemoving(false); onChange(v); } });
  const err = start.error ?? poll.error ?? confirm.error ?? cancel.error ?? unpair.error;
  const pairing = status.pairing;
  const href = pairing && httpUrl(pairing.approvalUrl);
  return <Card className="p-5 space-y-4">
    <h2 className="font-medium">Papercliped Connect</h2>
    {err && <Notice tone="warning" title="Connect could not be reached or refused the request">{err instanceof Error ? err.message : "Try again."} Nothing changed on this device.</Notice>}
    {status.paired && status.device ? <>
      <p className="text-compact text-ink-2">Linked as <strong>{status.device.name}</strong> to Papercliped account <span className="font-mono">{status.device.accountId.slice(0, 8)}</span>.</p>
      {status.tunnel && <Notice tone={status.tunnel.state === "running" ? "good" : status.tunnel.state === "error" || status.tunnel.state === "unavailable" ? "warning" : "info"} title={status.tunnel.hostname ?? "Address"}>{status.tunnel.message}</Notice>}
      <p className="text-xs text-ink-3">Having a Papercliped account or subscription never gives anyone Proxmox administrator rights. Local sign-in keeps working if Connect is offline.</p>
      {removing ? <Notice tone="warning" title="Unlink this device?" action={<><Button size="sm" onClick={() => setRemoving(false)}>Keep linked</Button><Button size="sm" variant="danger" loading={unpair.isPending} onClick={() => unpair.mutate()}>Unlink</Button></>}>The public address stops working. This device is removed locally now and from Connect as soon as it can be reached.</Notice> : <Button variant="ghost" onClick={() => setRemoving(true)}>Unlink this device</Button>}
    </> : !pairing || pairing.state === "expired" ? <>
      {pairing?.state === "expired" && <Notice tone="warning" title="That approval expired">Start again to get a new approval page.</Notice>}
      <p className="text-compact text-ink-3">Link this device to your Papercliped account. You will sign in on Papercliped’s site, approve this device, then confirm the account here.</p>
      <Button variant="primary" loading={start.isPending} onClick={() => start.mutate()}>Link to Papercliped</Button>
    </> : <>
      <ol className="list-decimal pl-5 space-y-2 text-compact text-ink-2">
        <li>Open the approval page and sign in with your Papercliped account. {href ? <a className="inline-flex items-center gap-1 text-accent hover:underline" href={httpUrl(pairing.approvalUrl) ?? undefined} target="_blank" rel="noopener noreferrer">Open approval page<ExternalLink className="h-3.5 w-3.5" /></a> : <span className="text-warning">The approval address was not a safe web address.</span>}</li>
        <li>Approve this device there. This page updates by itself.</li>
        <li>Confirm the account shown below.</li>
      </ol>
      {pairing.state === "approved" && pairing.selectedOwner ? <div className="space-y-3">
        <Notice tone="info" title="Approved by Papercliped account">The account id is <span className="font-mono">{pairing.selectedOwner}</span>. Confirm only if this is your account. Confirming links it to this device; it does not change any Proxmox permission.</Notice>
        <label className="block text-compact">Device name<Input className="mt-1" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} placeholder="ePaperclip" aria-label="Device name" /></label>
        <Button variant="primary" loading={confirm.isPending} onClick={() => confirm.mutate()}>Confirm this account</Button>
      </div> : <p className="text-compact text-ink-3">Waiting for approval…</p>}
      <div className="flex gap-2"><Button size="sm" loading={poll.isPending} onClick={() => poll.mutate()}>Check now</Button><Button size="sm" variant="ghost" loading={cancel.isPending} onClick={() => cancel.mutate()}>Cancel</Button></div>
    </>}
  </Card>;
}

/** Provider sign-in (OAuth) sends the browser back to one address. It must be the address this console is open at. */
export function ProviderAddress() {
  const status = useQuery({ queryKey: ["native-apps", "status"], queryFn: nativeAppApi.status, retry: 1 });
  const callback = status.data?.callbackUrl;
  if (!callback) return status.error ? <Notice tone="warning" title="Provider sign-in address unknown">{status.error instanceof Error ? status.error.message : "The device did not answer."}</Notice> : null;
  const here = window.location.origin;
  const ok = new URL(callback).origin === here;
  return <Card className="p-5 space-y-2">
    <h2 className="font-medium">Provider sign-in address</h2>
    <p className="text-compact text-ink-3">When you connect GitHub, Notion, Slack and similar apps, the provider sends your browser back to this address. Register it as the redirect address with each provider.</p>
    <p className="font-mono text-compact break-all">{callback}</p>
    {ok ? <Notice tone="good" title="Matches this console’s address">Provider sign-in can return here.</Notice>
      : <Notice tone="warning" title="Does not match this console’s address">Provider sign-in would return to a place this browser cannot reach. A device administrator sets the address once, on the Proxmox host:
        <span className="mt-2 block font-mono text-xs break-all">sudo /opt/epaperclip/update/install.sh --set-public-url {here}</span></Notice>}
  </Card>;
}
