#!/usr/bin/env node
// node packages/model-eval/src/cli.ts --fake | --openai id,baseUrl,model[,apiKeyEnv] | --command id,cmd,[args...] | --jev-routing
import { commandAdapter, fakeModel, openAiCompatible } from "./adapters.ts";
import { recommend, table } from "./report.ts";
import { routingAgreement } from "./routing-eval.ts";
import { runEval } from "./runner.ts";
import { TASKS } from "./tasks/index.ts";
import { createJevProvider, createTypeSafeAsk } from "@papercliped-engine/task-router";
import type { ModelAdapter } from "./types.ts";

const args = process.argv.slice(2);
const models: ModelAdapter[] = [];
let attempts = 2, jevRouting = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--fake") models.push(fakeModel("fake-easy", "easy"), fakeModel("fake-hard", "hard"));
  else if (a === "--attempts") attempts = Number(args[++i]);
  else if (a === "--jev-routing") jevRouting = true;
  else if (a === "--openai") { const [id, baseUrl, model, keyEnv] = args[++i].split(","); models.push(openAiCompatible({ id, baseUrl, model, apiKey: keyEnv ? process.env[keyEnv] : undefined })); }
  else if (a === "--command") { const [id, command, ...rest] = args[++i].split(","); models.push(commandAdapter({ id, command, args: rest })); }
  else { console.error(`Unknown option ${a}`); process.exit(2); }
}

if (jevRouting) {
  // The only place that talks to the real TypeSafe API, and only with the key of whoever runs it.
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) { console.error("--jev-routing needs TYPESAFE_API_KEY in the environment."); process.exit(2); }
  const withJev = await routingAgreement(TASKS, createJevProvider(createTypeSafeAsk({ apiKey: key })));
  const rules = await routingAgreement(TASKS);
  console.log(`rules: ${rules.agree}/${rules.total} agree with the expected tier\njev:   ${withJev.agree}/${withJev.total}`);
  for (const r of withJev.rows) console.log(`${r.taskId.padEnd(16)} expected ${r.expected.padEnd(11)} got ${r.got.padEnd(11)} ${r.source}${r.jevError ? ` (${r.jevError})` : ""}`);
}
if (models.length) {
  const results = await runEval(TASKS, models, attempts);
  console.log(table(results));
  console.log(`\nCheapest model that clears 80% per difficulty (models in the order given): ${JSON.stringify(recommend(results))}`);
}
if (!models.length && !jevRouting) { console.error("Nothing to run. Use --fake, --openai, --command or --jev-routing."); process.exit(2); }
