import { randomBytes } from "node:crypto";
import type { StateStore } from "../state.ts";

/**
 * The system vault: variables and secrets that belong to the whole host, not to one organization. Each has a name
 * (an environment-variable name such as GITHUB_TOKEN), a value sealed by the host's vault, and who may use it:
 *
 *   - Pin only: Pin can use it; no organization sees it.
 *   - Selected CEOs: Pin, and the CEO agents an administrator picks, in any organization.
 *
 * Paperclip has no instance-wide variables: its secrets belong to one company and agents point at them. So a value is
 * kept here once, and shared by writing a company secret in each chosen CEO's organization and pointing that agent's
 * environment at it (`secret_ref`); see vault-sync.ts. Nothing here talks to the engine.
 */

export const LIMITS = { items: 200, value: 16_384, description: 200, targets: 200 } as const;

export class VaultError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** A CEO agent in one organization. */
export interface Target {
  companyId: string;
  agentId: string;
}

export interface VaultItem {
  id: string;
  /** The environment variable name an agent sees. */
  name: string;
  description: string;
  share: "pin" | "ceos";
  targets: Target[];
  last4: string;
  createdAt: number;
  updatedAt: number;
  updatedBy: string;
  /** Where each share has been written in the engine: `companyId` -> the company secret's id. Not the value. */
  synced: Record<string, string>;
}

interface Doc {
  v: 1;
  items: VaultItem[];
}

/** Environment variable names: what a shell accepts, upper-case by convention, and never one that changes how a process starts. */
const NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const RESERVED = /^(PATH|HOME|SHELL|USER|LD_[A-Z_]+|DYLD_[A-Z_]+|NODE_OPTIONS|PAPERCLIP_[A-Z_]+|BASH_ENV|ENV|IFS|PS4)$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export const checkName = (v: unknown): string => {
  const name = typeof v === "string" ? v.trim().toUpperCase().replace(/[\s-]+/g, "_") : "";
  if (!NAME.test(name)) throw new VaultError(400, "bad_name", "A name uses letters, digits and underscores, starts with a letter, and is up to 64 characters. For example GITHUB_TOKEN.");
  if (RESERVED.test(name)) throw new VaultError(400, "reserved_name", `${name} changes how programs start, so it can't be a vault variable.`);
  return name;
};

const checkValue = (v: unknown): string => {
  if (typeof v !== "string" || !v.length) throw new VaultError(400, "bad_value", "A value is required.");
  if (v.length > LIMITS.value) throw new VaultError(400, "bad_value", `A value can be up to ${LIMITS.value} characters.`);
  if (v.includes("\0")) throw new VaultError(400, "bad_value", "A value can't contain a null character.");
  return v;
};

const checkTargets = (v: unknown): Target[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > LIMITS.targets) throw new VaultError(400, "bad_targets", `Pick up to ${LIMITS.targets} CEOs.`);
  const seen = new Set<string>();
  const out: Target[] = [];
  for (const t of v) {
    const { companyId, agentId } = (t ?? {}) as Record<string, unknown>;
    if (typeof companyId !== "string" || typeof agentId !== "string" || !ID.test(companyId) || !ID.test(agentId)) throw new VaultError(400, "bad_targets", "Each CEO is a companyId and an agentId.");
    if (seen.has(agentId)) continue;
    seen.add(agentId);
    out.push({ companyId, agentId });
  }
  return out;
};

const oneLine = (s: unknown, max: number) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "");

const valueKey = (id: string) => `vault.value:${id}`;
const DOC = "vault.items";

/** What the console may show: everything except the value. */
export type PublicItem = Omit<VaultItem, "synced"> & { syncedTo: string[] };
const pub = ({ synced, ...rest }: VaultItem): PublicItem => ({ ...rest, syncedTo: Object.keys(synced) });

export class Vault {
  private readonly state: StateStore;
  private readonly now: () => number;
  constructor(state: StateStore, now: () => number = Date.now) {
    this.state = state;
    this.now = now;
  }

