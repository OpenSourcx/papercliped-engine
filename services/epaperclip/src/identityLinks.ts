import { createHash, randomBytes, randomUUID } from "node:crypto";
import { HttpError } from "./http.ts";
import type { HttpFetch } from "./connectors.ts";
import type { StateStore } from "./state.ts";
import { PaperclipedDeviceIdentity } from "./paperclipedAccount.ts";
import { newVerifier, sessionBinding, type IdentityAction } from "./identityLinkCrypto.ts";

/**
 * Device side of the identity-link contract (docs/ACCESS-IDENTITY-LINK-CONTRACT.md, v2.1).
 *
 * A link is only an explicit association between one Papercliped account and one local Proxmox principal on this
 * machine. It grants no Proxmox permission and is independent of the remote-access mode: linking works in local,
 * cloudflare-self and connect, and the device only needs its existing free registration with Connect.
 *
 * The Connect side is not implemented in this repository. Its routes are called with the same device key, timestamp
 * and ECDSA P-256 signature as pairing and tunnel credentials; tests use a fake that really verifies them. One field is
 * sent that the contract's start table omits: `linkId` is generated on the device so the userCode hash, the verifier
 * and the session binding can all be built before the request. Connect stores it as the row id.
 */

export type LinkKind = "association" | "federated";
export type LinkState = "starting" | "awaiting_account" | "awaiting_confirm" | "awaiting_admin" | "active" | "orphaned" | "revoked" | "denied" | "expired" | "canceled";

export interface LocalPrincipal { userid: string; realm: string }
export interface LinkAccount { id: string; displayName?: string; idSuffix?: string }
export interface PairedDevice { deviceId: string; accountId: string; name: string }

interface LinkRecord {
  linkId: string;
  deviceId: string;
  kind: LinkKind;
  principal: LocalPrincipal;
  /** The local principal that started a federated link; for an association link, the same principal. */
  requestedBy: LocalPrincipal;
  sessionBinding: string;
  state: LinkState;
  account?: LinkAccount;
  role?: "owner" | "member";
  approvedBy?: string;
  createdAt: number;
  expiresAt: number;
  approvedAt?: number;
  linkedAt?: number;
  returnOrigin: string;
  returnPath: string;
  challenge?: string;
  userCodeHash?: string;
  /** A node administrator started it, so no second local consent is needed. */
  starterAdmin: boolean;
  preapprovalId?: string;
  replaces?: string;
  pendingRevoke?: boolean;
  lastError?: string;
}

interface Preapproval {
  id: string;
  principal: LocalPrincipal;
  kind: LinkKind;
  boundAccountId?: string;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
}

export interface LinkView {
  linkId: string;
  kind: LinkKind;
  principal: LocalPrincipal;
  /** The local person who started it (the same principal for an association link). */
  requestedBy: LocalPrincipal;
  state: LinkState;
  account?: LinkAccount;
  role?: "owner" | "member";
  approvedBy?: string;
  requestedAt: number;
  expiresAt: number;
  linkedAt?: number;
  needsAdminApproval: boolean;
}

export interface StartView extends LinkView {
  userCode: string;
  approvalUrl: string;
}

const LINKS = "identity.links";
const PREAPPROVALS = "identity.preapprovals";
const OIDC = "identity.oidc";
const SECRET = (linkId: string) => `identity.link.${linkId}.verifier`;
const MAX_LINKS = 200;
const MAX_PREAPPROVALS = 50;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const TERMINAL: LinkState[] = ["revoked", "denied", "expired", "canceled"];
const ORIGIN_PATH = new Set(["/", "/access"]);
const USERID = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;
const REALM = /^[A-Za-z][A-Za-z0-9._-]{0,31}$/;
const ACCOUNT = /^[A-Za-z0-9_-]{3,128}$/;

const codeHash = (linkId: string, code: string) => createHash("sha256").update(`papercliped-connect:link-code:v1:${linkId}:${code}`).digest("base64url");
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function principalOf(username: string): LocalPrincipal {
  const at = username.lastIndexOf("@");
  if (at <= 0) throw new HttpError(400, "bad_principal", "That session has no Proxmox realm.");
  return { userid: username.slice(0, at), realm: username.slice(at + 1) };
}

function accountOf(raw: unknown): LinkAccount | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const a = raw as Record<string, unknown>;
  if (typeof a.id !== "string" || !ACCOUNT.test(a.id)) return null;
  return {
    id: a.id,
    ...(typeof a.displayName === "string" && a.displayName.trim() ? { displayName: a.displayName.trim().slice(0, 120) } : {}),
    ...(typeof a.idSuffix === "string" && a.idSuffix ? { idSuffix: a.idSuffix.slice(-8) } : {}),
  };
}

