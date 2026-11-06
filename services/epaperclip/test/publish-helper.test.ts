import { mkdtempSync, readFileSync, existsSync, statSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error standalone deployment program has no declaration file
import { handle, serve } from "../../../deploy/epaperclip-publish.mjs";
import { socketTunnelHelper } from "../src/tunnelHelper.ts";

const TOKEN = "eyJhIjoiYWNjdCIsInQiOiJ0dW5uZWwiLCJzIjoic2VjcmV0In0=";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "epc-publish-"));
  dirs.push(dir);
  const calls: string[] = [];
  const deps = {
    etc: join(dir, "etc"), env: join(dir, "etc", "cloudflared.env"), owner: join(dir, "etc", "cloudflared.owner"), unit: join(dir, "cloudflared.service"),
    bins: ["/fake/cloudflared"], exists: () => true,
    spawnSync: (_c: string, args: string[]) => { calls.push(args.join(" ")); return { status: args[0] === "is-active" && !calls.some((c) => c.startsWith("enable")) ? 3 : 0 }; },
  };
  return { dir, deps, calls };
}

describe("publishing helper: one owner of the tunnel", () => {
  it("installs a Connect token root-only (0600), enables the service and reports status without the token", () => {
    const { deps, calls } = fixture();
    expect(handle({ operation: "install", owner: "connect", token: TOKEN }, deps)).toEqual({ ok: true });
    expect(readFileSync(deps.env, "utf8")).toBe(`TUNNEL_TOKEN=${TOKEN}\n`);
    expect(statSync(deps.env).mode & 0o777).toBe(0o600);
    expect(readFileSync(deps.owner, "utf8").trim()).toBe("connect");
    expect(calls).toContain("enable --now epaperclip-cloudflared.service");
    const st = handle({ operation: "status" }, deps);
    expect(st).toEqual({ ok: true, owner: "connect", installed: true, active: true });
    expect(JSON.stringify(st)).not.toContain(TOKEN);
  });

  it("the two owners can never both hold the tunnel", () => {
    const { deps } = fixture();
    handle({ operation: "install", owner: "self", token: TOKEN }, deps);
    expect(() => handle({ operation: "install", owner: "connect", token: TOKEN + "x" }, deps)).toThrow(/Switch to local-only/);
    expect(handle({ operation: "remove", owner: "connect" }, deps)).toEqual({ ok: true, removed: false }); // not theirs to remove
    expect(readFileSync(deps.env, "utf8")).toContain(TOKEN);
    handle({ operation: "remove", owner: "self" }, deps);
    handle({ operation: "install", owner: "connect", token: TOKEN }, deps);
    expect(() => handle({ operation: "install", owner: "self", token: TOKEN }, deps)).toThrow(/Connect is managing/);
    expect(() => handle({ operation: "install", token: TOKEN }, deps)).toThrow(/Connect is managing/); // owner defaults to self
  });

  it("an installation from before owners existed counts as the administrator's own", () => {
    const { deps } = fixture();
    handle({ operation: "install", owner: "self", token: TOKEN }, deps);
    rmSync(deps.owner);
    expect(handle({ operation: "status" }, deps)).toMatchObject({ owner: "self", installed: true });
    expect(() => handle({ operation: "install", owner: "connect", token: TOKEN }, deps)).toThrow();
  });

  it("remove deletes the token file, owner marker and unit, and stops the service", () => {
    const { deps, calls } = fixture();
    handle({ operation: "install", owner: "connect", token: TOKEN }, deps);
    expect(handle({ operation: "remove", owner: "connect" }, deps)).toEqual({ ok: true, removed: true });
    for (const f of [deps.env, deps.owner, deps.unit]) expect(existsSync(f)).toBe(false);
    expect(calls).toContain("disable --now epaperclip-cloudflared.service");
    expect(handle({ operation: "status" }, deps)).toEqual({ ok: true, owner: null, installed: false, active: false });
  });

  it("validates input: base64 tokens pass, anything that could break a line or an operation is refused", () => {
    const { deps } = fixture();
    for (const token of ["short", TOKEN + "\nExecStart=/bin/sh", TOKEN + " x", "a".repeat(5000), 42, undefined])
      expect(() => handle({ operation: "install", owner: "connect", token }, deps), String(token).slice(0, 20)).toThrow(/Invalid publishing request/);
    expect(() => handle({ operation: "install", owner: "root", token: TOKEN }, deps)).toThrow(/Invalid/);
    expect(() => handle({ operation: "rm -rf" }, deps)).toThrow(/Invalid/);
    expect(() => handle(null, deps)).toThrow();
    expect(existsSync(deps.env)).toBe(false);
  });

  it("works end to end over a unix socket with the host-side client, and no error ever echoes the token", async () => {
    const { dir, deps } = fixture();
    const path = join(dir, "publish.sock");
    const server = createServer({ allowHalfOpen: true }, (c) => {
      // systemd gives the helper separate stdin and stdout; reading the socket to its end must not close the reply side.
      const chunks: Buffer[] = [];
      c.on("data", (b) => chunks.push(b)).on("end", () => void serve(Readable.from(chunks), c, deps));
    });
    await new Promise<void>((r) => server.listen(path, r));
    try {
      const helper = socketTunnelHelper(path, 5000);
      await helper.install("connect", TOKEN);
      expect(await helper.status()).toEqual({ owner: "connect", installed: true, active: true });
      await expect(helper.install("self", TOKEN)).rejects.toThrow(/Switch to local-only/);
      await expect(helper.install("connect", "bad token")).rejects.toThrow(/Invalid publishing request/);
      await helper.remove("connect");
      expect(await helper.status()).toMatchObject({ owner: null });
      await helper.remove("connect"); // idempotent
    } finally { await new Promise<void>((r) => server.close(() => r())); }
    await expect(socketTunnelHelper(join(dir, "missing.sock"), 1000).status()).rejects.toThrow(/publishing helper/);
  });
});
