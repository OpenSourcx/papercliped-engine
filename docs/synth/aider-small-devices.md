# SYNTH: Aider small devices

Status: **code complete; real Jetson acceptance pending** on `feat/aider-small-devices`, based on `feat/stable-v1-reconcile`. PR #26 targets the integration branch and remains draft until the hardware proof below is observed.

## What this lane adds

- External Paperclip adapter `aider_local`, loaded through Paperclip's supported external-adapter API and executed through the existing Worker Fabric execution target.
- Strict per-run task contract: `goal`, one to three `allowedFiles`, mandatory `testCommand`, and `definitionOfDone`. A task without a test command is refused.
- Memory profiles:
  - 4 GB class: `qwen2.5-coder:3b`, whole-file edits, `num_ctx=8192`, one editable file.
  - 8 GB class: `qwen2.5-coder:7b`, diff edits, `num_ctx=8192`, up to three editable files.
  - 12 GB+ class: `qwen2.5-coder:7b`, diff edits, `num_ctx=16384`, up to three editable files.
- Small repo map through bounded `--map-tokens`.
- Headless Aider execution using `--message-file`, `--test-cmd`, `--auto-test`, `--yes-always`, no auto-commits, no dirty commits, and no push path.
- An outer retry loop, default three attempts, that reruns the exact test command after each Aider attempt and feeds the failing test output into the next attempt.
- Git allow-list enforcement. Pre-existing dirty files outside the task scope are refused; newly changed out-of-scope files are reverted/removed before a run can pass.
- Run result evidence returned to Paperclip: diff, final test log, pass/fail/escalate outcome, attempts, model, edit format, `num_ctx`, parsed token counts, effective wall-clock throughput, and wall time.
- Escalation handoff after exhausted attempts. The handoff contains the task contract, current diff, and final failing test log and can invoke configured `claude_local` or `codex_local`.
- Transient task/model control files live outside the Git workspace under `/tmp/epaperclip-aider/<run>` and are removed after the run.
- Additive worker installer `deploy/worker/install-aider.sh`; PR #25's worker bootstrap is not rewritten.
  - pinned `aider-chat==0.86.2` installed with pipx;
  - memory-tier model selected automatically;
  - the worker's existing Ollama listener is discovered without changing its bind address;
  - the model is pulled through that existing listener;
  - explicit Aider/Ollama context settings are written;
  - a real local repair-and-test self-test gets up to three attempts;
  - `~/.local/bin/epaperclip-aider` and the `aider` worker capability appear only after the self-test passes.
- ePaperclip packages the adapter inside the pinned engine tree and auto-registers it before creating a Worker Fabric environment.
- Release packaging, host installer fixtures, worker bundle packaging, CI, and release checks include the lane.

## Automated verification observed

The pure lane tests were run locally during implementation: **10/10 passed**. They cover profile selection, explicit context sizing, task validation, retry behavior, scope enforcement, token parsing, and fake Ollama inventory.

GitHub CI run #49 on the implementation head completed the main `checks` job successfully, including:

- `pnpm typecheck`
- full `pnpm test`
- full `pnpm build`
- Proxmox API consistency check
- script tests
- Proxmox sandbox + remote-worker provider checks
- Aider small-device tests/syntax checks
- worker installer simulation

The separate full deploy-simulation job also completed successfully after the release fixtures were updated to carry the external adapter. No security checks or installer guards were weakened to make it pass.

## Real Orion benchmark harness

The PR contains `engine/adapters/aider-local/bench/run-orion.mjs` and the exact test-first `makeLabel` fixture requested for the Jetson gate. Each of five runs begins from a clean Git repository with the acceptance tests already present.

The benchmark records:

- pass rate over five runs;
- attempts per run;
- parsed Aider token counts;
- end-to-end wall time;
- per-task effective throughput;
- a separate native Ollama generation probe using `eval_count / eval_duration` for true model tokens/sec and Ollama's reported load time;
- a deterministic forced-failure control that must end in `escalate`.

Peak shared memory is deliberately not inferred. Run `tegrastats` alongside the benchmark and record the highest `RAM X/YMB` observation.

Reference command from the PR:

```sh
NODE=/opt/epaperclip-worker/node/bin/node
command -v "$NODE" >/dev/null || NODE="$(command -v node)"
tegrastats --interval 1000 > /tmp/aider-tegrastats.log 2>&1 &
TPID=$!
"$NODE" engine/adapters/aider-local/bench/run-orion.mjs | tee /tmp/aider-bench.json
kill "$TPID" 2>/dev/null || true
```

## Hardware acceptance still required

No real-Orion result is claimed in this SYNTH. This implementation session did not have an SSH/remote-shell connector into the user's Tailscale device, so fabricating Nano evidence would violate the acceptance rule.

Before PR #26 is marked ready, attach observed evidence for:

1. **Benchmark task 1:** five real `makeLabel` runs on the Jetson Orin Nano, with pass rate, attempts/run, native Ollama tokens/sec, wall time, and peak shared memory.
2. **Benchmark task 2:** a deliberately hard/failing task showing the small lane emits `escalate`, plus a real Paperclip run proving the configured stronger `claude_local` or `codex_local` adapter receives the task, diff, and failing test log.
3. Exact Aider version, model, edit format and `num_ctx` reported by the device.
4. Worker capability refresh showing `aider` only after the installer self-test succeeds.

The previously supplied Orion baseline, Qwen2.5-Coder 7B at about 12.4 tok/s with about a six-second load, is context only and is **not** counted as proof produced by this PR.

## Safety and boundaries

This lane does not change Orion's Tailscale configuration or Ollama bind address and does not touch Proxmox/PVE, Stripe, Cloudflare, Supabase, or a live database. The worker may execute development shell commands through Worker Fabric, but this adapter does not copy hypervisor credentials or unrelated infrastructure secrets to the worker.

## Rollback

Disable/remove the `aider_local` external adapter in Paperclip and remove `~/.local/bin/epaperclip-aider` plus the Aider profile/readiness files from the worker. Worker Fabric and the existing `remote-worker` provider continue to function independently. No node identity, Tailscale configuration, Ollama listener, or Proxmox resource needs to be changed to roll this lane back.