export interface IdentityOptions {
  /** The registered device, or undefined while this machine is not paired. */
  device: () => PairedDevice | undefined;
  /** Where the approval page lives. Connect returns a path; this is the host it is resolved against. */
  approvalBase?: string;
  /** Best-effort audit callback. Identity actions never fail because auditing does. */
  audit?: (action: string, target: string, detail?: string) => void;
  /** Revokes console sessions and OAuth/MCP grants that derive from a federated link. */
  onLinkRevoked?: (linkId: string, principal: LocalPrincipal) => Promise<void> | void;
  /** True when a Papercliped OIDC realm is configured on this device. */
  federationEnabled?: () => boolean;
}

export class IdentityLinks {
  private readonly state: StateStore;
  private readonly fetch: HttpFetch;
  private readonly baseUrl: string;
  private readonly now: () => number;
  private readonly o: IdentityOptions;
  private readonly identity: PaperclipedDeviceIdentity;
  private readonly approvalBase: string;
  private chain: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;

  constructor(state: StateStore, fetch: HttpFetch, baseUrl: string, now: () => number, opts: IdentityOptions) {
    this.state = state;
    this.fetch = fetch;
    this.now = now;
    this.o = opts;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.identity = new PaperclipedDeviceIdentity(state);
    this.approvalBase = (opts.approvalBase ?? "https://console.papercliped.co").replace(/\/+$/, "");
  }

  // ---- Storage

  private links = (): LinkRecord[] => {
    const v = this.state.getSetting<LinkRecord[]>(LINKS);
    return Array.isArray(v) ? v.filter((x) => x && typeof x.linkId === "string") : [];
  };
  private save(links: LinkRecord[]) {
    this.state.setSetting(LINKS, links.slice(-MAX_LINKS));
  }
  private rec(linkId: string): LinkRecord | undefined {
    return this.links().find((x) => x.linkId === linkId);
  }
  private put(record: LinkRecord) {
    const links = this.links();
    const i = links.findIndex((x) => x.linkId === record.linkId);
    if (i >= 0) links[i] = record;
    else links.push(record);
    this.save(links);
  }
  private preapprovals = (): Preapproval[] => {
    const v = this.state.getSetting<Preapproval[]>(PREAPPROVALS);
    return Array.isArray(v) ? v : [];
  };
  private savePreapprovals(v: Preapproval[]) { this.state.setSetting(PREAPPROVALS, v.slice(-MAX_PREAPPROVALS)); }

