import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { createApp } from "../src/app.ts";
import { SessionStore } from "../src/sessions.ts";
import { StateStore } from "../src/state.ts";
import { fakeDiskCluster, type W3Options } from "./fakes-diskcluster.ts";

/** Boots the host service on a port against the disk-and-cluster fake. */
export class Harness {
  server: Server | undefined;
  base = "";
  pve!: ReturnType<typeof fakeDiskCluster>;
  seen: string[] = [];
  state!: StateStore;

  async boot(opts: W3Options = {}) {
    this.pve = fakeDiskCluster(opts);
    this.seen = [];
    this.state = new StateStore(mkdtempSync(join(tmpdir(), "epc-w3-")));
    const app = createApp({ pve: { baseUrl: "https://127.0.0.1:8006", node: "pve", transport: this.pve.transport }, sessions: new SessionStore(), staticDir: null, secureCookies: false, state: this.state });
    this.server = createServer(app);
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    this.base = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async close() {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server!.close(() => r()));
    this.server = undefined;
  }

  async signIn(username = "sam") {
    const r = await fetch(this.base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json", "X-EPC-Request": "1" }, body: JSON.stringify({ username, password: "right", realm: "pve" }) });
    expect(r.status).toBe(200);
    return r.headers.get("set-cookie")!.split(";")[0];
  }

  send = async (cookie: string, method: string, path: string, body?: unknown, extra: Record<string, string> = { "X-EPC-Request": "1" }) => {
    const r = await fetch(this.base + path, { method, headers: { "Content-Type": "application/json", Cookie: cookie, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    this.seen.push(text);
    return { status: r.status, json: (text ? JSON.parse(text) : null) as any };
  };

  calls = (method: string, path: string) => this.pve.calls.filter((c) => c.method === method && c.path === path);
}
