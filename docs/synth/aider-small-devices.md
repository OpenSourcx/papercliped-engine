# SYNTH: Aider small devices

Status: implementation in progress on `feat/aider-small-devices`, based on `feat/stable-v1-reconcile`.

## Shipped in this lane

- External Paperclip adapter `aider_local`, designed for Worker Fabric execution targets.
- Strict task contract: goal, 1-3 allowed files, mandatory test command, definition of done.
- Memory profiles: 4 GB -> Qwen2.5-Coder 3B/whole/8192 context; 8 GB -> Qwen2.5-Coder 7B/diff/8192; 12 GB+ -> 7B/diff/16384.
- Aider is driven headlessly with `--message-file`, `--test-cmd`, `--auto-test`, `--yes-always`, and no automatic commits.
- Outer retry loop defaults to 3 attempts, reruns the explicit correctness command, captures diff/test log/tokens/wall time, and refuses dirty state outside the declared file scope.
- Out-of-scope edits are reverted before the run can pass.
- Failed small-model runs produce an escalation handoff containing the task, current diff and last test log; configured `claude_local`/`codex_local` execution is supported.
- Additive worker installer `deploy/worker/install-aider.sh`: pinned `aider-chat==0.86.2` via pipx, memory-tier model pull, explicit num_ctx settings, Ollama listener discovery without changing its bind address, real local self-test, then publication of the `epaperclip-aider` capability wrapper.

## Verification seen

Local pure-lane tests: 10/10 passed before the GitHub branch was updated. They cover profile selection, explicit num_ctx, task validation, retry behavior, scope enforcement, token parsing and a fake Ollama inventory response.

## Real Orion proof

Not yet recorded in this SYNTH. Do not mark the lane complete until the actual Jetson Orin Nano run has been observed and the following are pasted here from the device run:

- makeLabel benchmark: 5 runs, pass rate, attempts per run, tokens/s, wall time and peak memory.
- forced/hard failure benchmark: evidence that the small lane emits escalation and that the configured stronger adapter receives the handoff.
- exact Aider version/model/context used.

Known baseline supplied before this lane: Qwen2.5-Coder 7B about 12.4 tok/s with about 6 s model load. That baseline is context only, not evidence produced by this PR.

## Rollback

Remove/disable the `aider_local` external adapter in Paperclip and remove `~/.local/bin/epaperclip-aider`; Worker Fabric and the existing `remote-worker` provider continue to operate independently. This lane does not change Tailscale, the Ollama listener, Proxmox, Papercliped Connect, Cloudflare, Stripe, Supabase, or a live database.
