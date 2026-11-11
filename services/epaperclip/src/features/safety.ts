import type { Session } from "../sessions.ts";
import { VaultError, type RecoveryFile } from "../vault.ts";
import { appendAudit } from "./access-tokens.ts";
import type { FeatureCtx, FeatureHandler } from "./index.ts";

/**
 * The emergency controls (docs/SAFETY.md). Only Proxmox administrators (Sys.Modify on /) use them, with the Proxmox
 * sign-in and our own page's header, never an API token.
 *
 *   GET  /api/safety                        whether the kill switch is on (anyone signed in), and what it did (administrators)
 *   POST /api/safety/kill-switch            { confirm: "STOP EVERYTHING" }: stop every running ePaperclip guest and pause every agent
 *   POST /api/safety/resume                 { unpauseAgents?: boolean }: clear the switch; restarts nothing by itself
 *   POST /api/vault/recovery/export         { passphrase }: the vault key sealed under that passphrase, as a file to keep off this host
 *   POST /api/vault/recovery/restore        { file, passphrase, confirm: "RESTORE VAULT KEY" }: put a recovered key in place (needs a restart)
 */

const ROUTE = /^\/api\/(?:(safety)(?:\/(kill-switch|resume))?|vault\/recovery\/(export|restore))$/;
const SETTING = "killSwitch";
export const KILL_CONFIRM = "STOP EVERYTHING";
export const RESTORE_CONFIRM = "RESTORE VAULT KEY";

export interface KillSwitchState {
  on: boolean;
  at: number;
  by: string;
  /** Guests that were running and were told to stop. */
  stopped: { vmid: number; name: string | null }[];
  /** Agents this switch paused (not ones that were already paused), so resuming can undo exactly that. */
  paused: { companyId: string; agentId: string }[];
  /** What could not be done, one line each. A switch with failures is still on. */
  failures: string[];
  /** Organizations the signed-in administrator is not a member of, whose agents could not be reached. */
  unreachableOrganizations: number;
}

export const killSwitchOn = (state: FeatureCtx["state"]): boolean => state.getSetting<KillSwitchState>(SETTING)?.on === true;

interface Resource { type?: string; vmid?: number; node?: string; name?: string; status?: string; template?: number | boolean; pool?: string; tags?: string }
interface Company { id: string }
interface Agent { id: string; status?: string }

const e = encodeURIComponent;
/** A guest this product made or manages: tagged `epaperclip`, or in one of its `epc-` pools. Never anything else. */
const isOurs = (r: Resource) => (r.tags ?? "").split(/[;,]/).includes("epaperclip") || (r.pool ?? "").startsWith("epc-");

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 160);

async function engage(ctx: FeatureCtx, s: Session): Promise<KillSwitchState> {
  const state: KillSwitchState = { on: true, at: ctx.now(), by: s.username, stopped: [], paused: [], failures: [], unreachableOrganizations: 0 };
  // Persist first: if anything below dies halfway, the switch is still recorded as on and can be repeated.
  ctx.state.setSetting(SETTING, state);

  // 1. Pause agents first, so nothing starts a new run while containers are going down.
  const gw = ctx.gateway;
  if (gw) {
    const companies = await gw.userJson<Company[]>(s, "GET", "/api/companies").catch((err: unknown) => {
      state.failures.push(`Couldn't list organizations: ${message(err)}`);
      return [] as Company[];
    });
    for (const c of Array.isArray(companies) ? companies : []) {
      let agents: Agent[];
      try {
        agents = await gw.userJson<Agent[]>(s, "GET", `/api/companies/${e(c.id)}/agents`);
      } catch {
        state.unreachableOrganizations++;
        continue;
      }
      for (const a of Array.isArray(agents) ? agents : []) {
        if (a.status === "paused" || a.status === "terminated") continue;
        try {
          await gw.userJson(s, "POST", `/api/agents/${e(a.id)}/pause`, {});
          state.paused.push({ companyId: c.id, agentId: a.id });
        } catch (err) {
          state.failures.push(`Agent ${a.id}: ${message(err)}`);
        }
      }
    }
  }

  // 2. Stop every running guest of ours (a hard stop: this is the emergency button, not a tidy shutdown).
  await ctx.asUser(async (pve) => {
    const resources = (await pve.clusterResources()) as Resource[];
    for (const r of resources) {
      if ((r.type !== "lxc" && r.type !== "qemu") || typeof r.vmid !== "number" || !r.node || r.template || r.status !== "running" || !isOurs(r)) continue;
      try {
        await pve.call("POST", `/nodes/${e(r.node)}/${r.type}/${r.vmid}/status/stop`, {});
        state.stopped.push({ vmid: r.vmid, name: r.name ?? null });
      } catch (err) {
        state.failures.push(`${r.type === "lxc" ? "CT" : "VM"} ${r.vmid}: ${message(err)}`);
      }
    }
  });

  ctx.state.setSetting(SETTING, state);
  appendAudit(ctx.state, ctx.now, { actor: s.username, action: "safety.kill-switch", target: "host", detail: `stopped ${state.stopped.length}, paused ${state.paused.length}, ${state.failures.length} failures` });
  return state;
}

