import { req } from "./eng.mjs";
const r = await req("GET", `/api/heartbeat-runs/${process.argv[2]}`);
console.log(r.body.status, r.body.error ?? "");
const so = (r.body.resultJson?.stdout || "");
const o = []; for (const l of so.split("\n")) { try { o.push(JSON.parse(l)); } catch {} }
for (const e of o) { const p = e.part || {}; if (e.type === "tool_use") console.log("TOOL", p.tool, JSON.stringify(p.state.input).replace(/\s+/g, " ").slice(0, 300), "=>", String(p.state.output || "").replace(/\s+/g, " ").slice(0, 300)); else if (e.type === "text") console.log("TEXT", p.text.slice(0, 700)); }
const u = r.body.usageJson || {}; console.log("USAGE", u.model, "cost$", u.costUsd, "in", u.inputTokens, "out", u.outputTokens, "cached", u.cachedInputTokens);
