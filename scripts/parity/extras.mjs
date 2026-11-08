#!/usr/bin/env node
// Extras on both targets: budget hard stop, managed-sandbox-only enforcement vs the host's guard, persistence across an engine
// restart, and one real local-network path (process adapter -> Ollama on Orion, read-only API, one request at a time).
// Usage: node scripts/parity/extras.mjs [--skip-restart] [--skip-orion] [--out docs/evidence/parity/extras.json]
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { driver, recorder, sleep } from "./lib.mjs";
const rec = recorder(); const ok2 = (r) => r.status >= 200 && r.status < 300;
const has = (f) => process.argv.includes(f); const oi = process.argv.indexOf("--out");
const eng = (cmd, w) => execFileSync(new URL("./engine.sh", import.meta.url).pathname, [cmd, w], { encoding: "utf8" });
const ORION = process.env.ORION_OLLAMA ?? "http://100.93.29.26:11434";
const dr = { native: await driver("native"), epc: await driver("epc") };
const ids = {};
async function mkOrg(k) {
  const d = dr[k]; const co = (await d.req("POST", "/api/companies", { name: `Extras ${k} ${Date.now().toString(36)}` })).body;
  const mk = async (name, role, command) => (await d.req("POST", `/api/companies/${co.id}/agents`, { name, role, adapterType: "process", adapterConfig: { command: "sh", args: ["-c", command] }, runtimeConfig: { heartbeat: { enabled: false } } })).body.id;
  const a = await mk("CEO", "ceo", "echo ok");
  for (let i = 0; i < 40; i++) { if ((await d.req("GET", `/api/agents/${a}`)).body.lifecycleState === "ready") break; await sleep(500); }
  ids[k] = { co: co.id, a }; return { co, a, mk };
}
async function lastRun(d, co, a, ms = 30000) {
  for (let t = 0; t < ms; t += 1000) { const r = (await d.req("GET", `/api/companies/${co}/heartbeat-runs?agentId=${a}`)).body; const x = r.find((x) => ["succeeded", "failed", "cancelled", "timed_out"].includes(x.status) && x.invocationSource === "on_demand"); if (x) return x; await sleep(1000); }
}
const wake = (d, a, reason) => d.req("POST", `/api/agents/${a}/wakeup`, { source: "on_demand", triggerDetail: "manual", reason, forceFreshSession: false });

