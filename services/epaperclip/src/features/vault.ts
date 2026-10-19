import type { EngineGateway } from "../engine.ts";
import type { Session } from "../sessions.ts";
import type { FeatureCtx, FeatureHandler } from "./index.ts";
import { VaultError, vaultFor, type Target, type Vault, type VaultItem } from "./vault-store.ts";

/**
 * The system vault as routes (docs/VAULT.md). Only Proxmox administrators (Sys.Modify on /) use it, and values are
 * write-only: nothing here ever returns one. Changes need `X-EPC-Request: 1` and the Proxmox sign-in, not an API token.
 *
 *   GET    /api/vault              the variables (no values), whether you may manage them, and any sync problems
 *   POST   /api/vault              add one: { name, value, description?, share: "pin"|"ceos", targets? }
 *   PATCH  /api/vault/:id          change value / description / who it is shared with
 *   DELETE /api/vault/:id          remove it here and from every organization it was shared to
 *   GET    /api/vault/ceos         the CEO agents the engine has, across organizations; empty when there are none
 *   POST   /api/vault/sync         write every share again (after an engine restore, or a failed sync)
 */

const ROUTE = /^\/api\/vault(?:\/(ceos|sync|[0-9a-f]{16}))?$/;

interface Company {
  id: string;
  name: string;
}
interface Agent {
  id: string;
  name: string;
  role?: string;
  status?: string;
  adapterConfig?: { env?: Record<string, unknown> } & Record<string, unknown>;
}
interface EngineSecret {
  id: string;
  key?: string;
  name?: string;
}

export interface Ceo {
  companyId: string;
  companyName: string;
  agentId: string;
  name: string;
}

/** Every CEO agent in every organization the signed-in administrator can see. Organizations without one are left out. */
export async function listCeos(gw: EngineGateway, s: Session): Promise<Ceo[]> {
  const companies = await gw.userJson<Company[]>(s, "GET", "/api/companies");
  const out: Ceo[] = [];
  for (const c of Array.isArray(companies) ? companies : []) {
    const agents = await gw.userJson<Agent[]>(s, "GET", `/api/companies/${encodeURIComponent(c.id)}/agents`).catch(() => [] as Agent[]);
    for (const a of Array.isArray(agents) ? agents : []) if (a.role === "ceo" && a.status !== "terminated") out.push({ companyId: c.id, companyName: c.name, agentId: a.id, name: a.name });
  }
  return out;
}

const e = encodeURIComponent;

/** The variables this item is shared as, in the engine, per organization. */
const secretKey = (item: VaultItem) => `VAULT_${item.name}`;

/**
 * Brings the engine in line with one item: a company secret in each organization that has a chosen CEO (created, or its
 * value rotated), that CEO's environment pointing at it, and nothing left behind for CEOs or organizations no longer chosen.
 * Returns the problems, one line each; a problem in one organization doesn't stop the rest.
 */
export async function syncItem(gw: EngineGateway, s: Session, vault: Vault, item: VaultItem, opts: { rotate?: boolean; remove?: boolean } = {}): Promise<string[]> {
  const problems: string[] = [];
  const wanted = opts.remove ? [] : item.targets;
  const byCompany = new Map<string, Target[]>();
  for (const t of wanted) byCompany.set(t.companyId, [...(byCompany.get(t.companyId) ?? []), t]);
  const synced: Record<string, string> = { ...item.synced };
  const value = opts.remove ? null : vault.value(item.id);

  // Organizations that no longer have a chosen CEO: take the variable off the agents that had it, delete the company secret.
  for (const [companyId, secretId] of Object.entries(item.synced)) {
    if (byCompany.has(companyId)) continue;
    try {
      await unbind(gw, s, companyId, item.name, secretId);
      await gw.userJson(s, "DELETE", `/api/secrets/${e(secretId)}`);
      delete synced[companyId];
    } catch (err) {
      problems.push(`${companyId}: ${message(err)}`);
    }
  }

  for (const [companyId, targets] of byCompany) {
    try {
      if (value === null) throw new VaultError(500, "no_value", "The value is missing from the vault.");
      let secretId = synced[companyId];
      if (!secretId) {
        const existing = await gw.userJson<EngineSecret[]>(s, "GET", `/api/companies/${e(companyId)}/secrets`);
        secretId = (Array.isArray(existing) ? existing : []).find((x) => x.key === secretKey(item) || x.name === secretKey(item))?.id ?? "";
        if (secretId) await gw.userJson(s, "POST", `/api/secrets/${e(secretId)}/rotate`, { value });
        else secretId = (await gw.userJson<EngineSecret>(s, "POST", `/api/companies/${e(companyId)}/secrets`, { name: secretKey(item), key: secretKey(item), value, description: item.description || `Shared from the host vault as ${item.name}` })).id;
      } else if (opts.rotate) {
        await gw.userJson(s, "POST", `/api/secrets/${e(secretId)}/rotate`, { value });
      }
      synced[companyId] = secretId;
      // Point each chosen CEO at it, and take it off any other agent in this organization that had it from us.
      await bind(gw, s, companyId, item.name, secretId, new Set(targets.map((t) => t.agentId)));
    } catch (err) {
      problems.push(`${companyId}: ${message(err)}`);
    }
  }
  vault.setSynced(item.id, synced);
  return problems;
}

