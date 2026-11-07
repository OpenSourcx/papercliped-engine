import type { Entry } from "@papercliped-engine/marketplace";
import type { EngineGateway } from "../engine.ts";
import { HttpError } from "../http.ts";
import { appendAudit } from "./access-tokens.ts";
import { cleanText } from "./connect-util.ts";
import { markets } from "./connect-adapters.ts";
import type { FeatureCtx } from "./index.ts";

/**
 * Machine-wide plugins from the signed catalog. A plugin runs code inside the engine, so this is administrators only and
 * every step is checked here, not in the browser:
 *  - only a catalog entry that passed signature, expiry and rollback checks can be installed (no pinned key, no catalog,
 *    no install; "unverified" plugins the engine already has can only be removed);
 *  - the package on npm must still have the exact integrity hash the catalog was signed for;
 *  - the administrator must submit exactly the permission list the catalog declares (consent is enforced by the server);
 *  - an upgrade needs a newer version, and fresh consent whenever it asks for a permission the installed one did not;
 *  - revoking removes the plugin in the engine and forgets the grant.
 * A plugin's permissions are declarations from the publisher; this host does not sandbox them. The engine's own plugin
 * runtime decides what a plugin can reach, and nothing here claims more.
 */

const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]{0,60}\/)?[a-z0-9][a-z0-9._-]{0,60}$/;
const ID = /^[a-z0-9][a-z0-9_-]{1,47}$/;
const ENGINE_ID = /^[A-Za-z0-9_.:-]{1,100}$/;
const INSTALLED = "connect.plugins";

interface PluginRec { id: string; engineId: string | null; packageName: string; version: string; integrity: string; permissions: string[]; at: number; by: string }

