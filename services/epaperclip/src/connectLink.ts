import { HttpError } from "./http.ts";
import type { HttpFetch } from "./connectors.ts";
import { PaperclipedDeviceIdentity, pairingApprovalUrl } from "./paperclipedAccount.ts";
import type { StateStore } from "./state.ts";

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
interface LinkRecord { mode: PublishMode; pairing?: PairingRecord; device?: DeviceRecord }

export interface ConnectStatus {
  mode: PublishMode;
  paired: boolean;
  device?: DeviceRecord;
  pairing?: { id: string; state: "pending" | "approved" | "expired"; approvalUrl: string; expiresAt: number; selectedOwner?: string };
}

const nameOk = (n: unknown): n is string => typeof n === "string" && n.trim().length >= 1 && n.trim().length <= 100;

export class ConnectLink {
  private readonly identity: PaperclipedDeviceIdentity;
  private readonly state: StateStore;
  private readonly fetch: HttpFetch;
  private readonly baseUrl: string;
  private readonly now: () => number;
  constructor(state: StateStore, fetch: HttpFetch, baseUrl: string, now: () => number = Date.now) {
    this.state = state;
    this.fetch = fetch;
    this.baseUrl = baseUrl;
    this.now = now;
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

  setMode(to: unknown): ConnectStatus {
    if (typeof to !== "string" || !MODES.includes(to as PublishMode)) throw new HttpError(400, "bad_mode", "Mode must be local, cloudflare-self or connect");
    const r = this.rec();
    if (to !== "local" && r.mode !== "local" && r.mode !== to) throw new HttpError(409, "switch_via_local", "Switch to local-only first, then choose the other mode.");
    if (to === "connect" && !r.device) throw new HttpError(409, "not_paired", "Pair this machine with your Papercliped account first.");
    this.save({ ...r, mode: to as PublishMode });
    return this.status();
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
    this.save({ mode: r.mode, device: { deviceId: done.deviceId, accountId: p.accountId, name: deviceName.trim(), pairedAt: this.now() } });
    return this.status();
  }

  cancel(): ConnectStatus {
    const r = this.rec();
    this.state.deleteSecret(TOKEN);
    this.save({ mode: r.mode, ...(r.device ? { device: r.device } : {}) });
    return this.status();
  }

  /** Forget the ownership binding locally and return to local-only. (Removing the device on the hosted side is a separate Connect step.) */
  unpair(): ConnectStatus {
    this.state.deleteSecret(TOKEN);
    this.save({ mode: "local" });
    return this.status();
  }

  status(): ConnectStatus {
    const r = this.rec(), p = r.pairing;
    const out: ConnectStatus = { mode: r.mode, paired: !!r.device, ...(r.device ? { device: r.device } : {}) };
    if (p) out.pairing = { id: p.id, state: this.now() > p.expiresAt ? "expired" : p.state, approvalUrl: pairingApprovalUrl(p.id), expiresAt: p.expiresAt, ...(p.accountId ? { selectedOwner: p.accountId } : {}) };
    return out;
  }
}
