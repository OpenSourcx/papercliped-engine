import { randomBytes } from "node:crypto";
import { HttpError } from "./http.ts";
import type { HttpFetch } from "./connectors.ts";
import { CLOUDFLARE_PERMISSIONS, type Publishing, type PublishZone } from "./publishing.ts";
import type { StateStore } from "./state.ts";
import type { TunnelHelper, TunnelHelperStatus } from "./tunnelHelper.ts";

/**
 * Self-managed Cloudflare: provisions ONE stable named tunnel for this device with the customer's own API token.
 *
 *   token ok -> domain chosen -> tunnel created -> DNS created -> connector running -> reachable
 *
 * Every step is recorded as it completes, so a failure leaves a resumable record (run it again: finished steps are
 * skipped, created objects are adopted by id or name, nothing is duplicated) and Remove deletes exactly what was created.
 * The tunnel run token is fetched from Cloudflare and handed straight to the root publishing helper over its private
 * socket. It is never stored here, returned, logged or shown to a browser or an organisation agent.
 * No Cloudflare Worker is involved: a Tunnel is an outbound cloudflared connection.
 */
export type StepId = "token" | "zone" | "tunnel" | "dns" | "connector" | "reachable";
const STEPS: { id: StepId; label: string }[] = [
  { id: "token", label: "API token accepted" },
  { id: "zone", label: "Domain chosen" },
  { id: "tunnel", label: "Named tunnel created and pointed at this device" },
  { id: "dns", label: "DNS record created" },
  { id: "connector", label: "Connector (cloudflared) running" },
  { id: "reachable", label: "Address reachable from the internet" },
];

interface Failure { step: StepId; code: string; message: string; at: number }
export interface DnsConflict { type: string; content: string; proxied?: boolean }
interface Deployment {
  zoneId: string; zoneName: string; accountId: string; label: string; hostname: string;
  tunnelName: string; tunnelId?: string; dnsRecordId?: string; replaced?: DnsConflict;
  done: Partial<Record<StepId, number>>; failure?: Failure; conflict?: DnsConflict; startedAt: number; updatedAt: number;
}

export interface DeploymentView {
  state: "none" | "failed" | "needs_confirmation" | "connecting" | "running" | "stopped";
  hostname?: string; zone?: string; tunnelId?: string;
  steps: { id: StepId; label: string; state: "done" | "todo" | "failed" }[];
  message: string;
  failure?: { step: StepId; code: string; message: string };
  /** An existing record at the hostname that is not ours; nothing changes until the administrator confirms replacing it. */
  conflict?: DnsConflict;
  helper?: TunnelHelperStatus | { error: string };
}

export interface PermissionCheck {
  tokenOk: boolean;
  checks: { id: string; label: string; required: boolean; state: "ok" | "missing" | "unknown"; detail: string }[];
  accounts: { id: string; name?: string }[];
  /** True only when no required permission is known to be missing. */
  ready: boolean;
  guide: typeof CLOUDFLARE_PERMISSIONS;
}

const DEPLOYMENT = "publishing.cloudflare.deployment";
const DEVICE = "publishing.cloudflare.device";
const ORIGIN = "https://127.0.0.1:443";
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RESERVED = new Set(["www", "mail", "smtp", "imap", "pop", "ftp", "ns1", "ns2", "autodiscover", "cpanel", "webmail"]);

const message = (e: unknown) => e instanceof Error ? e.message : String(e);
const code = (e: unknown) => e instanceof HttpError ? e.code : "failed";

export class CloudflareProvision {
  private readonly pub: Publishing;
  private readonly state: StateStore;
  private readonly helper: TunnelHelper;
  private readonly fetch: HttpFetch;
  private readonly now: () => number;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(pub: Publishing, state: StateStore, helper: TunnelHelper, fetch: HttpFetch, now: () => number = Date.now) {
    this.pub = pub; this.state = state; this.helper = helper; this.fetch = fetch; this.now = now;
  }