const norm = (list: unknown): string[] | null => (Array.isArray(list) && list.every((p) => typeof p === "string") ? [...new Set(list as string[])].sort() : null);
const same = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
const newer = (a: string, b: string) => {
  const n = (v: string) => v.split(/[-+]/)[0]!.split(".").map(Number);
  const [x, y] = [n(a), n(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};

function pluginsOf(raw: unknown) {
  const list = Array.isArray(raw) ? raw : Array.isArray((raw as { plugins?: unknown })?.plugins) ? (raw as { plugins: unknown[] }).plugins : [];
  const out: { id: string; key: string | null; status: string | null; packageName: string | null; version: string | null }[] = [];
  for (const p of list.slice(0, 200)) {
    if (!p || typeof p !== "object") continue;
    const r = p as Record<string, unknown>;
    if (typeof r.id !== "string" || !ENGINE_ID.test(r.id)) continue;
    out.push({ id: r.id, key: typeof r.pluginKey === "string" ? cleanText(r.pluginKey, 100) : null, status: typeof r.status === "string" ? cleanText(r.status, 40) : null, packageName: typeof r.packageName === "string" && NPM_NAME.test(r.packageName) ? r.packageName : null, version: typeof r.version === "string" ? cleanText(r.version, 40) : null });
  }
  return out;
}

export async function pluginRoutes(ctx: FeatureCtx): Promise<boolean> {
  if (!ctx.path.startsWith("/api/connect/plugins")) return false;
  const E = ctx.HttpError;
  const s = ctx.session();
  if (s.apiToken) throw new E(403, "ticket_only", "Plugins are managed in the console by a signed-in person, not with an API token.");
  const admin = async () => { if (!(await ctx.asUser((pve) => ctx.isNodeAdmin(pve)))) throw new E(403, "forbidden", "Only Proxmox administrators (Sys.Modify on /) can change machine-wide plugins"); };
  const gw: EngineGateway | null = ctx.gateway;
  const installed = () => ctx.state.getSetting<Record<string, PluginRec>>(INSTALLED) ?? {};
  const audit = (action: string, target: string, detail?: string) => { try { appendAudit(ctx.state, ctx.now, { actor: s.username, action, target, ...(detail ? { detail: detail.slice(0, 200) } : {}) }); } catch { /* best effort */ } };
  const fetchImpl = markets.get(ctx.state)?.fetch ?? ((u: string, i: RequestInit) => fetch(u, i));
  const entryOf = async (id: unknown): Promise<Entry & { source: { type: "npm"; name: string; version: string; integrity: string } }> => {
    if (typeof id !== "string" || !ID.test(id)) throw new E(400, "bad_request", "Send the id of a catalog plugin");
    const market = await markets.get(ctx.state)?.load();
    if (!market?.enabled) throw new E(409, "no_catalog", "This device has no trusted plugin catalog (no signing key is pinned), so nothing can be installed from one.");
    const e = market.index?.entries.find((x) => x.id === id && x.kind === "plugin");
    if (!e || e.source.type !== "npm") throw new E(404, "not_in_catalog", "That plugin isn't in the signed catalog.");
    const { name, version, integrity } = e.source;
    if (!NPM_NAME.test(name) || !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version) || !/^sha512-[A-Za-z0-9+/=]{80,}$/.test(integrity)) throw new E(400, "bad_entry", "The catalog entry isn't well formed.");
    return e as never;
  };
  const checkRegistry = async (e: { id: string; source: { name: string; version: string; integrity: string } }, what: string) => {
    let served: string | undefined;
    try {
      const r = await fetchImpl(`https://registry.npmjs.org/${e.source.name.replace("/", "%2F")}/${e.source.version}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
      if (!r.ok) throw new Error(String(r.status));
      served = ((await r.json()) as { dist?: { integrity?: string } }).dist?.integrity;
    } catch {
      throw new E(502, "registry_unreachable", "Couldn't check the package against the npm registry. Try again later.");
    }
    if (served !== e.source.integrity) { audit(`plugin.${what}.refused`, e.id, "integrity mismatch"); throw new E(409, "integrity_mismatch", "The package on the npm registry is not the one the catalog was signed for, so nothing was changed."); }
  };
  const consent = (given: unknown, wanted: string[]) => {
    const g = norm(given);
    if (!g || !same(g, wanted)) throw new E(409, "consent_required", `Review and accept exactly these permissions: ${wanted.length ? wanted.join(", ") : "none declared"}.`);
  };

  if (ctx.path === "/api/connect/plugins" && ctx.method === "GET") {
    let engineList: ReturnType<typeof pluginsOf> | null = null;
    let engineProblem: string | null = null;
    if (!gw) engineProblem = "The engine isn't set up on this host.";
    else { try { engineList = pluginsOf(await gw.userJson<unknown>(s, "GET", "/api/plugins")); } catch (e) { engineProblem = e instanceof HttpError ? e.message : "The engine didn't answer."; } }
    const rec = installed();
    const market = await markets.get(ctx.state)?.load().catch(() => null);
    const signed = (market?.index?.entries ?? []).filter((e) => e.kind === "plugin" && e.source.type === "npm");
    const recs = Object.values(rec);
    const listed = (engineList ?? []).map((p) => { const r = recs.find((x) => x.engineId === p.id || (p.packageName && x.packageName === p.packageName)); return { ...p, verified: !!r, catalogId: r?.id ?? null, grantedPermissions: r?.permissions ?? null }; });
    const available = signed.filter((e) => !rec[e.id]).map((e) => ({ id: e.id, name: e.name, vendor: e.vendor, summary: e.summary, version: e.version, permissions: e.permissions, packageName: e.source.type === "npm" ? e.source.name : "" }));
    const updates = signed.filter((e) => rec[e.id] && newer(e.version, rec[e.id]!.version)).map((e) => ({ id: e.id, from: rec[e.id]!.version, to: e.version, permissions: e.permissions, needsConsent: !e.permissions.every((p) => rec[e.id]!.permissions.includes(p)) }));
    return ctx.json(200, { plugins: listed, available, updates, catalog: { trusted: !!market?.enabled, problem: market?.problem ?? null }, engine: engineProblem ? { ok: false, problem: engineProblem } : { ok: true }, note: "Permissions are what the publisher declares; the engine's plugin runtime decides what a plugin can actually reach." }), true;
  }

  if (ctx.path === "/api/connect/plugins/install" && ctx.method === "POST") {
    ctx.sameSite(); await admin();
    const b = await ctx.readJson();
    if (Object.keys(b).some((k) => k !== "id" && k !== "acceptedPermissions")) throw new E(400, "bad_request", "Send { id, acceptedPermissions }");
    if (!gw) throw new E(503, "engine_unavailable", "The engine isn't set up on this host.");
    const e = await entryOf(b.id);
    if (installed()[e.id]) throw new E(409, "already_installed", "That plugin is already installed. Use upgrade.");
    consent(b.acceptedPermissions, norm(e.permissions)!);
    await checkRegistry(e, "install");
    const reply = await gw.userJson<{ id?: unknown }>(s, "POST", "/api/plugins/install", { packageName: e.source.name, version: e.source.version, isLocalPath: false });
    const rec = installed();
    rec[e.id] = { id: e.id, engineId: typeof reply?.id === "string" && ENGINE_ID.test(reply.id) ? reply.id : null, packageName: e.source.name, version: e.source.version, integrity: e.source.integrity, permissions: norm(e.permissions)!, at: ctx.now(), by: s.username };
    ctx.state.setSetting(INSTALLED, rec);
    audit("plugin.install", e.id, `${e.source.name}@${e.source.version} permissions: ${rec[e.id]!.permissions.join(",")}`);
    return ctx.json(200, { installed: true, id: e.id, version: e.source.version }), true;
  }

  const one = ctx.path.match(/^\/api\/connect\/plugins\/([A-Za-z0-9_.:-]{1,100})(\/upgrade|\/reinstall|\/disable|\/enable)?$/);
  if (one && ctx.method === "POST" && one[2] === "/upgrade") {
    ctx.sameSite(); await admin();
    const b = await ctx.readJson();
    if (Object.keys(b).some((k) => k !== "acceptedPermissions")) throw new E(400, "bad_request", "Send { acceptedPermissions }");
    if (!gw) throw new E(503, "engine_unavailable", "The engine isn't set up on this host.");
    const rec = installed(); const have = rec[one[1]!];
    if (!have) throw new E(404, "not_installed", "That plugin wasn't installed from the signed catalog.");
    const e = await entryOf(one[1]);
    if (!newer(e.version, have.version)) throw new E(409, "not_newer", "The catalog has no newer version of this plugin.");
    const wanted = norm(e.permissions)!;
    if (!wanted.every((p) => have.permissions.includes(p))) consent(b.acceptedPermissions, wanted);
    await checkRegistry(e, "upgrade");
    const engineId = have.engineId ?? pluginsOf(await gw.userJson<unknown>(s, "GET", "/api/plugins")).find((p) => p.packageName === have.packageName)?.id;
    if (!engineId) throw new E(404, "not_registered", "The engine doesn't have this plugin any more.");
    try {
      await gw.userJson(s, "POST", `/api/plugins/${encodeURIComponent(engineId)}/upgrade`, { version: e.source.version });
    } catch (err) {
      // Engine 2026.1023.0's loader refuses an upgrade that adds capabilities (400) instead of parking it for approval; there is no
      // approval call. Say so, change nothing, and point at the explicit reinstall (below), which needs its own consent.
      const caps = /new capabilities that require approval: (.+?)\. The previous version/.exec(err instanceof Error ? err.message : "")?.[1];
      if (caps) { audit("plugin.upgrade.refused", e.id, `engine refused: new capabilities ${caps}`); throw new E(409, "capability_increase", `The engine refuses to upgrade ${e.id} because ${e.source.version} asks for new capabilities (${caps}). Nothing was changed. To adopt it you can revoke the plugin and install ${e.source.version}, accepting its permissions.`); }
      throw err;
    }
    rec[e.id] = { ...have, engineId, version: e.source.version, integrity: e.source.integrity, permissions: wanted, at: ctx.now(), by: s.username };
    ctx.state.setSetting(INSTALLED, rec);
    audit("plugin.upgrade", e.id, `${have.version} -> ${e.source.version}`);
    return ctx.json(200, { upgraded: true, id: e.id, version: e.source.version }), true;
  }
  if (one && ctx.method === "POST" && one[2] === "/reinstall") {
    ctx.sameSite(); await admin();
    const b = await ctx.readJson();
    if (Object.keys(b).some((k) => k !== "acceptedPermissions" && k !== "confirm")) throw new E(400, "bad_request", "Send { acceptedPermissions, confirm: true }");
    if (b.confirm !== true) throw new E(409, "confirm_required", "Reinstalling removes the plugin from the engine and installs the new version. Confirm to continue.");
    if (!gw) throw new E(503, "engine_unavailable", "The engine isn't set up on this host.");
    const rec = installed(); const have = rec[one[1]!];
    if (!have) throw new E(404, "not_installed", "That plugin wasn't installed from the signed catalog.");
    const e = await entryOf(one[1]);
    if (!newer(e.version, have.version)) throw new E(409, "not_newer", "The catalog has no newer version of this plugin.");
    consent(b.acceptedPermissions, norm(e.permissions)!);
    await checkRegistry(e, "reinstall");
    const engineId = have.engineId ?? pluginsOf(await gw.userJson<unknown>(s, "GET", "/api/plugins")).find((p) => p.packageName === have.packageName)?.id;
    if (!engineId) throw new E(404, "not_registered", "The engine doesn't have this plugin any more.");
    await gw.userJson(s, "DELETE", `/api/plugins/${encodeURIComponent(engineId)}`);
    try {
      const reply = await gw.userJson<{ id?: unknown }>(s, "POST", "/api/plugins/install", { packageName: e.source.name, version: e.source.version, isLocalPath: false });
      rec[e.id] = { ...have, engineId: typeof reply?.id === "string" && ENGINE_ID.test(reply.id) ? reply.id : null, version: e.source.version, integrity: e.source.integrity, permissions: norm(e.permissions)!, at: ctx.now(), by: s.username };
      ctx.state.setSetting(INSTALLED, rec);
      audit("plugin.reinstall", e.id, `${have.version} -> ${e.source.version} permissions: ${rec[e.id]!.permissions.join(",")}`);
      return ctx.json(200, { reinstalled: true, id: e.id, version: e.source.version }), true;
    } catch (err) {
      // The old version is already gone from the engine: put it back (the version and hash it was installed with) and say what happened.
      let restored = false;
      try {
        const back = await gw.userJson<{ id?: unknown }>(s, "POST", "/api/plugins/install", { packageName: have.packageName, version: have.version, isLocalPath: false });
        rec[e.id] = { ...have, engineId: typeof back?.id === "string" && ENGINE_ID.test(back.id) ? back.id : null };
        ctx.state.setSetting(INSTALLED, rec);
        restored = true;
      } catch { /* reported below */ }
      if (!restored) { delete rec[e.id]; ctx.state.setSetting(INSTALLED, rec); }
      audit("plugin.reinstall.failed", e.id, restored ? "old version restored" : "old version NOT restored");
      throw new E(502, "reinstall_failed", `The new version could not be installed. ${restored ? `The previous version ${have.version} was put back.` : `The previous version could not be put back; ${e.id} is no longer installed.`}`);
    }
  }
  if (one && ctx.method === "POST" && (one[2] === "/disable" || one[2] === "/enable")) {
    ctx.sameSite(); await admin();
    if (!gw) throw new E(503, "engine_unavailable", "The engine isn't set up on this host.");
    const rec = installed()[one[1]!];
    const have = pluginsOf(await gw.userJson<unknown>(s, "GET", "/api/plugins")).find((p) => p.id === one[1] || (rec && (p.id === rec.engineId || p.packageName === rec.packageName)));
    if (!have) throw new E(404, "not_registered", "The engine doesn't have that plugin.");
    // Anything the engine has that did not come from the signed catalog can be switched off, never on.
    if (one[2] === "/enable" && !rec) throw new E(403, "unverified", "That plugin isn't from the signed catalog, so it can't be switched on from here.");
    await gw.userJson(s, "POST", `/api/plugins/${encodeURIComponent(have.id)}${one[2]}`, {});
    audit(`plugin${one[2]!.replace("/", ".")}`, have.id);
    return ctx.json(200, { ok: true }), true;
  }
  if (one && ctx.method === "DELETE" && !one[2]) {
    ctx.sameSite(); await admin();
    if (!gw) throw new E(503, "engine_unavailable", "The engine isn't set up on this host.");
    const rec = installed(); const have = rec[one[1]!];
    const list = pluginsOf(await gw.userJson<unknown>(s, "GET", "/api/plugins"));
    const target = list.find((p) => p.id === one[1] || (have && (p.id === have.engineId || p.packageName === have.packageName)));
    if (!target) throw new E(404, "not_registered", "The engine doesn't have that plugin.");
    await gw.userJson(s, "DELETE", `/api/plugins/${encodeURIComponent(target.id)}`);
    for (const [k, r] of Object.entries(rec)) if (r.engineId === target.id || (target.packageName && r.packageName === target.packageName)) delete rec[k];
    ctx.state.setSetting(INSTALLED, rec);
    audit("plugin.revoke", target.id);
    return ctx.json(200, { ok: true }), true;
  }
  throw new E(404, "not_found", "Unknown plugin route");
}
