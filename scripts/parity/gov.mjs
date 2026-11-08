#!/usr/bin/env node
// Governance and failure handling on both targets: board approval for new hires, and what a failing run does.
import { writeFileSync } from "node:fs";
import { driver, recorder, sleep } from "./lib.mjs";
const rec = recorder(); const oi = process.argv.indexOf("--out"); const ok2 = (r) => r.status >= 200 && r.status < 300;
for (const k of ["native", "epc"]) {
  const d = await driver(k), c = (id, ok, det) => rec.check(id, k, ok, det);
  const co = (await d.req("POST", "/api/companies", { name: `Gov ${k} ${Date.now().toString(36)}` })).body;
  let r = await d.req("PATCH", `/api/companies/${co.id}`, { requireBoardApprovalForNewAgents: true });
  c("G01 turn on board approval for new hires", ok2(r) && r.body.requireBoardApprovalForNewAgents === true, String(r.status));
  r = await d.req("POST", `/api/companies/${co.id}/agent-hires`, { name: "Hire", role: "engineer", adapterType: "process", adapterConfig: { command: "sh", args: ["-c", "exit 3"] }, runtimeConfig: { heartbeat: { enabled: false } } });
  const ap = r.body?.approval; const ag = r.body?.agent?.id;
  c("G02 hire request lands as a pending approval; agent not yet active", ok2(r) && ap?.status === "pending", `${r.status} approval=${ap?.status} agent=${r.body?.agent?.status}`);
  r = await d.req("POST", `/api/approvals/${ap?.id}/approve`, { decisionNote: "ok" });
  c("G03 approving activates the hire", ok2(r) && r.body.status === "approved", `${r.status}`);
  for (let i = 0; i < 40; i++) { if ((await d.req("GET", `/api/agents/${ag}`)).body.lifecycleState === "ready") break; await sleep(500); }
  const st = (await d.req("GET", `/api/agents/${ag}`)).body.status;
  await d.req("POST", `/api/agents/${ag}/wakeup`, { source: "on_demand", triggerDetail: "manual", reason: "fail", forceFreshSession: false });
  let run; for (let i = 0; i < 40 && !run; i++) { run = (await d.req("GET", `/api/companies/${co.id}/heartbeat-runs?agentId=${ag}`)).body.find((x) => x.status === "failed" && x.invocationSource === "on_demand"); await sleep(1000); }
  c("G04 non-zero exit: run is failed with exit code", run?.exitCode === 3, `${run?.status} exit=${run?.exitCode} (agent before ${st})`);
  r = await d.req("GET", `/api/agents/${ag}`);
  c("G05 failing agent is flagged (status error) for the board", r.body.status === "error", r.body.status);
  const a2 = await d.req("GET", `/api/companies/${co.id}/attention`); const inb = await d.req("GET", `/api/companies/${co.id}/sidebar-badges`);
  c("G06 attention/badges endpoints answer", ok2(a2) && ok2(inb), `${a2.status}/${inb.status}`);
  r = await d.req("POST", `/api/agents/${ag}/pause`, {}); const r2 = await d.req("POST", `/api/agents/${ag}/resume`, {});
  c("G07 pause and resume an agent", ok2(r) && ok2(r2), `${r.status}/${r2.status}`);
}
console.log(JSON.stringify({ pass: rec.rows.filter((x) => x.ok).length, fail: rec.rows.filter((x) => !x.ok).length }));
if (oi > 0) writeFileSync(process.argv[oi + 1], JSON.stringify({ at: new Date().toISOString(), rows: rec.rows }, null, 1));
