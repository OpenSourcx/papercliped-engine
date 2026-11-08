import { req } from "./eng.mjs";
import { readFileSync } from "node:fs";
const ids = JSON.parse(readFileSync("ids.json"));
for (const a of [ids.coder, ids.ceo]) { let r = await req("POST", `/api/agents/${a}/resume`, {}); console.log("resume", r.status, r.body.status ?? JSON.stringify(r.body).slice(0,150)); }
const desc = readFileSync("task.md", "utf8");
let r = await req("POST", `/api/companies/${ids.company}/issues`, { title: process.argv[2], description: desc, projectId: ids.project, goalId: ids.goal, assigneeAgentId: ids.coder, priority: "medium" });
console.log("issue", r.status, r.body.id, r.body.identifier);
