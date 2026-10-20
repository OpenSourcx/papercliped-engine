import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  it("doesn't show Proxmox's empty-log placeholder as output", async () => {
    const empty = recorder([{ status: 200, body: { data: [{ n: 0, t: "no content" }, { n: 1, t: "no content" }, { n: 2, t: "no content" }] } }]);
    expect(await client(empty.transport).taskLog("pve", "UPID:x")).toEqual([]);
    const real = recorder([{ status: 200, body: { data: [{ n: 1, t: "starting" }, { n: 2, t: "no content" }, { n: 3, t: "Get:1 http://deb.debian.org" }] } }]);
    expect((await client(real.transport).taskLog("pve", "UPID:x")).map((l) => l.t)).toEqual(["starting", "Get:1 http://deb.debian.org"]);
  });

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

describe("user sessions (Integrated Access Control)", () => {
  it("signs in with Proxmox's own login and acts as that user", async () => {
    const { seen, transport } = recorder([
      { status: 200, body: { data: { username: "sam@pve", ticket: "PVE:sam@pve:ABC", CSRFPreventionToken: "csrf123" } } },
      { status: 200, body: { data: [] } },
      { status: 200, body: { data: "UPID:3" } },
    ]);
    const r = await ProxmoxClient.login({ baseUrl: "https://pve.test:8006", transport }, { username: "sam", realm: "pve", password: "pw" });
    expect(r).toEqual({ username: "sam@pve", ticket: "PVE:sam@pve:ABC", csrf: "csrf123", needTfa: false });
    expect(new URLSearchParams(seen[0].body)).toEqual(new URLSearchParams({ username: "sam", password: "pw", realm: "pve" }));
    expect(seen[0].headers.Authorization).toBeUndefined();

    const c = new ProxmoxClient({ baseUrl: "https://pve.test:8006", ticket: r.ticket, csrf: r.csrf!, transport });
    await c.clusterResources();
    await c.guestPower("pve", "lxc", 9001, "start");
    expect(seen[1].headers.Cookie).toBe("PVEAuthCookie=PVE%3Asam%40pve%3AABC");
    expect(seen[1].headers.CSRFPreventionToken).toBeUndefined(); // reads need no CSRF token
    expect(seen[2].headers.CSRFPreventionToken).toBe("csrf123"); // writes do
  });

  it("reports a two-factor step and answers it with the challenge", async () => {
    const { seen, transport } = recorder([
      { status: 200, body: { data: { username: "ana@pve", ticket: "PVE:!tfa!xyz", NeedTFA: 1 } } },
      { status: 200, body: { data: { username: "ana@pve", ticket: "PVE:ana@pve:OK", CSRFPreventionToken: "c" } } },
    ]);
    const first = await ProxmoxClient.login({ baseUrl: "https://pve.test:8006", transport }, { username: "ana@pve", password: "pw" });
    expect(first.needTfa).toBe(true);
    expect(first.csrf).toBeNull();
    const second = await ProxmoxClient.login({ baseUrl: "https://pve.test:8006", transport }, { username: "ana@pve", password: "totp:123456", tfaChallenge: first.ticket });
    expect(second.needTfa).toBe(false);
    expect(new URLSearchParams(seen[1].body).get("tfa-challenge")).toBe("PVE:!tfa!xyz");
  });

  it("turns bad credentials into a 401 without detail", async () => {
    const { transport } = recorder([{ status: 401, body: "" }]);
    const err = await ProxmoxClient.login({ baseUrl: "https://pve.test:8006", transport }, { username: "x", password: "y" }).catch((e) => e);
    expect(err).toBeInstanceOf(ProxmoxError);
    expect(err.status).toBe(401);
  });
});

