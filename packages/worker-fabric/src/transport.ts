/**
 * Transport providers: how a worker reaches the host. A provider only turns "which provider" into addresses; the
 * channel authenticates and encrypts everything itself, so a provider has to deliver bytes and nothing more.
 */

export type ProviderId = "tailscale" | "lan" | "custom" | (string & {});

export interface Transport {
  provider: ProviderId;
  label: string;
  available: boolean;
  recommended?: boolean;
  address?: string;
  detail: string;
}

export interface NetInfo {
  /** `tailscale status --json` text, or null when tailscale is not installed or not running. */
  tailscaleStatus: string | null;
  /** `tailscale ip -4` output. */
  tailscaleIp: string | null;
  /** Non-loopback interface addresses. */
  interfaces: { name: string; address: string; family: "IPv4" | "IPv6" }[];
  /** A configured public URL for the custom provider (EPC_FABRIC_PUBLIC_URL), without the port. */
  customUrl?: string | null;
}

const isPrivate4 = (a: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a);
const isTailnet4 = (a: string) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a);

function tailscaleSelf(statusJson: string | null): { ip: string | null; dns: string | null; running: boolean } {
  if (!statusJson) return { ip: null, dns: null, running: false };
  try {
    const s = JSON.parse(statusJson) as { BackendState?: string; Self?: { TailscaleIPs?: string[]; DNSName?: string } };
    const ip = s.Self?.TailscaleIPs?.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) ?? null;
    return { ip, dns: s.Self?.DNSName?.replace(/\.$/, "") || null, running: s.BackendState === "Running" };
  } catch {
    return { ip: null, dns: null, running: false };
  }
}

/** Every provider this machine could offer, with a plain-language status. Tailscale is recommended but never required. */
export function detectTransports(n: NetInfo, port: number): Transport[] {
  const ts = tailscaleSelf(n.tailscaleStatus);
  const tsIp = ts.running ? (n.tailscaleIp?.trim() || ts.ip) : null;
  const out: Transport[] = [
    tsIp
      ? { provider: "tailscale", label: "Tailscale", available: true, recommended: true, address: `ws://${tsIp}:${port}`, detail: `This machine is on your tailnet as ${ts.dns ?? tsIp}. Workers on the same tailnet can reach it without opening any ports.` }
      : { provider: "tailscale", label: "Tailscale", available: false, recommended: true, detail: n.tailscaleStatus === null ? "Tailscale is not installed or not running on this machine. Install it from tailscale.com/download, run `tailscale up`, and join the worker to the same tailnet." : "Tailscale is installed but not connected. Run `tailscale up`." },
  ];
  const lan = n.interfaces.find((i) => i.family === "IPv4" && isPrivate4(i.address) && !isTailnet4(i.address));
  out.push(
    lan
      ? { provider: "lan", label: "Local network", available: true, address: `ws://${lan.address}:${port}`, detail: `Workers on the same network can connect to ${lan.address}.` }
      : { provider: "lan", label: "Local network", available: false, detail: "No private network address found on this machine." },
  );
  out.push(
    n.customUrl
      ? { provider: "custom", label: "Custom or existing network", available: true, address: n.customUrl, detail: "Your own routable address (VPN, WireGuard, corporate network or reverse proxy)." }
      : { provider: "custom", label: "Custom or existing network", available: false, detail: "Set EPC_FABRIC_PUBLIC_URL to an address your workers can already reach, for example wss://epaperclip.example.net:7843." },
  );
  return out;
}

/** The URLs a pairing code carries, in preference order: the chosen provider first, then the recommended order. */
export function endpointsFor(transports: Transport[], prefer?: ProviderId | null): { provider: string; url: string }[] {
  const order: ProviderId[] = ["tailscale", "lan", "custom"];
  const rank = (t: Transport) => (prefer && t.provider === prefer ? -1 : order.indexOf(t.provider) === -1 ? 99 : order.indexOf(t.provider));
  return transports
    .filter((t) => t.available && t.address)
    .sort((a, b) => rank(a) - rank(b))
    .map((t) => ({ provider: t.provider, url: `${t.address!.replace(/\/+$/, "")}/fabric/v1/connect` }));
}

/**
 * The worker side: which of the host's endpoints to try first. A worker that has tailscale itself prefers tailscale
 * endpoints, one on a private LAN prefers LAN; custom is always acceptable. The rest follow in the host's order.
 */
export function orderEndpoints(urls: { provider: string; url: string }[], local: { tailscale: boolean; lan: boolean }, prefer?: string | null): { provider: string; url: string }[] {
  const usable = (e: { provider: string }) => (e.provider === "tailscale" ? local.tailscale : e.provider === "lan" ? local.lan : true);
  const score = (e: { provider: string }, i: number) => (prefer && e.provider === prefer && usable(e) ? -1000 : 0) + (usable(e) ? 0 : 100) + i;
  return urls.map((e, i) => ({ e, s: score(e, i) })).sort((a, b) => a.s - b.s).map((x) => x.e);
}
