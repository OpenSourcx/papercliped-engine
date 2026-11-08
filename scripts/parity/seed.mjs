#!/usr/bin/env node
// onboarding-seed on both targets: goal, CEO with core skills, Onboarding project, first task; second apply is a no-op.
import { writeFileSync } from "node:fs";
import { driver, recorder, sleep } from "./lib.mjs";
const rec = recorder(); const oi = process.argv.indexOf("--out");
for (const k of ["native", "epc"]) {
  const d = await driver(k), c = (id, ok, det) => rec.check(id, k, ok, det);
  const co = (await d.req("POST", "/api/companies", { name: `Seed ${k} ${Date.now().toString(36)}` })).body;
  const body = { revision: "rev-1", mission: "Parity mission\nDetails", agent: { name: "Chief of staff", role: "ceo" }, firstTask: { title: "First seeded task", details: "x" } };
  let r = await d.req("POST", `/api/companies/${co.id}/onboarding-seed`, body);
  c("S01 onboarding-seed applies", r.status >= 200 && r.status < 300, `${r.status} ${JSON.stringify(r.body).slice(0, 80)}`);
  await sleep(1500);
  const agents = (await d.req("GET", `/api/companies/${co.id}/agents`)).body, goals = (await d.req("GET", `/api/companies/${co.id}/goals`)).body, projects = (await d.req("GET", `/api/companies/${co.id}/projects`)).body, issues = (await d.req("GET", `/api/companies/${co.id}/issues`)).body;
  const ceo = agents.find((a) => a.role === "ceo");
  c("S02 seeds goal + CEO + project + first task", goals.length >= 1 && !!ceo && projects.length >= 1 && issues.length >= 1, `goals ${goals.length} agents ${agents.length} projects ${projects.length} issues ${issues.length}`);
  c("S03 CEO may create agents and skills", ceo?.permissions?.canCreateAgents === true, JSON.stringify(ceo?.permissions));
  r = await d.req("POST", `/api/companies/${co.id}/onboarding-seed`, body);
  const again = (await d.req("GET", `/api/companies/${co.id}/agents`)).body.length;
  c("S04 same revision twice is a no-op", r.status < 500 && again === agents.length, `${r.status} agents ${again}`);
}
console.log(JSON.stringify({ pass: rec.rows.filter((x) => x.ok).length, fail: rec.rows.filter((x) => !x.ok).length }));
if (oi > 0) writeFileSync(process.argv[oi + 1], JSON.stringify({ at: new Date().toISOString(), rows: rec.rows }, null, 1));
