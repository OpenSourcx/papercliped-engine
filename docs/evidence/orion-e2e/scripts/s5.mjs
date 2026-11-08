import { req } from "./eng.mjs";
import { readFileSync } from "node:fs";
const ids = JSON.parse(readFileSync("ids.json"));
const base = readFileSync("task.md", "utf8");
const cfg = (await req("GET", `/api/agents/${ids.coder}`)).body.adapterConfig;
const out = {};
for (const [name, fn] of [["B", "wordcount"], ["C", "titlecase"]]) {
  let r = await req("POST", `/api/companies/${ids.company}/agents`, { name: `Orion Coder ${name}`, role: "engineer", title: "Engineer", reportsTo: ids.ceo, adapterType: "opencode_local", adapterConfig: cfg, runtimeConfig: { heartbeat: { enabled: false } }, defaultEnvironmentId: ids.env, budgetMonthlyCents: 20 });
  const id = r.body.id ?? r.body.agent?.id; await req("PATCH", `/api/agents/${id}`, { defaultEnvironmentId: ids.env }); await req("POST", `/api/agents/${id}/resume`, {});
  const desc = `Add a new function to the private GitHub repository \`KpnWorld/epaperclip-qualification-sandbox\`: create \`${fn}.py\` with a function \`${fn}(text: str)\` (${fn === "wordcount" ? "returns the number of whitespace-separated words" : "returns the text with each word capitalised"}) and a unittest file \`test_${fn}.py\` with two tests. Do NOT touch slugify.py. Do not commit __pycache__ (add a .gitignore line for it). Branch name must start with \`feat/${fn}-\`.\n\nFollow exactly the same clone, test, commit, push and pull-request steps as below (replace the slugify wording with your function). Do NOT merge.\n\n` + base.split("Steps")[1].replace(/^[^\n]*\n/, "Steps:\n");
  r = await req("POST", `/api/companies/${ids.company}/issues`, { title: `Add ${fn} and open a pull request`, description: desc, projectId: ids.project, goalId: ids.goal, assigneeAgentId: id });
  out[name] = { agent: id, issue: r.body.id }; console.log(name, id, r.body.identifier);
}
console.log(JSON.stringify(out));
