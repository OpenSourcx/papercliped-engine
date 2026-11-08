#!/usr/bin/env node
// Customer journey on BOTH targets with the same API calls: native = the pinned engine direct; epc = the ePaperclip host's
// /engine proxy (real host service, real engine, FAKE Proxmox) as the signed-in person sam. No paid model calls: the
// `process` adapter runs a local command, the `http` adapter calls a local STUB server started here (labelled "stub").
// Usage: node scripts/parity/journey.mjs [native|epc|both] [--out docs/evidence/parity/journey.json]
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { driver, recorder, sleep } from "./lib.mjs";

const which = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "both";
const outIdx = process.argv.indexOf("--out");
const rec = recorder();

// STUB http-adapter endpoint: records what the engine posts and answers 200. Not a model, not a provider.
const stubHits = [];
const stub = createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { stubHits.push({ url: req.url, body: b.slice(0, 400) }); res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, stub: true })); }); });
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const STUB = `http://127.0.0.1:${stub.address().port}/wake`;

const ok2xx = (r) => r.status >= 200 && r.status < 300;
async function waitRun(d, cid, agentId, ms = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await d.req("GET", `/api/companies/${cid}/heartbeat-runs?agentId=${agentId}`);
    const runs = Array.isArray(r.body) ? r.body : r.body?.runs ?? [];
    const done = runs.find((x) => ["succeeded", "failed", "cancelled", "timed_out"].includes(x.status) && x.invocationSource !== "automation");
    if (done) return { run: done, runs };
    await sleep(1000);
  }
  return { run: null, runs: [] };
}

async function ready(d, id, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const r = await d.req("GET", `/api/agents/${id}`); if (r.body?.lifecycleState === "ready") return r.body; await sleep(500); }
  return null;
}

