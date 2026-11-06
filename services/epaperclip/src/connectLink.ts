import { HttpError } from "./http.ts";
import type { HttpFetch } from "./connectors.ts";
import { PaperclipedDeviceIdentity, pairingApprovalUrl } from "./paperclipedAccount.ts";
import type { StateStore } from "./state.ts";
import { socketTunnelHelper, type TunnelHelper, type TunnelHelperStatus } from "./tunnelHelper.ts";
import { createHash } from "node:crypto";

/**
 * The device side of Papercliped Connect: the ONE remote-access mode in force, and the pairing that makes a
 * hosted account the verified owner of this machine.
 *
 *   local            nothing is published (default; always works, never needs Connect)
 *   cloudflare-self  the administrator's own Cloudflare account (Settings -> Advertising)
 *   connect          managed Papercliped Connect tunnel
 *
 * Only one is active, so they cannot fight over the tunnel service, the token file or EPC_PUBLIC_URL. Switching
 * between the two remote modes goes through local-only on purpose. A Connect outage fails closed here and never
 * affects local operation. The private device key never leaves the StateStore vault.
 */
export type PublishMode = "local" | "cloudflare-self" | "connect";
const MODES: readonly PublishMode[] = ["local", "cloudflare-self", "connect"];
const KEY = "connect.link";
const TOKEN = "connect.pairing.token";

interface PairingRecord { id: string; startedAt: number; expiresAt: number; state: "pending" | "approved"; accountId?: string }
interface DeviceRecord { deviceId: string; accountId: string; name: string; pairedAt: number }
/** What Connect last said about this device's tunnel. The run token itself is never kept here: the root helper owns it. */
export type TunnelResult = "ok" | "not_ready" | "no_entitlement" | "not_available" | "unreachable" | "invalid" | "helper_error" | "conflict";
interface TunnelRecord { hostname?: string; tokenId?: string; lastResult?: TunnelResult; lastAt?: number; lastOkAt?: number; nextAt?: number; attempts: number; denied: number; cleanup?: boolean }
/** pendingRevoke: this machine was unpaired locally but Connect has not confirmed removing its hosted device/tunnel/seat yet. */
interface LinkRecord { mode: PublishMode; pairing?: PairingRecord; device?: DeviceRecord; tunnel?: TunnelRecord; pendingRevoke?: { deviceId: string } }

export interface ConnectStatus {
  mode: PublishMode;
  paired: boolean;
  device?: DeviceRecord;
  pairing?: { id: string; state: "pending" | "approved" | "expired"; approvalUrl: string; expiresAt: number; selectedOwner?: string };
  tunnel?: TunnelStatus;
}
export interface TunnelStatus {
  /** off: not in Connect mode. running: Connect gave credentials and the service is up. */
  state: "off" | "connecting" | "waiting" | "running" | "stopped" | "subscription_needed" | "unavailable" | "offline" | "error";
  message: string;
  hostname?: string;
  lastResult?: TunnelResult;
  lastCheckedAt?: number;
  lastOkAt?: number;
  nextCheckAt?: number;
  /** Live from the helper (only on the status route): who holds the tunnel service and whether it is running. */
  helper?: TunnelHelperStatus | { error: string };
}

const HOSTNAME = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const TUNNEL_TOKEN = /^[A-Za-z0-9_.+/=-]{20,4096}$/;
const ORIGIN = "https://127.0.0.1:443";
/** Not-available answers in a row before the tunnel is stopped: a wrong clock looks the same as a removed device. */
const DENIED_LIMIT = 3;

/** Seconds until the next credentials check. Steady state is slow; waiting for provisioning and outages back off, capped. */
export function tunnelDelayMs(result: TunnelResult, attempts: number, random: number): number {
  const n = Math.min(Math.max(attempts, 0), 12);
  const base = result === "ok" ? 15 * 60_000
    : result === "not_ready" ? Math.min(5_000 * 2 ** n, 5 * 60_000)
    : result === "no_entitlement" || result === "not_available" ? 10 * 60_000
    : Math.min(10_000 * 2 ** n, 10 * 60_000);
  return Math.round(base * (1 + 0.2 * random)); // jitter so a Connect outage doesn't end in every device calling at once
}

