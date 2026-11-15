import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectLink } from "../src/connectLink.ts";
import { ctlHandler, listenCtl } from "../src/ctl.ts";
import { StateStore } from "../src/state.ts";
import { fakeConnect, fakeTunnelHelper } from "./fakes-papercliped.ts";

const dirs: string[] = [];
const servers: { close: () => void }[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function boot() {
  const dir = mkdtempSync(join(tmpdir(), "epc-ctl-")); dirs.push(dir);
  const fc = fakeConnect();
  const link = new ConnectLink(new StateStore(null), fc.fetch, "https://connect.test", () => fc.state.now(), { helper: fakeTunnelHelper().helper });
  const revoked: string[] = [];
  const path = join(dir, "ctl.sock");
  const server = listenCtl(path, ctlHandler({ link, revokeIdentityLinks: async () => { revoked.push("identity"); } }));
  servers.push(server);
  const call = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) => new Promise<{ status: number; json: any }>((resolve, reject) => {
    const req = request({ socketPath: path, path: p, method, headers: { "content-type": "application/json", ...headers } }, (res) => {
      let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => resolve({ status: res.statusCode ?? 0, json: t ? JSON.parse(t) : {} }));
    });
    req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { dir, path, fc, link, call, revoked, ready: new Promise<void>((r) => server.on("listening", () => setTimeout(r, 20))) };
}

describe("control socket for epaperclip login/logout/whoami", () => {
  it("is private to its owner and drives the whole pairing, including the administrator's account check", async () => {
    const t = boot(); await t.ready;
    expect(statSync(t.path).mode & 0o777).toBe(0o600);
    const status = await t.call("GET", "/v1/connect/status");
    expect(status.status).toBe(200); expect(status.json).toMatchObject({ mode: "local", paired: false });
    const started = await t.call("POST", "/v1/connect/pairing/start", {});
    expect(started.json.pairing).toMatchObject({ state: "pending", linkUrl: expect.stringMatching(/^https:\/\/link\.papercliped\.co\//) });
    expect(JSON.stringify(started.json)).not.toMatch(/token/i);
    expect((await t.call("POST", "/v1/connect/pairing/poll", {})).json.pairing.state).toBe("pending");
    t.fc.approve("acct_one");
    expect((await t.call("POST", "/v1/connect/pairing/poll", {})).json.pairing).toMatchObject({ state: "approved", selectedOwner: "acct_one" });
    const wrong = await t.call("POST", "/v1/connect/pairing/confirm", { accountId: "acct_other", deviceName: "lab" });
    expect(wrong.status).toBe(409); expect(wrong.json.error).toBe("owner_mismatch");
    const done = await t.call("POST", "/v1/connect/pairing/confirm", { accountId: "acct_one", deviceName: "lab-node" });
    expect(done.json).toMatchObject({ paired: true, device: { accountId: "acct_one", name: "lab-node" } });
    const gone = await t.call("POST", "/v1/connect/unpair", {});
    expect(gone.json.paired).toBe(false); expect(t.revoked).toEqual(["identity"]);
  });

  it("answers only the listed actions, with the listed methods, and never to a browser", async () => {
    const t = boot(); await t.ready;
    expect((await t.call("GET", "/v1/connect/pairing/start")).status).toBe(405);
    expect((await t.call("POST", "/v1/connect/status", {})).status).toBe(405);
    expect((await t.call("GET", "/v1/anything-else")).status).toBe(404);
    expect((await t.call("GET", "/api/papercliped/connect/status")).status).toBe(404);
    expect((await t.call("GET", "/v1/connect/status", undefined, { origin: "https://evil.example" })).status).toBe(403);
    expect((await t.call("POST", "/v1/connect/pairing/confirm", { accountId: "x", deviceName: "y" })).json.error).toBe("not_approved");
  });

  it("replaces a stale socket from a crash but never deletes anything else", async () => {
    const dir = mkdtempSync(join(tmpdir(), "epc-ctl-")); dirs.push(dir);
    const path = join(dir, "ctl.sock");
    const first = listenCtl(path, ctlHandler({ link: boot().link, revokeIdentityLinks: async () => {} }));
    await new Promise((r) => first.on("listening", r));
    const second = listenCtl(path, ctlHandler({ link: boot().link, revokeIdentityLinks: async () => {} })); servers.push(second, first);
    await new Promise((r) => second.on("listening", r));
    expect(statSync(path).isSocket()).toBe(true);
    const file = join(dir, "notasocket"); writeFileSync(file, "keep me");
    const third = listenCtl(file, ctlHandler({ link: boot().link, revokeIdentityLinks: async () => {} })); servers.push(third);
    await new Promise((r) => third.on("error", r));
    expect(statSync(file).isFile()).toBe(true);
  });
});