  private rec(): Deployment | undefined { return this.state.getSetting<Deployment>(DEPLOYMENT); }
  private save(d: Deployment | undefined) { this.state.setSetting(DEPLOYMENT, d ? { ...d, updatedAt: this.now() } : undefined); }
  private serial<T>(fn: () => Promise<T>): Promise<T> { const r = this.chain.then(fn, fn); this.chain = r.catch(() => {}); return r; }
  has(): boolean { return this.rec() !== undefined; }
  /** Requests arrive through our tunnel (client address from CF-Connecting-IP) once the connector has been started. */
  tunnelTrusted(): boolean { return !!this.rec()?.done.connector; }

  /** Stable per device, survives Remove, so re-creating after a lost record adopts the same tunnel name instead of piling up tunnels. */
  private deviceId(): string {
    let id = this.state.getSetting<string>(DEVICE);
    if (!id) { id = randomBytes(4).toString("hex"); this.state.setSetting(DEVICE, id); }
    return id;
  }

  // ---- Permission self-check

  async permissions(zoneName?: unknown): Promise<PermissionCheck> {
    const checks: PermissionCheck["checks"] = [];
    const add = (id: string, state: "ok" | "missing" | "unknown", detail: string) => {
      const p = CLOUDFLARE_PERMISSIONS.find((x) => x.id === id)!;
      checks.push({ id, label: p.label, required: p.required, state, detail });
    };
    const out = (tokenOk: boolean, accounts: PermissionCheck["accounts"] = []): PermissionCheck => ({ tokenOk, checks, accounts, ready: tokenOk && !checks.some((c) => c.required && c.state === "missing"), guide: CLOUDFLARE_PERMISSIONS });
    try { await this.pub.cf("/user/tokens/verify", { need: "a valid token" }); } catch (e) {
      // An account-owned token is not a user token; it is checked below through what it can actually do.
      if (code(e) !== "token_invalid" && code(e) !== "missing_permission") throw e;
      if (code(e) === "token_invalid") {
        try { await this.pub.cf("/zones?per_page=1", { need: "Zone: Zone: Read" }); } catch (e2) {
          if (code(e2) === "token_invalid") return out(false);
          if (code(e2) !== "missing_permission") throw e2;
        }
      }
    }
    let zones: PublishZone[] = [];
    try { zones = await this.pub.zones(); add("zone-read", "ok", zones.length ? `${zones.length} active domain${zones.length === 1 ? "" : "s"} found.` : "Allowed, but this token can see no active domain. Add the domain to the token's zone resources."); }
    catch (e) { if (code(e) !== "missing_permission") throw e; add("zone-read", "missing", "Cloudflare refused to list domains."); }
    let accounts: PermissionCheck["accounts"] = [];
    try {
      const a = await this.pub.cf<{ id: string; name?: string }[]>("/accounts?per_page=50", { need: "Account: Account Settings: Read" });
      accounts = (Array.isArray(a.result) ? a.result : []).filter((x) => typeof x?.id === "string").map((x) => ({ id: x.id, ...(typeof x.name === "string" ? { name: x.name } : {}) }));
      add("account-read", "ok", "Allowed.");
    } catch (e) {
      if (code(e) !== "missing_permission") throw e;
      const seen = new Map(zones.flatMap((z) => z.accountId ? [[z.accountId, z.accountName] as const] : []));
      accounts = [...seen].map(([id, name]) => ({ id, ...(name ? { name } : {}) }));
      add("account-read", "unknown", "Not granted. That is fine: the account is taken from your domain.");
    }
    const zone = zones.find((z) => z.name === (typeof zoneName === "string" ? zoneName.trim().toLowerCase() : "")) ?? zones[0];
    const account = zone?.accountId ?? accounts[0]?.id;
    if (account) {
      try { await this.pub.cf(`/accounts/${account}/cfd_tunnel?is_deleted=false&per_page=1`, { need: "Account: Cloudflare Tunnel: Edit" }); add("tunnel-edit", "ok", "Tunnels can be listed. Edit is confirmed when the tunnel is created."); }
      catch (e) { if (code(e) !== "missing_permission") throw e; add("tunnel-edit", "missing", "Cloudflare refused to list tunnels in this account."); }
    } else add("tunnel-edit", "unknown", "Could not tell which account to check: no domain is visible to this token.");
    if (zone) {
      try { await this.pub.cf(`/zones/${zone.id}/dns_records?per_page=1`, { need: "Zone: DNS: Edit" }); add("dns-edit", "ok", "DNS records can be read. Edit is confirmed when the record is created."); }
      catch (e) { if (code(e) !== "missing_permission") throw e; add("dns-edit", "missing", `Cloudflare refused to read DNS records for ${zone.name}.`); }
    } else add("dns-edit", "unknown", "No domain to check.");
    return out(true, accounts);
  }