const message = (err: unknown) => (err instanceof Error ? err.message : "failed");

/** Sets `env[name]` to the secret on the wanted agents, and removes our reference from every other agent in the organization. */
async function bind(gw: EngineGateway, s: Session, companyId: string, name: string, secretId: string, wanted: Set<string>) {
  const agents = await gw.userJson<Agent[]>(s, "GET", `/api/companies/${e(companyId)}/agents`);
  for (const a of Array.isArray(agents) ? agents : []) {
    const env = { ...((a.adapterConfig?.env as Record<string, unknown> | undefined) ?? {}) };
    const mine = (env[name] as { type?: string; secretId?: string } | undefined)?.secretId === secretId;
    if (wanted.has(a.id)) {
      if (mine) continue;
      env[name] = { type: "secret_ref", secretId, version: "latest" };
    } else if (mine) delete env[name];
    else continue;
    await gw.userJson(s, "PATCH", `/api/agents/${e(a.id)}`, { adapterConfig: { ...(a.adapterConfig ?? {}), env } });
  }
}

async function unbind(gw: EngineGateway, s: Session, companyId: string, name: string, secretId: string) {
  await bind(gw, s, companyId, name, secretId, new Set());
}

export const handleVault: FeatureHandler = async (ctx: FeatureCtx) => {
  const m = ROUTE.exec(ctx.path);
  if (!m) return false;
  const { HttpError, method } = ctx;
  const s = ctx.session();
  if (s.apiToken) throw new HttpError(403, "ticket_only", "The vault is managed in the console by a signed-in administrator.");
  const isAdmin = await ctx.asUser((pve) => ctx.isNodeAdmin(pve));
  const vault = vaultFor(ctx.state, ctx.now);
  const which = m[1];

  if (!which && method === "GET") return ctx.json(200, { items: isAdmin ? vault.list() : [], canManage: isAdmin }), true;
  if (!isAdmin) throw new HttpError(403, "forbidden", "Only Proxmox administrators (Sys.Modify on /) can use the vault.");

  const gw = ctx.gateway;
  const needEngine = () => {
    if (!gw) throw new HttpError(503, "engine_unavailable", "The engine isn't set up on this host.");
    return gw;
  };

  try {
    if (which === "ceos") {
      if (method !== "GET") throw new HttpError(405, "method", "Method not allowed");
      // No engine, or no organizations yet, simply means no CEOs to pick; the picker then shows nothing.
      const ceos = gw ? await listCeos(gw, s).catch(() => [] as Ceo[]) : [];
      return ctx.json(200, { ceos }), true;
    }
    if (method === "POST" || method === "PATCH" || method === "DELETE") ctx.sameSite();

    if (which === "sync") {
      if (method !== "POST") throw new HttpError(405, "method", "Method not allowed");
      const g = needEngine();
      const problems: Record<string, string[]> = {};
      for (const item of vault.all()) if (item.share === "ceos") {
        const p = await syncItem(g, s, vault, item, { rotate: true });
        if (p.length) problems[item.name] = p;
      }
      return ctx.json(200, { items: vault.list(), problems }), true;
    }

    if (!which) {
      if (method !== "POST") throw new HttpError(405, "method", "Method not allowed");
      const b = await ctx.readJson(32 * 1024);
      const created = vault.create(b, s.username);
      return ctx.json(201, { item: created, problems: await share(vault, created.id, s, gw, false) }), true;
    }

    if (method === "PATCH") {
      const b = await ctx.readJson(32 * 1024);
      const { item, valueChanged } = vault.update(which, b, s.username);
      return ctx.json(200, { item, problems: await share(vault, which, s, gw, valueChanged) }), true;
    }
    if (method === "DELETE") {
      const cur = vault.record(which);
      if (!cur) throw new VaultError(404, "not_found", "That variable isn't in the vault.");
      // Take it out of the organizations first; if that fails the variable stays, so nothing is left shared and forgotten.
      const problems = gw && Object.keys(cur.synced).length ? await syncItem(gw, s, vault, cur, { remove: true }) : [];
      if (problems.length) throw new HttpError(502, "unshare_failed", `It couldn't be taken out of every organization, so it was kept. ${problems.join("; ")}`);
      vault.remove(which);
      return ctx.json(200, { ok: true }), true;
    }
    throw new HttpError(405, "method", "Method not allowed");
  } catch (err) {
    if (err instanceof VaultError) throw new HttpError(err.status, err.code, err.message);
    throw err;
  }
};

async function share(vault: Vault, id: string, s: Session, gw: EngineGateway | null, rotate: boolean): Promise<string[]> {
  const item = vault.record(id);
  if (!item) return [];
  if (item.share === "pin" && !Object.keys(item.synced).length) return [];
  if (!gw) return item.targets.length || Object.keys(item.synced).length ? ["The engine isn't set up, so nothing was shared yet."] : [];
  return syncItem(gw, s, vault, item, { rotate });
}
