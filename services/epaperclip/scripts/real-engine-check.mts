// Runs the agent containers setup against a REAL engine (started separately) with a fake Proxmox and a fake ssh.
//   EPC_REAL_ENGINE=http://127.0.0.1:3411 EPC_REAL_PLUGIN=/path/to/built/plugin node --experimental-strip-types scripts/real-engine-check.mts
// It proves the plugin install and environment requests are accepted by the engine's own validation, and that with the
// managed-sandbox-only policy on, a run that would land on the host fails closed. Not part of the test suite.
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { SessionStore } from "../src/sessions.ts";
import { StateStore } from "../src/state.ts";
import { fakePve, fakeSsh } from "../test/fakes.ts";

const engineUrl = process.env.EPC_REAL_ENGINE!;
const pluginDir = process.env.EPC_REAL_PLUGIN!;
const pve = fakePve();
const ssh = fakeSsh();
const state = new StateStore(mkdtempSync(join(tmpdir(), "epc-real-state-")));
const app = createApp({
  pve: { baseUrl: "https://127.0.0.1:8006", node: "pve", transport: pve.transport, caPem: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----" },
  sessions: new SessionStore(),
  staticDir: null,
  secureCookies: false,
  state,
  engine: { url: engineUrl, installDir: tmpdir() },
  containers: { pluginDir, ssh: ssh.runner, paceMs: 0 },
});
const server = createServer(app);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

await app.engine!.start();
const login = await fetch(base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json", "X-EPC-Request": "1" }, body: JSON.stringify({ username: "sam", password: "right", realm: "pve" }) });
const cookie = login.headers.get("set-cookie")!.split(";")[0];
await sleep(1500);
const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json", "X-EPC-Request": "1", Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  return { status: r.status, json: t ? JSON.parse(t) : null };
};
const show = (label: string, v: unknown) => console.log(`\n== ${label}\n${typeof v === "string" ? v : JSON.stringify(v, null, 1)}`);

console.log("enforce:", await app.containers.enforce());
const co = (await call("POST", "/engine/api/companies", { name: "Northwind" })).json;
show("company", { id: co.id, name: co.name });
const rg = await call("PUT", `/api/resource-groups/${co.id}`, { name: "Northwind", cores: 4, memoryMb: 8192, diskGb: 64, maxGuests: 4 });
show("resource group", rg.status);
const agent = await call("POST", `/engine/api/companies/${co.id}/agents`, { name: "Runner", role: "engineer", adapterType: "claude_local", adapterConfig: {} });
show("agent created", { status: agent.status, id: agent.json?.id, defaultEnvironmentId: agent.json?.defaultEnvironmentId, error: agent.json?.error });

// 1. Containers not set up, but the policy is on: a run must fail closed, not run on the host.
const wake1 = await call("POST", `/engine/api/agents/${agent.json.id}/wakeup`, { source: "on_demand", triggerDetail: "manual" });
show("wakeup before setup", { status: wake1.status, body: JSON.stringify(wake1.json).slice(0, 200) });
await sleep(6000);
const runs1 = await call("GET", `/engine/api/companies/${co.id}/heartbeat-runs?agentId=${agent.json.id}`);
show("runs before setup", (Array.isArray(runs1.json) ? runs1.json : runs1.json?.runs ?? []).map((r: any) => ({ status: r.status, error: String(r.error ?? r.errorCode ?? "").slice(0, 200) })));

// 2. The setup.
const start = await call("POST", "/api/agent-containers/setup", {});
let job: any;
for (let i = 0; i < 300; i++) {
  job = (await call("GET", `/api/agent-containers/jobs/${start.json.jobId}`)).json;
  if (job.status !== "running") break;
  await sleep(200);
}
show("job", { status: job.status, error: job.error, steps: job.steps.map((s: any) => `${s.id}:${s.state}${s.detail ? ` (${s.detail})` : ""}`) });
show("log", job.log.filter((l: any) => l.level !== "info" || job.status !== "done").slice(-12).map((l: any) => `${l.level}: ${l.text}`));
show("status", (await call("GET", "/api/agent-containers")).json);

const svc = async (path: string) => (await fetch(engineUrl + path)).status; // unauthenticated, only to prove it needs auth
show("unauthenticated engine call", await svc("/api/plugins"));
const engineRead = async (path: string) => (await call("GET", "/engine/api" + path.replace(/^\/api/, ""))).json;
show("plugins", await engineRead("/api/plugins"));
const envs = await engineRead(`/api/companies/${co.id}/environments`);
show("environments", envs.map((e: any) => ({ name: e.name, driver: e.driver, config: e.config })));
const ag = await engineRead(`/api/companies/${co.id}/agents`);
show("agent default environment", ag.map((a: any) => ({ name: a.name, defaultEnvironmentId: a.defaultEnvironmentId })));
show("experimental", await engineRead("/api/instance/settings/experimental").then((x: any) => ({ enableManagedSandboxOnly: x.enableManagedSandboxOnly })));

// 3. The proxy refuses to turn the policy off.
show("turn policy off via proxy", (await call("PATCH", "/engine/api/instance/settings/experimental", { enableManagedSandboxOnly: false })).status);

// 4. Re-run: idempotent against the real engine.
const again = await call("POST", "/api/agent-containers/setup", {});
let job2: any;
for (let i = 0; i < 300; i++) {
  job2 = (await call("GET", `/api/agent-containers/jobs/${again.json.jobId}`)).json;
  if (job2.status !== "running") break;
  await sleep(200);
}
show("second run", { status: job2.status, error: job2.error });
show("environments after second run", (await engineRead(`/api/companies/${co.id}/environments`)).length);

// 5. Run after setup: it resolves to the container environment (the provider then talks to the fake Proxmox on 8006, which isn't there).
const wake2 = await call("POST", `/engine/api/agents/${agent.json.id}/wakeup`, { source: "on_demand", triggerDetail: "manual" });
show("wakeup after setup", wake2.status);
await sleep(8000);
const runs2 = await call("GET", `/engine/api/companies/${co.id}/heartbeat-runs?agentId=${agent.json.id}`);
show("runs after setup", (Array.isArray(runs2.json) ? runs2.json : runs2.json?.runs ?? []).map((r: any) => ({ status: r.status, error: String(r.error ?? r.errorCode ?? "").slice(0, 300) })));

// 6. Teardown.
const td = await call("DELETE", "/api/agent-containers", { confirm: "remove agent containers" });
let job3: any;
for (let i = 0; i < 300; i++) {
  job3 = (await call("GET", `/api/agent-containers/jobs/${td.json.jobId}`)).json;
  if (job3.status !== "running") break;
  await sleep(200);
}
show("teardown", { status: job3.status, error: job3.error, log: job3.log.map((l: any) => l.text) });
show("plugins after teardown", await engineRead("/api/plugins"));

server.close();
process.exit(0);