  private audit(action: string, target: string, detail?: string) {
    try { this.o.audit?.(action, target, detail); } catch { /* an audit failure must not break a link */ }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  private device(): PairedDevice {
    const d = this.o.device();
    if (!d) throw new HttpError(409, "not_paired", "Pair this machine with your Papercliped account first.");
    return d;
  }

  private verifier(linkId: string): string | null { return this.state.getSecret(SECRET(linkId)); }
  private dropVerifier(linkId: string) { this.state.deleteSecret(SECRET(linkId)); }

  /** Deletes expired in-flight links and their sealed verifiers. Safe to call at any time. */
  sweep() {
    const t = this.now();
    const links = this.links();
    let changed = false;
    for (const l of links) {
      if ((l.state === "awaiting_account" || l.state === "awaiting_confirm" || l.state === "awaiting_admin" || l.state === "starting") && l.expiresAt <= t) {
        l.state = "expired"; l.expiresAt = t; this.dropVerifier(l.linkId); changed = true;
      }
    }
    if (changed) this.save(links);
    const pre = this.preapprovals();
    const live = pre.filter((p) => p.expiresAt > t);
    if (live.length !== pre.length) this.savePreapprovals(live);
    return changed;
  }

  private view(l: LinkRecord, account?: LinkAccount): LinkView {
    const owner = this.o.device()?.accountId;
    return {
      linkId: l.linkId, kind: l.kind, principal: l.principal, requestedBy: l.requestedBy, state: l.state,
      ...(l.account ?? account ? { account: l.account ?? account } : {}),
      ...(l.role ? { role: l.role } : {}),
      ...(l.approvedBy ? { approvedBy: l.approvedBy } : {}),
      requestedAt: l.createdAt, expiresAt: l.expiresAt,
      ...(l.linkedAt ? { linkedAt: l.linkedAt } : {}),
      needsAdminApproval: l.kind === "federated" || (!!l.account && l.account.id !== owner && !l.starterAdmin && !l.preapprovalId),
    };
  }

  private active(principal?: LocalPrincipal, kind?: LinkKind): LinkRecord[] {
    return this.links().filter((l) => l.state === "active" && (!principal || (l.principal.userid === principal.userid && l.principal.realm === principal.realm)) && (!kind || l.kind === kind));
  }

  /** The federated principal behind an account, if this device has an active link for it. */
  federatedFor(userid: string, realm: string): LinkRecord | undefined {
    return this.links().find((l) => l.state === "active" && l.kind === "federated" && l.principal.userid === userid && l.principal.realm === realm);
  }

  link(linkId: string): LinkView | undefined {
    const l = this.rec(linkId);
    return l ? this.view(l) : undefined;
  }

  linksFor(userid: string, realm: string, admin: boolean): LinkView[] {
    this.sweep();
    return this.links()
      .filter((l) => admin || (l.principal.userid === userid && l.principal.realm === realm) || (l.requestedBy.userid === userid && l.requestedBy.realm === realm))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((l) => this.view(l));
  }

  /** Links waiting for a local administrator, same two identities on screen before any button works. */
  requests(): LinkView[] {
    this.sweep();
    return this.links().filter((l) => l.state === "awaiting_admin").map((l) => this.view(l));
  }

  // ---- Remote calls (device-signed)

  private async call(path: string, action: IdentityAction, fields: readonly (readonly [string, string | number])[], extra: Record<string, unknown> = {}, httpMethod: "POST" | "DELETE" = "POST"): Promise<{ status: number; body: Record<string, unknown> }> {
    const ts = Math.floor(this.now() / 1000);
    let signature: string;
    try {
      signature = this.identity.signIdentity(action, fields);
    } catch (e) {
      throw new HttpError(500, "device_key", `This machine's Connect key is unusable: ${message(e)}`);
    }
    const id = this.identity.publicIdentity();
    let res: Response;
    try {
      res = await this.fetch(this.baseUrl + path, {
        method: httpMethod,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicKeyJwk: id.publicKeyJwk, ts, signature, ...extra }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new HttpError(502, "connect_unreachable", "Papercliped Connect can't be reached right now. Nothing changed on this machine; local use is not affected.");
    }
    if (res.status >= 500) throw new HttpError(502, "connect_unavailable", "Papercliped Connect is having trouble. Nothing changed on this machine; try again shortly.");
    let body: Record<string, unknown> = {};
    try { body = await res.json() as Record<string, unknown>; } catch { /* an empty or non-JSON refusal below */ }
    if (res.ok) return { status: res.status, body };
    if (res.status === 429) throw new HttpError(429, "rate_limited", "Connect asked this machine to slow down. Try again shortly.");
    const code = typeof body.error === "string" ? body.error : "connect_refused";
    const status = res.status === 410 ? 410 : res.status === 409 ? 409 : res.status === 403 ? 403 : 400;
    throw new HttpError(status, code, typeof body.message === "string" ? body.message.slice(0, 300) : "Papercliped Connect declined this step.");
  }

  private approvalUrl(raw: unknown, linkId: string): string {
    if (typeof raw !== "string" || !raw) return `${this.approvalBase}/devices/link?lid=${encodeURIComponent(linkId)}`;
    let url: URL;
    try { url = new URL(raw, this.approvalBase); } catch { throw new HttpError(502, "connect_invalid", "Connect returned an unusable approval address."); }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) throw new HttpError(502, "connect_invalid", "Connect returned an approval address that is not https.");
    if (url.username || url.password) throw new HttpError(502, "connect_invalid", "Connect returned an approval address with a login.");
    return url.href;
  }

  // ---- Start

  async start(p: { sessionId: string; username: string; origin: string; returnTo?: unknown; kind?: unknown; replaceLinkId?: unknown; isAdmin: boolean }): Promise<StartView> {
    this.sweep();
    const device = this.device();
    const kind: LinkKind = p.kind === "federated" ? "federated" : "association";
    if (p.kind !== undefined && p.kind !== "association" && p.kind !== "federated") throw new HttpError(400, "bad_request", "kind is association or federated");
    if (kind === "federated" && !(this.o.federationEnabled?.() ?? false)) throw new HttpError(409, "federation_off", "Sign in with Papercliped is not enabled on this machine.");
    const starter = principalOf(p.username);
    const principal: LocalPrincipal = kind === "federated" ? { userid: "*", realm: "papercliped" } : starter;
    const returnPath = p.returnTo === undefined ? "/access" : p.returnTo;
    if (typeof returnPath !== "string" || !ORIGIN_PATH.has(returnPath)) throw new HttpError(400, "bad_return", "Return to / or /access on this device.");
    let origin: URL;
    try { origin = new URL(p.origin); } catch { throw new HttpError(400, "bad_return", "This device's own address is not usable."); }
    if (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["127.0.0.1", "localhost"].includes(origin.hostname))) throw new HttpError(400, "bad_return", "Links need this device's https address.");
    if (origin.username || origin.password || origin.search || origin.hash) throw new HttpError(400, "bad_return", "This device's own address is not usable.");

    const links = this.links();
    const inFlight = links.find((l) => (kind === "federated" ? l.kind === "federated" && l.requestedBy.userid === starter.userid && l.requestedBy.realm === starter.realm : l.principal.userid === starter.userid && l.principal.realm === starter.realm && l.kind === kind) && ["starting", "awaiting_account", "awaiting_confirm", "awaiting_admin"].includes(l.state));
    const existing = kind === "federated" ? links.find((l) => l.kind === "federated" && l.requestedBy.userid === starter.userid && l.requestedBy.realm === starter.realm && l.state === "active") : this.active(starter, kind)[0];
    if (existing && kind === "federated") throw new HttpError(409, "already_linked", "This account already has a Papercliped sign-in link on this machine. Unlink it first.");
    if (existing && p.replaceLinkId !== existing.linkId) throw new HttpError(409, "already_linked", "This Proxmox user already has a linked Papercliped account. Unlink it before linking another.");
    let replaceLinkId = "";
    if (p.replaceLinkId !== undefined) {
      if (typeof p.replaceLinkId !== "string" || !existing || p.replaceLinkId !== existing.linkId) throw new HttpError(409, "not_linked", "There is no active link of yours to replace.");
      replaceLinkId = existing.linkId;
    }
    if (inFlight && inFlight.linkId !== replaceLinkId) throw new HttpError(409, "link_in_progress", "A link for this principal is already waiting. Finish it, cancel it, or wait for it to expire.");

    const linkId = randomUUID();
    const { verifier, challenge } = newVerifier();
    const before = this.now();
    const code = Array.from(randomBytes(8)).map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]!).join("");
    const userCode = `${code.slice(0, 4)}-${code.slice(4)}`;
    const binding = sessionBinding(linkId, p.sessionId);
    const pre = kind === "association" ? this.preapprovals().find((x) => x.expiresAt > before && x.kind === "association" && x.principal.userid === starter.userid && x.principal.realm === starter.realm) : undefined;
    const likelyAdmin = kind === "federated" ? true : !p.isAdmin && !pre;
    const confirmWindowSec = likelyAdmin ? 86_400 : 600;
    const fields: (readonly [string, string | number])[] = [
      ["deviceId", device.deviceId], ["ts", Math.floor(before / 1000)], ["linkId", linkId], ["challenge", challenge],
      ["kind", kind], ["principalUserid", principal.userid], ["principalRealm", principal.realm], ["sessionBinding", binding],
      ["userCodeHash", codeHash(linkId, userCode)], ["returnOrigin", origin.origin], ["returnPath", returnPath],
      ["confirmWindowSec", confirmWindowSec], ["replaceLinkId", replaceLinkId],
    ];
    const out = await this.call(`/api/v1/devices/${device.deviceId}/identity-links`, "start", fields, {
      linkId, challenge, kind, principal, sessionBinding: binding, userCodeHash: codeHash(linkId, userCode),
      returnOrigin: origin.origin, returnPath, confirmWindowSec, replaceLinkId: replaceLinkId || undefined,
    });
    if (out.body.linkId !== linkId) throw new HttpError(502, "connect_invalid", "Connect returned a different link id.");
    const expiresAt = typeof out.body.expiresAt === "number" && Number.isFinite(out.body.expiresAt) ? out.body.expiresAt : before + confirmWindowSec * 1000;
    const record: LinkRecord = {
      linkId, deviceId: device.deviceId, kind, principal, requestedBy: starter, sessionBinding: binding,
      state: "awaiting_account", createdAt: before, expiresAt, returnOrigin: origin.origin, returnPath,
      challenge, userCodeHash: codeHash(linkId, userCode), starterAdmin: kind === "federated" ? false : p.isAdmin,
      ...(pre ? { preapprovalId: pre.id } : {}), ...(replaceLinkId ? { replaces: replaceLinkId } : {}),
    };
    this.state.setSecret(SECRET(linkId), verifier);
    try { this.put(record); } catch (e) {
      this.dropVerifier(linkId);
      throw e;
    }
    this.audit("identity.link.start", linkId, `${kind} ${starter.userid}@${starter.realm}`);
    return { ...this.view(record), userCode, approvalUrl: this.approvalUrl(out.body.approvalPath, linkId) };
  }

  // ---- Poll / confirm

  async poll(linkId: string, sessionId: string, isAdmin: boolean): Promise<LinkView> {
    this.sweep();
    const device = this.device();
    const l = this.rec(linkId);
    if (!l) throw new HttpError(404, "not_found", "No such link on this machine.");
    if (l.sessionBinding !== sessionBinding(linkId, sessionId)) throw new HttpError(403, "session_mismatch", "This link was started in another session.");
    if (l.state === "active" || TERMINAL.includes(l.state)) return this.view(l);
    if (l.expiresAt <= this.now()) throw new HttpError(410, "expired", "This link expired. Start again.");
    const out = await this.call(`/api/v1/devices/${device.deviceId}/identity-links/${linkId}/poll`, "poll", [
      ["deviceId", device.deviceId], ["linkId", linkId], ["ts", Math.floor(this.now() / 1000)],
    ]);
    const state = typeof out.body.state === "string" ? out.body.state : "";
    if (state === "denied" || state === "canceled" || state === "revoked" || state === "expired") {
      l.state = state === "expired" ? "expired" : state === "revoked" ? "revoked" : state === "canceled" ? "canceled" : "denied";
      this.dropVerifier(linkId);
      this.put(l);
      this.audit("identity.link." + l.state, linkId);
      return this.view(l);
    }
    if (state === "approved") {
      const account = accountOf(out.body.account);
      if (!account) throw new HttpError(502, "connect_invalid", "Connect approved the link but did not name the account.");
      l.account = account;
      l.state = "awaiting_confirm";
      if (typeof out.body.role === "string" && (out.body.role === "owner" || out.body.role === "member")) l.role = out.body.role;
      // An owner account needs no second consent; a node administrator can consent for their own principal.
      if (account.id === device.accountId || (isAdmin && l.kind === "association")) l.starterAdmin = l.starterAdmin || isAdmin;
      this.put(l);
      this.audit("identity.link.approved", linkId, account.id);
      return this.view(l);
    }
    return this.view(l);
  }

  private async confirmRemote(l: LinkRecord, approvedBy: string, ensureFederatedPrincipal?: (accountId: string) => Promise<void>): Promise<LinkView> {
    const device = this.device();
    const verifier = this.verifier(l.linkId);
    if (!verifier) throw new HttpError(410, "expired", "The sealed verifier for this link is gone. Start again.");
    if (!l.account) throw new HttpError(409, "bad_state", "No account has approved this link yet.");
    if (l.kind === "federated") {
      if (!ensureFederatedPrincipal) throw new HttpError(409, "federation_off", "Sign in with Papercliped is not set up on this machine.");
      try { await ensureFederatedPrincipal(l.account.id); }
      catch (e) { throw new HttpError(409, "principal_create_failed", `The Proxmox user for this account could not be created: ${message(e)}`); }
      // The federated principal is computed from the approving account, never chosen by the caller.
      l.principal = { userid: l.account.id, realm: "papercliped" };
    }
    const membership = l.account.id === device.accountId ? "owner" : "member";
    const linkExpiresAt = Math.floor(l.expiresAt / 1000);
    const out = await this.call(`/api/v1/devices/${device.deviceId}/identity-links/${l.linkId}/confirm`, "confirm", [
      ["deviceId", device.deviceId], ["linkId", l.linkId], ["ts", Math.floor(this.now() / 1000)], ["kind", l.kind],
      ["accountId", l.account.id], ["principalUserid", l.principal.userid], ["principalRealm", l.principal.realm],
      ["sessionBinding", l.sessionBinding], ["challenge", l.challenge ?? ""], ["linkExpiresAt", linkExpiresAt],
      ["approvedBy", approvedBy], ["membership", membership],
    ], { verifier, accountId: l.account.id, kind: l.kind, principal: l.principal, sessionBinding: l.sessionBinding, challenge: l.challenge ?? "", linkExpiresAt, approvedBy, membership });
    const role = out.body.role === "owner" || out.body.role === "member" ? out.body.role : membership;
    const now = this.now();
    const had = this.links();
    const old = l.replaces ? had.find((x) => x.linkId === l.replaces) : undefined;
    if (old) { old.state = "revoked"; old.lastError = "replaced"; this.put(old); }
    l.state = "active"; l.role = role; l.approvedBy = approvedBy; l.approvedAt ??= now; l.linkedAt = now; l.expiresAt = 0;
    l.pendingRevoke = false; delete l.lastError;
    this.dropVerifier(l.linkId);
    this.put(l);
    if (l.preapprovalId) this.savePreapprovals(this.preapprovals().filter((x) => x.id !== l.preapprovalId));
    this.audit("identity.link.confirmed", l.linkId, `${l.principal.userid}@${l.principal.realm} ${role}`);
    return this.view(l);
  }

  async confirm(p: { linkId: string; sessionId: string; accountId: unknown; username: string; isAdmin: boolean; viaAdmin?: boolean; ensureFederatedPrincipal?: (accountId: string) => Promise<void> }): Promise<LinkView> {
    this.sweep();
    const device = this.device();
    const l = this.rec(p.linkId);
    if (!l) throw new HttpError(404, "not_found", "No such link on this machine.");
    if (l.sessionBinding !== sessionBinding(p.linkId, p.sessionId) && !p.viaAdmin) throw new HttpError(403, "session_mismatch", "This link was started in another session.");
    if (l.state === "active") return this.view(l);
    if (l.state === "expired" || l.expiresAt <= this.now()) throw new HttpError(410, "expired", "This link expired. Start again.");
    if (l.state !== "awaiting_confirm" && l.state !== "awaiting_admin") throw new HttpError(409, "bad_state", "This link isn't ready to confirm.");
    if (typeof p.accountId !== "string" || !l.account || p.accountId !== l.account.id) throw new HttpError(409, "wrong_account", "That isn't the account that approved this machine.");
    const pre = l.preapprovalId ? this.preapprovals().find((x) => x.id === l.preapprovalId) : undefined;
    const preOk = !!pre && pre.expiresAt > this.now() && (!pre.boundAccountId || pre.boundAccountId === l.account.id);
    const owner = l.account.id === device.accountId;
    const needsAdmin = l.kind === "federated" || (!owner && !l.starterAdmin && !preOk);
    const actorIsAdmin = p.viaAdmin || p.isAdmin;
    if (needsAdmin && !actorIsAdmin) {
      l.state = "awaiting_admin";
      // The administrator may act hours later; Connect's start already allowed this longer window when it was expected.
      l.expiresAt = Math.max(l.expiresAt, this.now() + 86_400_000);
      this.put(l);
      this.audit("identity.link.awaiting_admin", p.linkId, `${l.account.id} -> ${l.principal.userid}@${l.principal.realm}`);
      return this.view(l);
    }
    const approvedBy = l.kind === "federated"
      ? (p.username === `${l.requestedBy.userid}@${l.requestedBy.realm}` ? "self-admin" : `admin:${p.username}`)
      : owner ? "owner-account" : p.viaAdmin ? (p.username === `${l.principal.userid}@${l.principal.realm}` ? "self-admin" : `admin:${p.username}`) : preOk ? `preapproval:${l.preapprovalId}` : p.username === `${l.principal.userid}@${l.principal.realm}` ? "self-admin" : "owner-account";
    return this.confirmRemote(l, approvedBy, p.ensureFederatedPrincipal);
  }

  async cancel(linkId: string, sessionId: string, username: string): Promise<{ ok: true; remote: "revoked" | "pending" }> {
    const l = this.rec(linkId);
    if (!l) throw new HttpError(404, "not_found", "No such link on this machine.");
    if (l.sessionBinding !== sessionBinding(linkId, sessionId)) throw new HttpError(403, "session_mismatch", "This link was started in another session.");
    if (l.state === "active") throw new HttpError(409, "bad_state", "This link is active. Unlink it instead.");
    l.state = "canceled"; l.expiresAt = 0; l.pendingRevoke = true;
    this.dropVerifier(linkId);
    this.put(l);
    this.audit("identity.link.cancel", linkId, username);
    const remote = await this.revokeRemote(l, "device", "canceled");
    return { ok: true, remote };
  }

  // ---- Administrator approval and pre-approvals

  async adminApprove(linkId: string, accountId: unknown, admin: string, ensureFederatedPrincipal?: (accountId: string) => Promise<void>): Promise<LinkView> {
    const l = this.rec(linkId);
    if (!l) throw new HttpError(404, "not_found", "No such link on this machine.");
    if (l.state !== "awaiting_admin") throw new HttpError(409, "bad_state", "This link isn't waiting for a local administrator.");
    if (typeof accountId !== "string" || !l.account || accountId !== l.account.id) throw new HttpError(409, "wrong_account", "That isn't the account shown on the request.");
    return this.confirm({ linkId, sessionId: "", accountId, username: admin, isAdmin: true, viaAdmin: true, ...(ensureFederatedPrincipal ? { ensureFederatedPrincipal } : {}) });
  }

  async adminDeny(linkId: string, admin: string, reason?: string): Promise<{ ok: true }> {
    const l = this.rec(linkId);
    if (!l) throw new HttpError(404, "not_found", "No such link on this machine.");
    if (l.state !== "awaiting_admin") throw new HttpError(409, "bad_state", "This link isn't waiting for a local administrator.");
    l.state = "denied"; l.expiresAt = 0; l.pendingRevoke = true;
    this.dropVerifier(linkId);
    this.put(l);
    this.audit("identity.link.denied", linkId, `${admin}${reason ? `: ${reason.slice(0, 120)}` : ""}`);
    await this.revokeRemote(l, "device", reason ? `denied: ${reason.slice(0, 80)}` : "denied");
    return { ok: true };
  }

  preapprovalList(): Preapproval[] { this.sweep(); return this.preapprovals().sort((a, b) => b.createdAt - a.createdAt); }

  addPreapproval(p: { principal: unknown; boundAccountId?: unknown; kind?: unknown; ttlHours?: unknown; admin: string }): Preapproval {
    const raw = p.principal as { userid?: unknown; realm?: unknown } | null;
    if (!raw || typeof raw !== "object" || typeof raw.userid !== "string" || !USERID.test(raw.userid) || typeof raw.realm !== "string" || !REALM.test(raw.realm)) throw new HttpError(400, "bad_request", "principal is { userid, realm }");
    const kind: LinkKind = p.kind === "federated" ? "federated" : "association";
    if (p.kind !== undefined && p.kind !== "association" && p.kind !== "federated") throw new HttpError(400, "bad_request", "kind is association or federated");
    if (p.boundAccountId !== undefined && (typeof p.boundAccountId !== "string" || !ACCOUNT.test(p.boundAccountId))) throw new HttpError(400, "bad_request", "boundAccountId is a Papercliped account id");
    const ttl = p.ttlHours === undefined ? 24 : p.ttlHours;
    if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < 1 || ttl > 72) throw new HttpError(400, "bad_request", "ttlHours is 1 to 72");
    if (this.preapprovals().length >= MAX_PREAPPROVALS) throw new HttpError(409, "too_many", "There are already 50 pre-approvals. Remove one you no longer need.");
    const pre: Preapproval = { id: randomUUID(), principal: { userid: raw.userid, realm: raw.realm }, kind, ...(typeof p.boundAccountId === "string" ? { boundAccountId: p.boundAccountId } : {}), createdBy: p.admin, createdAt: this.now(), expiresAt: this.now() + ttl * 3600_000 };
    this.savePreapprovals([...this.preapprovals(), pre]);
    this.audit("identity.preapproval.add", pre.id, `${pre.principal.userid}@${pre.principal.realm}`);
    return pre;
  }

  removePreapproval(id: string, admin: string): { ok: true } {
    const pre = this.preapprovals();
    if (!pre.some((p) => p.id === id)) throw new HttpError(404, "not_found", "No such pre-approval.");
    this.savePreapprovals(pre.filter((p) => p.id !== id));
    this.audit("identity.preapproval.remove", id, admin);
    return { ok: true };
  }

  // ---- Unlink / revoke

  private async revokeRemote(l: LinkRecord, initiator: string, reason: string): Promise<"revoked" | "pending"> {
    try {
      const device = this.device();
      await this.call(`/api/v1/devices/${device.deviceId}/identity-links/${l.linkId}/revoke`, "revoke", [
        ["deviceId", device.deviceId], ["linkId", l.linkId], ["ts", Math.floor(this.now() / 1000)], ["initiator", initiator], ["reason", reason],
      ], { initiator, reason });
      const cur = this.rec(l.linkId);
      if (cur) { delete cur.pendingRevoke; this.put(cur); }
      return "revoked";
    } catch (e) {
      // A 4xx means Connect already doesn't have it; anything else is retried by reconcile.
      if (e instanceof HttpError && e.status >= 400 && e.status < 500 && e.status !== 429) {
        const cur = this.rec(l.linkId);
        if (cur) { delete cur.pendingRevoke; this.put(cur); }
        return "revoked";
      }
      const cur = this.rec(l.linkId);
      if (cur) { cur.pendingRevoke = true; this.put(cur); }
      return "pending";
    }
  }

  async unlink(linkId: string, p: { username: string; isAdmin: boolean }): Promise<{ ok: true; remote: "revoked" | "pending" }> {
    const l = this.rec(linkId);
    if (!l) throw new HttpError(404, "not_found", "No such link on this machine.");
    const own = p.username === `${l.principal.userid}@${l.principal.realm}` || (l.kind === "federated" && p.username === `${l.principal.userid}@${l.principal.realm}`);
    if (!own && !p.isAdmin) throw new HttpError(403, "forbidden", "Only the linked person or a Proxmox administrator can unlink this.");
    const wasActive = l.state === "active";
    l.state = "revoked"; l.expiresAt = 0; l.pendingRevoke = true; delete l.role;
    this.dropVerifier(linkId);
    this.put(l);
    this.audit("identity.link.unlink", linkId, p.username);
    if (wasActive && l.kind === "federated") {
      try { await this.o.onLinkRevoked?.(linkId, l.principal); } catch { /* local unlink still wins */ }
    }
    const remote = await this.revokeRemote(l, p.username, "unlink");
    return { ok: true, remote };
  }

  /** Unlink every link (unpair, principal removal, owner change). Returns how many were active. */
  async revokeAll(initiator: string, reason: string): Promise<number> {
    let n = 0;
    for (const l of this.links()) {
      if (TERMINAL.includes(l.state)) continue;
      const active = l.state === "active";
      l.state = "revoked"; l.expiresAt = 0; l.pendingRevoke = true; delete l.role;
      this.dropVerifier(l.linkId);
      this.put(l);
      if (active) {
        n++;
        if (l.kind === "federated") { try { await this.o.onLinkRevoked?.(l.linkId, l.principal); } catch { /* best effort */ } }
      }
      await this.revokeRemote(l, initiator, reason);
    }
    return n;
  }

  /** The explicit security action: end all sessions and tokens of the principal, then unlink it. */
  async revokePrincipalAccess(principal: LocalPrincipal, p: { username: string; isAdmin: boolean; endSessions: () => number; revokeTokens: () => number }): Promise<{ sessionsEnded: number; tokensRevoked: number; linksUnlinked: number }> {
    if (p.username !== `${principal.userid}@${principal.realm}` && !p.isAdmin) throw new HttpError(403, "forbidden", "Only that person or a Proxmox administrator can do this.");
    const sessionsEnded = p.endSessions();
    const tokensRevoked = p.revokeTokens();
    let linksUnlinked = 0;
    for (const l of this.links().filter((x) => x.principal.userid === principal.userid && x.principal.realm === principal.realm && x.state === "active")) {
      await this.unlink(l.linkId, p);
      linksUnlinked++;
    }
    this.audit("identity.security.revoke_principal", `${principal.userid}@${principal.realm}`, `${sessionsEnded} sessions, ${tokensRevoked} tokens`);
    return { sessionsEnded, tokensRevoked, linksUnlinked };
  }

  // ---- Reconcile

  async reconcile(): Promise<{ links: LinkView[]; changed: number }> {
    return this.serial(async () => {
      this.sweep();
      const device = this.o.device();
      if (!device) return { links: this.links().map((l) => this.view(l)), changed: 0 };
      let changed = 0;
      // Retry revocations that failed while Connect was unreachable.
      for (const l of this.links().filter((x) => x.pendingRevoke && TERMINAL.includes(x.state))) {
        if ((await this.revokeRemote(l, l.kind === "federated" ? "device" : "device", "reconcile")) === "revoked") changed++;
      }
      let body: Record<string, unknown> = {};
      try {
        const out = await this.call(`/api/v1/devices/${device.deviceId}/identity-links/reconcile`, "reconcile", [
          ["deviceId", device.deviceId], ["ts", Math.floor(this.now() / 1000)], ["cursor", ""],
        ], { cursor: "" });
        body = out.body;
      } catch (e) {
        if (e instanceof HttpError && e.code === "connect_unreachable") return { links: this.links().map((l) => this.view(l)), changed };
        throw e; // 5xx: the caller keeps the previous state and tries later
      }
      const remote = Array.isArray(body.links) ? body.links : [];
      for (const r of remote) {
        if (!r || typeof r !== "object") continue;
        const item = r as Record<string, unknown>;
        if (typeof item.linkId !== "string") continue;
        const l = this.rec(item.linkId);
        if (!l) continue;
        if (item.state === "revoked" || item.state === "denied" || item.state === "expired" || item.state === "canceled") {
          if (l.state === "active" || !TERMINAL.includes(l.state)) {
            l.state = "revoked"; l.expiresAt = 0; this.dropVerifier(l.linkId); this.put(l);
            if (l.kind === "federated") { try { await this.o.onLinkRevoked?.(l.linkId, l.principal); } catch { /* local state already updated */ } }
            changed++;
          }
        }
      }
      return { links: this.links().map((l) => this.view(l)), changed };
    });
  }

  /** Unlink every federated link, e.g. when Sign in with Papercliped is disabled. */
  async revokeFederated(reason: string): Promise<number> {
    let n = 0;
    for (const l of this.links().filter((x) => x.kind === "federated" && !TERMINAL.includes(x.state))) {
      if (l.state === "active") {
        n++;
        try { await this.o.onLinkRevoked?.(l.linkId, l.principal); } catch { /* local state still wins */ }
      }
      l.state = "revoked"; l.expiresAt = 0; l.pendingRevoke = true; delete l.role;
      this.dropVerifier(l.linkId);
      this.put(l);
      await this.revokeRemote(l, "device", reason);
    }
    return n;
  }

  // ---- Papercliped as an OIDC issuer (Sign in with Papercliped)

  oidc(): { issuer: string; clientId: string; realm: "papercliped"; enabledAt: number } | undefined {
    return this.state.getSetting("identity.oidc");
  }

  /** One confidential client per device at Connect. The secret is returned once and goes straight to Proxmox. */
  async registerOidc(redirectUris: string[]): Promise<{ issuer: string; clientId: string; clientSecret: string }> {
    const device = this.device();
    if (!redirectUris.length || redirectUris.length > 8) throw new HttpError(400, "bad_request", "Send 1 to 8 https redirect addresses.");
    for (const u of redirectUris) {
      let url: URL;
      try { url = new URL(u); } catch { throw new HttpError(400, "bad_request", "Each redirect address must be a valid URL."); }
      if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) throw new HttpError(400, "bad_request", "Redirect addresses must be https, except loopback development builds.");
      if (url.username || url.password || url.hash) throw new HttpError(400, "bad_request", "A redirect address cannot carry a login or fragment.");
    }
    const out = await this.call(`/api/v1/devices/${device.deviceId}/oidc-client`, "oidc-register", [
      ["deviceId", device.deviceId], ["ts", Math.floor(this.now() / 1000)], ["redirectUris", redirectUris.join("\n")],
    ], { redirectUris });
    if (typeof out.body.issuer !== "string" || typeof out.body.clientId !== "string" || typeof out.body.clientSecret !== "string") throw new HttpError(502, "connect_invalid", "Connect did not return an OIDC client.");
    return { issuer: out.body.issuer, clientId: out.body.clientId, clientSecret: out.body.clientSecret };
  }

  /** Removes the device's OIDC client at Connect. The realm is removed by the caller, locally and first. */
  async removeOidc(): Promise<void> {
    const device = this.device();
    await this.call(`/api/v1/devices/${device.deviceId}/oidc-client`, "oidc-remove", [
      ["deviceId", device.deviceId], ["ts", Math.floor(this.now() / 1000)],
    ], {}, "DELETE");
  }

  saveOidc(cfg: { issuer: string; clientId: string } | undefined) {
    this.state.setSetting("identity.oidc", cfg ? { ...cfg, realm: "papercliped", enabledAt: this.now() } : undefined);
  }

  /** A 15-minute reconciler independent of the remote-access mode. */
  watch(intervalMs = 15 * 60_000) {
    this.stopped = false;
    const tick = async () => {
      if (this.stopped) return;
      try { await this.reconcile(); } catch { /* state shown by the next successful check */ }
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => void tick(), intervalMs);
      this.timer.unref?.();
    };
    void tick();
  }
  unwatch() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
