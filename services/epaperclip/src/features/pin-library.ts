import type { FeatureCtx } from "./index.ts";
import { LibraryError, libraryFor, type MemoryFile } from "./pin-store.ts";

/**
 * Pin's saved conversations and its SOUL.md and MEMORY.md, as routes (docs/PIN.md, "Chats and memory"). Both belong to the
 * signed-in person and to nobody else. They need the Proxmox sign-in, not a script's API token, and changes need
 * `X-EPC-Request: 1`.
 *
 *   GET    /api/pin/chats               the person's chats, newest first
 *   POST   /api/pin/chats               a new, empty chat
 *   GET    /api/pin/chats/:id           one chat with its messages
 *   PATCH  /api/pin/chats/:id           rename
 *   DELETE /api/pin/chats/:id
 *   GET    /api/pin/memory              SOUL.md, MEMORY.md and the revision they are at
 *   PUT    /api/pin/memory/soul|memory  save (a stale baseRev is refused with 409)
 *   GET    /api/pin/memory/history      earlier versions (without their text)
 *   POST   /api/pin/memory/restore      put an earlier version back
 *   POST   /api/pin/memory/remember     save one line the person typed themselves (the composer's "#")
 */

const CHAT = /^\/api\/pin\/chats(?:\/([0-9a-f]{16}))?$/;
const MEMORY = /^\/api\/pin\/memory(?:\/(soul|memory|history|restore|remember))?$/;

export async function libraryRoutes(ctx: FeatureCtx): Promise<boolean> {
  const chat = CHAT.exec(ctx.path);
  const mem = MEMORY.exec(ctx.path);
  if (!chat && !mem) return false;
  const { HttpError, method } = ctx;
  const s = ctx.session();
  if (s.apiToken) throw new HttpError(403, "ticket_only", "Chats and memory are personal. They're available in the console, to the signed-in person.");
  const lib = libraryFor(ctx.state);
  const user = s.username;
  try {
    if (chat) {
      const id = chat[1];
      if (!id) {
        if (method === "GET") return ctx.json(200, { chats: lib.listChats(user) }), true;
        if (method === "POST") {
          ctx.sameSite();
          return ctx.json(201, { chat: lib.createChat(user) }), true;
        }
        throw new HttpError(405, "method", "Method not allowed");
      }
      if (method === "GET") return ctx.json(200, { chat: lib.getChat(user, id) }), true;
      if (method === "PATCH") {
        ctx.sameSite();
        const b = await ctx.readJson(4096);
        return ctx.json(200, { chat: { ...lib.renameChat(user, id, b.title), messages: undefined } }), true;
      }
      if (method === "DELETE") {
        ctx.sameSite();
        lib.deleteChat(user, id);
        return ctx.json(200, { ok: true }), true;
      }
      throw new HttpError(405, "method", "Method not allowed");
    }

    const which = mem![1];
    if (!which) {
      if (method !== "GET") throw new HttpError(405, "method", "Method not allowed");
      return ctx.json(200, lib.view(user)), true;
    }
    if (which === "history") {
      if (method !== "GET") throw new HttpError(405, "method", "Method not allowed");
      return ctx.json(200, { revisions: lib.history(user) }), true;
    }
    if (method !== "PUT" && method !== "POST") throw new HttpError(405, "method", "Method not allowed");
    ctx.sameSite();
    const b = await ctx.readJson(64 * 1024);
    if (which === "restore") return ctx.json(200, lib.restore(user, b.rev)), true;
    if (which === "remember") {
      // A line the person typed themselves (the composer's "#"): their own words, so no gate. The revision before the
      // save comes back with it so the console can undo through the ordinary restore route.
      if (method !== "POST") throw new HttpError(405, "method", "Method not allowed");
      if (typeof b.text !== "string") throw new HttpError(400, "bad_request", "text must be a string.");
      // Nothing typed (or only spaces) is nothing to keep; say that rather than let the store's length check answer.
      if (!b.text.trim()) throw new HttpError(400, "nothing_typed", "Type what to remember after the #.");
      const before = lib.view(user);
      const r = lib.remember(user, b.text);
      if (!r.ok) throw new HttpError(400, "not_saved", r.message);
      const after = lib.view(user);
      const saved = r.message.startsWith("Already in") ? null : after.memory.trim().split("\n").pop() ?? null;
      return ctx.json(200, { ok: true, message: r.message, line: saved, rev: before.rev }), true;
    }
    const baseRev = b.baseRev === undefined ? undefined : Number(b.baseRev);
    if (baseRev !== undefined && !Number.isInteger(baseRev)) throw new HttpError(400, "bad_request", "baseRev must be a whole number.");
    return ctx.json(200, lib.setFile(user, which as MemoryFile, b.text, { baseRev })), true;
  } catch (e) {
    if (e instanceof LibraryError) throw new HttpError(e.status, e.code, e.message);
    throw e;
  }
}
