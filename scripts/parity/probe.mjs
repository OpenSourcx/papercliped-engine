#!/usr/bin/env node
// Capability probe: the same GET on the native engine and through the ePaperclip host proxy. A native 2xx with an epc 404
// means the route is closed at the proxy (engine-allow.ts), i.e. a screen that needs it cannot exist in the console.
// Usage: node scripts/parity/probe.mjs [--out docs/evidence/parity/probe.json]
import { writeFileSync } from "node:fs";
import { driver } from "./lib.mjs";
const outIdx = process.argv.indexOf("--out");
const CAPS = [
  ["org/list companies", "/api/companies"], ["org/chart json", "/api/companies/{c}/org"], ["org/chart svg", "/api/companies/{c}/org.svg"],
  ["org/branding", "/api/companies/{c}/branding"], ["org/export", "/api/companies/{c}/export"], ["org/invites", "/api/companies/{c}/invites"], ["org/members", "/api/companies/{c}/members"],
  ["org/join requests", "/api/companies/{c}/join-requests"], ["org/user directory", "/api/companies/{c}/user-directory"],
  ["goals/list", "/api/companies/{c}/goals"], ["goals/get", "/api/goals/{goal}"],
  ["agents/list", "/api/companies/{c}/agents"], ["agents/get", "/api/agents/{a}"], ["agents/configuration", "/api/agents/{a}/configuration"], ["agents/config revisions", "/api/agents/{a}/config-revisions"],
  ["agents/permissions", "/api/agents/{a}/permissions"], ["agents/keys", "/api/agents/{a}/keys"], ["agents/instructions", "/api/agents/{a}/instructions-bundle"], ["agents/skills", "/api/agents/{a}/skills"],
  ["agents/runtime state", "/api/agents/{a}/runtime-state"], ["agents/task sessions", "/api/agents/{a}/task-sessions"], ["agents/inbox", "/api/agents/me/inbox-lite"],
  ["adapters/list", "/api/adapters"], ["adapters/models", "/api/companies/{c}/adapters/process/models"], ["adapters/config schema", "/api/adapters/process/config-schema"],
  ["runtime/environments", "/api/companies/{c}/environments"], ["runtime/env capabilities", "/api/companies/{c}/environments/capabilities"],
  ["models/ai connections", "/api/companies/{c}/ai-connections"], ["models/connection intents", "/api/companies/{c}/connection-intents"],
  ["secrets/list", "/api/companies/{c}/secrets"], ["secrets/providers", "/api/companies/{c}/secret-providers"], ["secrets/provider configs", "/api/companies/{c}/secret-provider-configs"],
  ["skills/company", "/api/companies/{c}/skills"], ["skills/catalog", "/api/skills/catalog"], ["skills/sources", "/api/companies/{c}/skill-sources"],
  ["issues/list", "/api/companies/{c}/issues"], ["issues/get", "/api/issues/{i}"], ["issues/comments", "/api/issues/{i}/comments"], ["issues/heartbeat context", "/api/issues/{i}/heartbeat-context"],
  ["issues/documents", "/api/issues/{i}/documents"], ["issues/work products", "/api/issues/{i}/work-products"], ["issues/attachments", "/api/issues/{i}/attachments"], ["issues/labels", "/api/companies/{c}/labels"],
  ["issues/tree control", "/api/issues/{i}/tree-control/state"], ["issues/approvals", "/api/issues/{i}/approvals"], ["issues/interactions", "/api/issues/{i}/interactions"],
  ["projects/list", "/api/companies/{c}/projects"], ["projects/get", "/api/projects/{p}"], ["projects/workspaces", "/api/projects/{p}/workspaces"], ["projects/access members", "/api/projects/{p}/access-members"],
  ["routines/list", "/api/companies/{c}/routines"], ["workspaces/execution", "/api/companies/{c}/execution-workspaces"],
  ["approvals/list", "/api/companies/{c}/approvals"], ["governance/decisions", "/api/companies/{c}/decisions"],
  ["costs/summary", "/api/companies/{c}/costs/summary"], ["costs/by agent", "/api/companies/{c}/costs/by-agent"], ["costs/finance", "/api/companies/{c}/costs/finance-summary"], ["costs/window spend", "/api/companies/{c}/costs/window-spend"],
  ["budgets/overview", "/api/companies/{c}/budgets/overview"], ["budgets/policies", "/api/companies/{c}/budgets/policies"],
  ["runs/heartbeat list", "/api/companies/{c}/heartbeat-runs"], ["runs/live", "/api/companies/{c}/live-runs"], ["runs/scheduler", "/api/instance/scheduler-heartbeats"],
  ["activity/list", "/api/companies/{c}/activity"], ["search/query", "/api/companies/{c}/search?q=a"], ["dashboard", "/api/companies/{c}/dashboard"],
  ["sidebar/badges", "/api/companies/{c}/sidebar-badges"], ["inbox/dismissals", "/api/companies/{c}/inbox-dismissals"], ["attention", "/api/companies/{c}/attention"],
  ["tools/gallery (apps/MCP connectors)", "/api/companies/{c}/tools/gallery"], ["tools/connections", "/api/companies/{c}/tools/connections"], ["tools/profiles", "/api/companies/{c}/tools/profiles"], ["tools/policies", "/api/companies/{c}/tools/policies"],
  ["tools/action requests", "/api/companies/{c}/tools/action-requests"], ["tools/applications", "/api/companies/{c}/tool-applications"], ["mcp/aggregators", "/api/companies/{c}/mcp-aggregators"],
  ["plugins/list", "/api/plugins"], ["plugins/ui contributions", "/api/plugins/ui-contributions"], ["plugins/examples", "/api/plugins/examples"],
  ["chat/endpoints", "/api/companies/{c}/chat-endpoints"], ["chat/board", "/api/companies/{c}/chats"], ["email/status", "/api/companies/{c}/email"],
  ["artifacts/list", "/api/companies/{c}/artifacts"], ["folders", "/api/companies/{c}/folders"], ["teams/catalog", "/api/teams/catalog"], ["resource memberships (me)", "/api/companies/{c}/resource-memberships/me"],
  ["admin/instance general", "/api/instance/settings/general"], ["admin/experimental", "/api/instance/settings/experimental"], ["admin/db backups", "/api/instance/database-backups"], ["admin/users", "/api/admin/users"],
  ["identity/cli-auth me", "/api/cli-auth/me"], ["identity/user profile", "/api/users/me/profile"], ["health", "/api/health"], ["llms/agent config doc", "/llms/agent-configuration.txt"],
  ["announcements", "/api/companies/{c}/announcements"], ["status cards", "/api/companies/{c}/status-cards"], ["voice sessions", "/api/companies/{c}/voice-sessions"],
];
const d = { native: await driver("native"), epc: await driver("epc") };
const out = [];
for (const k of ["native", "epc"]) {
  const cos = (await d[k].req("GET", "/api/companies")).body;
  const co = cos.find((c) => c.name.startsWith(`Parity ${k}`));
  const a = (await d[k].req("GET", `/api/companies/${co.id}/agents`)).body[0].id;
  const i = (await d[k].req("GET", `/api/companies/${co.id}/issues`)).body[0].id;
  const p = (await d[k].req("GET", `/api/companies/${co.id}/projects`)).body[0].id;
  const goal = (await d[k].req("GET", `/api/companies/${co.id}/goals`)).body[0]?.id ?? "x";
  d[k].sub = (s) => s.replace("{c}", co.id).replace("{a}", a).replace("{i}", i).replace("{p}", p).replace("{goal}", goal);
}
for (const [cap, path] of CAPS) {
  const row = { cap, path };
  for (const k of ["native", "epc"]) { const r = await d[k].req("GET", d[k].sub(path)); row[k] = r.status; }
  row.state = row.native === row.epc ? "same" : row.native < 400 && row.epc === 404 ? "closed at proxy" : "differs";
  out.push(row);
}
const n = (s) => out.filter((r) => r.state === s).length;
for (const r of out.filter((r) => r.state !== "same")) console.log(`${r.state.padEnd(16)} native ${r.native} epc ${r.epc}  ${r.cap}  ${r.path}`);
console.log(`probed ${out.length}: same ${n("same")}, closed at proxy ${n("closed at proxy")}, differs ${n("differs")}`);
if (outIdx > 0) writeFileSync(process.argv[outIdx + 1], JSON.stringify({ at: new Date().toISOString(), rows: out }, null, 1));
