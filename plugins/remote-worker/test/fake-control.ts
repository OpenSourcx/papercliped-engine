import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** A stand-in for the Fabric's control API with one worker, leases and scripted command output. */
export class FakeControl {
  server!: Server;
  url = "";
  token = "fct_testtoken";
  paths: string[] = [];
  leases = new Map<string, { workspace: string; state: string; agentId: string }>();
  worker = { id: "wrk_1", name: "orion", online: true };
  seq = 0;
  failProbe = false;
  async start() {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const path = req.url ?? "";
        this.paths.push(path);
        const send = (s: number, b: unknown) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
        if (req.headers.authorization !== `Bearer ${this.token}`) return send(401, { code: "unauthorized", error: "no" });
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        if (path === "/control/v1/probe") return this.failProbe ? send(200, { ok: false, summary: "No worker is ready (no_match).", candidates: [{ workerId: "wrk_1", name: "orion", online: false, reasons: ["offline"] }] }) : send(200, { ok: true, summary: "Ready: orion.", candidates: [{ workerId: "wrk_1", name: "orion", online: true, reasons: [] }] });
        if (path === "/control/v1/leases") {
          const id = `wl_${String(++this.seq).padStart(16, "0")}`;
          const workspace = `/workspaces/${body.companyId}/${body.agentId}/${body.workspaceKey}`;
          this.leases.set(id, { workspace, state: "active", agentId: body.agentId });
          return send(201, { leaseId: id, workerId: "wrk_1", workerName: "orion", workspace });
        }
        const m = /^\/control\/v1\/leases\/([^/]+)\/(\w+)$/.exec(path);
        if (!m) return send(404, { code: "not_found", error: "nf" });
        const l = this.leases.get(m[1]!);
        if (!l || l.state === "destroyed") return m[2] === "destroy" ? send(200, { state: "destroyed" }) : send(410, { code: "expired", error: "gone" });
        switch (m[2]) {
          case "resume": l.state = "active"; return send(200, { leaseId: m[1], workspace: l.workspace, workerId: "wrk_1" });
          case "workspace": return send(200, { cwd: l.workspace });
          case "release": l.state = "released"; return send(200, { state: "released" });
          case "stop": l.state = "stopped"; return send(200, { state: "stopped" });
          case "destroy": l.state = "destroyed"; return send(200, { state: "destroyed" });
          case "exec": {
            res.writeHead(200, { "content-type": "application/x-ndjson" });
            res.write(`${JSON.stringify({ ev: "out", stream: "stdout", data: `ran ${body.command} in ${body.cwd}\n` })}\n`);
            res.write(`${JSON.stringify({ ev: "out", stream: "stderr", data: "warn\n" })}\n`);
            return void res.end(`${JSON.stringify({ ev: "exit", exitCode: body.command === "false" ? 1 : 0, signal: null, timedOut: false })}\n`);
          }
        }
        send(404, { code: "not_found", error: "nf" });
      });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async stop() { this.server.closeAllConnections(); await new Promise((r) => this.server.close(r)); }
}