const nameOk = (n: unknown): n is string => typeof n === "string" && n.trim().length >= 1 && n.trim().length <= 100;

export class ConnectLink {
  private readonly identity: PaperclipedDeviceIdentity;
  private readonly state: StateStore;
  private readonly fetch: HttpFetch;
  private readonly baseUrl: string;
  private readonly now: () => number;
  private readonly helper: TunnelHelper;
  private readonly random: () => number;
  private chain: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(state: StateStore, fetch: HttpFetch, baseUrl: string, now: () => number = Date.now, opts: { helper?: TunnelHelper; random?: () => number } = {}) {
    this.state = state;
    this.fetch = fetch;
    this.baseUrl = baseUrl;
    this.now = now;
    this.helper = opts.helper ?? socketTunnelHelper();
    this.random = opts.random ?? Math.random;
    const u = new URL(baseUrl);
    if (u.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(u.hostname)) throw new Error("Connect URL must be https");
    this.identity = new PaperclipedDeviceIdentity(state);
  }

  private rec(): LinkRecord { return this.state.getSetting<LinkRecord>(KEY) ?? { mode: "local" }; }
  private save(r: LinkRecord) { this.state.setSetting(KEY, r); }
  mode(): PublishMode { return this.rec().mode; }

  /** Publishing settings use this: Cloudflare self-management is locked while Connect owns the tunnel. */
  assertSelfManagedAllowed() {
    if (this.mode() === "connect") throw new HttpError(409, "mode_connect", "Papercliped Connect is managing remote access. Switch to local-only first.");
  }

  /** The public https address of this machine while Connect's tunnel is ours (OAuth issuer, MCP URL); undefined otherwise. */
  publicUrl(): string | undefined {
    const r = this.rec();
    return r.mode === "connect" && r.tunnel?.hostname ? "https://" + r.tunnel.hostname : undefined;
  }

  /** True while requests may arrive through our tunnel (their client address comes from CF-Connecting-IP). */
  tunnelTrusted(): boolean { return this.mode() === "connect"; }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  async setMode(to: unknown): Promise<ConnectStatus> {
    if (typeof to !== "string" || !MODES.includes(to as PublishMode)) throw new HttpError(400, "bad_mode", "Mode must be local, cloudflare-self or connect");
    const r = this.rec();
    if (to !== "local" && r.mode !== "local" && r.mode !== to) throw new HttpError(409, "switch_via_local", "Switch to local-only first, then choose the other mode.");
    if (to === "connect" && !r.device) throw new HttpError(409, "not_paired", "Pair this machine with your Papercliped account first.");
    if (to === r.mode) return this.status();
    // The mode is saved first, so a stuck helper or an unreachable Connect can't leave a half-switched machine.
    this.save(to === "connect" ? { ...r, mode: "connect", tunnel: { attempts: 0, denied: 0 } } : this.withoutTunnel({ ...r, mode: to as PublishMode }, r));
    return this.serial(() => this.reconcile());
  }

  /** Leaving Connect forgets the tunnel; if the helper can't remove it right now that is retried by reconcile(). */
  private withoutTunnel(next: LinkRecord, was: LinkRecord): LinkRecord {
    delete next.tunnel;
    if (was.mode === "connect") next.tunnel = { attempts: 0, denied: 0, cleanup: true };
    return next;
  }

  private async call<T>(path: string, body: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetch(this.baseUrl + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new HttpError(502, "connect_unreachable", "Papercliped Connect can't be reached right now. Local use is not affected.");
    }
    if (res.status >= 500) throw new HttpError(502, "connect_unavailable", "Papercliped Connect is having trouble. Try again shortly.");
    if (!res.ok) throw new HttpError(409, "connect_refused", "Papercliped Connect declined this step. Start the pairing again.");
    return await res.json() as T;
  }

