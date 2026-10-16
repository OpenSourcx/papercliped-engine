import { startPinApp } from "./fakes-pin.ts";
import { configureNotes, type OrgRef } from "../src/features/notes-ops.ts";
import type { NotesModel } from "../src/features/notes-sort.ts";

/**
 * Test support for Notes: a host service (Pin's test app with its fake Proxmox) with Notes configured to use a scripted
 * model, and a table of who belongs to which organization. The scripted model records every request it receives, so a
 * test can assert what a model is, and is not, shown.
 */

export interface ModelCall {
  system: string;
  user: string;
  payload: { chunks: { n: number; text: string }[]; folders: string[]; tags: string[] };
}

export function scriptedModel() {
  const calls: ModelCall[] = [];
  const st = {
    /** Called with the parsed request; returns the model's raw answer text, or throws. */
    answer: null as null | ((c: ModelCall) => string),
  };
  const model: NotesModel = async ({ system, user }) => {
    const call = { system, user, payload: JSON.parse(user) } as ModelCall;
    calls.push(call);
    if (!st.answer) throw new Error("no model");
    return st.answer(call);
  };
  return { model, calls, st };
}

export async function startNotesApp(o: { withModel?: boolean } = {}) {
  const h = await startPinApp();
  const fake = scriptedModel();
  const orgs = new Map<string, OrgRef[]>();
  const rt = configureNotes(h.state, {
    now: () => h.clock.t,
    model: () => (o.withModel === false ? null : fake.model),
    orgsOf: async (s) => orgs.get(s.username) ?? [],
  });
  const api = (cookie: string) => ({
    get: async (path: string) => h.call("GET", `/api/notes${path}`, { cookie }),
    send: async (method: string, path: string, body?: unknown) => h.call(method, `/api/notes${path}`, { cookie }, body ?? {}),
    json: async (method: string, path: string, body?: unknown): Promise<any> => {
      const r = await h.call(method, `/api/notes${path}`, { cookie }, method === "GET" ? undefined : (body ?? {}));
      return { status: r.status, body: await r.json() };
    },
  });
  return { ...h, fake, orgs, notes: rt, api };
}
