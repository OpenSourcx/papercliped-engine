import type { Index } from "@papercliped-engine/marketplace";
import type { EngineGateway } from "../engine.ts";
import { HttpError } from "../http.ts";
import type { StateStore } from "../state.ts";
import { appendAudit } from "./access-tokens.ts";
import { cleanText } from "./connect-util.ts";
import type { FeatureCtx } from "./index.ts";

/**
 * Agent adapters in the Store (docs/CONNECTORS.md). Paperclip ships these adapter types itself; "installing" one is
 * switching it on in the engine. An adapter is shown as **verified** only when it is one of the types in the pinned
 * engine's own list (`BUILTIN_ADAPTERS`, which a test compares with the engine's API description) or was installed from
 * the signed marketplace index. Anything else the engine happens to have registered is shown as unverified and can
 * only be removed, never enabled from here.
 *
 * Signed-index adapters (npm packages pinned to an exact version and the registry's integrity hash) are installed
 * through the engine's own adapter API after the host service checked that the registry still serves exactly that
 * integrity hash. The browser never reads the index or the registry.
 */

export interface BuiltinAdapter {
  type: string;
  name: string;
  summary: string;
  /** Where its agents run: a command inside the organization's agent container, or somewhere else. */
  runs: "container" | "remote";
}

/** Paperclip's built-in adapter types at the pinned engine version. Kept equal to the engine's API description by a test. */
export const BUILTIN_ADAPTERS: readonly BuiltinAdapter[] = [
  { type: "claude_local", name: "Claude Code", summary: "Run agents with Claude Code, in the agent container.", runs: "container" },
  { type: "codex_local", name: "Codex", summary: "Run agents with Codex, in the agent container.", runs: "container" },
  { type: "cursor", name: "Cursor", summary: "Run agents with Cursor's agent, in the agent container.", runs: "container" },
  { type: "cursor_cloud", name: "Cursor Cloud", summary: "Hand work to Cursor's cloud agents.", runs: "remote" },
  { type: "gemini_local", name: "Gemini CLI", summary: "Run agents with Gemini CLI, in the agent container.", runs: "container" },
  { type: "grok_local", name: "Grok Build", summary: "Run agents with Grok Build, in the agent container.", runs: "container" },
  { type: "hermes_local", name: "Hermes", summary: "Run agents with Hermes, in the agent container.", runs: "container" },
  { type: "hermes_gateway", name: "Hermes Gateway", summary: "Reach a Hermes agent through its gateway.", runs: "remote" },
  { type: "kimi_local", name: "Kimi Code", summary: "Run agents with Kimi Code, in the agent container.", runs: "container" },
  { type: "opencode_local", name: "OpenCode", summary: "Run agents with OpenCode and any model you connect.", runs: "container" },
  { type: "openclaw_gateway", name: "OpenClaw Gateway", summary: "Reach an OpenClaw agent through its gateway.", runs: "remote" },
  { type: "pi_local", name: "Pi", summary: "Run agents with Pi, in the agent container.", runs: "container" },
  { type: "paperclip_runner", name: "Paperclip Runner", summary: "Paperclip's own runner for agent work.", runs: "remote" },
  { type: "http", name: "HTTP", summary: "Wake an agent that lives behind a web address.", runs: "remote" },
  { type: "process", name: "Process", summary: "Run any command as an agent (not available while agents are limited to containers).", runs: "container" },
];

const TYPE = /^[a-z][a-z0-9_-]{0,63}$/;
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]{0,60}\/)?[a-z0-9][a-z0-9._-]{0,60}$/;
const INSTALLED = "connect.adapters";

interface InstalledRec {
  id: string;
  packageName: string;
  version: string;
  integrity: string;
  at: number;
  by: string;
}

export type MarketLoader = () => Promise<{ enabled: boolean; index: Index | null; problem: { code: string; message: string } | null }>;
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
const markets = new WeakMap<StateStore, { load: MarketLoader; fetch: Fetcher }>();
export const registerMarket = (state: StateStore, load: MarketLoader, fetch: Fetcher) => void markets.set(state, { load, fetch });

