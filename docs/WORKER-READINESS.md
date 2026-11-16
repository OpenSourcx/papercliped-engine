# Portable worker readiness and resource admission

Worker Fabric is the execution layer for Paperclip's existing agents, runs and threads. A device is a worker node; a thread's subsequent runs retain their workspace through the existing reusable lease contract. This change does not create another orchestrator, task queue, agent identity or conversation store.

## Installation and adoption

The Linux service installer supports amd64 and arm64, Node.js 22+, and systemd. Per-user installation uses the user's systemd manager; boot persistence requires lingering. Other architectures, non-systemd systems and distributions incompatible with the Node/Python binaries require their own packaging and validation. “Any Linux device” is the portability goal, not a claim that every distribution has been tested. GPU support and local inference are optional: a CPU-only node can run repository tools, builds and tests while its agent calls an authorized cloud model.

Use the existing signed worker release and `deploy/worker/install.sh`. Its `--check`, verified `--tarball`, `--user`, upgrade, rollback and uninstall paths remain intact. The node keeps its identity, configuration and workspaces on upgrades. Pair it with the existing console's Workers → Add worker flow and scope it to the intended organizations. Tailscale is optional; the worker makes an outbound authenticated connection using a configured transport.

Tools must be installed for the worker's execution account. A binary in `/home/miah/.local/bin` does not qualify the system account `epaperclip-worker`. The installed command wrapper changes to the service account when invoked through sudo:

```sh
sudo epaperclip-worker install-aider
sudo epaperclip-worker caps
```

`install-aider` installs pinned `aider-chat==0.86.2` into that account's private Python venv and exposes it on its own PATH. Python 3 and venv support must already be installed. It does not download or load models, change Ollama's listener, install swap or grant administrative access to the coding worker. The execution shell retains the service account's ordinary development permissions.

## What is ready

Tool discovery, model inventory and coding qualification are separate. `caps` reports the actual execution username/uid and tool versions. Installed models are not presented as passing coding checks.

For a local coding lane, drain the worker in the console, let current commands and inference finish, and free enough physical RAM for a cold-load test. Stop unused models through the configured Ollama endpoint if necessary. Keep the worker daemon running so the test uses its inference gate. Then:

```sh
sudo epaperclip-worker qualify --model qwen2.5-coder:3b
```

The command runs one Aider whole-file edit against the slug fixture that failed on Orion. It checks repeated separators, trimming, lowercase, digits and empty results. Tests are supplied read-only, compared byte-for-byte, restored before execution, and run with Python. The Aider process must also exit successfully. The bounded attempt has a timeout and no automatic test-reflection loop. Failed tests produce a failed qualification and a nonzero exit code.

Evidence is stored in the worker state directory as `qualifications.json` and `qualification-last.log`. Refresh capabilities in the console afterward. Eligibility is tied to the exact model digest, Aider version, execution account and bounded context; changing those invalidates the reported check. Passing this small fixture does not establish repository-scale coding competence. Every real coding task still needs its own tests and a bounded retry/escalation policy.

Known coding profiles are 1.5B (2048 MiB / 2048 context), 3B (3072 MiB / 4096 context), and 7B (7168 MiB / 4096 context). These are admission estimates, not kernel-enforced memory limits. The 8 GB Orion cannot admit the 7B profile with system headroom. Keep its existing swap as overflow protection; it never increases the scheduler's RAM capacity.

## Scheduling and scaling

An execution environment can specify `requirements.memoryMb`, tools, architecture, GPU, and an optional `localModel`. Omit `localModel` for cloud-model execution. Merely running commands on Orion does not require local inference. Configure the cloud provider and its credentials on the agent using the existing engine facilities; no provider credits are purchased or spent by setup or qualification.

| Budget | Behavior |
| --- | --- |
| Shell slots | Newly adopted nodes with at most 8192 MiB default to one lease. Larger nodes use a bounded CPU/RAM-derived default. Existing operator slot settings are preserved; set Orion's existing worker to one slot in the console. |
| Per-job RAM | At least 512 MiB, or the greater explicit budget, legacy `minFreeMemMb`, or known local-model floor. Increase it for builds. |
| System headroom | At least 1024 MiB or 20% of physical memory, whichever is larger. |
| Live telemetry | Linux `MemAvailable`, limited by Node's detected cgroup memory allowance. Missing or stale readings refuse new placement. Swap usage is reported separately. |
| Warm model | A matching `/api/ps` digest and context credits RAM already occupied by that model. Dedicated VRAM is excluded from RAM credit; unified RAM is counted once. |
| Inference slots | One by default, shared by native Ollama, Aider and local OpenAI-compatible requests. At most 32 waiting inference requests; a full queue returns 429. |

The host selects and reserves capacity synchronously before awaiting workspace creation. Active reservations survive host restart. Failed workspace creation/resume releases its new reservation. Release, stop and destroy retain capacity until cancellation is acknowledged; an offline release is reconciled after reconnect. A reusable thread workspace cannot be superseded while it still has a running command. Streamed output does not refresh memory telemetry. Reuse still rechecks capacity, organization scope and qualification.

These estimates intentionally err toward refusing another job; they are not cgroup isolation and cannot prevent an unrelated process or an underestimated build from exhausting RAM. Add nodes to gain execution capacity. Shared use by three people is scheduled through the existing engine; do not promise three simultaneous local generations on Orion. The host remains the existing single authoritative state store—this change does not enable multiple independent hubs writing the same state file.

## Inference endpoints

Commands receive `OLLAMA_HOST` and Aider's `OLLAMA_API_BASE` pointing at the same loopback gate. Job-provided environment values cannot override those injected addresses. `EPAPERCLIP_OPENAI_BASE_URL` exposes the gate's `/v1` address for an explicitly configured local OpenAI-compatible client. Cloud `OPENAI_BASE_URL` values are preserved. A general-purpose development shell can still deliberately contact another address; this is routing protection against accidental bypass, not a network sandbox.

The gate supports native generation/chat/embeddings and OpenAI-compatible chat/completions/embeddings/responses through one queue. Native chat/generation context is clamped to the configured cap and known coding profile. Ollama's OpenAI compatibility does not provide a per-request context-window control: configure and verify a bounded Ollama model alias before using that route for a memory-sensitive workload. Do not infer context enforcement from `max_tokens`. The Aider qualification uses the native Ollama route.

References: [Ollama running models](https://docs.ollama.com/api/ps), [OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility).

## Verification boundary

Automated tests exercise protocol pairing/replay protection, two simulated nodes, real shell execution, reusable workspaces, capacity races, memory accounting, stale telemetry, cancellation, offline release/reconnect, gate queueing and qualification with real Python tests and a simulated model edit. Installer simulations cover install, upgrade, rollback, user mode, signatures and preserved identity/settings. They do not prove GPU performance, a physical reboot, two actual devices or a real engine model run.

The supplied Orion evidence remains: 3B generated about 24–25 tokens/s warm but failed the slug coding task; 7B also failed and had an OOM incident. A short 7B run with swap left only 374 MiB available. Neither model is grandfathered into a passing qualification by this PR. Real Orion acceptance must run after deployment. This PR does not merge or register the separate draft Aider adapter from #26, whose 8 GB → 7B defaults must not be carried forward. Existing engine adapters continue to use the remote-worker provider.
