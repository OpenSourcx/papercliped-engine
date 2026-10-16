import type { IncomingMessage } from "node:http";
import { INBOX, NotesError, cleanFolder, cleanTag, type Query } from "./notes-core.ts";
import { applyDraft, buildInventory, createFolder, createNote, deleteFolder, deleteNote, draftView, exportZip, getNote, importZip, listNotes, notesFor, renameFolder, revealSecret, secretsAction, setSettings, shareNote, sharedNote, sharedWithMe, startSort, undoBatch, updateNote, emptyInventory, warningsFor, type Edit, type SecretMode } from "./notes-ops.ts";
import { IMPORT_LIMITS } from "./notes-zip.ts";
import type { FeatureCtx, FeatureHandler } from "./index.ts";
import type { Inventory } from "./notes-rules.ts";

/**
 * Notes, as routes (docs/NOTES.md). Notes belong to the signed-in person and only to them; the only way anyone else sees
 * one is an explicit share with an organization they both belong to. Everything here needs the Proxmox sign-in (not an API
 * token: notes are personal), changes need `X-EPC-Request: 1`, and input is validated before it is stored.
 */

const ID = "[0-9a-f]{16}";
const SORTS_PER_MINUTE = 6;

async function readRaw(req: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new NotesError(413, "too_large", "That file is too large to import.");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

const asEdits = (v: unknown): Edit[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 80) throw new NotesError(400, "bad_request", "edits must be a list of at most 80 proposals.");
  return v.map((e) => {
    if (!e || typeof e !== "object" || typeof (e as Edit).key !== "string") throw new NotesError(400, "bad_request", "Each edit needs the key of a proposal.");
    return e as Edit;
  });
};

export const handleNotes: FeatureHandler = async (ctx) => {
  if (!ctx.path.startsWith("/api/notes")) return false;
  const { HttpError, method } = ctx;
  const rest = ctx.path.slice("/api/notes".length);
  const s = ctx.session();
  // Notes are personal. A script's API token can't read or write someone's notes.
  if (s.apiToken) throw new HttpError(403, "ticket_only", "Notes are available in the console, to the signed-in person. API tokens can't read them.");
  const rt = notesFor(ctx.state);
  const user = s.username;
  const write = () => {
    ctx.sameSite();
  };
  try {
    return await route(ctx, rt, rest, method, user, write);
  } catch (e) {
    if (e instanceof NotesError) throw new HttpError(e.status, e.code, e.message);
    throw e;
  }
};

async function inventoryFor(ctx: FeatureCtx, rt: ReturnType<typeof notesFor>): Promise<Inventory> {
  try {
    return await ctx.asUser(async (pve, sess) => buildInventory(pve, await rt.orgsOf(sess, ctx.gateway)));
  } catch (e) {
    if (e instanceof ctx.HttpError && e.status === 401) throw e;
    return emptyInventory();
  }
}

