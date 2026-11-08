# Orion end-to-end qualification (2026-11-08)

Labels: [RT] real Paperclip runtime 2026.1023.0, [HW] physical Orion, [EXT] real external provider (OpenRouter, GitHub), [HARNESS] fabric host run through `services/epaperclip/scripts/fabric-host-live.ts` (real hub, listener, environments code; not the Proxmox-login console).

## Headline demo: PASSED [RT][HW][EXT]
- Engine: paperclipai 2026.1023.0 disposable (`/project/.work/orion-e2e`, port 3298); host harness fabric port 7853, control 3230.
- Worker: `wrk_654e443f5d0a` (Orion kpnai, aarch64, Ubuntu 24.04, user `miah`, non-root). Re-paired from `wrk_d142b0970803`: the old host pinned a different host key and holds port 7843 (a process this run did not start), so the same identity key was adopted by a second host. `config.json.pre-orion-e2e` kept on Orion.
- Environment `916e455c-07f5-4418-86f9-5a6c35c5c66c` (sandbox, provider remote-worker), company `6b151cd0-d1f0-4312-b958-f2fd9a398fe4` (Orion Qualification Co, budget US$1), goal `3e5c0a03-...`, project `6e3db6eb-...`, CEO `4455ca3d-...`, coder `14d87d70-84a7-4848-b8e8-a1c11c92b597`.
- Adapter: `opencode_local` v1.19.5 (aarch64 binary from the anomalyco/opencode release, sha256 `fae5be26...d088b` verified), model `openrouter/qwen/qwen3-coder`. Stand-in `claude` removed from Orion PATH (moved to `~/.local/stub-removed`).
- Why not the local 3B model: opencode requests carry ~16k tokens (15.7k input per run here); Orion's Ollama context is clamped to 4096, so qwen2.5-coder:3b cannot hold the agent prompt. Not attempted, reasoned from measured prompt size. claude/codex/gemini logins were not used.
- Task ORI-2 `6e81e7c3-9bc3-4572-9544-8c38bd83dfc6`; run `766cbd32-8650-47f6-a01c-1a1985f6baf5` (succeeded, 77 s): clone with credential helper (token only in per-run env `QUAL_GH_TOKEN`), branch `feat/slugify-1794126310`, implement, `python3 -m unittest` OK (4 tests), commit `6c063cc1922545c7b13015d47191663a24859715`, push, PR via REST.
- **PR #1 (open, unmerged): https://github.com/KpnWorld/epaperclip-qualification-sandbox/pull/1** (private repo KpnWorld/epaperclip-qualification-sandbox). Agent also committed `__pycache__` (model quality blemish). A Paperclip continuation run (`05a14f15`) opened PR #2 (`5c346f30`) because the issue was not closed by the agent; run `6d744125` followed. Both PRs left open.
- Usage recorded by Paperclip for the run: 15,763 in / 884 out / 133,248 cached tokens, US$0.0189 (provider reported). Company spend total after all runs: US$0.173 of the US$1 cap.
- Token hygiene: the PAT was never stored on Orion; a scan of `~/epaperclip-workspaces`, `~/.local`, `~/.config`, shell history and the user journal for the token found nothing; run logs on the engine do not contain it.

## Findings
1. `GITHUB_TOKEN` as an agent env name did not authenticate (first attempt ORI-1, run `4024dc9d`); engine reserves GH/GITHUB token names. Renamed to `QUAL_GH_TOKEN`. Pinned-engine behaviour.
2. Without linger the user manager (and the worker) stops when the last SSH session ends; the service restarted every ~20 s during unattended periods. A holder SSH session kept it up. Blocker: one root command, `sudo loginctl enable-linger miah`.
3. `epaperclip-worker adopt` while the daemon runs raced with the running daemon (first adoption re-used the old worker id and was refused); stopping the service first fixed it.
4. Cancelling a running run left `cost_accounting_pending` true with an incomplete receipt, which hard-stops the agent and company budget (policy "block") although only 5% was spent. Engine route `costs/retry-accounting` returned `accounted:false`; in the disposable DB the flag was cleared by SQL after approving the two budget_override approvals. Pinned-engine behaviour.
5. Leak: `paperclip-bridge-server.mjs` processes started by the adapter on Orion survive the run and lease destroy (the worker kills only the exec process group). Fix in this PR (see commits).
6. Worker clones have no credential channel for private repos (daemon `git clone` is unauthenticated); the agent cloned itself with the per-run secret.

Scripts used are in `scripts/` (no secrets). ids: `ids.json`.
