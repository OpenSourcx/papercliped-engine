#!/usr/bin/env node
// Permissions / private-project check, same scenario on both targets: an owner makes a private project, a second person is a
// "viewer" member, and a third is no member. native: invites via the engine. epc: Proxmox users sam (administrator), lee
// (granted viewer through the host's /api/iac/orgs/:id/members route, which sets the engine membership). Evidence: real
// Paperclip runtime (engine + real host); Proxmox itself is the repo's fake.
// Usage: node scripts/parity/access.mjs [--out docs/evidence/parity/access.json]
import { writeFileSync } from "node:fs";
import { driver, Client, NATIVE, recorder, sleep } from "./lib.mjs";
const rec = recorder(); const ok2 = (r) => r.status >= 200 && r.status < 300;
const outIdx = process.argv.indexOf("--out");

// ---- native
{
  const t = "native", c = (id, ok, d) => rec.check(id, t, ok, d);
  const a = await driver("native"); const tag = Date.now().toString(36);
  const co = (await a.req("POST", "/api/companies", { name: `Access ${tag}` })).body;
  const pub = (await a.req("POST", `/api/companies/${co.id}/projects`, { name: "Open one" })).body;
  const priv = (await a.req("POST", `/api/companies/${co.id}/projects`, { name: "Private one", visibility: "private" })).body;
  const bob = new Client(NATIVE); await bob.signUp(`bob${tag}@parity.invalid`, "Parity-pass-12345", "Bob");
  const outsider = new Client(NATIVE); await outsider.signUp(`out${tag}@parity.invalid`, "Parity-pass-12345", "Out");
  const inv = await a.req("POST", `/api/companies/${co.id}/invites`, { allowedJoinTypes: "human", humanRole: "viewer" });
  const acc = await bob.req("POST", `/api/invites/${inv.body?.token}/accept`, { requestType: "human" });
  c("A01 invite + accept as viewer", ok2(inv) && ok2(acc), `${inv.status}/${acc.status}`);
  const members = (await a.req("GET", `/api/companies/${co.id}/members`)).body; const ml = Array.isArray(members) ? members : members.members ?? [];
  const bm = ml.find((m) => m.principalType === "user" && m.status !== "archived" && m.principalId !== co.defaultResponsibleUserId);
  if (bm?.status === "pending") await a.req("POST", `/api/companies/${co.id}/join-requests/${bm.id}/approve`, {}).catch(() => {});
  let r = await outsider.req("GET", `/api/companies/${co.id}/projects`);
  c("A02 non-member cannot list projects", r.status === 403 || r.status === 404, String(r.status));
  r = await bob.req("GET", `/api/companies/${co.id}/projects`);
  const names = Array.isArray(r.body) ? r.body.map((p) => p.name) : [];
  c("A03 viewer member lists projects", ok2(r), `${r.status} member=${bm?.status}`);
  c("A04 viewer does not see the private project", ok2(r) && names.includes("Open one") && !names.includes("Private one"), names.join(","));
  r = await bob.req("GET", `/api/projects/${priv.id}`);
  c("A05 viewer cannot read the private project by id", r.status >= 400, String(r.status));
  r = await bob.req("POST", `/api/companies/${co.id}/projects`, { name: "viewer write" });
  c("A06 viewer cannot create projects", r.status >= 400, String(r.status));
}
// ---- epc
{
  const t = "epc", c = (id, ok, d) => rec.check(id, t, ok, d);
  const sam = await driver("epc", { user: "sam" }); const lee = await driver("epc", { user: "lee" });
  await sleep(4000);
  const tag = Date.now().toString(36);
  const co = (await sam.req("POST", "/api/companies", { name: `Access ${tag}` })).body;
  await sam.req("POST", `/api/companies/${co.id}/projects`, { name: "Open one" });
  const priv = (await sam.req("POST", `/api/companies/${co.id}/projects`, { name: "Private one", visibility: "private" })).body;
  let r = await lee.req("GET", `/api/companies/${co.id}/projects`);
  c("A02 non-member cannot list projects", r.status === 403 || r.status === 404, String(r.status));
  const g = await sam.host("PUT", `/api/iac/orgs/${co.id}/members/lee@pve`, { role: "viewer" });
  c("A01 grant viewer through the host (engine membership)", ok2(g), `${g.status} ${JSON.stringify(g.body).slice(0, 80)}`);
  await sleep(1500);
  r = await lee.req("GET", `/api/companies/${co.id}/projects`);
  const names = Array.isArray(r.body) ? r.body.map((p) => p.name) : [];
  c("A03 viewer member lists projects", ok2(r), String(r.status));
  c("A04 viewer does not see the private project", ok2(r) && names.includes("Open one") && !names.includes("Private one"), names.join(","));
  r = await lee.req("GET", `/api/companies/${co.id}/issues`);
  c("A05 viewer reads issues through proxy", ok2(r), String(r.status));
  r = await lee.req("POST", `/api/companies/${co.id}/projects`, { name: "viewer write" });
  c("A06 viewer cannot create projects", r.status >= 400, String(r.status));
  r = await lee.req("GET", `/api/projects/${priv.id}`);
  c("A05b private project by id is not reachable by a viewer (route closed at the proxy, so 404 regardless)", r.status >= 400, String(r.status));
  const me = await lee.req("GET", "/api/cli-auth/me");
  c("A07 a non-admin Proxmox person is not an engine instance admin", me.body?.isInstanceAdmin === false, `isInstanceAdmin=${me.body?.isInstanceAdmin}`);
  const sm = await sam.req("GET", "/api/cli-auth/me");
  rec.check("A08 Proxmox administrator becomes engine instance admin (sees every organization)", t, sm.body?.isInstanceAdmin === true, `isInstanceAdmin=${sm.body?.isInstanceAdmin}`);
}
console.log(JSON.stringify({ pass: rec.rows.filter((x) => x.ok).length, fail: rec.rows.filter((x) => !x.ok).length }));
if (outIdx > 0) writeFileSync(process.argv[outIdx + 1], JSON.stringify({ at: new Date().toISOString(), rows: rec.rows }, null, 1));
