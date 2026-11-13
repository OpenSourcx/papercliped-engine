/**
 * The device-flow harness: how a person connects a provider (GitHub today, others as they are added) without a pasted token, a client
 * secret or a callback address on their own device. The person opens the provider's page, types a short code and approves; this
 * module polls the provider and hands back the access token, which the caller stores sealed.
 *
 * Every ePaperclip device uses the SAME public client ID per provider, shipped in `DEVICE_PROVIDERS` (a client ID is an identifier,
 * not a secret). `EPC_<PROVIDER>_CLIENT_ID` overrides it for someone running their own OAuth app. Paperclip does the equivalent
 * through "Paperclip Cloud", which owns the provider registration; device flow needs no broker, so nothing here calls home.
 *
 * Providers that have no device flow (most web-only OAuth providers) need an authorization-code flow through a broker such as
 * Papercliped Connect; they are not listed here until that exists.
 */

export interface DeviceProvider {
  id: string;
  label: string;
  deviceCodeUrl: string;
  tokenUrl: string;
  scope: string;
  /** The public client ID of ePaperclip's OAuth app for this provider. Empty until that app is registered. */
  defaultClientId: string;
  /** Environment variable that overrides the built-in client ID. */
  envVar: string;
  /** The verification page must be on one of these hosts: a provider answer can never send a person elsewhere. */
  verificationHosts: string[];
  fallbackVerificationUri: string;
}

export const DEVICE_PROVIDERS: Readonly<Record<string, DeviceProvider>> = {
  github: {
    id: "github",
    label: "GitHub",
    deviceCodeUrl: "https://github.com/login/device/code",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scope: "repo read:user",
    // The Client ID of the "Papercliped" OAuth app registered under the OpenSourcx organization (device flow enabled, expiring tokens off).
    // A public value. There is NO client secret in this repository or on any device: device flow does not use one. See docs/GITHUB-OAUTH.md.
    defaultClientId: "Ov23limskUWybL3oLifO",
    envVar: "EPC_GITHUB_CLIENT_ID",
    verificationHosts: ["github.com"],
    fallbackVerificationUri: "https://github.com/login/device",
  },
};

/** The client ID a device uses for a provider: the override if set, else the one built in. Empty means sign-in isn't available. */
export function clientIdFor(p: DeviceProvider, env: Record<string, string | undefined> = process.env): string {
  return (env[p.envVar] ?? p.defaultClientId ?? "").trim();
}

export interface DeviceStart { id: string; userCode: string; verificationUri: string; interval: number; expiresIn: number }
export type DevicePoll = { status: "pending" | "denied" | "expired" } | { status: "done"; accessToken: string };

export class DeviceError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface Pending { provider: string; deviceCode: string; user: string; expiresAt: number; nextAt: number; interval: number }

const form = (o: Record<string, string>) => ({
  method: "POST",
  headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "epaperclip" },
  body: new URLSearchParams(o).toString(),
  signal: AbortSignal.timeout(10_000),
});

/** Sign-ins in progress. The provider's device code never leaves this object: the browser only gets an opaque id. */
export class DeviceSessions {
  private readonly pending = new Map<string, Pending>();

  async start(provider: DeviceProvider, clientId: string, user: string, now: number): Promise<DeviceStart> {
    for (const [k, d] of this.pending) if (d.expiresAt < now) this.pending.delete(k);
    const r = await fetch(provider.deviceCodeUrl, form({ client_id: clientId, scope: provider.scope })).catch(() => null);
    if (!r) throw new DeviceError(502, "provider_unreachable", `${provider.label} didn't answer. Check the host's internet access and try again.`);
    const j = (await r.json().catch(() => ({}))) as { device_code?: string; user_code?: string; verification_uri?: string; expires_in?: number; interval?: number; error?: string; error_description?: string };
    if (!r.ok || !j.device_code || !j.user_code || !j.verification_uri) {
      throw new DeviceError(502, "provider_refused", `${provider.label} refused the sign-in${j.error_description ? `: ${j.error_description}` : j.error ? `: ${j.error}` : ""}. Check that the OAuth app has device flow turned on.`);
    }
    const id = `dv_${Math.random().toString(36).slice(2)}${now.toString(36)}`;
    const interval = Math.max(5, Number(j.interval) || 5);
    const expiresIn = Math.min(900, Number(j.expires_in) || 900);
    this.pending.set(id, { provider: provider.id, deviceCode: j.device_code, user, expiresAt: now + expiresIn * 1000, nextAt: 0, interval });
    let host = "";
    try { const u = new URL(j.verification_uri); host = u.protocol === "https:" ? u.hostname : ""; } catch { /* falls back below */ }
    const verificationUri = provider.verificationHosts.includes(host) ? j.verification_uri : provider.fallbackVerificationUri;
    return { id, userCode: j.user_code, verificationUri, interval, expiresIn };
  }

  async poll(provider: DeviceProvider, clientId: string, id: string, user: string, now: number): Promise<DevicePoll> {
    const d = this.pending.get(id);
    if (!d || d.user !== user || d.provider !== provider.id) throw new DeviceError(404, "not_found", "That sign-in isn't running any more. Start again.");
    if (d.expiresAt < now) { this.pending.delete(id); return { status: "expired" }; }
    // The provider says how often it may be asked; hold early polls back instead of hammering it.
    if (now < d.nextAt) return { status: "pending" };
    d.nextAt = now + d.interval * 1000;
    const r = await fetch(provider.tokenUrl, form({ client_id: clientId, device_code: d.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" })).catch(() => null);
    if (!r) return { status: "pending" };
    const j = (await r.json().catch(() => ({}))) as { access_token?: string; error?: string; interval?: number };
    if (j.error === "slow_down") { d.interval = Math.max(d.interval + 5, Number(j.interval) || 0); return { status: "pending" }; }
    if (j.error === "authorization_pending") return { status: "pending" };
    if (j.error === "access_denied") { this.pending.delete(id); return { status: "denied" }; }
    if (j.error === "expired_token") { this.pending.delete(id); return { status: "expired" }; }
    if (!j.access_token) throw new DeviceError(502, "provider_refused", `${provider.label} answered, but not with a token. Start again.`);
    this.pending.delete(id);
    return { status: "done", accessToken: j.access_token };
  }
}
