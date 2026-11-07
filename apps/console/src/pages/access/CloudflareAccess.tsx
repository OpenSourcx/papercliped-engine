import { useState } from "react";
import { Cloud, ExternalLink, Loader2, ShieldCheck } from "lucide-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { host } from "../../data/engine/host.ts";
import { useConnectors } from "../../data/engine/queries.ts";
import { Button, Card, Input, Notice, Select } from "../../ui/primitives.tsx";

/** Access → Remote access → Self-managed Cloudflare. Publishing belongs to the device, never to one organisation or an agent. */
export function CloudflareAccess() {
  const connectors = useConnectors();
  const cloudflare = connectors.data?.connectors.find((c) => c.id === "cloudflare");
  const zones = useQuery({ queryKey: ["publishing", "cloudflare", "zones"], queryFn: host.publishing.cloudflareZones, enabled: cloudflare?.configured === true && connectors.data?.canManage === true, retry: 1 });
  const [zone, setZone] = useState("");
  const [subdomain, setSubdomain] = useState("app");
  const plan = useMutation({ mutationFn: () => host.publishing.cloudflarePlan(zone, subdomain) });
  const availableZones = zones.data ?? [];
  const selectedZone = zone || availableZones[0]?.name || "";

  return (
    <div className="space-y-4">
      {!connectors.data?.canManage && connectors.data && <Notice tone="warning" title="Administrator access required">Only a Proxmox administrator can connect a hosting provider or publish a device address.</Notice>}
      {!cloudflare?.configured && !connectors.isPending && (
        <Card className="p-5">
          <div className="flex gap-3"><Cloud className="h-5 w-5 text-ink-2 shrink-0" /><div><h2 className="font-medium">Connect Cloudflare first</h2><p className="text-compact text-ink-3 mt-1">In Settings → Plugins, add a scoped Cloudflare API token. It is stored in this device’s vault and is never available to Pin, agents, or organisations.</p><a className="inline-flex text-compact text-accent hover:underline mt-3" href="?settings=plugins">Open Plugins <ExternalLink className="h-3.5 w-3.5 ml-1" /></a></div></div>
        </Card>
      )}
      {cloudflare?.configured && <>
        <Card className="p-5 space-y-4">
          <div className="flex items-center gap-3"><Cloud className="h-5 w-5 text-ink-2" /><div><h2 className="font-medium">Cloudflare</h2><p className="text-compact text-ink-3">Choose a domain and one subdomain. ePaperclip will use a stable named tunnel to its local HTTPS service.</p></div></div>
          {zones.isPending && <p className="text-compact text-ink-3"><Loader2 className="h-3.5 w-3.5 animate-spin inline mr-1.5" />Loading domains…</p>}
          {zones.error && <Notice tone="warning" title="Could not load Cloudflare domains">Check the token’s Zone:Read permission, then test the Cloudflare connector.</Notice>}
          {zones.data && availableZones.length === 0 && <Notice tone="warning" title="No active Cloudflare domains">You can still use a temporary Cloudflare URL for a preview. It changes on restart and is not suitable for Pin’s streaming features.</Notice>}
          {availableZones.length > 0 && <div className="grid sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-3 items-end"><label className="block text-compact">Subdomain<Input value={subdomain} onChange={(e) => setSubdomain(e.target.value)} spellCheck={false} className="mt-1" aria-label="Subdomain" /></label><label className="block text-compact">Domain<Select value={selectedZone} onChange={(e) => setZone(e.target.value)} className="mt-1" aria-label="Cloudflare domain">{availableZones.map((z) => <option key={z.id} value={z.name}>{z.name}</option>)}</Select></label><Button variant="primary" onClick={() => plan.mutate()} disabled={!selectedZone || !subdomain.trim() || plan.isPending}>{plan.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Prepare"}</Button></div>}
        </Card>
        {plan.error && <p className="text-compact text-critical mt-3" role="alert">{plan.error instanceof Error ? plan.error.message : "Could not prepare the publication."}</p>}
        {plan.data && <Card className="p-5 mt-4"><div className="flex gap-3"><ShieldCheck className="h-5 w-5 text-good shrink-0" /><div><h2 className="font-medium">{plan.data.hostname}</h2><p className="text-compact text-ink-3 mt-1">This is the address a named Cloudflare Tunnel (cloudflared) would use to reach ePaperclip’s local HTTPS service. Visitors would still sign in through ePaperclip with their Proxmox account.</p><p className="text-xs text-ink-3 mt-2"><strong>Nothing has been created.</strong> Preparing only checks the domain and the name. ePaperclip does not yet create the tunnel or the DNS record for you, and it never creates a Cloudflare Worker. To publish today, create the tunnel in your Cloudflare account and have a device administrator install its run token with the privileged publishing helper; see <span className="font-mono">epaperclip device publish status</span> for its state.</p></div></div></Card>}
      </>}
      <p className="text-xs text-ink-3 mt-4">What this page does today: it keeps your Cloudflare API token in this device’s vault, checks it, and lists your active domains (read only). A Cloudflare Tunnel is an outbound connection from this machine; a Worker is code that runs at Cloudflare, and ePaperclip does not deploy one. A temporary <span className="font-mono">trycloudflare.com</span> Quick Tunnel is a cloudflared feature that ePaperclip does not set up; it changes at restart and cannot carry Pin’s streaming.</p>
    </div>
  );
}
