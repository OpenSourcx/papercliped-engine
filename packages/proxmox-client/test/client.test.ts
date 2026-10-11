import { describe, expect, it } from "vitest";
import { ProxmoxClient, ProxmoxError, type Transport } from "../src/index.ts";

function recorder(responses: { status: number; body: unknown }[]) {
  const seen: Parameters<Transport>[0][] = [];
  const transport: Transport = async (req) => {
    seen.push(req);
    const r = responses.shift() ?? { status: 200, body: { data: null } };
    return { status: r.status, body: typeof r.body === "string" ? r.body : JSON.stringify(r.body) };
  };
  return { seen, transport };
}

const client = (transport: Transport) => new ProxmoxClient({ baseUrl: "https://pve.test:8006/", tokenId: "broker@pve!engine", tokenSecret: "s3cret", transport });

describe("ProxmoxClient", () => {
  it("refuses plain http", () => {
    expect(() => new ProxmoxClient({ baseUrl: "http://pve.test:8006", tokenId: "a@pve!b", tokenSecret: "x" })).toThrow(/https/);
  });

  it("sends the API token header and form bodies for writes", async () => {
    const { seen, transport } = recorder([{ status: 200, body: { data: "UPID:1" } }]);
    const upid = await client(transport).createLxc("pve", { vmid: 9001, unprivileged: true, onboot: false, "ssh-public-keys": "ssh-ed25519 AAAA x", skipped: undefined });
    expect(upid).toBe("UPID:1");
    expect(seen[0].method).toBe("POST");
    expect(seen[0].url).toBe("https://pve.test:8006/api2/json/nodes/pve/lxc");
    expect(seen[0].headers.Authorization).toBe("PVEAPIToken=broker@pve!engine=s3cret");
    expect(seen[0].headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(new URLSearchParams(seen[0].body)).toEqual(new URLSearchParams({ vmid: "9001", unprivileged: "1", onboot: "0", "ssh-public-keys": "ssh-ed25519 AAAA x" }));
  });

  it("puts reads and deletes in the query string and encodes path segments", async () => {
    const { seen, transport } = recorder([{ status: 200, body: { data: [] } }, { status: 200, body: { data: "UPID:2" } }, { status: 200, body: { data: { status: "running" } } }]);
    const c = client(transport);
    await c.clusterResources();
    await c.destroyLxc("pve", 9001);
    await c.taskStatus("pve", "UPID:pve:00001:x:");
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      "GET https://pve.test:8006/api2/json/cluster/resources?type=vm",
      "DELETE https://pve.test:8006/api2/json/nodes/pve/lxc/9001?force=1",
      "GET https://pve.test:8006/api2/json/nodes/pve/tasks/UPID%3Apve%3A00001%3Ax%3A/status",
    ]);
    expect(seen[1].body).toBeUndefined();
  });

  it("asks for usage history the way the Proxmox UI does", async () => {
    const { seen, transport } = recorder([{ status: 200, body: { data: [{ time: 1, cpu: 0.2 }] } }, { status: 200, body: { data: [] } }]);
    const c = client(transport);
    expect(await c.guestRrd("pve", "lxc", 9001, "day", "MAX")).toEqual([{ time: 1, cpu: 0.2 }]);
    await c.nodeRrd("pve", "week");
    expect(seen.map((s) => s.url)).toEqual([
      "https://pve.test:8006/api2/json/nodes/pve/lxc/9001/rrddata?timeframe=day&cf=MAX",
      "https://pve.test:8006/api2/json/nodes/pve/rrddata?timeframe=week&cf=AVERAGE",
    ]);
  });

  it("turns API errors into ProxmoxError with the field details", async () => {
    const { transport } = recorder([{ status: 400, body: { errors: { vmid: "VM 9001 already exists" } } }]);
    const err = await client(transport).checkVmidFree(9001).catch((e) => e);
    expect(err).toBeInstanceOf(ProxmoxError);
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/vmid: VM 9001 already exists/);
  });

  it("waits for tasks, accepts warnings and throws on failure", async () => {
    const sleep = async () => undefined;
    const ok = recorder([{ status: 200, body: { data: { status: "running" } } }, { status: 200, body: { data: { status: "stopped", exitstatus: "WARNINGS: 1" } } }]);
    await expect(client(ok.transport).waitTask("pve", "UPID:1", { sleep })).resolves.toBeUndefined();
    const bad = recorder([{ status: 200, body: { data: { status: "stopped", exitstatus: "unable to create CT 9001" } } }]);
    await expect(client(bad.transport).waitTask("pve", "UPID:1", { sleep })).rejects.toThrow(/unable to create CT/);
  });
});
