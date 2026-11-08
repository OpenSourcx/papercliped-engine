/**
 * The customer-facing Jev switch (docs/CONNECTORS.md, "Task routing with Jev"). The key is sealed in the host vault
 * under a per-organization name; settings keep only whether a key exists. It is read server-side when a task is routed.
 */
import { createJevProvider, createTypeSafeAsk, createTaskRouter, DEFAULT_ROUTING_TABLE, parseRoutingTable, type Ask, type JevProvider, type RouteDecision, type RoutingTable, type RunReport, type TaskContract } from "@papercliped-engine/task-router";
import type { StateStore } from "./state.ts";

export interface JevOrgSettings { enabled: boolean; secretId: string | null; consentSendTaskText: boolean }
export const EMPTY_JEV_SETTINGS: JevOrgSettings = { enabled: false, secretId: null, consentSendTaskText: false };

export interface SettingsStore {
  get(companyId: string): Promise<JevOrgSettings | undefined>;
  set(companyId: string, s: JevOrgSettings): Promise<void>;
}
/** Over the engine's secrets: `create` is settings.createSecret, `read` is the host's server-side resolution. */
export interface SecretPort {
  create(companyId: string, name: string, value: string): Promise<{ id: string }>;
  read(companyId: string, id: string): Promise<string | undefined>;
  remove?(companyId: string, id: string): Promise<void>;
}

/** Shown next to the switch. Kept here so the console and the docs say the same thing. */
export const JEV_CARD = {
  title: "Jev task routing (TypeSafe)",
  summary: "Use TypeSafe's Jev model to decide which AI model should do each task: a cheap one for routine work, a stronger one for hard or risky work.",
  disclosure:
    "When this is on, each new task's goal text, the names of the files it may change and its expected size are sent to TypeSafe, using your own TypeSafe API key, so Jev can answer three yes/no style questions. Nothing else is sent: no file contents, no comments, no secrets. Tasks tagged auth, billing, tenancy or security are never sent; they always go to the strongest model. If Jev is off, has no key, or fails, tasks are routed by built-in rules on this machine.",
  keyLabel: "TypeSafe API key",
  consentLabel: "I understand task text is sent to TypeSafe",
  switchLabel: "Route my organization's tasks with Jev",
} as const;

export interface JevSettingsView { enabled: boolean; hasKey: boolean; consentSendTaskText: boolean; active: boolean; disclosure: string }

export const toView = (s: JevOrgSettings): JevSettingsView => ({
  enabled: s.enabled,
  hasKey: !!s.secretId,
  consentSendTaskText: s.consentSendTaskText,
  active: s.enabled && !!s.secretId && s.consentSendTaskText,
  disclosure: JEV_CARD.disclosure,
});

export class SettingsError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}