  private load(): Doc {
    return this.state.getSetting<Doc>(DOC) ?? { v: 1, items: [] };
  }
  private save(doc: Doc) {
    this.state.setSetting(DOC, doc);
  }

  list(): PublicItem[] {
    return this.load().items.map(pub).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The record, with its sync map, for the sync code. */
  record(id: string): VaultItem | null {
    return this.load().items.find((i) => i.id === id) ?? null;
  }
  all(): VaultItem[] {
    return this.load().items;
  }
  byName(name: string): VaultItem | null {
    return this.load().items.find((i) => i.name === name) ?? null;
  }

  /** The value, for server-side use only (Pin, and the sync). */
  value(id: string): string | null {
    return this.state.getSecret(valueKey(id));
  }

  create(b: { name?: unknown; value?: unknown; description?: unknown; share?: unknown; targets?: unknown }, by: string): PublicItem {
    const doc = this.load();
    const name = checkName(b.name);
    if (doc.items.some((i) => i.name === name)) throw new VaultError(409, "name_taken", `${name} is already in the vault. Edit it, or pick another name.`);
    if (doc.items.length >= LIMITS.items) throw new VaultError(400, "limit", `The vault holds up to ${LIMITS.items} variables.`);
    const value = checkValue(b.value);
    const { share, targets } = this.access(b);
    const t = this.now();
    const item: VaultItem = { id: randomBytes(8).toString("hex"), name, description: oneLine(b.description, LIMITS.description), share, targets, last4: value.length >= 12 ? value.slice(-4) : "", createdAt: t, updatedAt: t, updatedBy: by, synced: {} };
    this.state.setSecret(valueKey(item.id), value);
    this.save({ v: 1, items: [...doc.items, item] });
    return pub(item);
  }

  private access(b: { share?: unknown; targets?: unknown }, current?: VaultItem): { share: "pin" | "ceos"; targets: Target[] } {
    const share = b.share === undefined ? (current?.share ?? "pin") : b.share;
    if (share !== "pin" && share !== "ceos") throw new VaultError(400, "bad_share", 'Share is "pin" (Pin only) or "ceos" (selected CEOs).');
    const targets = share === "pin" ? [] : b.targets === undefined ? (current?.targets ?? []) : checkTargets(b.targets);
    return { share, targets };
  }

  /** Changes the description, who it is shared with, and/or the value. Returns what changed in the sharing, for the sync. */
  update(id: string, b: { value?: unknown; description?: unknown; share?: unknown; targets?: unknown }, by: string): { item: PublicItem; valueChanged: boolean } {
    const doc = this.load();
    const cur = doc.items.find((i) => i.id === id);
    if (!cur) throw new VaultError(404, "not_found", "That variable isn't in the vault.");
    const { share, targets } = this.access(b, cur);
    const next: VaultItem = { ...cur, share, targets, updatedAt: this.now(), updatedBy: by };
    if (b.description !== undefined) next.description = oneLine(b.description, LIMITS.description);
    let valueChanged = false;
    if (b.value !== undefined) {
      const value = checkValue(b.value);
      this.state.setSecret(valueKey(id), value);
      next.last4 = value.length >= 12 ? value.slice(-4) : "";
      valueChanged = true;
    }
    this.save({ v: 1, items: doc.items.map((i) => (i.id === id ? next : i)) });
    return { item: pub(next), valueChanged };
  }

  setSynced(id: string, synced: Record<string, string>) {
    const doc = this.load();
    this.save({ v: 1, items: doc.items.map((i) => (i.id === id ? { ...i, synced } : i)) });
  }

  remove(id: string): VaultItem {
    const doc = this.load();
    const cur = doc.items.find((i) => i.id === id);
    if (!cur) throw new VaultError(404, "not_found", "That variable isn't in the vault.");
    this.state.deleteSecret(valueKey(id));
    this.save({ v: 1, items: doc.items.filter((i) => i.id !== id) });
    return cur;
  }
}

export const vaultFor = (state: StateStore, now?: () => number) => new Vault(state, now);