describe("storage content and uploads", () => {
  it("streams an upload as multipart with an exact Content-Length", async () => {
    let seen: { url: string; headers: Record<string, string>; body: Buffer } | null = null;
    const c = new ProxmoxClient({
      baseUrl: "https://pve.test:8006",
      ticket: "PVE:t",
      csrf: "c1",
      streamTransport: async (req) => {
        const parts: Buffer[] = [];
        for await (const ch of req.body) parts.push(Buffer.from(ch));
        seen = { url: req.url, headers: req.headers, body: Buffer.concat(parts) };
        return { status: 200, body: JSON.stringify({ data: "UPID:pve:up" }) };
      },
    });
    async function* file() {
      yield Buffer.from("ISO");
      yield Buffer.from("DATA");
    }
    expect(await c.upload("pve", "local", { content: "iso", filename: 'my"disk.iso', size: 7, file: file() })).toBe("UPID:pve:up");
    const s = seen!;
    expect(s.url).toBe("https://pve.test:8006/api2/json/nodes/pve/storage/local/upload");
    expect(s.headers.CSRFPreventionToken).toBe("c1");
    expect(Number(s.headers["Content-Length"])).toBe(s.body.length);
    const text = s.body.toString();
    expect(text).toContain('name="content"\r\n\r\niso\r\n');
    expect(text).toContain('filename="mydisk.iso"');
    expect(text).toContain("\r\n\r\nISODATA\r\n--");
  });

  it("deletes volumes by encoded volid and asks for the catalog and downloads", async () => {
    const { seen, transport } = recorder([{ status: 200, body: { data: null } }, { status: 200, body: { data: [] } }, { status: 200, body: { data: "UPID:dl" } }]);
    const c = new ProxmoxClient({ baseUrl: "https://pve.test:8006", ticket: "PVE:t", csrf: "c1", transport });
    await c.deleteVolume("pve", "local", "local:iso/a b.iso");
    await c.templateCatalog("pve");
    await c.downloadUrl("pve", "local", { url: "https://x.test/a.iso", content: "iso", filename: "a.iso", checksum: "ab", algorithm: "sha256" });
    expect(seen[0].url).toBe("https://pve.test:8006/api2/json/nodes/pve/storage/local/content/local%3Aiso%2Fa%20b.iso");
    expect(seen[1].url).toBe("https://pve.test:8006/api2/json/nodes/pve/aplinfo");
    expect(Object.fromEntries(new URLSearchParams(seen[2].body))).toEqual({ url: "https://x.test/a.iso", content: "iso", filename: "a.iso", checksum: "ab", "checksum-algorithm": "sha256", "verify-certificates": "1" });
  });

  it("keeps Proxmox's explanation on errors", async () => {
    const { transport } = recorder([{ status: 400, body: { errors: { filename: "already exists" } } }]);
    const err = await new ProxmoxClient({ baseUrl: "https://pve.test:8006", ticket: "t", csrf: "c", transport }).downloadTemplate("pve", "local", "x").catch((e) => e);
    expect(err.detail).toBe("filename: already exists");
  });
});

describe("the real transport against a server as strict as Proxmox's", () => {
  it("sends form bodies with an exact Content-Length, never chunked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pve-tls-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "1", "-subj", "/CN=pve", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
    const cert = readFileSync(join(dir, "c.pem"), "utf8");
    const seen: { length: string | undefined; chunked: boolean; body: string }[] = [];
    const server = createServer({ cert, key: readFileSync(join(dir, "k.pem")) }, (req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ length: req.headers["content-length"], chunked: /chunked/i.test(String(req.headers["transfer-encoding"] ?? "")), body });
        // Proxmox answers 501 to a chunked request body.
        if (/chunked/i.test(String(req.headers["transfer-encoding"] ?? ""))) { res.writeHead(501); return res.end(); }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: { username: "root@pam", ticket: "PVE:root@pam:ABC", CSRFPreventionToken: "tok" } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const baseUrl = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const r = await ProxmoxClient.login({ baseUrl, caPem: cert }, { username: "root", password: "pässword&=1", realm: "pam" });
      expect(r).toMatchObject({ username: "root@pam", needTfa: false });
      expect(seen[0]).toMatchObject({ chunked: false, length: String(Buffer.byteLength(seen[0].body)) });
      expect(new URLSearchParams(seen[0].body).get("password")).toBe("pässword&=1");
    } finally {
      server.close();
      server.closeAllConnections();
    }
  });

  it("keeps Proxmox's reason when a sign-in fails some other way than bad credentials", async () => {
    const { transport } = recorder([{ status: 500, body: JSON.stringify({ message: "pam module failure" }) }]);
    const err = await ProxmoxClient.login({ baseUrl: "https://pve.test:8006", transport }, { username: "x", password: "y" }).catch((e) => e);
    expect(err).toBeInstanceOf(ProxmoxError);
    expect(err.detail).toBe("pam module failure");
  });
});
