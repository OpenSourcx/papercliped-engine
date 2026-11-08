import { randomBytes } from "node:crypto";
import type { Requirements } from "@papercliped-engine/worker-fabric";
import type { EngineGateway } from "../engine.ts";
import { HttpError } from "../http.ts";
import type { StateStore } from "../state.ts";
import type { FabricHub } from "./hub.ts";

/** Creates the Paperclip side of a remote-worker environment: the provider plugin, a secret holding the control token, and the environment. */

export const REMOTE_PLUGIN_KEY = "epaperclip.remote-worker-provider";
const ENVS = "fabric.envs";
interface EnvRec { companyId: string; secretId: string }
interface EngineEnv { id: string; name: string; status: string; config?: Record<string, unknown> | null; metadata?: { epaperclip?: string; companyId?: string } | null }

export interface EnvView { id: string; companyId: string; name: string; workerId: string | null; requirements: Requirements; agents: string[] }

const view = (e: EngineEnv, companyId: string, agents: string[]): EnvView => ({
  id: e.id, companyId, name: e.name, workerId: typeof e.config?.workerId === "string" && e.config.workerId ? e.config.workerId : null,
  requirements: (e.config?.requirements as Requirements | undefined) ?? {}, agents,
});

export class FabricEnvironments {
  private readonly gw: EngineGateway | null;
  private readonly hub: FabricHub;
  private readonly state: StateStore;
  private readonly pluginDir: string;
  private readonly controlUrl: string;
  constructor(o: { gateway: EngineGateway | null; hub: FabricHub; state: StateStore; pluginDir: string; controlUrl: string }) {
    this.gw = o.gateway;
    this.hub = o.hub;
    this.state = o.state;
    this.pluginDir = o.pluginDir;
    this.controlUrl = o.controlUrl;
  }
  private async eng<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.gw) throw new HttpError(503, "engine_unavailable", "The engine isn't set up on this host.");
    const r = await this.gw.serviceJson<T>(method, path, body);
    if (r === null) throw new HttpError(503, "engine_unavailable", "ePaperclip's service account is not the engine's administrator.");
    return r;
  }
  private recs(): Record<string, EnvRec> {
    return this.state.getSetting<Record<string, EnvRec>>(ENVS) ?? {};
  }

  async ensurePlugin(): Promise<string> {
    const list = await this.eng<{ id: string; pluginKey: string; status: string }[]>("GET", "/api/plugins");
    let pl = list.find((x) => x.pluginKey === REMOTE_PLUGIN_KEY);
    if (pl?.status === "disabled") pl = await this.eng("POST", `/api/plugins/${encodeURIComponent(pl.id)}/enable`, {});
    if (!pl || pl.status !== "ready") pl = await this.eng("POST", "/api/plugins/install", { packageName: this.pluginDir, isLocalPath: true });
    if (!pl || pl.status !== "ready") throw new HttpError(502, "plugin_not_ready", "The engine installed the remote worker provider but it is not ready.");
    return pl.id;
  }

  async list(): Promise<EnvView[]> {
    if (!this.gw) return [];
    const out: EnvView[] = [];
    for (const [id, rec] of Object.entries(this.recs())) {
      try {
        const envs = await this.eng<EngineEnv[]>("GET", `/api/companies/${encodeURIComponent(rec.companyId)}/environments`);
        const e = envs.find((x) => x.id === id);
        if (e) out.push(view(e, rec.companyId, []));
      } catch {
        /* the engine may be starting */
      }
    }
    return out;
  }

  async create(o: { companyId: string; name?: string; workerId?: string | null; requirements?: Requirements; assignAgents?: string[]; reuseLease?: boolean }): Promise<EnvView> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(o.companyId)) throw new HttpError(400, "bad_request", "Bad organization id.");
    if (o.workerId && !this.hub.worker(o.workerId)) throw new HttpError(404, "not_found", "No such worker.");
    await this.ensurePlugin();
    const cid = encodeURIComponent(o.companyId);
    const token = this.hub.issueControlToken(o.companyId);
    const secret = await this.eng<{ id: string }>("POST", `/api/companies/${cid}/secrets`, { name: `epaperclip-fabric-token-${randomBytes(3).toString("hex")}`, value: token, description: "Created by ePaperclip's Worker Fabric" });
    const name = (o.name?.trim() || "Remote worker").slice(0, 80);
    const env = await this.eng<EngineEnv>("POST", `/api/companies/${cid}/environments`, {
      name, description: "Runs agents on a worker you own. Managed by ePaperclip's Worker Fabric.", driver: "sandbox", status: "active",
      config: { provider: "remote-worker", controlUrl: this.controlUrl, controlToken: secret.id, workerId: o.workerId ?? "", requirements: o.requirements ?? {}, reuseLease: o.reuseLease !== false },
      metadata: { epaperclip: "remote-worker", companyId: o.companyId },
    });
    this.state.setSetting(ENVS, { ...this.recs(), [env.id]: { companyId: o.companyId, secretId: secret.id } });
    const agents: string[] = [];
    for (const a of o.assignAgents ?? []) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(a)) continue;
      await this.eng("PATCH", `/api/agents/${encodeURIComponent(a)}`, { defaultEnvironmentId: env.id });
      agents.push(a);
    }
    this.hub.audit("host", "environment.create", o.workerId ?? undefined, `${env.id} ${o.companyId}`);
    return view(env, o.companyId, agents);
  }

  private rec(id: string): EnvRec {
    const r = this.recs()[id];
    if (!r) throw new HttpError(404, "not_found", "No such Worker Fabric environment.");
    return r;
  }

  /** Changes what an environment asks for: its name, a pinned worker, requirements, whether workspaces are kept, and which agents default to it. */
  async update(id: string, o: { name?: string; workerId?: string | null; requirements?: Requirements; reuseLease?: boolean; assignAgents?: string[] }): Promise<EnvView> {
    const rec = this.rec(id);
    if (o.workerId && !this.hub.worker(o.workerId)) throw new HttpError(404, "not_found", "No such worker.");
    const envs = await this.eng<EngineEnv[]>("GET", `/api/companies/${encodeURIComponent(rec.companyId)}/environments`);
    const cur = envs.find((e) => e.id === id);
    if (!cur) throw new HttpError(404, "not_found", "The engine no longer has that environment.");
    const config = { ...(cur.config ?? {}) } as Record<string, unknown>;
    if (o.workerId !== undefined) config.workerId = o.workerId ?? "";
    if (o.requirements) config.requirements = o.requirements;
    if (o.reuseLease !== undefined) config.reuseLease = o.reuseLease;
    const env = await this.eng<EngineEnv>("PATCH", `/api/environments/${encodeURIComponent(id)}`, { ...(o.name?.trim() ? { name: o.name.trim().slice(0, 80) } : {}), config });
    const agents: string[] = [];
    for (const a of o.assignAgents ?? []) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(a)) continue;
      await this.eng("PATCH", `/api/agents/${encodeURIComponent(a)}`, { defaultEnvironmentId: id });
      agents.push(a);
    }
    this.hub.audit("host", "environment.update", o.workerId ?? undefined, id);
    return view(env, rec.companyId, agents);
  }

  /** Removes the environment (and its control token). Workers and their workspaces are not touched. */
  async remove(id: string): Promise<void> {
    const rec = this.rec(id);
    await this.eng("DELETE", `/api/environments/${encodeURIComponent(id)}`);
    await this.eng("DELETE", `/api/secrets/${encodeURIComponent(rec.secretId)}`).catch(() => {});
    const all = { ...this.recs() };
    delete all[id];
    this.state.setSetting(ENVS, all);
    this.hub.audit("host", "environment.remove", undefined, id);
  }

  private readonly names = new Map<string, string>();
  /** An agent's display name for the console (cached; empty when the engine cannot say). */
  async agentName(agentId: string): Promise<string | null> {
    if (this.names.has(agentId)) return this.names.get(agentId)!;
    try {
      const a = await this.eng<{ name?: string }>("GET", `/api/agents/${encodeURIComponent(agentId)}`);
      if (a.name) this.names.set(agentId, a.name);
      return a.name ?? null;
    } catch {
      return null;
    }
  }
}
