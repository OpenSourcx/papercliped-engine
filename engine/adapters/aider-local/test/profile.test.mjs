import test from "node:test";
import assert from "node:assert/strict";
import { profileForMemory, modelSettingsYaml, parseAiderTokens, probeOllama } from "../src/profile.js";

test("4 GB and 8 GB profiles choose the requested models and formats", () => {
  assert.deepEqual(profileForMemory(4096), {
    tier: "4gb", minMemMb: 3072, model: "qwen2.5-coder:3b", aiderModel: "ollama_chat/qwen2.5-coder:3b", editFormat: "whole", numCtx: 8192, mapTokens: 512, maxEditableFiles: 1,
  });
  assert.deepEqual(profileForMemory(7600), {
    tier: "8gb", minMemMb: 6144, model: "qwen2.5-coder:7b", aiderModel: "ollama_chat/qwen2.5-coder:7b", editFormat: "diff", numCtx: 8192, mapTokens: 768, maxEditableFiles: 3,
  });
  assert.equal(profileForMemory(16384).numCtx, 16384);
  assert.throws(() => profileForMemory(2048), /at least 3 GiB/);
});

test("model settings explicitly pin Ollama num_ctx", () => {
  const y = modelSettingsYaml(profileForMemory(7600));
  assert.match(y, /ollama_chat\/qwen2\.5-coder:7b/);
  assert.match(y, /num_ctx: 8192/);
});

test("token parser accumulates aider summaries", () => {
  assert.deepEqual(parseAiderTokens("Tokens: 1.2k sent, 345 received\nTokens: 800 sent, 1.1k received"), { inputTokens: 2000, outputTokens: 1445 });
});

test("fake Ollama probe reads model inventory", async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    return new Response(JSON.stringify({ models: [{ name: "qwen2.5-coder:7b" }, { model: "qwen2.5-coder:3b" }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const got = await probeOllama("http://127.0.0.1:11434/", fakeFetch);
  assert.deepEqual(got.models, ["qwen2.5-coder:7b", "qwen2.5-coder:3b"]);
  assert.deepEqual(calls, ["http://127.0.0.1:11434/api/tags"]);
});
