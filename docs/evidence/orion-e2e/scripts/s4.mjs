import { req } from "./eng.mjs";
import { readFileSync } from "node:fs";
const ids = JSON.parse(readFileSync("ids.json"));
let r = await req("GET", `/api/agents/${ids.coder}`);
const cfg = r.body.adapterConfig; const ref = cfg.env.GITHUB_TOKEN; delete cfg.env.GITHUB_TOKEN; cfg.env.QUAL_GH_TOKEN = ref;
r = await req("PATCH", `/api/agents/${ids.coder}`, { adapterConfig: cfg }); console.log("patch", r.status, Object.keys(r.body.adapterConfig?.env ?? {}));
r = await req("GET", "/api/issues/667a05e1-0429-4e3c-aec6-7a96917d5f5d"); console.log("ORI-1", r.body.status);