for (const k of ["native", "epc"]) {
  const d = dr[k], c = (id, ok, detail, level) => rec.check(id, k, ok, detail, level);
  const { co, a } = await mkOrg(k);
  // budget hard stop
  let r = await d.req("PATCH", `/api/agents/${a}/budgets`, { budgetMonthlyCents: 100 });
  c("X01 set agent monthly budget", ok2(r), String(r.status));
  r = await d.req("POST", `/api/companies/${co.id}/cost-events`, { agentId: a, provider: "stub", model: "stub", costCents: 150, occurredAt: new Date().toISOString(), billingType: "metered_api", inputTokens: 1, outputTokens: 1 });
  const posted = ok2(r); c("X02 board posts a cost event (cost ledger write)", posted, String(r.status));
  if (posted) { await sleep(1500); r = await d.req("GET", `/api/agents/${a}`); c("X03 over budget: agent is paused by the engine", r.body.status === "paused", `${r.body.status} ${r.body.pauseReason ?? ""}`); }
  r = await d.req("GET", `/api/companies/${co.id}/budgets/overview`);
  c("X04 budget overview readable", ok2(r), String(r.status));
}
// managed-sandbox-only: engine behaviour (native engine) and the host's guard (epc)
{
  const d = dr.native; const { co, a } = await mkOrg("native");
  let r = await d.req("PATCH", "/api/instance/settings/experimental", { enableManagedSandboxOnly: true });
  rec.check("X05 engine accepts managed-sandbox-only", "native", ok2(r), String(r.status));
  await wake(d, a, "sandbox only"); const run = await lastRun(d, co.id, a);
  rec.check("X06 with managed-sandbox-only a host run fails closed", "native", run?.status === "failed" || run?.status === "cancelled", `${run?.status} ${String(run?.error ?? "").slice(0, 100)}`);
  await d.req("PATCH", "/api/instance/settings/experimental", { enableManagedSandboxOnly: false });
  r = await d.req("PATCH", "/api/instance/settings/experimental", { enableManagedSandboxOnly: false });
  rec.check("X07 native lets an admin turn it off again", "native", ok2(r), String(r.status));
  r = await dr.epc.req("PATCH", "/api/instance/settings/experimental", { enableManagedSandboxOnly: false });
  rec.check("X08 host refuses turning agents-on-host back on (403 agents_on_host_refused)", "epc", r.status === 403, `${r.status} ${r.body?.error?.code ?? r.body?.code ?? ""}`);
}
// restart persistence
if (!has("--skip-restart")) for (const k of ["native", "epc"]) {
  const d = dr[k], { co, a } = ids[k] ? { co: { id: ids[k].co }, a: ids[k].a } : await mkOrg(k);
  await d.req("POST", `/api/companies/${co.id}/goals`, { title: "survives restart" });
  const before = { agents: (await d.req("GET", `/api/companies/${co.id}/agents`)).body.length, goals: (await d.req("GET", `/api/companies/${co.id}/goals`)).body.length, runs: (await d.req("GET", `/api/companies/${co.id}/heartbeat-runs`)).body.length };
  eng("stop", k); await sleep(4000); eng("start", k);
  const d2 = await driver(k);
  const after = { agents: (await d2.req("GET", `/api/companies/${co.id}/agents`)).body.length, goals: (await d2.req("GET", `/api/companies/${co.id}/goals`)).body.length, runs: (await d2.req("GET", `/api/companies/${co.id}/heartbeat-runs`)).body.length };
  rec.check("X09 organization, goals, agents, run history survive an engine restart", k, JSON.stringify(before) === JSON.stringify(after), `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  const ag = (await d2.req("GET", `/api/agents/${a}`)).body;
  rec.check("X10 agent usable after restart (wake -> run)", k, ok2(await wake(d2, a, "after restart")) && !!(await lastRun(d2, co.id, a)), ag.status);
  dr[k] = d2;
}
// Orion Ollama, read-only API, process adapter, one request at a time
if (!has("--skip-orion")) for (const k of ["epc"]) {
  const d = dr[k]; const { co, a, mk } = await mkOrg(k);
  const body = JSON.stringify({ model: "qwen2.5-coder:1.5b", prompt: "Reply with one word: ok", stream: false, options: { num_predict: 6 } });
  const ag = await mk("Orion", "engineer", `curl -sS -m 90 ${ORION}/api/generate -d '${body}' | head -c 400`);
  for (let i = 0; i < 40; i++) { if ((await d.req("GET", `/api/agents/${ag}`)).body.lifecycleState === "ready") break; await sleep(500); }
  await wake(d, ag, "orion ollama"); const run = await lastRun(d, co.id, ag, 100000);
  let log = ""; if (run) log = JSON.stringify((await d.req("GET", `/api/heartbeat-runs/${run.id}/log`)).body).slice(0, 700);
  rec.check("X11 process adapter reaches Ollama on Orion (real network, no paid model)", k, run?.status === "succeeded" && /response/.test(log), `${run?.status} ${/response/.test(log) ? "model replied" : log.slice(0, 120)}`, "physical Proxmox+Orion hardware");
}
console.log(JSON.stringify({ pass: rec.rows.filter((x) => x.ok).length, fail: rec.rows.filter((x) => !x.ok).length }));
if (oi > 0) writeFileSync(process.argv[oi + 1], JSON.stringify({ at: new Date().toISOString(), rows: rec.rows }, null, 1));
