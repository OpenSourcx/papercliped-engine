import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { SessionStore } from "../src/sessions.ts";
import { StateStore } from "../src/state.ts";
import { fakeEngine, fakePve } from "./fakes.ts";

let eng: Awaited<ReturnType<typeof fakeEngine>>;
let server: Server;
let base: string;
let status = 404;

beforeEach(async () => {
  eng = await fakeEngine();
  const pve = fakePve();
  const transport: typeof pve.transport = async (req) => (req.url.includes("/access/roles") ? { status, body: "" } : pve.transport(req));
  server = createServer(createApp({ pve: { baseUrl: "https://127.0.0.1:8006", node: "pve", transport }, sessions: new SessionStore(), staticDir: null, secureCookies: false, state: new StateStore(mkdtempSync(join(tmpdir(), "epc-err-"))), engine: { url: eng.url, sleep: async () => {} }, containers: { paceMs: 0 } }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await eng.close();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const signIn = async () => (await fetch(base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json", "X-EPC-Request": "1" }, body: JSON.stringify({ username: "sam", password: "right", realm: "pve" }) })).headers.get("set-cookie")!.split(";")[0];

describe("the agent containers check when Proxmox can't answer", () => {
  it.each([[404, /doesn't have what was asked for/], [403, /doesn't have permission/], [500, /reported an error \(500\)/]])("explains a %i in words, once, without the API path", async (code, words) => {
    status = code;
    const r = await fetch(base + "/api/agent-containers", { headers: { Cookie: await signIn() } });
    const text = await r.text();
    const body = JSON.parse(text);
    expect(body.error).toMatch(/^Couldn't check Proxmox\./);
    expect(body.error).toMatch(words);
    expect(text).not.toMatch(/\/access\/roles|failed \(\d+\)|Proxmox GET/);
    for (const id of ["access", "key", "template", "grant"]) expect(body.steps.find((s: any) => s.id === id).detail).toBe("Not checked");
  });
});