  // ---- Provision

  private validate(zone: unknown, sub: unknown) {
    const zoneName = typeof zone === "string" ? zone.trim().toLowerCase() : "";
    const label = typeof sub === "string" ? sub.trim().toLowerCase() : "";
    if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(zoneName)) throw new HttpError(400, "bad_zone", "Choose a valid Cloudflare domain.");
    if (!LABEL.test(label)) throw new HttpError(400, "bad_subdomain", "Use one subdomain label: letters, numbers and hyphens only.");
    if (RESERVED.has(label)) throw new HttpError(400, "bad_subdomain", `"${label}" is commonly used for something else on a domain. Choose another name such as "app" or "pve".`);
    return { zoneName, label };
  }

  /** Create the address, or resume/repair it. Idempotent: the same input runs only the steps that are not finished. */
  async provision(zone: unknown, subdomain: unknown, opts: { confirmReplace?: boolean } = {}): Promise<DeploymentView> {
    const { zoneName, label } = this.validate(zone, subdomain);
    return this.serial(async () => {
      const hostname = `${label}.${zoneName}`;
      let d = this.rec();
      if (d && d.hostname !== hostname) throw new HttpError(409, "deployment_exists", `This device already has ${d.hostname}. A device has one stable address: remove it first to use ${hostname}.`);
      const t0 = this.now();
      try {
        if (!d) {
          const zones = await this.pub.zones();
          const z = zones.find((x) => x.name === zoneName);
          if (!z) throw new HttpError(404, "zone_not_found", `${zoneName} is not an active domain this token can use. Check the domain's status in Cloudflare and the token's zone resources.`);
          if (!z.accountId) throw new HttpError(502, "no_account", "Cloudflare did not say which account owns this domain.");
          d = { zoneId: z.id, zoneName, accountId: z.accountId, label, hostname, tunnelName: `epaperclip-${this.deviceId()}`, done: { token: t0, zone: t0 }, startedAt: t0, updatedAt: t0 };
          this.save(d);
        }
        d = await this.run(d, !!opts.confirmReplace);
      } catch (e) {
        const step = this.currentStep(d);
        if (d) { d.failure = { step, code: code(e), message: message(e), at: this.now() }; this.save(d); }
        else throw e; // nothing exists yet, so there is nothing to resume: report the real reason
      }
      return this.view(false);
    });
  }

  private currentStep(d: Deployment | undefined): StepId { return STEPS.find((s) => !d?.done[s.id])?.id ?? "reachable"; }

  private async run(d: Deployment, confirm: boolean): Promise<Deployment> {
    delete d.failure; delete d.conflict;
    const acct = `/accounts/${d.accountId}/cfd_tunnel`;
    // Tunnel: adopt by recorded id, else by our deterministic name, else create.
    if (!d.done.tunnel) {
      if (!d.tunnelId) {
        const found = await this.pub.cf<{ id: string; name: string; config_src?: string }[]>(`${acct}?name=${encodeURIComponent(d.tunnelName)}&is_deleted=false`, { need: "Account: Cloudflare Tunnel: Edit" });
        const same = (found.result ?? []).find((t) => t.name === d.tunnelName);
        if (same) {
          if (same.config_src && same.config_src !== "cloudflare") throw new HttpError(409, "tunnel_foreign", `A tunnel named ${d.tunnelName} already exists but is managed locally, not from Cloudflare. Delete it in Cloudflare (Zero Trust, Networks, Tunnels) and try again.`);
          d.tunnelId = same.id;
        } else {
          const created = await this.pub.cf<{ id: string }>(acct, { method: "POST", need: "Account: Cloudflare Tunnel: Edit", body: { name: d.tunnelName, config_src: "cloudflare" } });
          if (typeof created.result?.id !== "string") throw new HttpError(502, "bad_answer", "Cloudflare did not return the new tunnel's id.");
          d.tunnelId = created.result.id;
        }
        this.save(d);
      }
      await this.pub.cf(`${acct}/${d.tunnelId}/configurations`, { method: "PUT", need: "Account: Cloudflare Tunnel: Edit", body: { config: { ingress: [{ hostname: d.hostname, service: ORIGIN, originRequest: { noTLSVerify: true } }, { service: "http_status:404" }] } } });
      d.done.tunnel = this.now(); this.save(d);
    }
    // DNS: one proxied CNAME to the tunnel. A record that is not ours is never touched without confirmation.
    if (!d.done.dns) {
      const target = `${d.tunnelId}.cfargotunnel.com`;
      const body = { type: "CNAME", name: d.hostname, content: target, proxied: true, comment: `Managed by ePaperclip (${d.tunnelName})` };
      const zone = `/zones/${d.zoneId}/dns_records`;
      const existing = await this.pub.cf<{ id: string; type: string; content: string; proxied?: boolean }[]>(`${zone}?name=${encodeURIComponent(d.hostname)}`, { need: "Zone: DNS: Edit" });
      const records = (existing.result ?? []).filter((r) => typeof r?.id === "string");
      const mine = records.find((r) => r.id === d.dnsRecordId) ?? records.find((r) => r.type === "CNAME" && r.content === target);
      if (mine) {
        if (!(mine.content === target && mine.proxied === true)) await this.pub.cf(`${zone}/${mine.id}`, { method: "PUT", need: "Zone: DNS: Edit", body });
        d.dnsRecordId = mine.id;
      } else if (records.length) {
        const first = records[0]!;
        const c: DnsConflict = { type: first.type, content: first.content, ...(typeof first.proxied === "boolean" ? { proxied: first.proxied } : {}) };
        if (!confirm) { d.conflict = c; this.save(d); throw new HttpError(409, "dns_conflict", `${d.hostname} already has a ${c.type} record pointing at ${c.content.slice(0, 80)}. ePaperclip will not change it unless you confirm replacing it.`); }
        for (const r of records) await this.pub.cf(`${zone}/${r.id}`, { method: "DELETE", need: "Zone: DNS: Edit" });
        d.replaced = c;
        d.dnsRecordId = await this.createRecord(zone, body);
      } else d.dnsRecordId = await this.createRecord(zone, body);
      d.done.dns = this.now(); this.save(d);
    }
    // Connector: the run token goes from Cloudflare to the root helper and nowhere else. Always re-installed on a run, which also repairs a stopped or rotated connector.
    {
      const token = (await this.pub.cf<string>(`${acct}/${d.tunnelId}/token`, { need: "Account: Cloudflare Tunnel: Edit" })).result;
      if (typeof token !== "string" || token.length < 20) throw new HttpError(502, "bad_answer", "Cloudflare did not return a tunnel run token.");
      try { await this.helper.install("self", token); } catch (e) { throw new HttpError(502, "helper_error", message(e)); }
      d.done.connector = this.now(); this.save(d);
    }
    return d;
  }

  private async createRecord(zone: string, body: unknown): Promise<string> {
    const r = await this.pub.cf<{ id: string }>(zone, { method: "POST", need: "Zone: DNS: Edit", body });
    if (typeof r.result?.id !== "string") throw new HttpError(502, "bad_answer", "Cloudflare did not return the new DNS record's id.");
    return r.result.id;
  }

  // ---- Status

  /** Live view: the recorded steps plus the connector's state and an end-to-end probe through Cloudflare. */
  status(): Promise<DeploymentView> { return this.view(true); }

  private async probe(hostname: string): Promise<boolean> {
    try {
      const r = await this.fetch(`https://${hostname}/api/health`, { signal: AbortSignal.timeout(6000) });
      if (!r.ok) return false;
      return (await r.json() as { ok?: boolean }).ok === true;
    } catch { return false; }
  }

  private async view(live: boolean): Promise<DeploymentView> {
    const d = this.rec();
    if (!d) return { state: "none", steps: STEPS.map((s) => ({ ...s, state: "todo" as const })), message: "No address is set up. Choose a domain and a name to create one." };
    let helper: DeploymentView["helper"];
    try { helper = await this.helper.status(); } catch (e) { helper = { error: message(e) }; }
    const up = !!helper && !("error" in helper) && helper.owner === "self" && helper.active;
    const done: Partial<Record<StepId, number>> = { ...d.done };
    if (done.connector && !up) delete done.connector; // the record says started; the machine says otherwise
    if (live && done.connector && !(await this.probe(d.hostname))) delete done.reachable;
    else if (live && done.connector) done.reachable = this.now();
    else if (!live) delete done.reachable;
    const failStep = d.failure?.step;
    const steps = STEPS.map((s) => ({ ...s, state: (failStep === s.id ? "failed" : done[s.id] ? "done" : "todo") as "done" | "todo" | "failed" }));
    const base = { hostname: d.hostname, zone: d.zoneName, ...(d.tunnelId ? { tunnelId: d.tunnelId } : {}), steps, ...(helper ? { helper } : {}) };
    if (d.conflict) return { ...base, state: "needs_confirmation", conflict: d.conflict, message: `${d.hostname} already has a ${d.conflict.type} record that ePaperclip did not create. Replace it to continue, or choose another name.` };
    if (d.failure) return { ...base, state: "failed", failure: { step: d.failure.step, code: d.failure.code, message: d.failure.message }, message: d.failure.message };
    if (!done.connector) return { ...base, state: "stopped", message: d.done.connector ? "The connector on this device is not running. Press Resume to start it again." : "Set-up is not finished. Press Resume to continue." };
    if (done.reachable) return { ...base, state: "running", message: `${d.hostname} reaches this device through Cloudflare.` };
    return { ...base, state: "connecting", message: live ? "The connector is running, but the address does not answer yet. A new DNS record and tunnel can take up to a minute." : "The connector was started. Checking that the address answers…" };
  }

  // ---- Stop / remove

  /** Leaving self-managed mode: stop the connector but keep the Cloudflare objects so coming back is quick. */
  async stop(): Promise<void> {
    await this.serial(async () => {
      const d = this.rec();
      if (!d) return;
      try { await this.helper.remove("self"); } catch { return; }
      delete d.done.connector; delete d.done.reachable; this.save(d);
    });
  }

  /**
   * Full teardown: stop the connector, delete the DNS record and the tunnel. Each object is removed only if this device created
   * it (by recorded id), and already-gone objects count as done. A failure keeps the record so Remove can be run again.
   */
  remove(): Promise<DeploymentView> {
    return this.serial(async () => {
      const d = this.rec();
      if (!d) return this.view(false);
      try {
        try { await this.helper.remove("self"); } catch (e) { throw new HttpError(502, "helper_error", message(e)); }
        delete d.done.connector; delete d.done.reachable;
        if (d.dnsRecordId) {
          await this.pub.cf(`/zones/${d.zoneId}/dns_records/${d.dnsRecordId}`, { method: "DELETE", need: "Zone: DNS: Edit", allow404: true });
          delete d.dnsRecordId; delete d.done.dns; this.save(d);
        }
        if (d.tunnelId) {
          const t = `/accounts/${d.accountId}/cfd_tunnel/${d.tunnelId}`;
          await this.pub.cf(`${t}/connections`, { method: "DELETE", need: "Account: Cloudflare Tunnel: Edit", allow404: true });
          await this.pub.cf(t, { method: "DELETE", need: "Account: Cloudflare Tunnel: Edit", allow404: true });
          delete d.tunnelId; delete d.done.tunnel; this.save(d);
        }
        this.save(undefined);
      } catch (e) {
        d.failure = { step: d.dnsRecordId ? "dns" : "tunnel", code: code(e), message: `Removal stopped: ${message(e)} Press Remove again to finish.`, at: this.now() };
        this.save(d);
      }
      return this.view(false);
    });
  }
}