/** What the engine reports about its adapters, reduced to what the console needs. */
function adaptersOf(raw: unknown): { type: string; disabled: boolean; packageName: string | null; version: string | null; builtin: boolean | null }[] {
  const list = Array.isArray(raw) ? raw : Array.isArray((raw as { adapters?: unknown })?.adapters) ? (raw as { adapters: unknown[] }).adapters : [];
  const out = [];
  for (const a of list.slice(0, 200)) {
    if (!a || typeof a !== "object") continue;
    const r = a as Record<string, unknown>;
    const type = typeof r.type === "string" ? r.type : typeof r.adapterType === "string" ? r.adapterType : null;
    if (!type || !TYPE.test(type)) continue;
    out.push({
      type,
      disabled: r.disabled === true || r.enabled === false,
      packageName: typeof r.packageName === "string" && NPM_NAME.test(r.packageName) ? r.packageName : null,
      version: typeof r.version === "string" ? cleanText(r.version, 40) : null,
      builtin: typeof r.builtin === "boolean" ? r.builtin : r.source === "builtin" ? true : null,
    });
  }
  return out;
}

export async function adapterRoutes(ctx: FeatureCtx): Promise<boolean> {
  if (!ctx.path.startsWith("/api/connect/adapters")) return false;
  const fetchImpl: Fetcher = markets.get(ctx.state)?.fetch ?? ((u, i) => fetch(u, i));
  const E = ctx.HttpError;
  const s = ctx.session();
  if (s.apiToken) throw new E(403, "ticket_only", "Adapters are managed in the console by a signed-in person, not with an API token.");
  const gw: EngineGateway | null = ctx.gateway;
  const admin = async () => {
    if (!(await ctx.asUser((pve) => ctx.isNodeAdmin(pve)))) throw new E(403, "forbidden", "Only Proxmox administrators (Sys.Modify on /) can change adapters");
  };
  const installed = () => ctx.state.getSetting<Record<string, InstalledRec>>(INSTALLED) ?? {};
  const audit = (action: string, target: string, detail?: string) => {
    try {
      appendAudit(ctx.state, ctx.now, { actor: s.username, action, target, ...(detail ? { detail: detail.slice(0, 200) } : {}) });
    } catch {
      /* best effort */
    }
  };

  if (ctx.path === "/api/connect/adapters" && ctx.method === "GET") {
    let engineList: ReturnType<typeof adaptersOf> | null = null;
    let engineProblem: string | null = null;
    if (!gw) engineProblem = "The engine isn't set up on this host.";
    else {
      try {
        engineList = adaptersOf(await gw.userJson<unknown>(s, "GET", "/api/adapters"));
      } catch (e) {
        engineProblem = e instanceof HttpError ? e.message : "The engine didn't answer.";
      }
    }
    const byType = new Map((engineList ?? []).map((a) => [a.type, a]));
    const rec = installed();
    const market = await markets.get(ctx.state)?.load().catch(() => null);
    const signed = (market?.index?.entries ?? []).filter((e) => e.kind === "adapter" && e.source.type === "npm");
    const builtin = BUILTIN_ADAPTERS.map((b) => {
      const e = byType.get(b.type);
      return { ...b, source: "builtin" as const, verified: true, registered: e ? true : engineList ? false : null, enabled: e ? !e.disabled : engineList ? false : null };
    });
    const known = new Set(BUILTIN_ADAPTERS.map((b) => b.type));
    const external = (engineList ?? []).filter((a) => !known.has(a.type)).map((a) => {
      const viaIndex = Object.values(rec).find((r) => r.packageName === a.packageName);
      return { type: a.type, name: a.type, summary: a.packageName ? `Package ${a.packageName}${a.version ? ` ${a.version}` : ""}` : "Registered in the engine.", runs: "container" as const, source: "external" as const, verified: !!viaIndex, registered: true, enabled: !a.disabled, packageName: a.packageName, version: a.version };
    });
    const available = signed
      .filter((e) => e.source.type === "npm" && !Object.values(rec).some((r) => r.id === e.id))
      .map((e) => ({ id: e.id, name: e.name, vendor: e.vendor, summary: e.summary, version: e.version, permissions: e.permissions, packageName: e.source.type === "npm" ? e.source.name : "" }));
    return ctx.json(200, { adapters: [...builtin, ...external], available, engine: engineProblem ? { ok: false, problem: engineProblem } : { ok: true }, marketProblem: market?.problem ?? null }), true;
  }

  const one = ctx.path.match(/^\/api\/connect\/adapters\/([a-z][a-z0-9_-]{0,63})$/);
  if (one && ctx.method === "PUT") {
    ctx.sameSite();
    await admin();
    const type = one[1];
    const b = await ctx.readJson();
    if (typeof b.enabled !== "boolean" || Object.keys(b).length !== 1) throw new E(400, "bad_request", "Send { enabled: true | false }");
    if (!gw) throw new E(503, "engine_unavailable", "The engine isn't set up on this host.");
    const list = adaptersOf(await gw.userJson<unknown>(s, "GET", "/api/adapters"));
    const have = list.find((a) => a.type === type);
    if (!have) throw new E(404, "not_registered", `The engine doesn't have an adapter called ${type}.`);
    const isBuiltin = BUILTIN_ADAPTERS.some((a) => a.type === type);
    const viaIndex = Object.values(installed()).some((r) => r.packageName === have.packageName);
    if (b.enabled && !isBuiltin && !viaIndex) throw new E(403, "unverified", `${type} isn't one of Paperclip's built-in adapters or from the signed catalog, so it can't be switched on from here.`);
    await gw.userJson(s, "PATCH", `/api/adapters/${encodeURIComponent(type)}`, { disabled: !b.enabled });
    audit(b.enabled ? "adapter.enable" : "adapter.disable", type);
    return ctx.json(200, { type, enabled: b.enabled }), true;
  }
  if (one && ctx.method === "DELETE") {
    ctx.sameSite();
    await admin();
    const type = one[1];
    if (BUILTIN_ADAPTERS.some((a) => a.type === type)) throw new E(400, "builtin", "Paperclip's built-in adapters can be switched off but not removed.");
    if (!gw) throw new E(503, "engine_unavailable", "The engine isn't set up on this host.");
    const have = adaptersOf(await gw.userJson<unknown>(s, "GET", "/api/adapters")).find((a) => a.type === type);
    if (!have) throw new E(404, "not_registered", `The engine doesn't have an adapter called ${type}.`);
    await gw.userJson(s, "DELETE", `/api/adapters/${encodeURIComponent(type)}`);
    const rec = installed();
    for (const [k, r] of Object.entries(rec)) if (r.packageName === have.packageName) delete rec[k];
    ctx.state.setSetting(INSTALLED, rec);
    audit("adapter.remove", type);
    return ctx.json(200, { ok: true }), true;
  }

  if (ctx.path === "/api/connect/adapters/install" && ctx.method === "POST") {
    ctx.sameSite();
    await admin();
    const b = await ctx.readJson();
    if (typeof b.id !== "string" || Object.keys(b).length !== 1) throw new E(400, "bad_request", "Send { id } of a catalog adapter");
    if (!gw) throw new E(503, "engine_unavailable", "The engine isn't set up on this host.");
    const m = await markets.get(ctx.state)?.load();
    const entry = m?.index?.entries.find((e) => e.id === b.id && e.kind === "adapter");
    if (!entry || entry.source.type !== "npm") throw new E(404, "not_in_catalog", "That adapter isn't in the signed catalog.");
    const { name, version, integrity } = entry.source;
    if (!NPM_NAME.test(name) || !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version) || !/^sha512-[A-Za-z0-9+/=]{80,}$/.test(integrity)) throw new E(400, "bad_entry", "The catalog entry isn't well formed.");
    // The registry must still serve exactly the package the catalog was signed for.
    let served: string | undefined;
    try {
      const r = await fetchImpl(`https://registry.npmjs.org/${name.replace("/", "%2F")}/${version}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
      if (!r.ok) throw new Error(String(r.status));
      served = ((await r.json()) as { dist?: { integrity?: string } }).dist?.integrity;
    } catch {
      throw new E(502, "registry_unreachable", "Couldn't check the package against the npm registry. Try again later.");
    }
    if (served !== integrity) {
      audit("adapter.install.refused", entry.id, "integrity mismatch");
      throw new E(409, "integrity_mismatch", "The package on the npm registry is not the one the catalog was signed for, so it was not installed.");
    }
    await gw.userJson(s, "POST", "/api/adapters/install", { packageName: name, version, isLocalPath: false });
    const rec = installed();
    rec[entry.id] = { id: entry.id, packageName: name, version, integrity, at: ctx.now(), by: s.username };
    ctx.state.setSetting(INSTALLED, rec);
    audit("adapter.install", entry.id, `${name}@${version}`);
    return ctx.json(200, { installed: true, id: entry.id, version }), true;
  }
  return false;
}
