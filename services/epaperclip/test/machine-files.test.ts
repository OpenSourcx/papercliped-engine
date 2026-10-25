import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HttpError } from "../src/http.ts";
import { cleanPath, handleMachineFiles, parseListing, MAX_EDIT } from "../src/features/machine-files.ts";
import type { FeatureCtx } from "../src/features/index.ts";

/** A container terminal that runs each typed line in a real local shell (as the guest-exec tests do), recording the lines. */
function terminal(typed: string[]) {
  const ws = Object.assign(new EventEmitter(), {
    send(data: string) {
      if (data.startsWith("0:")) {
        const line = data.slice(data.indexOf(":", 2) + 1);
        typed.push(line);
        if (line.includes("__EPC_")) {
          const r = spawnSync("sh", ["-c", line], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
          setTimeout(() => ws.emit("message", Buffer.from(r.stdout.replace(/\n/g, "\r\n"))), 2);
        }
        return;
      }
      setTimeout(() => ws.emit("message", Buffer.from("OK")), 1);
    },
    terminate() {},
  });
  setTimeout(() => ws.emit("open"), 0);
  return ws;
}

function call(method: string, path: string, query: Record<string, string>, body?: Record<string, unknown>, status = "running") {
  const typed: string[] = [];
  let out: { status: number; body: any } | null = null;
  const url = new URL(`http://h${path}?${new URLSearchParams(query)}`);
  const pve = {
    clusterResources: async () => [{ vmid: 103, type: "lxc", node: "pve", name: "paperclip", status }],
    terminalTarget: async () => ({ url: "wss://x/ws", headers: {}, handshake: "root@pam:t\n" }),
  };
  const ctx = {
    path, url, method, node: "pve", HttpError,
    session: () => ({ username: "sam@pam" }),
    asUser: (fn: (p: unknown, s: unknown) => Promise<unknown>) => fn(pve, {}),
    connect: () => terminal(typed),
    sameSite: () => undefined,
    readJson: async () => body ?? {},
    json: (s: number, b: unknown) => { out = { status: s, body: b }; },
  } as unknown as FeatureCtx;
  return { run: async () => { await handleMachineFiles(ctx); return out!; }, typed };
}

describe("paths and listings", () => {
  it("keeps only absolute paths, resolves . and .., refuses line breaks and NUL", () => {
    expect(cleanPath("/srv/./app/../data/")).toBe("/srv/data");
    expect(cleanPath("/../../etc")).toBe("/etc");
    expect(cleanPath("relative")).toBeNull();
    expect(cleanPath("/a\nb")).toBeNull();
    expect(cleanPath("/a\0b")).toBeNull();
  });

  it("puts folders first, then files, by name", () => {
    expect(parseListing("f\t10 1700000000\tb.txt\nd\t0 1\tzeta\nL\t4 1\tlinked\nl\t4 1\tlink\njunk line").map((e) => [e.kind, e.name])).toEqual([["linkdir", "linked"], ["dir", "zeta"], ["file", "b.txt"], ["link", "link"]]);
  });
});

describe("files inside a container", () => {
  const dir = () => {
    const d = mkdtempSync(join(tmpdir(), "epc-mf-"));
    mkdirSync(join(d, "sub"));
    writeFileSync(join(d, "hello.txt"), "line one\n\tline two with 'quotes' and $dollar\n");
    writeFileSync(join(d, ".hidden"), "x");
    writeFileSync(join(d, "blob.bin"), Buffer.from([1, 0, 2]));
    return d;
  };

  it("lists a folder with hidden files, folders first", async () => {
    const d = dir();
    const r = await call("GET", "/api/guests/103/files", { path: d }).run();
    expect(r.status).toBe(200);
    expect(r.body.entries.map((e: any) => [e.kind, e.name])).toEqual([["dir", "sub"], ["file", ".hidden"], ["file", "blob.bin"], ["file", "hello.txt"]]);
    expect(r.body.entries.find((e: any) => e.name === "hello.txt").size).toBeGreaterThan(10);
  });

  it("reads text exactly (tabs, quotes, dollars), refuses to show binary, and says when a folder doesn't exist", async () => {
    const d = dir();
    const r = await call("GET", "/api/guests/103/file", { path: join(d, "hello.txt") }).run();
    expect(r.body.content).toBe("line one\n\tline two with 'quotes' and $dollar\n");
    expect(r.body.etag).toMatch(/^[0-9a-f]{32}$/);
    const b = await call("GET", "/api/guests/103/file", { path: join(d, "blob.bin") }).run();
    expect(b.body).toMatchObject({ binary: true, content: null });
    await expect(call("GET", "/api/guests/103/files", { path: join(d, "nope") }).run()).rejects.toThrow(/isn't a folder/);
  });

  it("writes in chunks short enough for any terminal, keeps the file's permissions, and refuses when it changed meanwhile", async () => {
    const d = dir();
    const file = join(d, "hello.txt");
    chmodSync(file, 0o640);
    const first = await call("GET", "/api/guests/103/file", { path: file }).run();
    const big = "x".repeat(20_000) + "\nend 'q' $HOME\n";
    const w = call("PUT", "/api/guests/103/file", {}, { path: file, content: big, etag: first.body.etag });
    const res = await w.run();
    expect(res.status).toBe(200);
    expect(readFileSync(file, "utf8")).toBe(big);
    expect(statSync(file).mode & 0o777).toBe(0o640);
    expect(Math.max(...w.typed.map((l) => l.length))).toBeLessThan(4000);
    // Someone else changes it; the old etag no longer matches.
    writeFileSync(file, "changed elsewhere");
    await expect(call("PUT", "/api/guests/103/file", {}, { path: file, content: "mine", etag: first.body.etag }).run()).rejects.toThrow(/changed in the machine/);
    expect(readFileSync(file, "utf8")).toBe("changed elsewhere");
  }, 60_000);

  it("creates a new file, refuses content that is too big or binary, and a machine that is off", async () => {
    const d = dir();
    await call("PUT", "/api/guests/103/file", {}, { path: join(d, "new.conf"), content: "a=1\n" }).run();
    expect(readFileSync(join(d, "new.conf"), "utf8")).toBe("a=1\n");
    await expect(call("PUT", "/api/guests/103/file", {}, { path: join(d, "x"), content: "y".repeat(MAX_EDIT + 1) }).run()).rejects.toThrow(/KiB/);
    await expect(call("PUT", "/api/guests/103/file", {}, { path: join(d, "x"), content: "a\0b" }).run()).rejects.toThrow(/text/);
    await expect(call("GET", "/api/guests/103/files", { path: d }, undefined, "stopped").run()).rejects.toThrow(/isn't running/);
  });
});

describe("Pin's machine_write_file", () => {
  it("writes content longer than a terminal line in pieces, exactly", async () => {
    const { ACTS } = await import("../src/features/pin-act.ts");
    const d = mkdtempSync(join(tmpdir(), "epc-pw-"));
    const typed: string[] = [];
    const pve = {
      clusterResources: async () => [{ vmid: 103, type: "lxc", node: "pve", name: "paperclip", status: "running" }],
      terminalTarget: async () => ({ url: "wss://x/ws", headers: {}, handshake: "root@pam:t\n" }),
    };
    const content = "y".repeat(9000) + "\n'quotes' $HOME `tick`\n";
    const r = await ACTS.machine_write_file.run({ node: "pve", username: "sam@pam", pve: async () => pve as never, connect: () => terminal(typed) as never }, { vmid: 103, path: join(d, "big.txt"), content, append: false });
    expect(r.result).toMatch(/^Exit 0\./);
    expect(readFileSync(join(d, "big.txt"), "utf8")).toBe(content);
    expect(Math.max(...typed.map((l) => l.length))).toBeLessThan(4000);
  }, 60_000);
});
