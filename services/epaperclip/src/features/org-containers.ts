import type { GuestType, ProxmoxClient } from "@papercliped-engine/proxmox-client";
import type { EngineGateway } from "../engine.ts";
import { HttpError } from "../http.ts";
import type { Session } from "../sessions.ts";
import type { StateStore } from "../state.ts";
import { appendAudit } from "./access-tokens.ts";
import { execInGuest } from "./guest-exec.ts";
import type { FeatureCtx } from "./index.ts";

/**
 * Shell access to an organization's agent containers, from the organization's side.
 *
 *   GET  /api/agent-containers/orgs/:companyId                 the containers in the organization's pool, with each one's console path
 *   POST /api/agent-containers/orgs/:companyId/:vmid/exec      { script, timeoutMs? }: runs a script in one of them, as the person
 *
 * Three independent checks, all of which must pass, so a member of organization A can never reach organization B's
 * containers: (1) the person is an active member of the organization in the engine (owner or admin for a command or a
 * terminal), (2) the machine is in that organization's own resource group pool, as seen by the person's own Proxmox
 * session, and (3) Proxmox itself (VM.Console on the machine) allows it; the exec helper and the console relay check that
 * again on their own. A pool is never guessed: an organization with no resource group has no containers to reach.
 */

const ROUTE = /^\/api\/agent-containers\/orgs\/([A-Za-z0-9_-]{1,64})(?:\/(\d{3,9})\/(exec))?$/;
const MAX_SCRIPT = 16 * 1024;
const MAX_TIMEOUT_MS = 10 * 60_000;

export interface OrgContainer {
  vmid: number;
  name: string | null;
  node: string;
  type: GuestType;
  status: string | null;
}

/**
 * The organization's containers as this person's Proxmox session sees them (templates left out), after the engine
 * membership check. `admin` asks for owner or admin, which opening a terminal or running a command needs.
 */
export async function orgContainers(deps: { gateway: EngineGateway | null; state: StateStore }, s: Session, pve: ProxmoxClient, companyId: string, admin: boolean): Promise<OrgContainer[]> {
  if (!deps.gateway) throw new HttpError(503, "engine_unavailable", "The engine isn't set up on this host.");
  const m = await deps.gateway.membership(s, companyId);
  if (!m) throw new HttpError(403, "not_member", "You aren't a member of that organization.");
  if (admin && m.role !== "owner" && m.role !== "admin") throw new HttpError(403, "forbidden", "Only the organization's owners and admins can open a shell in its containers.");
  const pool = deps.state.getSetting<Record<string, { pool?: string }>>("resourceGroups")?.[companyId]?.pool;
  if (!pool) return [];
  const all = await pve.clusterResources();
  return all
    .filter((r) => r.pool === pool && (r.type === "lxc" || r.type === "qemu") && typeof r.vmid === "number" && !r.template)
    .map((r) => ({ vmid: r.vmid!, name: r.name ?? null, node: r.node ?? "", type: r.type as GuestType, status: r.status ?? null }));
}

const audit = (ctx: FeatureCtx, action: string, target: string, detail?: string) => {
  try {
    appendAudit(ctx.state, ctx.now, { actor: ctx.session().username, action, target, ...(detail ? { detail: detail.slice(0, 200) } : {}) });
  } catch {
    /* best effort */
  }
};

export async function orgContainerRoutes(ctx: FeatureCtx): Promise<boolean> {
  const m = ctx.path.match(ROUTE);
  if (!m) return false;
  const s = ctx.session();
  if (s.apiToken) throw new HttpError(403, "ticket_only", "A shell in a container is opened in the console by a signed-in person, not with an API token.");
  const companyId = m[1]!;
  const deps = { gateway: ctx.gateway, state: ctx.state };

  if (!m[3]) {
    if (ctx.method !== "GET") throw new HttpError(405, "method_not_allowed", "Use GET.");
    const list = await ctx.asUser((pve) => orgContainers(deps, s, pve, companyId, false));
    return ctx.json(200, { containers: list.map((c) => ({ ...c, consolePath: `/api/console/guests/${c.vmid}?org=${encodeURIComponent(companyId)}` })) }), true;
  }

  if (ctx.method !== "POST") throw new HttpError(405, "method_not_allowed", "Use POST.");
  ctx.sameSite();
  const vmid = Number(m[2]);
  const b = await ctx.readJson(MAX_SCRIPT + 1024);
  for (const k of Object.keys(b)) if (k !== "script" && k !== "timeoutMs") throw new HttpError(400, "bad_request", `Unknown field ${k.slice(0, 30)}`);
  if (typeof b.script !== "string" || !b.script.trim() || b.script.length > MAX_SCRIPT || b.script.includes("\0")) throw new HttpError(400, "bad_request", `script is a non-empty text of at most ${MAX_SCRIPT} characters.`);
  const timeoutMs = b.timeoutMs === undefined ? 60_000 : b.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_TIMEOUT_MS) throw new HttpError(400, "bad_request", `timeoutMs is between 1000 and ${MAX_TIMEOUT_MS}.`);
  const result = await ctx.asUser(async (pve) => {
    const mine = (await orgContainers(deps, s, pve, companyId, true)).find((c) => c.vmid === vmid);
    // The same answer whether the machine exists elsewhere or not: nothing says which organization owns it.
    if (!mine) throw new HttpError(404, "not_found", "That container isn't one of this organization's.");
    if (mine.status !== "running") throw new HttpError(409, "not_running", "The container isn't running.");
    return execInGuest({ pve: async () => pve, connect: ctx.connect }, { type: mine.type, vmid, node: mine.node || ctx.node }, b.script as string, { timeoutMs });
  });
  audit(ctx, "agent-container.exec", `${companyId}/${vmid}`, `exit=${result.exitCode ?? "none"}${result.timedOut ? " timeout" : ""}`);
  return ctx.json(200, result), true;
}