  /** Begin pairing: get a one-time challenge, prove we hold the device key, return the page the owner opens. */
  async start(): Promise<ConnectStatus> {
    const r = this.rec();
    if (r.device) throw new HttpError(409, "already_paired", "This machine is already paired. Unpair it first.");
    const id = this.identity.publicIdentity();
    const b = await this.call<{ pairingId: string; token: string; expiresAt: number }>("/api/v1/pairings", { publicKeyJwk: id.publicKeyJwk });
    pairingApprovalUrl(b.pairingId); // throws unless Connect returned a well-formed id
    await this.call("/api/v1/pairings/" + b.pairingId + "/proof", { token: b.token, publicKeyJwk: id.publicKeyJwk, signature: this.identity.signChallenge(b.token) });
    this.state.setSecret(TOKEN, b.token);
    this.save({ ...r, pairing: { id: b.pairingId, startedAt: this.now(), expiresAt: Number(b.expiresAt), state: "pending" } });
    return this.status();
  }

  /** Ask Connect whether the owner approved; learn WHICH account they chose so the administrator can confirm it. */
  async poll(): Promise<ConnectStatus> {
    const r = this.rec(), p = r.pairing, token = this.state.getSecret(TOKEN);
    if (!p || !token) return this.status();
    if (this.now() > p.expiresAt) return this.status();
    const b = await this.call<{ state: string; accountId?: string | null }>("/api/v1/pairings/" + p.id + "/poll", { token });
    if (b.state === "approved" && typeof b.accountId === "string") this.save({ ...r, pairing: { ...p, state: "approved", accountId: b.accountId } });
    return this.status();
  }

  /** Local administrator consent: sign the exact account shown to them, then finish. Refuses any other account. */
  async confirm(accountId: unknown, deviceName: unknown): Promise<ConnectStatus> {
    const r = this.rec(), p = r.pairing, token = this.state.getSecret(TOKEN);
    if (!p || !token || p.state !== "approved" || !p.accountId) throw new HttpError(409, "not_approved", "The account owner hasn't approved this machine yet.");
    if (this.now() > p.expiresAt) throw new HttpError(409, "expired", "This pairing expired. Start again.");
    if (accountId !== p.accountId) throw new HttpError(409, "owner_mismatch", "That isn't the account that approved this machine.");
    if (!nameOk(deviceName)) throw new HttpError(400, "bad_name", "Give this machine a name (1-100 characters).");
    const id = this.identity.publicIdentity();
    const done = await this.call<{ deviceId: string }>("/api/v1/pairings/" + p.id + "/complete", {
      token, publicKeyJwk: id.publicKeyJwk, accountId: p.accountId, deviceName: deviceName.trim(),
      signature: this.identity.signAccountConfirmation(p.id, p.accountId, token),
    });
    this.state.deleteSecret(TOKEN);
    this.save({ mode: r.mode, ...(r.tunnel ? { tunnel: r.tunnel } : {}), device: { deviceId: done.deviceId, accountId: p.accountId, name: deviceName.trim(), pairedAt: this.now() } });
    return this.status();
  }

  cancel(): ConnectStatus {
    const r = this.rec();
    this.state.deleteSecret(TOKEN);
    this.save({ mode: r.mode, ...(r.device ? { device: r.device } : {}), ...(r.tunnel ? { tunnel: r.tunnel } : {}) });
    return this.status();
  }

  /** Forget the ownership binding locally, stop and delete the tunnel, return to local-only, and ask Connect to remove this device (tunnel, DNS, seat). Local always wins: if Connect is unreachable the removal is retried at the next reconcile/start. */
  async unpair(): Promise<ConnectStatus> {
    const r = this.rec();
    this.state.deleteSecret(TOKEN);
    const next = this.withoutTunnel({ mode: "local" }, r);
    if (r.device) next.pendingRevoke = { deviceId: r.device.deviceId };
    this.save(next);
    return this.serial(() => this.reconcile());
  }

