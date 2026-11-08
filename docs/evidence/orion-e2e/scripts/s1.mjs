import { req } from "./eng.mjs";
const C = process.argv[2], W = process.argv[3];
let r = await req("POST", "/api/plugins/install", { packageName: "/project/papercliped-engine-worktrees/orion-e2e/plugins/remote-worker", isLocalPath: true });
console.log("install", r.status, r.body.status, r.body.pluginKey, r.body.lastError ?? "");
const env = await (await fetch("http://127.0.0.1:3231/env", { method: "POST", body: JSON.stringify({ companyId: C, name: "Orion (remote worker)", workerId: W, requirements: {} }) })).json();
console.log("env", JSON.stringify(env));
r = await req("POST", `/api/environments/${env.id}/probe`, {});
console.log("probe", r.status, JSON.stringify(r.body).slice(0, 600));