async function run(kind) {
  const d = await driver(kind);
  const c = (id, ok, detail, level) => rec.check(id, kind, ok, detail, level);
  const tag = `${kind}-${Date.now().toString(36)}`;
  let r;

  // 1. org
  r = await d.req("POST", "/api/companies", { name: `Parity ${tag}`, description: "parity journey", budgetMonthlyCents: 50000 });
  c("J01 create organization", ok2xx(r), `${r.status} ${r.body?.id ?? JSON.stringify(r.body).slice(0, 100)}`);
  const cid = r.body.id;
  r = await d.req("PATCH", `/api/companies/${cid}`, { description: "renamed by parity" });
  c("J02 edit organization", ok2xx(r) && r.body?.description === "renamed by parity", String(r.status));
  r = await d.req("PATCH", `/api/companies/${cid}/budgets`, { budgetMonthlyCents: 70000 });
  c("J03 set company monthly budget", ok2xx(r) && (r.body?.budgetMonthlyCents === 70000), `${r.status} ${JSON.stringify(r.body).slice(0, 80)}`);

  // 2. goal, CEO, hire
  r = await d.req("POST", `/api/companies/${cid}/goals`, { title: "Ship the parity gate", level: "company", status: "active" });
  c("J04 create goal", ok2xx(r), String(r.status));
  const goalId = r.body?.id;
  r = await d.req("POST", `/api/companies/${cid}/agents`, { name: "CEO", role: "ceo", adapterType: "process", adapterConfig: { command: "sh", args: ["-c", "echo ceo-ran; sleep 1; echo done"] }, runtimeConfig: { heartbeat: { enabled: false } }, budgetMonthlyCents: 10000 });
  c("J05 create CEO agent (process adapter)", ok2xx(r), `${r.status} ${r.body?.status} ${r.body?.lifecycleState}`);
  const ceo = r.body?.id;
  r = await d.req("POST", `/api/companies/${cid}/agent-hires`, { name: "Engineer", role: "engineer", reportsTo: ceo, adapterType: "process", adapterConfig: { command: "sh", args: ["-c", "echo engineer-ran; sleep 1"] }, runtimeConfig: { heartbeat: { enabled: false } } });
  c("J06 hire agent reporting to CEO (process adapter)", ok2xx(r), `${r.status} ${JSON.stringify(r.body).slice(0, 60)}`);
  const eng = r.body?.agent?.id ?? r.body?.id;
  c("J06b agents leave `preparing` and become ready", !!(await ready(d, ceo)) && !!(await ready(d, eng)), "lifecycleState ready");
  r = await d.req("GET", `/api/companies/${cid}/agents`);
  c("J07 org chart data: reportsTo preserved", ok2xx(r) && r.body.find((a) => a.id === eng)?.reportsTo === ceo, `${r.body?.length} agents`);
  r = await d.req("GET", `/api/companies/${cid}/org`);
  c("J08 org chart route (GET /org)", ok2xx(r), String(r.status));
  r = await d.req("PATCH", `/api/agents/${ceo}/permissions`, { canCreateAgents: true, canAssignTasks: true });
  c("J09 agent permissions edit", ok2xx(r), String(r.status));
  r = await d.req("GET", `/api/agents/${ceo}/configuration`);
  c("J10 agent configuration read", ok2xx(r), String(r.status));
  r = await d.req("GET", `/api/agents/${ceo}/instructions-bundle`);
  c("J11 agent instructions bundle", ok2xx(r), String(r.status));
  r = await d.req("POST", `/api/companies/${cid}/secrets`, { name: "demo", key: "DEMO_KEY", managedMode: "paperclip_managed", value: "not-a-real-secret" });
  c("J12 secret reference create", ok2xx(r), `${r.status}`);
  const sec = r.body?.id;
  r = await d.req("GET", `/api/companies/${cid}/secrets`);
  c("J12b secret value never returned", ok2xx(r) && !JSON.stringify(r.body).includes("not-a-real-secret"), String(r.status));

  // 3. project, issues, checkout lock
  r = await d.req("POST", `/api/companies/${cid}/projects`, { name: "Launch", goalIds: goalId ? [goalId] : [], status: "in_progress" });
  c("J13 create project", ok2xx(r), String(r.status));
  const pid = r.body?.id;
  r = await d.req("PATCH", `/api/projects/${pid}`, { description: "edited", status: "planned" });
  c("J14 edit project", ok2xx(r), String(r.status));
  r = await d.req("POST", `/api/companies/${cid}/projects`, { name: "Secret", visibility: "private" });
  c("J15 create private project", ok2xx(r) && r.body?.visibility === "private", `${r.status} ${r.body?.visibility}`);
  const priv = r.body?.id;
  r = await d.req("GET", `/api/projects/${priv}/access-members`);
  c("J15b private project access members route", ok2xx(r), String(r.status));
  r = await d.req("POST", `/api/companies/${cid}/issues`, { title: "First task", projectId: pid, assigneeAgentId: ceo, status: "todo", goalId });
  c("J16 create issue assigned to CEO", ok2xx(r), `${r.status}`);
  const iss = r.body?.id;
  r = await d.req("POST", `/api/issues/${iss}/checkout`, { agentId: ceo, expectedStatuses: ["todo", "backlog"] });
  const co1 = r.status;
  r = await d.req("POST", `/api/issues/${iss}/checkout`, { agentId: eng, expectedStatuses: ["todo", "backlog", "in_progress"] });
  c("J17 checkout: second agent refused (execution lock)", co1 >= 200 && co1 < 300 && r.status === 409, `first ${co1}, second ${r.status}`);
  r = await d.req("POST", `/api/issues/${iss}/comments`, { body: "progress note" });
  c("J18 issue comment", ok2xx(r), String(r.status));
  r = await d.req("POST", `/api/issues/${iss}/release`, {});
  c("J19 release checkout", ok2xx(r), String(r.status));
  r = await d.req("GET", `/api/companies/${cid}/search?q=First`);
  c("J20 search finds the issue", ok2xx(r) && JSON.stringify(r.body).includes("First task"), String(r.status));

  // 4. approvals
  r = await d.req("POST", `/api/companies/${cid}/approvals`, { type: "request_board_approval", payload: { title: "Approve launch", summary: "parity" }, requestedByAgentId: ceo });
  c("J21 create approval request", ok2xx(r), String(r.status));
  const ap = r.body?.id;
  r = await d.req("POST", `/api/approvals/${ap}/approve`, { decisionNote: "ok" });
  c("J22 approve", ok2xx(r) && r.body?.status === "approved", `${r.status} ${r.body?.status}`);
  r = await d.req("POST", `/api/companies/${cid}/approvals`, { type: "request_board_approval", payload: { title: "Reject me" } });
  r = await d.req("POST", `/api/approvals/${r.body?.id}/reject`, { decisionNote: "no" });
  c("J23 reject", ok2xx(r) && r.body?.status === "rejected", `${r.status} ${r.body?.status}`);

  // 5. runtime, in a fresh organization so earlier edits cannot cancel the runs under test.
  r = await d.req("POST", "/api/companies", { name: `Runtime ${tag}` });
  const rcid = r.body.id;
  const mk = async (name, role, extra = {}) => (await d.req("POST", `/api/companies/${rcid}/agents`, { name, role, adapterType: "process", adapterConfig: { command: "sh", args: ["-c", `echo ${name}-ran; sleep 1`] }, runtimeConfig: { heartbeat: { enabled: false } }, ...extra })).body.id;
  const rceo = await mk("CEO", "ceo"), reng = await mk("Engineer", "engineer");
  await ready(d, rceo); await ready(d, reng);
  r = await d.req("POST", `/api/agents/${rceo}/wakeup`, { source: "on_demand", triggerDetail: "manual", reason: "parity run", forceFreshSession: false });
  c("J24 wake CEO (process adapter)", ok2xx(r), `${r.status} ${JSON.stringify(r.body).slice(0, 80)}`);
  let { run: pr } = await waitRun(d, rcid, rceo);
  c("J25 process run succeeds (local command)", pr?.status === "succeeded", pr ? `${pr.status}${pr.error ? " " + String(pr.error).slice(0, 120) : ""}` : "none in 40s");
  if (pr) {
    await sleep(1500);
    r = await d.req("GET", `/api/heartbeat-runs/${pr.id}/log`);
    c("J26 run log readable", ok2xx(r), `${r.status} ${typeof r.body === "string" ? r.body.slice(0, 60) : JSON.stringify(r.body).slice(0, 100)}`);
    r = await d.req("GET", `/api/heartbeat-runs/${pr.id}/events`);
    c("J27 run events readable", ok2xx(r), `${r.status}`);
  }
  // Assignment wakes the assignee on its own (no manual wakeup): the scheduler/assignment path.
  r = await d.req("POST", `/api/companies/${rcid}/issues`, { title: "Engineer task", assigneeAgentId: reng, status: "todo" });
  const hr = await waitRun(d, rcid, reng);
  c("J28 assignment wakes the assignee; run succeeds", hr.run?.status === "succeeded", hr.run ? `${hr.run.status} source=${hr.run.invocationSource}` : "no run in 40s");
  // http adapter: the pin refuses private/loopback endpoints (SSRF guard), so a local stub cannot be called on either target.
  r = await d.req("POST", `/api/companies/${rcid}/adapters/http/test-environment`, { adapterConfig: { url: STUB } });
  c("J28b http adapter refuses loopback/private endpoint (same guard both targets)", ok2xx(r) && JSON.stringify(r.body).includes("cannot target private"), `${r.status} stubHits=${stubHits.length}`, "real Paperclip runtime");
  r = await d.req("POST", `/api/agents/${rceo}/wakeup`, { source: "on_demand", triggerDetail: "manual", reason: "cancel me", forceFreshSession: false });
  r = await d.req("PATCH", `/api/agents/${rceo}`, { adapterConfig: { command: "sh", args: ["-c", "sleep 30"] } });
  r = await d.req("POST", `/api/agents/${rceo}/wakeup`, { source: "on_demand", triggerDetail: "manual", reason: "long run", forceFreshSession: false });
  await sleep(3000);
  const live = await d.req("GET", `/api/companies/${rcid}/live-runs`);
  const lr = (Array.isArray(live.body) ? live.body : live.body?.runs ?? []).find((x) => x.agentId === rceo);
  c("J32 live-runs shows the running run", ok2xx(live) && !!lr, `${live.status} ${lr?.status ?? "none"}`);
  if (lr) { r = await d.req("POST", `/api/heartbeat-runs/${lr.id}/cancel`, {}); await sleep(2000); r = await d.req("GET", `/api/heartbeat-runs/${lr.id}`); c("J33 cancel a running run", r.body?.status === "cancelled", r.body?.status); }
  r = await d.req("GET", `/api/companies/${cid}/activity`);
  c("J29 activity log records the journey", ok2xx(r) && (r.body?.length ?? r.body?.items?.length ?? 0) > 5, `${r.status} n=${r.body?.length ?? r.body?.items?.length}`);
  r = await d.req("GET", `/api/companies/${cid}/costs/summary`);
  c("J30 cost summary", ok2xx(r), String(r.status));
  r = await d.req("GET", `/api/companies/${cid}/dashboard`);
  c("J31 dashboard", ok2xx(r), String(r.status));
  return { cid, kind, ids: { ceo, eng, iss, pid, priv } };
}

const targets = which === "both" ? ["native", "epc"] : [which];
const ctx = [];
for (const k of targets) ctx.push(await run(k));
stub.close();
console.log(JSON.stringify({ pass: rec.rows.filter((x) => x.ok).length, fail: rec.rows.filter((x) => !x.ok).length }));
if (outIdx > 0) writeFileSync(process.argv[outIdx + 1], JSON.stringify({ at: new Date().toISOString(), pin: "paperclipai 2026.1023.0", rows: rec.rows, ctx }, null, 1));
process.exit(0);
