# Orion benchmark

Run this only after `deploy/worker/install-aider.sh` has completed its self-test and the worker advertises the `aider` capability.

Use the private Node runtime installed by Worker Fabric when there is no system Node:

```sh
NODE=/opt/epaperclip-worker/node/bin/node
command -v "$NODE" >/dev/null || NODE="$(command -v node)"
tegrastats --interval 1000 > /tmp/aider-tegrastats.log 2>&1 &
TPID=$!
"$NODE" engine/adapters/aider-local/bench/run-orion.mjs | tee /tmp/aider-bench.json
kill "$TPID" 2>/dev/null || true
```

The benchmark runs the exact `makeLabel` acceptance task five times from a clean Git repository, with tests present before the model edits. It also runs one deterministic forced-failure control and requires the small-device loop to return `escalate`.

For the full Paperclip escalation proof, configure the Aider agent's `escalationAdapter` as `claude_local` or `codex_local`, assign the Worker Fabric environment, then use the same forced-failure contract. The server adapter hands the current diff and test log to that stronger adapter. Record the Paperclip run id and log in the SYNTH. Do not treat this direct runner control as proof that a cloud adapter ran.

Peak memory comes from the matching `tegrastats` log. Record the maximum `RAM X/YMB` value. The benchmark JSON records pass rate, attempts, parsed Aider tokens, per-task effective throughput, wall time, plus `ollamaProbe.tokensPerSecond` computed from Ollama's native `eval_count / eval_duration` and its reported model load time.
