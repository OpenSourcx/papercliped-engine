import { req } from "./eng.mjs";
import { readFileSync } from "node:fs";
const ids = JSON.parse(readFileSync("ids.json"));
const r = await req("GET", `/api/companies/${ids.company}/heartbeat-runs?limit=10`);
const runs = Array.isArray(r.body) ? r.body : r.body.runs ?? [];
for (const x of runs) console.log(x.id, x.agentId.slice(0,8), x.status, x.errorCode ?? "", String(x.error ?? "").slice(0, 200), x.startedAt, x.finishedAt ?? "");