export const handleSafety: FeatureHandler = async (ctx: FeatureCtx) => {
  const m = ROUTE.exec(ctx.path);
  if (!m) return false;
  const { HttpError, method } = ctx;
  const s = ctx.session();
  if (s.apiToken) throw new HttpError(403, "ticket_only", "The emergency controls are used in the console by a signed-in administrator.");
  const isAdmin = await ctx.asUser((pve) => ctx.isNodeAdmin(pve));
  const sw = ctx.state.getSetting<KillSwitchState>(SETTING) ?? null;

  if (m[1] && !m[2]) {
    if (method !== "GET") throw new HttpError(405, "method", "Method not allowed");
    // Everyone signed in is told the switch is on (the console shows a banner); only administrators see what it did.
    return ctx.json(200, { canManage: isAdmin, killSwitch: isAdmin ? sw : sw ? { on: sw.on, at: sw.at } : null, vault: isAdmin ? { keyId: ctx.state.vaultKeyId() } : null }), true;
  }
  if (method !== "POST") throw new HttpError(405, "method", "Method not allowed");
  if (!isAdmin) throw new HttpError(403, "forbidden", "Only Proxmox administrators (Sys.Modify on /) can use the emergency controls.");
  ctx.sameSite();

  try {
    if (m[2] === "kill-switch") {
      const b = await ctx.readJson(1024);
      if (b.confirm !== KILL_CONFIRM) throw new HttpError(400, "confirm", `Type ${KILL_CONFIRM} to confirm.`);
      return ctx.json(200, { killSwitch: await engage(ctx, s) }), true;
    }

    if (m[2] === "resume") {
      const b = await ctx.readJson(1024);
      if (!sw?.on) throw new HttpError(409, "not_on", "The kill switch isn't on.");
      const failures: string[] = [];
      let resumed = 0;
      if (b.unpauseAgents === true && ctx.gateway) {
        for (const p of sw.paused) {
          try {
            await ctx.gateway.userJson(s, "POST", `/api/agents/${e(p.agentId)}/resume`, {});
            resumed++;
          } catch (err) {
            failures.push(`Agent ${p.agentId}: ${message(err)}`);
          }
        }
      }
      ctx.state.setSetting(SETTING, { ...sw, on: false });
      appendAudit(ctx.state, ctx.now, { actor: s.username, action: "safety.resume", target: "host", detail: `resumed ${resumed} agents, restarted no guests` });
      return ctx.json(200, { killSwitch: { ...sw, on: false }, resumedAgents: resumed, failures }), true;
    }

    if (m[3] === "export") {
      const b = await ctx.readJson(4 * 1024);
      const file = ctx.state.vaultRecoveryExport(typeof b.passphrase === "string" ? b.passphrase : "", new Date(ctx.now()));
      appendAudit(ctx.state, ctx.now, { actor: s.username, action: "vault.recovery.export", target: `key ${file.kid}` });
      return ctx.json(200, file, { "Content-Disposition": 'attachment; filename="epaperclip-vault-recovery.json"', "Cache-Control": "no-store" }), true;
    }

    if (m[3] === "restore") {
      const b = await ctx.readJson(16 * 1024);
      if (b.confirm !== RESTORE_CONFIRM) throw new HttpError(400, "confirm", `Type ${RESTORE_CONFIRM} to confirm.`);
      const r = ctx.state.vaultRestoreFromRecovery(b.file as RecoveryFile, typeof b.passphrase === "string" ? b.passphrase : "", ctx.now());
      appendAudit(ctx.state, ctx.now, { actor: s.username, action: "vault.recovery.restore", target: `key ${r.kid}`, detail: r.same ? "already the key in use" : "key file replaced; restart needed" });
      return ctx.json(200, { restored: !r.same, same: r.same, restartRequired: r.restartRequired, keptPreviousKey: r.backup !== null }), true;
    }
  } catch (err) {
    if (err instanceof VaultError) throw new HttpError(400, "vault_recovery", err.message);
    throw err;
  }
  throw new HttpError(404, "not_found", "Not found");
};
