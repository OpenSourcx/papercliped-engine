#!/usr/bin/env node
// Screen tour of both UIs in headless Chromium: for each page, the heading text, every API response >= 400 the page triggered,
// and a screenshot. native = the pinned package's own UI (served by the engine); epc = the ePaperclip console served by the host.
// Usage: node scripts/parity/tour.mjs native|epc [--shots docs/evidence/parity/shots] [--out docs/evidence/parity/tour-<t>.json]
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { launch } from "./pw.mjs";
import { NATIVE, driver } from "./lib.mjs";

const kind = process.argv[2] ?? "native";
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const shots = arg("--shots", "docs/evidence/parity/shots"); mkdirSync(shots, { recursive: true });
const d = await driver(kind);
const cos = (await d.req("GET", "/api/companies")).body;
const co = cos.find((c) => c.name.startsWith(`Parity ${kind}`));
if (!co) throw new Error("run journey.mjs first");
const slug = co.issuePrefix.toLowerCase();
const agent = (await d.req("GET", `/api/companies/${co.id}/agents`)).body.find((a) => a.role === "ceo");
const issue = (await d.req("GET", `/api/companies/${co.id}/issues`)).body[0];
const base = kind === "native" ? NATIVE : d.base;
// Page list per target. Native routes come from its sidebar and agent/instance sub-routes; epc routes from apps/console/src/App.tsx.
const NATIVE_PAGES = ["dashboard", "inbox", "issues", `issues/${issue?.identifier ?? ""}`, "projects", "goals", "routines", "artifacts", "agents", "agents/all", `agents/${agent?.urlKey ?? "ceo"}`, `agents/${agent?.urlKey ?? "ceo"}/instructions`, `agents/${agent?.urlKey ?? "ceo"}/skills`, `agents/${agent?.urlKey ?? "ceo"}/configuration`, `agents/${agent?.urlKey ?? "ceo"}/runs`, `agents/${agent?.urlKey ?? "ceo"}/budget`, "agents/new", "skills", "apps", "activity", "costs", "approvals", "org", "search", "members", "company/settings", "company/settings/environments", "company/settings/secrets", "company/import", "company/export", "workspaces", "dashboard/live"];
const EPC_PAGES = ["", "inbox", "decisions", "tasks", `tasks/${issue?.id ?? ""}`, "projects", "goals", "routines", "artifacts", "agents", `agents/${agent?.id ?? ""}`, "skills", "connectors", "activity", "costs", "org", "members", "settings", "chat", "workspaces", "machines"];
const pages = kind === "native" ? NATIVE_PAGES.map((p) => [p, `${base}/${slug.toUpperCase()}/${p}`]) : EPC_PAGES.map((p) => [p || "dashboard", `${base}/pve/${slug}/${p}`]);

const b = await launch();
const ctx = await b.newContext({ viewport: { width: 1360, height: 860 } });
if (kind === "native") await ctx.request.post(NATIVE + "/api/auth/sign-in/email", { headers: { Origin: NATIVE }, data: { email: "admin@parity.invalid", password: "Parity-pass-12345" } });
else await ctx.request.post(base + "/api/login", { headers: { "X-EPC-Request": "1", Origin: base }, data: { username: "sam", password: "right", realm: "pve" } });
if (kind === "epc") await ctx.addInitScript(() => localStorage.setItem("epc.setup", JSON.stringify({ ownerName: "Sam", deviceName: "pve", pinMode: "assist", aiProvider: "claude", pinAccess: { read: true, act: false }, completedAt: "2026-11-07T00:00:00Z" })));
const out = [];
for (const [name, url] of pages) {
  const page = await ctx.newPage();
  const bad = [];
  page.on("response", (r) => { const u = new URL(r.url()); if (r.status() >= 400 && (u.pathname.startsWith("/api/") || u.pathname.startsWith("/engine/api/"))) bad.push(`${r.status()} ${r.request().method()} ${u.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "{id}")}`); });
  let status = "ok";
  try { await page.goto(url, { waitUntil: "networkidle", timeout: 20000 }); await page.waitForTimeout(1200); } catch (e) { status = "timeout"; }
  const text = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  const h = (await page.locator("h1:visible, main h2:visible").first().innerText().catch(() => "")).trim();
  const file = `${shots}/${kind}-${name.replace(/[^a-z0-9]+/gi, "_") || "home"}.png`;
  await page.screenshot({ path: file }).catch(() => {});
  out.push({ page: name, url: url.replace(base, ""), heading: h.slice(0, 60), bodyStart: text.slice(0, 140), notFound: /not found|404|doesn.t exist/i.test(text.slice(0, 300)), badApi: [...new Set(bad)].slice(0, 8), status, shot: file });
  console.log(`${out.at(-1).notFound ? "NOTFOUND" : "ok      "} ${name.padEnd(34)} ${h.slice(0, 40).padEnd(40)} bad=${out.at(-1).badApi.length}`);
  await page.close();
}
await b.close();
const o = arg("--out", `docs/evidence/parity/tour-${kind}.json`);
writeFileSync(o, JSON.stringify({ at: new Date().toISOString(), kind, pages: out }, null, 1));
