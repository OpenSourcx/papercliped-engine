/**
 * The customer-facing Jev switch (Settings > Connectors). Framework-free: the host service mounts `handle` under
 * /api/task-router/orgs/:companyId/jev and passes in a secret port. The key is stored as a Paperclip secret; only its id
 * is kept here, and it is read server-side at the moment a task is routed.
 */
import { createJevProvider, type JevProvider } from "./jev.ts";
import { createTypeSafeAsk, type Ask } from "./typesafe.ts";

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

export interface Actor { isAdmin: boolean }
export interface Reply { status: number; body: unknown }

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

  /** Dispatcher for the host's router: `sub` is the path after `/jev`. Changing anything needs an administrator. */
  async function handle(method: string, sub: string, companyId: string, body: Record<string, unknown> | undefined, actor: Actor): Promise<Reply> {
    try {
      const route = `${method.toUpperCase()} ${sub.replace(/\/+$/, "") || "/"}`;
      if (route === "GET /") return { status: 200, body: await api.view(companyId) };
      if (!actor.isAdmin) return { status: 403, body: { error: "Only an organization administrator can change this." } };
      if (route === "PUT /") return { status: 200, body: await api.update(companyId, body ?? {}) };
      if (route === "PUT /key") return { status: 200, body: await api.setKey(companyId, body?.apiKey) };
      if (route === "DELETE /key") return { status: 200, body: await api.removeKey(companyId) };
      if (route === "POST /test") return { status: 200, body: await api.test(companyId) };
      return { status: 404, body: { error: "Not found." } };
    } catch (e) {
      if (e instanceof SettingsError) return { status: e.status, body: { error: e.message } };
      throw e;
    }
  }
  return { ...api, handle };
}
export type JevSettings = ReturnType<typeof createJevSettings>;
