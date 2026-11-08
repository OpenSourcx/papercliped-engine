# SYNTH: task-router
Date / agent / model used: 2026-11-08 / Claude Code (Othniel's agent account, working for Miah, the owner) / Claude Sonnet 5.5 (`claude-sonnet-5-5`)
Branch, PR link, head commit, CI status: `feat/task-router` / PR_LINK / HEAD_COMMIT / CI_STATUS

Report to: **Othniel and Miah** (the owner).

## What exists now (one line per component, with path)
- Task contract and tier types (`local-small`, `free-cloud`, `claude`), `RouteDecision`, `RunReport`: `packages/task-router/src/types.ts`
- Rule classifier (risk tags and risky paths always `claude`; size, file count, missing test or size decide the rest): `packages/task-router/src/classifier.ts`
- Per-organization routing table (tier -> adapter + model + environment), validator `parseRoutingTable`, fallback chain helpers: `packages/task-router/src/table.ts`
- Router (`createTaskRouter`: `route()` and `next()` for the "escalate" chain): `packages/task-router/src/router.ts`
- Jev decision provider: question wording, thresholds and the truth table in one file (`questions.ts`), provider (`jev.ts`), server-side TypeSafe client (`typesafe.ts`)
- Customer switch for Jev: settings, key-as-secret handling, disclosure text, request dispatcher (`settings.ts`), organization entry point (`org.ts`)
- Evaluation harness: 16 coding tasks with `node:test` tests, starting with `makeLabel` (`packages/model-eval/src/tasks/index.ts`), runner (`runner.ts`), table and tier recommendation (`report.ts`), adapters: fake, OpenAI-compatible (works against the Router), command (`adapters.ts`), routing agreement check (`routing-eval.ts`), CLI (`cli.ts`)
- Tests: `packages/task-router/test/router.test.ts` (25), `packages/model-eval/test/eval.test.ts` (11)

## How it plugs into ePaperclip (the exact contracts: adapter type id, config fields, API routes, env vars)
- **Package interface (stable; the thing the aider adapter and the host rely on):**
  - `createTaskRouter({ table?, classifier?, jev? })` -> `{ route(task: TaskContract): Promise<RouteDecision>, next(decision, report: RunReport): RouteDecision | null }`
  - `TaskContract = { goal, filesAllowed[], testCommand?, expectedDiffLines?, riskTags? }`
  - `RouteDecision = { tier, target: { adapterType, model?, environment? }, source: "rules" | "jev" | "rules-fallback", reasons[], jevError? }`
  - `RunReport = { status: "ok" | "escalate" | "failed", note? }`. Only `escalate` moves up the chain; `next` returns `null` at the end of the chain.
  - Organization entry point: `createOrgRouter({ tables, jev }).route(companyId, task)` and `.next(companyId, decision, report)`.
- **Adapter type ids** in the default table are existing ones: `opencode_local` (local-small, free-cloud) and `claude_local` (claude). The aider adapter plugs in by setting `adapterType` in an organization's table (or the default); no router change. Default model names are placeholders (`auto` through the Router, `claude-sonnet-5-5`) until `model-eval` has measured real ones.
- **Routing table** (per organization, stored by the host; the router only parses it): `{ targets: { "<tier>": { adapterType, model?, environment? } }, chain: ["local-small","free-cloud","claude"] }`. The chain goes cheapest to strongest. A task is never started on a tier cheaper than wanted, and a table with no `claude` rejects a risky task with an error.
- **Jev settings API** (not yet mounted; the host mounts `createJevSettings(...).handle(method, sub, companyId, body, { isAdmin })` under `/api/task-router/orgs/:companyId/jev`):
  - `GET /` view `{ enabled, hasKey, consentSendTaskText, active, disclosure }` (never the key). Anyone signed in to the organization may read.
  - `PUT /` `{ enabled?, consentSendTaskText? }`; `PUT /key` `{ apiKey }`; `DELETE /key`; `POST /test`. Administrators only (403 otherwise). `enabled: true` is refused (409) without a key and without consent; taking consent back switches it off.
  - Ports the host supplies: `SettingsStore { get, set }` (per organization, holds `{ enabled, secretId, consentSendTaskText }` only) and `SecretPort { create, read, remove? }` over the engine's secrets (`POST /api/companies/{companyId}/secrets`, `engine-client` `settings.createSecret`) and the host's server-side secret resolution. The key is stored as a Paperclip secret; only its id is kept in settings.
  - Console copy (title, switch label, consent label, what is sent): `JEV_CARD` in `settings.ts`, so the console and docs say the same thing.
- **What is sent to TypeSafe** (per task, only when active): goal text, file paths, expected diff lines. Never file contents, comments or secrets. Tasks with a risk tag or risky path, or with no file limit, are decided by code and never sent. The test button sends fixed text only. Endpoint `POST https://api.typesafe.ai/v1/systemone`, model `jev-latest`, key as a bearer header from the organization's secret.
- **Jev questions** (all in `questions.ts`): Noul "touches authentication, billing, tenancy or security"; Choice "files realistically needed" (`one_file` / `two_or_three_files` / `four_or_more_files`); Noul "routine work". Bands: at least 0.7 is yes, at most 0.3 is no, between is "unsure" (own rows). The truth table is a plain array, first match wins, ends in a catch-all; a test checks all 27 combinations have an outcome.
- **Env vars:** none for the router. `TYPESAFE_API_KEY` is read only by the eval CLI's `--jev-routing` mode, from the environment of whoever runs it.
- **Eval CLI:** `node packages/model-eval/src/cli.ts --fake | --openai id,baseUrl,model[,keyEnv] | --command id,cmd[,args] | --jev-routing [--attempts n]` (also `pnpm --filter @papercliped-engine/model-eval eval -- ...`). Models are listed cheapest first; the CLI prints a table (pass rate, mean attempts for passed tasks, cost, time, by difficulty) and the cheapest model that clears 80% per difficulty.

## Evidence (each item labelled: CI / local / real-device; command + result)
- local: `pnpm --filter @papercliped-engine/task-router typecheck` -> clean; `... test` -> 25 passed (classifier, table validation, fallback chain, truth table, Jev failure fallback, no-Jev-for-risky, key redaction, settings guards, per-organization isolation).
- local: `pnpm --filter @papercliped-engine/model-eval typecheck` -> clean; `... test` -> 11 passed (every reference solution passes its tests and an empty module fails them, for all 16 tasks; retry feedback; timeout; adapters; table; recommendation).
- local: `pnpm install --frozen-lockfile --filter @papercliped-engine/task-router --filter @papercliped-engine/model-eval` accepts the hand-added lockfile entries.
- local: `node packages/model-eval/src/cli.ts --fake` (fake models only, not a measurement of any real model):
  `fake-easy` 44% (easy 7/7, medium 0/6, hard 0/3), `fake-hard` 100%; recommendation `{"easy":"fake-easy","medium":"fake-hard","hard":"fake-hard"}`; about 8 s.
- local: rule classifier vs. the expected tier per difficulty (easy -> local-small, medium -> free-cloud, hard -> claude): 7 of 16 agree. All 16 tasks are one file with 5 to 30 changed lines, so the rules send all of them to `local-small`. See known gaps.
- CI: CI_EVIDENCE
- NOT done: no call to the real TypeSafe API, no real model measured. The router tests use a fake Jev and assert tiers, never probabilities.

## Decisions made and why (max 10 bullets)
- Code decides, Jev judges: three small questions, a plain truth table, thresholds 0.7/0.3 (TypeSafe's starting values); "unsure" risk goes to `claude`.
- Risk is decided before Jev: tagged, risky-path or unbounded tasks go to `claude` without leaving the host, so the strongest rule needs no network and sends no text.
- Jev may make a task cheaper than the rules would, but never below the "floor" code can prove (risk, declared file count). Jev can only lower a tier from the soft facts (unknown size, missing test).
- Jev failures are never an answer: the rules decide, `source` is `rules-fallback`, and `jevError` says why.
- No key, switched off, or no consent means the rule classifier runs unchanged; consent is a separate, explicit opt-in and withdrawing it turns Jev off.
- Fallback goes up one tier per `escalate` and stops; plain `failed` does not spend more money.
- Tasks with no test command or unknown diff size never start on `local-small` (nothing to check a small model's work).
- Harness tasks are plain ESM functions tested with `node:test`, so any adapter (HTTP, CLI agent, fake) runs the same way with no extra dependencies; `recommend()` picks the first model, in cheapest-first order, that clears a pass rate per difficulty.
- `makeLabel` is a reconstruction: the original task text is not in the repository (see gaps).
- Changes stay inside the two new packages, this file and `pnpm-lock.yaml` (two importer entries, needed for `--frozen-lockfile`).

## Known gaps and risks
- **Not wired into the host or console.** The brief limited work to new paths, so the Settings > Connectors card, the `/api/task-router/...` mount, the settings and table storage, and the call from task creation are not done. They are small and specified above. Until they are, the customer feature exists as tested code, not as a visible switch.
- **`makeLabel` task text was not available**; the 16 tasks and their tests are mine. Replace `make-label` with the real task when it is found.
- **The rules cannot see difficulty inside a one-file, small-diff task** (7 of 16 agree with the expected tier). That is the case for measuring: run the harness against real models, set the table from `recommend()`, and compare rules with `--jev-routing`. Neither the Jev question set nor its truth table has been tried on the real API.
- **Default model names are placeholders**, not measured picks.
- Eval cost is only as good as the adapter's prices (`usdPerMTokIn/Out`); free tiers report 0.
- `AbortSignal.timeout` and Node 22+ type stripping are assumed (the repo requires Node 22+; CI uses 24).
- A TypeSafe key sits in memory on the host while a task is routed; it is never logged or returned, and errors are redacted, but a host compromise exposes it like any other connector key.
- Eval tests take about 15 s because each task test spawns Node.

## What the Lead must do to integrate (ordered steps, including merge order and anything needing owner approval)
1. Merge order: stable v1.0.0 tag first, then this PR, then the aider adapter. Merging needs the owner; this lane did not merge.
2. Check CI on the PR is green (`pnpm install --frozen-lockfile`, `typecheck`, `test`, `build`).
3. Host service: add storage for `{ enabled, secretId, consentSendTaskText }` per organization and for the routing table; implement `SecretPort` over the engine's secrets; mount `createJevSettings(...).handle` under `/api/task-router/orgs/:companyId/jev` (admin-only for writes, audited like other connector changes).
4. Console: add the "Jev task routing (TypeSafe)" card to Settings > Connectors from `JEV_CARD` (key field, consent checkbox, switch, test button, the disclosure sentence), using the recognized TypeSafe mark per `docs/CONNECTORS.md`.
5. Call `createOrgRouter(...).route(companyId, contract)` where a task is assigned an agent; on a run that reports it cannot finish, call `.next(...)` and re-assign. Map `target.adapterType`, `model` and `environment` onto the agent's adapter config.
6. Aider adapter: set its `adapterType` in the default table where wanted; the router needs no other change.
7. Owner decision: run `model-eval` against real models with the owner's keys (OpenAI-compatible endpoints or the Router), set the default table from the result, and try `--jev-routing` with the owner's `TYPESAFE_API_KEY` (task text of the 16 eval tasks is sent). Not done here.

## Files touched (list)
- `packages/task-router/` (new): `package.json`, `tsconfig.json`, `src/{types,classifier,table,questions,typesafe,jev,router,settings,org,index}.ts`, `test/router.test.ts`
- `packages/model-eval/` (new): `package.json`, `tsconfig.json`, `src/{types,runner,report,adapters,routing-eval,cli,index}.ts`, `src/tasks/index.ts`, `test/eval.test.ts`
- `docs/synth/task-router.md` (new)
- `pnpm-lock.yaml` (two importer entries added)