export function createJevSettings(deps: { store: SettingsStore; secrets: SecretPort; fetch?: typeof fetch; ask?: (key: string) => Ask }) {
  const load = async (c: string) => (await deps.store.get(c)) ?? EMPTY_JEV_SETTINGS;
  const askFor = (key: string) => deps.ask?.(key) ?? createTypeSafeAsk({ apiKey: key, fetch: deps.fetch });

  const api = {
    view: async (c: string) => toView(await load(c)),

    async update(c: string, patch: { enabled?: unknown; consentSendTaskText?: unknown }) {
      const cur = await load(c);
      const next = { ...cur };
      if (patch.consentSendTaskText !== undefined) {
        if (typeof patch.consentSendTaskText !== "boolean") throw new SettingsError(400, "consentSendTaskText must be true or false.");
        next.consentSendTaskText = patch.consentSendTaskText;
        if (!next.consentSendTaskText) next.enabled = false; // taking consent back switches it off
      }
      if (patch.enabled !== undefined) {
        if (typeof patch.enabled !== "boolean") throw new SettingsError(400, "enabled must be true or false.");
        if (patch.enabled && !next.secretId) throw new SettingsError(409, "Add your TypeSafe API key first.");
        if (patch.enabled && !next.consentSendTaskText) throw new SettingsError(409, "Confirm that task text is sent to TypeSafe first.");
        next.enabled = patch.enabled;
      }
      await deps.store.set(c, next);
      return toView(next);
    },

    async setKey(c: string, apiKey: unknown) {
      if (typeof apiKey !== "string" || apiKey.trim().length < 8 || /\s/.test(apiKey.trim())) throw new SettingsError(400, "That doesn't look like a TypeSafe API key.");
      const cur = await load(c);
      const { id } = await deps.secrets.create(c, "typesafe-api-key", apiKey.trim());
      await deps.store.set(c, { ...cur, secretId: id });
      if (cur.secretId) await deps.secrets.remove?.(c, cur.secretId);
      return toView({ ...cur, secretId: id });
    },

    async removeKey(c: string) {
      const cur = await load(c);
      if (cur.secretId) await deps.secrets.remove?.(c, cur.secretId);
      const next = { ...cur, secretId: null, enabled: false };
      await deps.store.set(c, next);
      return toView(next);
    },

    /** One real question with fixed, harmless text, to show the key works. Sends no task text. */
    async test(c: string) {
      const cur = await load(c);
      const key = cur.secretId ? await deps.secrets.read(c, cur.secretId) : undefined;
      if (!key) throw new SettingsError(409, "Add your TypeSafe API key first.");
      try {
        await askFor(key)("Add a unit test for a date formatting helper.", { routine: { type: "noul", instructions: "This is a small coding task." } });
      } catch (e) {
        throw new SettingsError(502, (e as Error).message);
      }
      return { ok: true };
    },

    /** The provider to route with, or undefined when Jev is off, unconfigured or not consented. Read fresh on every call. */
    async providerFor(c: string): Promise<JevProvider | undefined> {
      const cur = await load(c);
      if (!toView(cur).active || !cur.secretId) return undefined;
      const key = await deps.secrets.read(c, cur.secretId);
      return key ? createJevProvider(askFor(key)) : undefined;
    },
  };

  return api;
}
export type JevSettings = ReturnType<typeof createJevSettings>;

const SETTINGS = (c: string) => `task-router-jev:${c}`;
const TABLE = (c: string) => `task-router-table:${c}`;
const KEY_NAME = (c: string) => `task-router-typesafe:${c}`;

/** Settings and key kept in the host's state store: the key is sealed by its vault, the settings hold no secret. */
export function stateJevPorts(state: StateStore): { store: SettingsStore; secrets: SecretPort } {
  return {
    store: { get: async (c) => state.getSetting<JevOrgSettings>(SETTINGS(c)), set: async (c, v) => state.setSetting(SETTINGS(c), v) },
    secrets: {
      async create(c, _name, value) { state.setSecret(KEY_NAME(c), value); return { id: KEY_NAME(c) }; },
      async read(c, id) { return id === KEY_NAME(c) ? (state.getSecret(id) ?? undefined) : undefined; },
      async remove(c, id) { if (id === KEY_NAME(c)) state.deleteSecret(id); },
    },
  };
}

export const getTable = (state: StateStore, c: string): unknown => state.getSetting<unknown>(TABLE(c));
export function saveTable(state: StateStore, c: string, raw: unknown): RoutingTable {
  const t = parseRoutingTable(raw);
  state.setSetting(TABLE(c), t);
  return t;
}

/**
 * The entry point for routing a task: the organization's table (the default if none or if the saved one is invalid,
 * with a note), and Jev only when the organization has switched it on.
 */
export function createOrgRouter(state: StateStore, jev: Pick<JevSettings, "providerFor">) {
  function tableFor(c: string): { table: RoutingTable; error?: string } {
    const stored = getTable(state, c);
    if (stored === undefined) return { table: DEFAULT_ROUTING_TABLE };
    try { return { table: parseRoutingTable(stored) }; } catch (e) { return { table: DEFAULT_ROUTING_TABLE, error: `Routing table ignored: ${(e as Error).message}` }; }
  }
  return {
    async route(c: string, task: TaskContract): Promise<RouteDecision> {
      const { table, error } = tableFor(c);
      const d = await createTaskRouter({ table, jev: await jev.providerFor(c) }).route(task);
      return error ? { ...d, reasons: [...d.reasons, error] } : d;
    },
    async next(c: string, current: RouteDecision, report: RunReport): Promise<RouteDecision | null> {
      return createTaskRouter({ table: tableFor(c).table }).next(current, report);
    },
  };
}
