import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { Capabilities } from "@papercliped-engine/worker-fabric";
import { FabricHub } from "../src/fabric/hub.ts";
import { controlListener, workerListener } from "../src/fabric/listener.ts";
import { StateStore } from "../src/state.ts";
import { WorkerClient } from "../../../packages/worker-daemon/src/client.ts";
import { WorkerFiles } from "../../../packages/worker-daemon/src/config.ts";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until<T>(fn: () => T | Promise<T>, ms = 8000, what = "condition"): Promise<NonNullable<T>> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

export const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), `epw-${p}-`)));

export const fakeCaps = (root: string, over: Partial<Capabilities> = {}): Capabilities => ({
  os: { name: "Ubuntu", version: "24.04" }, arch: "arm64", hostname: "node-a", cpu: { model: "test", cores: 8 }, memMb: 8000, gpu: { present: true, kind: "jetson", name: "Orin" },
  storage: [], tools: { git: "2.43", node: "22" }, inference: null, networks: [], workspaceRoot: root, ...over,
});

export interface Host { hub: FabricHub; state: StateStore; stateDir: string; wl: Server; cl: Server; url: string; control: string; close(): Promise<void> }

const listen = (s: Server, port = 0) => new Promise<number>((res) => s.listen(port, "127.0.0.1", () => res((s.address() as AddressInfo).port)));

export async function startHost(o: { stateDir?: string; port?: number; controlPort?: number; hbMs?: number; now?: () => number } = {}): Promise<Host> {
  const stateDir = o.stateDir ?? tmp("state");
  const state = new StateStore(stateDir);
  let port = o.port ?? 0;
  const hub = new FabricHub({ state, heartbeatMs: o.hbMs ?? 300, now: o.now, transports: () => [{ provider: "custom", label: "t", available: true, address: `ws://127.0.0.1:${port}`, detail: "" }] });
  hub.start();
  const wl = workerListener(hub);
  port = await listen(wl, o.port ?? 0);
  const cl = controlListener(hub);
  const cport = await listen(cl, o.controlPort ?? 0);
  return {
    hub, state, stateDir, wl, cl, url: `ws://127.0.0.1:${port}/fabric/v1/connect`, control: `http://127.0.0.1:${cport}`,
    close: async () => { hub.close(); wl.closeAllConnections(); cl.closeAllConnections(); await Promise.all([new Promise((r) => wl.close(r)), new Promise((r) => cl.close(r))]); },
  };
}

export interface Worker { client: WorkerClient; files: WorkerFiles; dir: string; root: string }
export function newWorker(o: { dir?: string; caps?: Partial<Capabilities>; name?: string } = {}): Worker {
  const dir = o.dir ?? tmp("worker");
  const root = join(dir, "ws");
  mkdirSync(root, { recursive: true });
  const files = new WorkerFiles(dir);
  const c = files.config();
  c.workspaceRoot = root;
  if (o.name) c.name = o.name;
  files.saveConfig(c);
  const client = new WorkerClient({ files, backoff: { minMs: 50, maxMs: 300 }, detect: async (cc) => fakeCaps(cc.workspaceRoot, o.caps), version: "test" });
  return { client, files, dir, root };
}

export async function control(h: Host, token: string, path: string, body: unknown, stream = false): Promise<{ status: number; json: any; lines: any[] }> {
  const r = await fetch(`${h.control}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await r.text();
  if (stream) return { status: r.status, json: null, lines: text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) };
  return { status: r.status, json: text ? JSON.parse(text) : null, lines: [] };
}

/** Adopts a worker through a pairing code and waits until it is online. */
export async function adoptOnline(h: Host, w: Worker, name = "w", companies: string[] | null = null) {
  const { code } = h.hub.createPairing("tester", { name, companies });
  w.client.adopt(code);
  await w.client.start();
  const id = await until(() => h.hub.workers().find((x) => x.online && x.name === name)?.id, 8000, "worker online");
  return id;
}
