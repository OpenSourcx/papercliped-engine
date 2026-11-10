import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startConnectApp, type ConnectApp } from "./fakes-connect.ts";
import { wsOpen } from "./fakes.ts";

const exec = vi.hoisted(() => vi.fn());
vi.mock("../src/features/guest-exec.ts", async (orig) => ({ ...(await orig<typeof import("../src/features/guest-exec.ts")>()), execInGuest: exec }));

let h: ConnectApp;
const guest = (vmid: number, name: string, pool: string, status = "running", extra: Record<string, unknown> = {}) => ({ id: `lxc/${vmid}`, type: "lxc", vmid, node: "pve", name, status, pool, ...extra });
const resources = [guest(301, "agent-a1", "epc-co1"), guest(302, "agent-a2", "epc-co1", "stopped"), guest(300, "template", "epc-co1", "stopped", { template: 1 }), guest(401, "agent-b1", "epc-co2"), guest(500, "no-pool", "")];

beforeEach(async () => {
  exec.mockReset().mockResolvedValue({ exitCode: 0, output: "hi\n", timedOut: false, truncated: false });
  h = await startConnectApp({
    pveExtra: (base) => (req) => {
      const u = new URL(req.url);
      if (u.pathname.endsWith("/cluster/resources") && req.method === "GET") return Promise.resolve({ status: 200, body: JSON.stringify({ data: resources }) });
      return base(req);
    },
  });
  h.state.setSetting("resourceGroups", { co_1: { pool: "epc-co1" }, co_2: { pool: "epc-co2" } });
});
afterEach(() => h.closeAll());

const j = async (r: Response) => (await r.json()) as any;
const list = (co: string, cookie = h.sam) => h.call("GET", `/api/agent-containers/orgs/${co}`, { cookie });
const run = (co: string, vmid: number, body: unknown, cookie = h.sam) => h.call("POST", `/api/agent-containers/orgs/${co}/${vmid}/exec`, { cookie }, body);

describe("shell access to an organization's agent containers", () => {
  it("lists only the organization's own containers (no templates, nothing from another pool), to any member", async () => {
    const mine = (await j(await list("co_1"))).containers;
    expect(mine.map((c: any) => c.vmid)).toEqual([301, 302]);
    expect(mine[0]).toMatchObject({ name: "agent-a1", status: "running", consolePath: "/api/console/guests/301?org=co_1" });
    expect((await j(await list("co_2"))).containers.map((c: any) => c.vmid)).toEqual([401]);
    // lee is an operator of co_1: may look, not open a shell.
    expect((await j(await list("co_1", h.lee))).containers).toHaveLength(2);
  });

  it("never reaches another organization: not a member, or a machine in another pool", async () => {
    expect((await list("co_2", h.lee)).status).toBe(403); // lee is not in co_2
    expect((await run("co_2", 401, { script: "id" }, h.lee)).status).toBe(403);
    // sam owns both, but a machine is reachable only through its own organization.
    expect((await run("co_1", 401, { script: "id" })).status).toBe(404);
    expect((await run("co_2", 301, { script: "id" })).status).toBe(404);
    expect((await run("co_1", 500, { script: "id" })).status).toBe(404);
    expect((await run("co_1", 300, { script: "id" })).status).toBe(404); // a template
    expect(exec).not.toHaveBeenCalled();
  });

  it("runs a command for an owner or admin, in a running container, and audits it without the script", async () => {
    const r = await run("co_1", 301, { script: "echo secret-ish", timeoutMs: 5000 });
    expect(r.status).toBe(200);
    expect(await j(r)).toEqual({ exitCode: 0, output: "hi\n", timedOut: false, truncated: false });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0]![1]).toEqual({ type: "lxc", vmid: 301, node: "pve" });
    expect(exec.mock.calls[0]![2]).toBe("echo secret-ish");
    expect((await run("co_1", 302, { script: "id" })).status).toBe(409); // stopped
    expect((await run("co_1", 301, { script: "id" }, h.lee)).status).toBe(403); // operator
    const audit = JSON.stringify(await j(await h.call("GET", "/api/access/audit", { cookie: h.sam })));
    expect(audit).toContain("agent-container.exec");
    expect(audit).not.toContain("secret-ish");
  });

  it("validates the request and an organization with no resource group has nothing to reach", async () => {
    expect((await run("co_1", 301, { script: "" })).status).toBe(400);
    expect((await run("co_1", 301, { script: "id", timeoutMs: 5 })).status).toBe(400);
    expect((await run("co_1", 301, { script: "id", cwd: "/" })).status).toBe(400);
    h.state.setSetting("resourceGroups", {});
    expect((await j(await list("co_1"))).containers).toEqual([]);
    expect((await run("co_1", 301, { script: "id" })).status).toBe(404);
  });

  it("refuses a console opened for an organization that is not the machine's, or by someone who is not its owner or admin", async () => {
    const refused = async (path: string, cookie: string) => {
      const { out, closed } = await wsOpen(`${h.base.replace("http", "ws")}${path}`, { Cookie: cookie, Origin: h.base });
      expect((await closed).code).toBe(4000);
      return out.join("");
    };
    expect(await refused("/api/console/guests/401?org=co_1", h.sam)).toContain("isn't one of this organization's");
    expect(await refused("/api/console/guests/301?org=co_2", h.sam)).toContain("isn't one of this organization's");
    expect(await refused("/api/console/guests/401?org=co_2", h.lee)).toContain("aren't a member");
    expect(await refused("/api/console/guests/301?org=co_1", h.lee)).toContain("owners and admins");
    expect(await refused("/api/console/guests/301?org=bad%20id", h.sam)).toContain("Unknown organization");
  });
});
