import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startPinApp } from "./fakes-pin.ts";

let h: Awaited<ReturnType<typeof startPinApp>>;
let sam: string;
let lee: string;
const j = async (r: Response): Promise<any> => r.json();
const DAY = 86_400_000;
const memGuard = { name: "Memory guard", trigger: { type: "condition", when: { metric: "memory_percent", op: ">", value: 50, forSeconds: 0 }, cooldownSeconds: 0, everySeconds: 60 }, scope: { guestType: "lxc" }, then: { action: "shutdown" } };
const create = async (body: unknown = memGuard, cookie = sam) => {
  const r = await h.call("POST", "/api/pin/automations", { cookie }, body);
  return { status: r.status, body: await j(r) };
};

beforeEach(async () => {
  h = await startPinApp({ helper: true });
  sam = await h.signIn("sam");
  lee = await h.signIn("lee");
});
afterEach(() => h.close());

describe("automation tokens have a finite life", () => {
  it("expires after 90 days by default, in Proxmox and in the host, or after the days asked for", async () => {
    const r = await create();
    expect(r.status).toBe(201);
    expect(r.body.automation.tokenExpiresAt).toBe(h.clock.t + 90 * DAY);
    const tok = h.pve.tokens.get("sam@pve")!.get(`epcauto-${r.body.automation.id}`)!;
    expect(tok.expire).toBe(Math.floor((h.clock.t + 90 * DAY) / 1000));
    const short = await create({ ...memGuard, tokenDays: 7 });
    expect(short.body.automation.tokenExpiresAt).toBe(h.clock.t + 7 * DAY);
    for (const bad of [0, 400, 1.5, "7"]) expect((await create({ ...memGuard, tokenDays: bad })).status).toBe(400);
  });

  it("warns the owner a week before the end, then stops (not fails) the automation when it ends", async () => {
    const id = (await create({ ...memGuard, tokenDays: 10 })).body.automation.id;
    h.clock.t += 4 * DAY;
    sam = await h.signIn("sam"); // the browser session idled out meanwhile
    await h.runner.tick();
    let inbox = (await j(await h.call("GET", "/api/pin/notifications", { cookie: sam }))).notifications;
    expect(inbox.some((n: any) => /token ends soon/.test(n.title))).toBe(true);
    h.clock.t += 7 * DAY;
    sam = await h.signIn("sam");
    await h.runner.tick();
    const a = (await j(await h.call("GET", `/api/pin/automations/${id}`, { cookie: sam }))).automation;
    expect(a.paused).toMatchObject({ by: "runner", reason: expect.stringMatching(/token expired/) });
    expect((await j(await h.call("GET", `/api/pin/automations/${id}`, { cookie: sam }))).runs.every((r: any) => r.status !== "failed")).toBe(true);
    inbox = (await j(await h.call("GET", "/api/pin/notifications", { cookie: sam }))).notifications;
    expect(inbox.some((n: any) => /token expired/.test(n.title))).toBe(true);
  });

  it("renews: a new end date in Proxmox and here, and an expiry pause lifts", async () => {
    const id = (await create({ ...memGuard, tokenDays: 2 })).body.automation.id;
    h.clock.t += 3 * DAY;
    sam = await h.signIn("sam");
    await h.runner.tick();
    const r = await h.call("POST", `/api/pin/automations/${id}/renew`, { cookie: sam }, { days: 30 });
    expect(r.status).toBe(200);
    const a = (await j(r)).automation;
    expect(a.tokenExpiresAt).toBe(h.clock.t + 30 * DAY);
    expect(a.paused).toBeNull();
    expect(h.pve.tokens.get("sam@pve")!.get(`epcauto-${id}`)!.expire).toBe(Math.floor((h.clock.t + 30 * DAY) / 1000));
  });

  it("a pause the owner chose stays after renewing; renewing validates days and belongs to the owner", async () => {
    const id = (await create()).body.automation.id;
    await h.call("POST", `/api/pin/automations/${id}/pause`, { cookie: sam });
    const r = await j(await h.call("POST", `/api/pin/automations/${id}/renew`, { cookie: sam }, {}));
    expect(r.automation.paused).toMatchObject({ by: "user" });
    expect(r.automation.tokenExpiresAt).toBe(h.clock.t + 90 * DAY);
    expect((await h.call("POST", `/api/pin/automations/${id}/renew`, { cookie: sam }, { days: 999 })).status).toBe(400);
    expect((await h.call("POST", `/api/pin/automations/${id}/renew`, { cookie: lee }, {})).status).toBe(404);
  });
});