async function route(ctx: FeatureCtx, rt: ReturnType<typeof notesFor>, rest: string, method: string, user: string, write: () => void): Promise<boolean> {
  const { HttpError } = ctx;
  const s = ctx.session();
  const q = ctx.url.searchParams;

  if (rest === "" || rest === "/") {
    if (method === "GET") {
      const query: Query = { q: q.get("q") ?? undefined, folder: q.get("folder") ? cleanFolder(q.get("folder")) : undefined, tag: q.get("tag") ? cleanTag(q.get("tag")) : undefined, pinned: q.get("pinned") === "1", machine: q.get("machine") ?? undefined, org: q.get("org") ?? undefined };
      return ctx.json(200, listNotes(rt, user, query)), true;
    }
    if (method === "POST") {
      write();
      const b = await ctx.readJson(160 * 1024);
      return ctx.json(201, createNote(rt, user, b, "manual")), true;
    }
    throw new HttpError(405, "method", "Method not allowed");
  }

  if (rest === "/capture" && method === "POST") {
    write();
    const b = await ctx.readJson(160 * 1024);
    return ctx.json(201, createNote(rt, user, { body: b.text, folder: INBOX, tags: b.tags }, "capture")), true;
  }

  if (rest === "/options" && method === "GET") {
    const inv = await inventoryFor(ctx, rt);
    return ctx.json(200, { machines: inv.machines.map((m) => ({ vmid: m.vmid, name: m.name, type: m.type })), storages: inv.storages, orgs: inv.orgs }), true;
  }

  if (rest === "/settings") {
    if (method === "GET") return ctx.json(200, { settings: rt.store.load(user).settings }), true;
    if (method === "PUT") {
      write();
      return ctx.json(200, { settings: setSettings(rt, user, await ctx.readJson()) }), true;
    }
    throw new HttpError(405, "method", "Method not allowed");
  }

  if (rest === "/folders") {
    if (method === "GET") return ctx.json(200, { folders: listNotes(rt, user, {}).folders }), true;
    write();
    if (method === "POST") return ctx.json(201, { path: createFolder(rt, user, (await ctx.readJson()).path) }), true;
    if (method === "PUT") {
      const b = await ctx.readJson();
      return ctx.json(200, { path: renameFolder(rt, user, b.from, b.to) }), true;
    }
    if (method === "DELETE") return deleteFolder(rt, user, q.get("path")), ctx.json(200, { ok: true }), true;
    throw new HttpError(405, "method", "Method not allowed");
  }

  if (rest === "/sort" && method === "POST") {
    write();
    const b = await ctx.readJson(160 * 1024);
    const t = ctx.now();
    const recent = (rt.sortTimes.get(user) ?? []).filter((x) => t - x < 60_000);
    if (recent.length >= SORTS_PER_MINUTE) throw new HttpError(429, "rate_limited", "That is a lot of sorting at once. Wait a moment and try again.");
    if (rt.sorting.has(user)) throw new HttpError(429, "rate_limited", "Pin is still sorting your last request.");
    recent.push(t);
    rt.sortTimes.set(user, recent);
    rt.sorting.add(user);
    try {
      const inv = await inventoryFor(ctx, rt);
      return ctx.json(200, await startSort(rt, user, b, inv)), true;
    } finally {
      rt.sorting.delete(user);
    }
  }

  const sort = rest.match(/^\/sort\/([0-9a-f]{16})(\/accept)?$/);
  if (sort) {
    if (method === "GET" && !sort[2]) return ctx.json(200, { draft: draftView(rt.draft(user, sort[1])) }), true;
    write();
    if (method === "DELETE" && !sort[2]) return rt.dropDraft(rt.draft(user, sort[1]).id), ctx.json(200, { ok: true }), true;
    if (method === "POST" && sort[2]) {
      const b = await ctx.readJson(160 * 1024);
      const mode = (b.secrets ?? "redact") as SecretMode;
      if (mode !== "redact" && mode !== "vault" && mode !== "keep") throw new HttpError(400, "bad_request", "secrets is redact, vault or keep.");
      const only = b.only === undefined ? undefined : Array.isArray(b.only) && b.only.every((x) => typeof x === "string") ? (b.only as string[]) : (() => { throw new HttpError(400, "bad_request", "only must be a list of proposal keys."); })();
      return ctx.json(200, applyDraft(rt, user, sort[1], { edits: asEdits(b.edits), only }, mode)), true;
    }
    throw new HttpError(405, "method", "Method not allowed");
  }

  const undo = rest.match(/^\/batches\/([0-9a-f]{12})\/undo$/);
  if (undo && method === "POST") {
    write();
    return ctx.json(200, undoBatch(rt, user, undo[1])), true;
  }

  if (rest === "/shared" && method === "GET") return ctx.json(200, { notes: await sharedWithMe(rt, s, ctx.gateway) }), true;
  const sh = rest.match(/^\/shared\/([^/]+)\/([0-9a-f]{16})$/);
  if (sh && method === "GET") {
    let owner = "";
    try {
      owner = decodeURIComponent(sh[1]);
    } catch {
      throw new HttpError(404, "not_found", "There is no such note.");
    }
    return ctx.json(200, { note: await sharedNote(rt, s, ctx.gateway, owner, sh[2]) }), true;
  }

  if (rest === "/export" && method === "GET") {
    const zip = exportZip(rt, user);
    ctx.res.writeHead(200, { "Content-Type": "application/zip", "Content-Disposition": 'attachment; filename="notes.zip"', "Content-Length": zip.length, "Cache-Control": "no-store" });
    ctx.res.end(zip);
    return true;
  }
  if (rest === "/import" && method === "POST") {
    write();
    const data = await readRaw(ctx.req, IMPORT_LIMITS.zipBytes);
    return ctx.json(200, importZip(rt, user, data)), true;
  }

  const one = rest.match(new RegExp(`^/(${ID})(?:/(secrets|share)(?:/(s\\d+)/(reveal))?)?$`));
  if (!one) throw new HttpError(404, "not_found", "Not found");
  const id = one[1];
  if (!one[2]) {
    if (method === "GET") {
      const note = getNote(rt, user, id);
      return ctx.json(200, { note, warnings: warningsFor(note.body) }), true;
    }
    write();
    if (method === "PUT") return ctx.json(200, updateNote(rt, user, id, await ctx.readJson(160 * 1024))), true;
    if (method === "DELETE") return deleteNote(rt, user, id), ctx.json(200, { ok: true }), true;
    throw new HttpError(405, "method", "Method not allowed");
  }
  if (method !== "POST") throw new HttpError(405, "method", "Method not allowed");
  write();
  if (one[2] === "secrets" && !one[3]) {
    const b = await ctx.readJson();
    if (b.action !== "redact" && b.action !== "vault") throw new HttpError(400, "bad_request", "action is redact or vault.");
    return ctx.json(200, secretsAction(rt, user, id, b.action)), true;
  }
  if (one[2] === "secrets" && one[3]) return ctx.json(200, revealSecret(rt, user, id, one[3])), true;
  if (one[2] === "share") {
    const b = await ctx.readJson();
    return ctx.json(200, { note: await shareNote(rt, s, ctx.gateway, id, b.orgId ?? null) }), true;
  }
  throw new HttpError(404, "not_found", "Not found");
}