  /** Tell Connect to remove this machine. Done when Connect confirms or already doesn't know the device; kept pending on any outage. */
  private async revokeRemote(deviceId: string) {
    const ts = Math.floor(this.now() / 1000);
    try {
      const id = this.identity.publicIdentity();
      const res = await this.fetch(this.baseUrl + "/api/v1/devices/" + deviceId + "/device-revoke", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicKeyJwk: id.publicKeyJwk, ts, signature: this.identity.signRevokeRequest(deviceId, ts) }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status >= 500 || res.status === 429) return;           // outage: keep pending
      const c = this.rec(); delete c.pendingRevoke; this.save(c);       // 2xx = removed; 403 = Connect no longer knows this device
    } catch { /* unreachable: keep pending */ }
  }

  status(): ConnectStatus {
    const r = this.rec(), p = r.pairing;
    const out: ConnectStatus = { mode: r.mode, paired: !!r.device, ...(r.device ? { device: r.device } : {}) };
    if (r.mode === "connect") out.tunnel = this.tunnelStatus(r.tunnel);
    if (p) out.pairing = { id: p.id, state: this.now() > p.expiresAt ? "expired" : p.state, approvalUrl: pairingApprovalUrl(p.id), expiresAt: p.expiresAt, ...(p.accountId ? { selectedOwner: p.accountId } : {}) };
    return out;
  }

  // ---- The tunnel (Connect mode only)

  private tunnelStatus(t: TunnelRecord | undefined, helper?: TunnelHelperStatus | { error: string }): TunnelStatus {
    const up = !!helper && !("error" in helper) && helper.owner === "connect" && helper.active;
    const known = !!helper && !("error" in helper);
    const base = { ...(t?.hostname ? { hostname: t.hostname } : {}), ...(t?.lastResult ? { lastResult: t.lastResult } : {}), ...(t?.lastAt ? { lastCheckedAt: t.lastAt } : {}), ...(t?.lastOkAt ? { lastOkAt: t.lastOkAt } : {}), ...(t?.nextAt ? { nextCheckAt: t.nextAt } : {}), ...(helper ? { helper } : {}) };
    const done = (state: TunnelStatus["state"], message: string): TunnelStatus => ({ state, message, ...base });
    switch (t?.lastResult) {
      case undefined: return done("connecting", "Asking Papercliped Connect for this machine's tunnel.");
      case "not_ready": return done("waiting", "Papercliped Connect is still setting up this machine's address, or its subscription is paused.");
      case "no_entitlement": return done("subscription_needed", "Subscription needed: add a Papercliped Connect subscription to this machine in your account. Local use is not affected.");
      case "not_available": return done("unavailable", "Papercliped Connect doesn't recognise this machine. Check the clock, or unpair and pair again.");
      case "invalid": return done("error", "Papercliped Connect sent an answer this machine can't use.");
      case "conflict": return done("error", "Your own Cloudflare tunnel is running. Switch to local-only, then to Papercliped Connect.");
      case "helper_error": return done("error", "The tunnel couldn't be started on this machine. Update ePaperclip and check the publishing helper.");
      case "unreachable": return done(up ? "running" : "offline", up ? "The tunnel is running; Papercliped Connect can't be reached right now to re-check it." : "Papercliped Connect can't be reached right now. Local use is not affected.");
      case "ok": return known && !up ? done("stopped", "Connect gave this machine its address but the tunnel service isn't running.") : done("running", "Reachable at https://" + (t.hostname ?? "") + (known ? "" : " (service state not checked)"));
    }
  }

  /** Status including the helper's live view of the tunnel service. A broken helper is reported, never thrown. */
  async statusLive(): Promise<ConnectStatus> {
    const out = this.status();
    if (out.tunnel) {
      let h: TunnelHelperStatus | { error: string };
      try { h = await this.helper.status(); } catch (e) { h = { error: e instanceof Error ? e.message : "helper unavailable" }; }
      out.tunnel = this.tunnelStatus(this.rec().tunnel, h);
    }
    return out;
  }

  private patchTunnel(p: Partial<TunnelRecord>) {
    const r = this.rec();
    if (r.mode !== "connect") return; // switched away while a check was in flight: reconcile() cleans up
    this.save({ ...r, tunnel: { attempts: 0, denied: 0, ...r.tunnel, ...p } });
  }

  private async helperRemove() {
    try {
      await this.helper.remove("connect");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Bring the tunnel into line with the mode, once. Never throws: Connect or the helper failing changes the reported
   * state only, never local operation. Outside Connect mode it makes sure no Connect token or service is left behind.
   */
  async reconcile(): Promise<ConnectStatus> {
    try {
      const r = this.rec();
      if (r.mode !== "connect" || !r.device) {
        if (r.tunnel?.cleanup || await this.ownsTunnel()) {
          if (await this.helperRemove()) { const c = this.rec(); delete c.tunnel; this.save(c); }
        }
        if (r.pendingRevoke) await this.revokeRemote(r.pendingRevoke.deviceId);
        return this.statusLive();
      }
      await this.checkCredentials(r.device);
    } catch { /* state was recorded where it mattered */ }
    this.arm();
    return this.statusLive();
  }

  private async ownsTunnel(): Promise<boolean> {
    try { return (await this.helper.status()).owner === "connect"; } catch { return false; }
  }

  private async checkCredentials(device: DeviceRecord) {
    const t = this.now();
    const ts = Math.floor(t / 1000);
    const prior = this.rec().tunnel ?? { attempts: 0, denied: 0 };
    const finish = (result: TunnelResult, extra: Partial<TunnelRecord> = {}) => {
      const attempts = result === "ok" ? 0 : prior.attempts + 1;
      this.patchTunnel({ lastResult: result, lastAt: t, attempts, nextAt: t + tunnelDelayMs(result, attempts, this.random()), ...(result === "ok" ? { lastOkAt: t } : {}), ...extra });
    };
    let res: Response;
    try {
      const id = this.identity.publicIdentity();
      res = await this.fetch(this.baseUrl + "/api/v1/devices/" + device.deviceId + "/tunnel-credentials", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicKeyJwk: id.publicKeyJwk, ts, signature: this.identity.signTunnelRequest(device.deviceId, ts) }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch { return finish("unreachable"); } // keep whatever tunnel state we had
    if (res.status >= 500 || res.status === 429) return finish("unreachable");
    let body: Record<string, unknown> = {};
    try { body = await res.json() as Record<string, unknown>; } catch { /* below */ }
    if (res.status === 409 && body.error === "not_ready") return finish("not_ready", { denied: 0 });
    if (res.status === 403 && body.error === "no_entitlement") {
      // The subscription ended: stop serving, and fall back to this machine's own address everywhere.
      const gone = await this.helperRemove();
      return finish("no_entitlement", { denied: 0, hostname: undefined, tokenId: undefined, cleanup: !gone });
    }
    if (res.status === 403) {
      const denied = prior.denied + 1;
      if (denied < DENIED_LIMIT) return finish("not_available", { denied });
      const gone = await this.helperRemove();
      return finish("not_available", { denied, hostname: undefined, tokenId: undefined, cleanup: !gone });
    }
    const hostname = typeof body.hostname === "string" ? body.hostname.toLowerCase() : "";
    const token = body.tunnelToken;
    if (res.status !== 200 || !HOSTNAME.test(hostname) || typeof token !== "string" || !TUNNEL_TOKEN.test(token) || body.origin !== ORIGIN) return finish("invalid");
    const tokenId = createHash("sha256").update(token).digest("hex").slice(0, 16);
    try {
      const h = await this.helper.status();
      if (h.owner === "self") return finish("conflict");
      if (h.owner !== "connect" || !h.active || prior.tokenId !== tokenId) await this.helper.install("connect", token);
    } catch { return finish("helper_error"); }
    finish("ok", { denied: 0, hostname, tokenId, cleanup: false });
  }

  /** Re-check on a timer: quick while waiting for provisioning, slow once running. Timers never keep the process alive. */
  private arm() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const r = this.rec();
    if (this.stopped || r.mode !== "connect" || !r.device) return;
    const wait = Math.max(1_000, (r.tunnel?.nextAt ?? this.now()) - this.now());
    this.timer = setTimeout(() => void this.serial(() => this.reconcile()), wait);
    this.timer.unref?.();
  }
  private stopped = true;

  /** Start the background check (host service boot). Cleans up leftovers and, in Connect mode, fetches credentials now. */
  watch() {
    this.stopped = false;
    void this.serial(() => this.reconcile());
  }
  unwatch() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
